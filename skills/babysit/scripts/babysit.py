#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "typer>=0.12",
#   "rich>=13",
#   "psutil>=7",
#   "textual>=0.80",
# ]
# ///
"""babysit — supervised background task runner.

Single-file daemon + CLI. Spawns tasks under per-user systemd scopes (cgroup v2)
and enforces memory / CPU / observability rules per ./babysit.md.

Setup: enable user-systemd lingering so daemon survives logout:
    loginctl enable-linger $USER
"""

from __future__ import annotations

import contextlib
import json
import os
import random
import re
import selectors
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import psutil
import typer
from rich.console import Console
from rich.table import Table


# ──────────────────────────────────────────────────────────────────────────────
# Paths & constants
# ──────────────────────────────────────────────────────────────────────────────

STATE_DIR = Path(os.environ.get("BABYSIT_STATE", str(Path.home() / ".local/state/babysit")))
LOG_DIR = STATE_DIR / "logs"
DB_PATH = STATE_DIR / "state.db"
SOCK_PATH = STATE_DIR / "sock"
DAEMON_PID_PATH = STATE_DIR / "daemon.pid"
DAEMON_LOG_PATH = STATE_DIR / "daemon.log"

def _host_default_mem() -> str:
    """4G default, but clamped to half host RAM so it never exceeds total on tiny hosts."""
    total = psutil.virtual_memory().total
    target = min(4 * 1024**3, total // 2)
    return f"{max(target // (1024**2), 1)}M"


def _host_default_cores() -> float:
    return float(min(4, os.cpu_count() or 1))


DEFAULTS = {
    "estimated_time": "10m",
    "kill_timeout": "20m",
    "observability_interval": "5m",
    "mem_pct_limit": 40.0,
    "cpu_pct_limit": 90.0,
    "estimated_mem_bytes": _host_default_mem(),
    "estimated_cpu_cores": _host_default_cores(),
    "max_sys_mem_pct": 70.0,
    "max_sys_disk_pct": 98.0,
    "max_babysit_cpu_pct": 90.0,
    "monitor_interval": "10s",
    "monitor_tolerance_count": 3,
    "monitor_disk_infer_by_dir": str(Path.home()),
    "cleanup_ttl": "7d",
}

STATUSES = ("pending", "running", "completed", "failed", "killed", "unknown")
TERMINAL = {"completed", "failed", "killed", "unknown"}

SPEC_COLUMNS = (
    "name", "pid", "status", "kill_reason", "kill_hint", "kill_detail", "exit_code", "command",
    "elapsed_time", "estimated_time", "kill_timeout", "observability_interval",
    "last_observed_log", "time_since_last_observe",
    "cpu_cores", "cpu_pct", "estimated_cpu_cores",
    "mem_bytes", "mem_pct", "estimated_mem_bytes",
    "disk_write_bytes", "disk_read_bytes",
    "num_procs", "num_threads",
    "cwd",
    "claude_session_id",
)

# Agent-facing remediation hints. Keys must match every `kill_reason` string
# the daemon writes (see `_kill_task`, `_check_task`, `_adopt_running`, `_start_task`).
KILL_HINTS: dict[str, str] = {
    "system_mem_pressure": "system memory >70% sustained — reduce batch size or wait for free RAM",
    "system_disk_pressure": "system disk >98% sustained — clean outputs or write elsewhere",
    "mem_exceeded": "task RSS exceeded --mem_pct_limit (default 40% of total RAM) — reduce batch size or pass a higher --mem_pct_limit",
    "cpu_exceeded": "task CPU exceeded --cpu_pct_limit × cores — reduce parallelism or pass a higher --cpu_pct_limit",
    "estimated_mem_exceeded": "task RSS exceeded 2× --estimated_mem_bytes sustained — your peak-memory prediction was off; raise --estimated_mem_bytes or reduce footprint, then re-queue",
    "estimated_cpu_exceeded": "task CPU exceeded 2× --estimated_cpu_cores sustained — your peak-CPU prediction was off; raise --estimated_cpu_cores or reduce parallelism, then re-queue",
    "cgroup_oom_killed": "kernel OOM-killed the task at the 3× --estimated_mem_bytes cgroup boundary — your peak-memory prediction was severely off (explosive allocation outpaced the 30s soft-watch); raise --estimated_mem_bytes substantially or reduce footprint, then re-queue",
    "kernel_oom": "task SIGKILLed by kernel under memory pressure — reduce memory footprint, then re-queue",
    "elapsed_exceeded": "task elapsed > --kill_timeout — pass a longer --kill_timeout or speed up the job",
    "observability_stall": "task wrote no log line for > --observability_interval — ensure progress prints; check PYTHONUNBUFFERED=1",
    "manual": "killed by user via `babysit kill`",
    "daemon_shutdown": "daemon stopped (SIGTERM); restart with `babysit daemon-start` and re-queue",
    "daemon_restart_dead": "task PID was gone when daemon restarted; re-queue",
    "daemon_restart_pid_reuse": "task PID was reused by another process across daemon restart; re-queue",
    "process_vanished": "task process disappeared between probes (likely external kill or kernel OOM-killer) — check `dmesg`",
    "adopted_exited": "adopted task exited across daemon restart; exit code unobservable — inspect the log file",
}


def kill_hint_for(reason: str | None) -> str | None:
    if not reason:
        return None
    if reason.startswith("spawn_error:"):
        return "systemd-run failed to start the scope — check daemon log; likely missing user-systemd or DBus session"
    return KILL_HINTS.get(reason)

console = Console()


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

_DURATION_RE = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*([smhd]?)\s*$")


def parse_duration(s: str | float | int) -> float:
    if isinstance(s, (int, float)):
        return float(s)
    m = _DURATION_RE.match(s)
    if not m:
        raise ValueError(f"bad duration: {s!r}")
    n = float(m.group(1))
    unit = m.group(2) or "s"
    return n * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]


def fmt_duration(secs: float | None) -> str:
    if secs is None:
        return "-"
    secs = int(secs)
    if secs < 60:
        return f"{secs}s"
    if secs < 3600:
        return f"{secs // 60}m{secs % 60}s"
    h, rem = divmod(secs, 3600)
    return f"{h}h{rem // 60}m"


_BYTES_RE = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*([KMGT]?)B?\s*$", re.IGNORECASE)


def parse_bytes(s: str | int | float) -> int:
    """Parse human-friendly byte spec ('4G', '512M', '1.5T', '8192') → int."""
    if isinstance(s, (int, float)):
        return int(s)
    m = _BYTES_RE.match(s)
    if not m:
        raise ValueError(f"bad bytes spec: {s!r}")
    n = float(m.group(1))
    unit = (m.group(2) or "").upper()
    return int(n * {"": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}[unit])


def fmt_bytes(n: int | None) -> str:
    if n is None:
        return "-"
    for unit in ("B", "K", "M", "G", "T"):
        if abs(n) < 1024:
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}{unit}"
        n /= 1024
    return f"{n:.1f}P"


def now() -> float:
    return time.time()


# ──────────────────────────────────────────────────────────────────────────────
# Storage
# ──────────────────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    name TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    status TEXT NOT NULL,
    pid INTEGER,
    scope_unit TEXT,
    estimated_time REAL,
    kill_timeout REAL,
    observability_interval REAL,
    mem_pct_limit REAL,
    cpu_pct_limit REAL,
    estimated_mem_bytes INTEGER,
    estimated_cpu_cores REAL,
    created_at REAL NOT NULL,
    started_at REAL,
    ended_at REAL,
    exit_code INTEGER,
    kill_reason TEXT,
    log_path TEXT NOT NULL,
    cwd TEXT,
    claude_session_id TEXT,
    kill_detail TEXT
);

CREATE TABLE IF NOT EXISTS daemon_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def open_db() -> sqlite3.Connection:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, isolation_level=None, timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    if "kill_detail" not in cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN kill_detail TEXT")
    return conn


def row_to_dict(r: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(r) if r is not None else None


# ──────────────────────────────────────────────────────────────────────────────
# systemd-run wrapper
# ──────────────────────────────────────────────────────────────────────────────


def _systemd_env() -> dict[str, str]:
    env = os.environ.copy()
    uid = os.getuid()
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{uid}")
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{uid}/bus")
    return env


def spawn_under_scope(
    name: str,
    command: str,
    mem_pct_limit: float,
    cpu_pct_limit: float,
    log_path: Path,
    estimated_mem_bytes: int | None = None,
    estimated_cpu_cores: float | None = None,
    cwd: str | None = None,
) -> tuple[subprocess.Popen, str]:
    """Spawn `command` inside a transient systemd --user scope (cgroup v2).

    cgroup envelopes are sized to `min(3 × estimate, pct_limit × total)` per dim
    when an estimate is provided — bounds explosive runaways at the kernel level
    while preserving the global pct_limit safety net. The 3× headroom sits above
    the daemon's 2× sustained soft-kill so the daemon usually fires first with a
    graceful kill_reason; the kernel only steps in for instant explosions.

    Returns (Popen, scope_unit_name). Popen.pid is the task PID — systemd-run
    --scope sets up the cgroup then execs in place, preserving PID.
    """
    n_cores = os.cpu_count() or 1
    mem_total = psutil.virtual_memory().total
    mem_cap_global = int(mem_total * mem_pct_limit / 100)
    cpu_cap_global_pct = int(round(cpu_pct_limit * n_cores))  # 90% × 64 cores = 5760%
    mem_bytes = (
        min(3 * estimated_mem_bytes, mem_cap_global)
        if estimated_mem_bytes else mem_cap_global
    )
    cpu_quota = (
        min(int(round(3 * estimated_cpu_cores * 100)), cpu_cap_global_pct)
        if estimated_cpu_cores else cpu_cap_global_pct
    )
    scope_unit = f"babysit-{re.sub(r'[^A-Za-z0-9_-]', '_', name)}.scope"

    cmd = [
        "systemd-run", "--user", "--scope", "--quiet", "--collect",
        f"--unit={scope_unit}",
        f"--property=MemoryMax={mem_bytes}",
        "--property=MemorySwapMax=0",
        f"--property=CPUQuota={cpu_quota}%",
        "--",
        "bash", "-c", command,
    ]

    # Default thread-pool envs to the declared CPU budget so libraries that
    # otherwise spawn one thread per host core (Polars, OpenMP/LightGBM, BLAS)
    # stay within estimated_cpu_cores — otherwise their oversubscription trips
    # the daemon's sustained-CPU soft-kill on a many-core host. Coupled to the
    # estimate (the sustained budget), not the 3× cgroup burst headroom. Only
    # setdefault: a user's inline `POLARS_MAX_THREADS=8 cmd` prefix still wins
    # at exec, and an exported value in the daemon env is preserved.
    env = _systemd_env()
    if estimated_cpu_cores:
        n_threads = str(max(1, int(round(estimated_cpu_cores))))
        for _var in (
            "POLARS_MAX_THREADS", "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS",
            "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS",
        ):
            env.setdefault(_var, n_threads)

    log_path.parent.mkdir(parents=True, exist_ok=True)
    fp = open(log_path, "ab", buffering=0)
    proc = subprocess.Popen(
        cmd,
        stdout=fp,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        env=env,
        close_fds=True,
        cwd=cwd,
        preexec_fn=lambda: os.nice(10),  # demote task vs monitor
    )
    fp.close()  # child holds the FD now
    return proc, scope_unit


def stop_scope(scope_unit: str) -> None:
    """Best-effort scope teardown via systemctl --user stop."""
    with contextlib.suppress(Exception):
        subprocess.run(
            ["systemctl", "--user", "stop", scope_unit],
            env=_systemd_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )


def cgroup_oom_killed(scope_unit: str) -> bool:
    """Return True iff the scope's cgroup has a non-zero oom_kill counter.

    Must be called BEFORE `stop_scope` — systemd-run --collect removes the
    cgroup on stop, taking memory.events with it.
    """
    try:
        r = subprocess.run(
            ["systemctl", "--user", "show", scope_unit,
             "--property=ControlGroup", "--value"],
            env=_systemd_env(),
            capture_output=True, text=True, timeout=2,
        )
        cgroup_rel = r.stdout.strip()
        if not cgroup_rel:
            return False
        events_path = Path(f"/sys/fs/cgroup{cgroup_rel}/memory.events")
        if not events_path.exists():
            return False
        for line in events_path.read_text().splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0] == "oom_kill":
                return int(parts[1]) > 0
    except Exception:
        pass
    return False


# ──────────────────────────────────────────────────────────────────────────────
# Resource probes
# ──────────────────────────────────────────────────────────────────────────────


@dataclass
class TaskStats:
    cpu_pct: float = 0.0
    cpu_cores: float = 0.0
    mem_bytes: int = 0
    mem_pct: float = 0.0
    disk_read_bytes: int = 0
    disk_write_bytes: int = 0
    num_procs: int = 0
    num_threads: int = 0


def probe_task(
    pid: int,
    prev_cpu_times: dict[int, tuple[float, float]],
) -> tuple[TaskStats, dict[int, tuple[float, float]]] | None:
    """Recursive process-tree probe with accurate per-PID CPU%.

    `prev_cpu_times` maps PID → (cpu_seconds, wall_time) from prior probe.
    CPU% per PID = (cur_cpu - prev_cpu) / (now_wall - prev_wall) * 100.
    Returns (stats, new_cpu_times) or None if root PID is gone.
    """
    try:
        root = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return None
    procs = [root]
    with contextlib.suppress(psutil.NoSuchProcess):
        procs.extend(root.children(recursive=True))

    mem_total = psutil.virtual_memory().total
    now_wall = time.time()
    cpu_sum = 0.0
    mem_sum = threads_sum = read_sum = write_sum = 0
    new_cpu_times: dict[int, tuple[float, float]] = {}
    for p in procs:
        try:
            ct = p.cpu_times()
            cur_cpu = ct.user + ct.system
            mem_sum += p.memory_info().rss
            threads_sum += p.num_threads()
            try:
                io = p.io_counters()
                read_sum += io.read_bytes
                write_sum += io.write_bytes
            except (psutil.AccessDenied, AttributeError):
                pass
            new_cpu_times[p.pid] = (cur_cpu, now_wall)
            prev = prev_cpu_times.get(p.pid)
            if prev is not None:
                dw = now_wall - prev[1]
                if dw > 0:
                    cpu_sum += (cur_cpu - prev[0]) / dw * 100.0
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    stats = TaskStats(
        cpu_pct=cpu_sum,
        cpu_cores=cpu_sum / 100.0,
        mem_bytes=mem_sum,
        mem_pct=(mem_sum / mem_total * 100) if mem_total else 0.0,
        disk_read_bytes=read_sum,
        disk_write_bytes=write_sum,
        num_procs=len(procs),
        num_threads=threads_sum,
    )
    return stats, new_cpu_times


@dataclass
class SysStats:
    mem_pct: float
    cpu_pct: float
    disk_pct: float


def probe_system(disk_dir: str) -> SysStats:
    du = shutil.disk_usage(disk_dir)
    return SysStats(
        mem_pct=psutil.virtual_memory().percent,
        cpu_pct=psutil.cpu_percent(interval=None),
        disk_pct=du.used / du.total * 100.0 if du.total else 0.0,
    )


def log_last_mtime(log_path: Path) -> float | None:
    try:
        return log_path.stat().st_mtime
    except FileNotFoundError:
        return None


def tail_n(path: Path, n: int) -> str:
    """Last n lines of a (possibly large) log file."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            block = 8192
            data = b""
            while end > 0 and data.count(b"\n") <= n:
                read = min(block, end)
                end -= read
                f.seek(end)
                data = f.read(read) + data
            lines = data.splitlines()[-n:]
            return b"\n".join(lines).decode("utf-8", "replace")
    except FileNotFoundError:
        return ""


# ──────────────────────────────────────────────────────────────────────────────
# RPC protocol — newline-delimited JSON over Unix socket
# ──────────────────────────────────────────────────────────────────────────────


def rpc_send(sock: socket.socket, obj: dict) -> None:
    sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))


def rpc_recv(sock: socket.socket) -> dict | None:
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = sock.recv(65536)
        if not chunk:
            return None
        buf += chunk
        if len(buf) > 16 * 1024 * 1024:
            raise RuntimeError("RPC message too large")
    line = buf.rstrip(b"\n")
    return json.loads(line.decode("utf-8")) if line else None


def daemon_alive() -> bool:
    try:
        pid = int(DAEMON_PID_PATH.read_text().strip())
        os.kill(pid, 0)
        return True
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return False


class RPCError(RuntimeError):
    """RuntimeError carrying the full daemon response payload (for callers
    that need to surface structured error fields, e.g. `capacity_exceeded`)."""

    def __init__(self, msg: str, payload: dict | None = None):
        super().__init__(msg)
        self.payload: dict = payload or {}


def rpc_call(op: str, **kwargs) -> dict:
    if not SOCK_PATH.exists() or not daemon_alive():
        raise RPCError(
            "babysit daemon not running. Start with: babysit daemon-start"
        )
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(10.0)
    try:
        s.connect(str(SOCK_PATH))
        rpc_send(s, {"op": op, **kwargs})
        resp = rpc_recv(s)
    finally:
        s.close()
    if resp is None:
        raise RPCError("empty response from daemon")
    if not resp.get("ok", False):
        raise RPCError(resp.get("error", "unknown daemon error"), resp)
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# Daemon
# ──────────────────────────────────────────────────────────────────────────────


@dataclass
class RunningTask:
    name: str
    popen: subprocess.Popen | None  # None for adopted (cross-daemon-restart) tasks
    pid: int
    scope_unit: str
    log_path: Path
    obs_interval: float
    kill_timeout: float
    mem_pct_limit: float
    cpu_pct_limit: float
    started_at: float
    estimated_mem_bytes: int | None = None
    estimated_cpu_cores: float | None = None
    obs_violation_count: int = 0
    mem_overrun_count: int = 0
    cpu_overrun_count: int = 0
    last_log_mtime: float | None = None
    last_stats: TaskStats | None = None
    prev_cpu_times: dict[int, tuple[float, float]] = field(default_factory=dict)


class Daemon:
    def __init__(
        self,
        max_sys_mem_pct: float,
        max_sys_disk_pct: float,
        max_babysit_cpu_pct: float,
        monitor_interval: float,
        monitor_tolerance_count: int,
        monitor_disk_infer_by_dir: str,
        cleanup_ttl: float,
    ) -> None:
        self.max_sys_mem_pct = max_sys_mem_pct
        self.max_sys_disk_pct = max_sys_disk_pct
        self.max_babysit_cpu_pct = max_babysit_cpu_pct
        self.monitor_interval = monitor_interval
        self.monitor_tolerance_count = monitor_tolerance_count
        self.disk_dir = monitor_disk_infer_by_dir
        self.cleanup_ttl = cleanup_ttl
        self._last_cleanup_at = 0.0

        self.db = open_db()
        self.running: dict[str, RunningTask] = {}
        self.sys_pressure: dict[str, int] = {"mem": 0, "disk": 0}
        self.shutting_down = False

        # Adopt any tasks left running by a prior daemon (PID-reuse guarded)
        self._adopt_running()

        if SOCK_PATH.exists():
            SOCK_PATH.unlink()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(SOCK_PATH))
        os.chmod(SOCK_PATH, 0o600)
        self.server.listen(64)
        self.server.setblocking(False)

        self.sel = selectors.DefaultSelector()
        self.sel.register(self.server, selectors.EVENT_READ, self._accept)

        # Save config snapshot
        for k, v in {
            "max_sys_mem_pct": max_sys_mem_pct,
            "max_sys_disk_pct": max_sys_disk_pct,
            "max_babysit_cpu_pct": max_babysit_cpu_pct,
            "monitor_interval": monitor_interval,
            "monitor_tolerance_count": monitor_tolerance_count,
            "monitor_disk_infer_by_dir": monitor_disk_infer_by_dir,
            "cleanup_ttl": cleanup_ttl,
        }.items():
            self.db.execute(
                "INSERT OR REPLACE INTO daemon_config(key,value) VALUES(?,?)",
                (k, json.dumps(v)),
            )

    # ── PID adoption across daemon restart ─────────────────────────────────
    def _adopt_running(self) -> None:
        rows = self.db.execute("SELECT * FROM tasks WHERE status='running'").fetchall()
        for r in rows:
            name = r["name"]
            pid = r["pid"]
            started_at = r["started_at"]
            reason = None
            if pid is None or not psutil.pid_exists(pid):
                reason = "daemon_restart_dead"
            else:
                try:
                    proc = psutil.Process(pid)
                    # PID-reuse guard
                    if started_at and proc.create_time() > started_at + 5:
                        reason = "daemon_restart_pid_reuse"
                except psutil.NoSuchProcess:
                    reason = "daemon_restart_dead"
            if reason is not None:
                self.db.execute(
                    "UPDATE tasks SET status='failed', kill_reason=?, ended_at=? WHERE name=?",
                    (reason, now(), name),
                )
                self.log(f"[{name}] not adopted ({reason})")
                continue
            rt = RunningTask(
                name=name,
                popen=None,
                pid=pid,
                scope_unit=r["scope_unit"] or "",
                log_path=Path(r["log_path"]),
                obs_interval=r["observability_interval"] or parse_duration(DEFAULTS["observability_interval"]),
                kill_timeout=r["kill_timeout"] or parse_duration(DEFAULTS["kill_timeout"]),
                mem_pct_limit=r["mem_pct_limit"] or DEFAULTS["mem_pct_limit"],
                cpu_pct_limit=r["cpu_pct_limit"] or DEFAULTS["cpu_pct_limit"],
                started_at=started_at or now(),
                estimated_mem_bytes=r["estimated_mem_bytes"],
                estimated_cpu_cores=r["estimated_cpu_cores"],
            )
            # prime CPU baseline
            with contextlib.suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                p = psutil.Process(pid)
                ct = p.cpu_times()
                rt.prev_cpu_times = {pid: (ct.user + ct.system, time.time())}
            self.running[name] = rt
            self.log(f"[{name}] adopted pid={pid} from prior daemon")

    # ── lifecycle ───────────────────────────────────────────────────────────
    def log(self, msg: str) -> None:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        print(f"[{ts}] {msg}", flush=True)

    def run_forever(self) -> None:
        signal.signal(signal.SIGTERM, lambda *_: self._begin_shutdown())
        signal.signal(signal.SIGINT, lambda *_: self._begin_shutdown())
        self.log(f"daemon up (pid={os.getpid()}) — monitor every {self.monitor_interval}s")
        psutil.cpu_percent(interval=None)  # prime
        last_tick = 0.0
        while not (self.shutting_down and not self.running):
            timeout = max(0.05, self.monitor_interval - (time.time() - last_tick))
            events = self.sel.select(timeout=timeout)
            for key, _mask in events:
                cb = key.data
                cb(key.fileobj)
            if time.time() - last_tick >= self.monitor_interval:
                self._tick()
                last_tick = time.time()
        self.log("daemon shutdown")

    def _begin_shutdown(self) -> None:
        if self.shutting_down:
            return
        self.shutting_down = True
        self.log("SIGTERM received — stopping running tasks")
        for name in list(self.running):
            self._kill_task(name, reason="daemon_shutdown")

    # ── socket I/O ──────────────────────────────────────────────────────────
    def _accept(self, sock: socket.socket) -> None:
        try:
            conn, _ = sock.accept()
        except BlockingIOError:
            return
        conn.settimeout(10.0)
        try:
            req = rpc_recv(conn)
            resp = self._dispatch(req or {})
        except Exception as e:  # noqa: BLE001
            resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        try:
            rpc_send(conn, resp)
        except OSError:
            pass
        finally:
            conn.close()

    def _dispatch(self, req: dict) -> dict:
        op = req.get("op")
        handler = getattr(self, f"_op_{op}", None)
        if handler is None:
            return {"ok": False, "error": f"unknown op: {op}"}
        return handler(req)

    # ── RPC handlers ────────────────────────────────────────────────────────
    def _op_run(self, req: dict) -> dict:
        name = req["name"]
        command = req["command"]
        cwd = req.get("cwd")
        if cwd is not None:
            if not cwd or not cwd.strip() or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
                return {"ok": False, "error": f"cwd {cwd!r} must be an existing absolute directory"}
        total_mem = psutil.virtual_memory().total
        n_cores = os.cpu_count() or 1
        em = req.get("estimated_mem_bytes")
        ec = req.get("estimated_cpu_cores")
        if em is not None and int(em) > total_mem:
            return {"ok": False, "error": f"estimated_mem_bytes {int(em)} exceeds host total RAM {total_mem} — infeasible; reduce estimate or split the task"}
        if ec is not None and float(ec) > n_cores:
            return {"ok": False, "error": f"estimated_cpu_cores {float(ec)} exceeds host total cores {n_cores} — infeasible; reduce estimate or split the task"}
        for key in ("mem_pct_limit", "cpu_pct_limit"):
            v = req.get(key)
            if v is not None and not (0 < float(v) <= 100):
                return {"ok": False, "error": f"{key} {v} must be in (0, 100]"}
        for key in ("estimated_time", "kill_timeout", "observability_interval"):
            v = req.get(key)
            if v is not None and float(v) <= 0:
                return {"ok": False, "error": f"{key} {v} must be > 0"}
        existing = self.db.execute(
            "SELECT status FROM tasks WHERE name=?", (name,)
        ).fetchone()
        if existing and existing["status"] not in TERMINAL:
            return {"ok": False, "error": f"task {name!r} already exists with status={existing['status']}"}
        if existing:
            # purge terminal record so name can be reused
            self.db.execute("DELETE FROM tasks WHERE name=?", (name,))

        if not req.get("force"):
            deny = self._capacity_check(
                int(req.get("estimated_mem_bytes") or 0),
                float(req.get("estimated_cpu_cores") or 0),
            )
            if deny is not None:
                return {"ok": False, **deny}

        log_path = LOG_DIR / f"{name}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        # Truncate to start fresh
        with open(log_path, "wb"):
            pass

        self.db.execute(
            "INSERT INTO tasks(name,command,status,estimated_time,kill_timeout,"
            "observability_interval,mem_pct_limit,cpu_pct_limit,"
            "estimated_mem_bytes,estimated_cpu_cores,"
            "created_at,log_path,cwd,claude_session_id) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                name,
                command,
                "pending",
                req.get("estimated_time"),
                req.get("kill_timeout"),
                req.get("observability_interval"),
                req.get("mem_pct_limit"),
                req.get("cpu_pct_limit"),
                req.get("estimated_mem_bytes"),
                req.get("estimated_cpu_cores"),
                now(),
                str(log_path),
                req.get("cwd"),
                req.get("claude_session_id"),
            ),
        )
        # Dispatch immediately if system has capacity (don't wait for tick)
        if not self.shutting_down:
            s = probe_system(self.disk_dir)
            if not (s.mem_pct > self.max_sys_mem_pct
                    or s.disk_pct > self.max_sys_disk_pct):
                self._schedule_pending()
        return {"ok": True, "name": name}

    def _op_list(self, req: dict) -> dict:
        rows = self.db.execute("SELECT * FROM tasks ORDER BY created_at").fetchall()
        return {"ok": True, "tasks": [self._enrich(r) for r in rows]}

    def _op_status(self, req: dict) -> dict:
        r = self.db.execute("SELECT * FROM tasks WHERE name=?", (req["name"],)).fetchone()
        if r is None:
            return {"ok": False, "error": f"no such task: {req['name']!r}"}
        return {"ok": True, "task": self._enrich(r)}

    def _op_kill(self, req: dict) -> dict:
        name = req["name"]
        if name not in self.running:
            return {"ok": False, "error": f"task {name!r} not running"}
        self._kill_task(name, reason="manual")
        return {"ok": True}

    def _op_adjust(self, req: dict) -> dict:
        # Mutate a pending or running task's resource estimate. DB row is
        # updated unconditionally so admission accounting picks up the new
        # numbers on the next capacity check. If the task is running, the
        # in-memory RunningTask is updated and overrun counters are reset
        # so the 2×-sustained kill threshold restarts against the new
        # estimate; the cgroup memory.max set at launch (= min(3× estimate,
        # 40% host RAM)) is NOT re-set on the running scope.
        name = req["name"]
        r = self.db.execute("SELECT * FROM tasks WHERE name=?", (name,)).fetchone()
        if r is None:
            return {"ok": False, "error": f"no such task: {name!r}"}
        if r["status"] in TERMINAL:
            return {"ok": False, "error": f"task {name!r} is in terminal status {r['status']!r}; adjust applies only to pending/running"}
        new_em = req.get("estimated_mem_bytes")
        new_ec = req.get("estimated_cpu_cores")
        if new_em is None and new_ec is None:
            return {"ok": False, "error": "nothing to adjust; pass estimated_mem_bytes and/or estimated_cpu_cores"}
        total_mem = psutil.virtual_memory().total
        n_cores = os.cpu_count() or 1
        if new_em is not None:
            new_em = int(new_em)
            if new_em <= 0:
                return {"ok": False, "error": "estimated_mem_bytes must be > 0"}
            if new_em > total_mem:
                return {"ok": False, "error": f"estimated_mem_bytes {new_em} exceeds host total RAM {total_mem}"}
        if new_ec is not None:
            new_ec = float(new_ec)
            if new_ec <= 0:
                return {"ok": False, "error": "estimated_cpu_cores must be > 0"}
            if new_ec > n_cores:
                return {"ok": False, "error": f"estimated_cpu_cores {new_ec} exceeds host total cores {n_cores}"}
        sets, args = [], []
        if new_em is not None:
            sets.append("estimated_mem_bytes=?")
            args.append(new_em)
        if new_ec is not None:
            sets.append("estimated_cpu_cores=?")
            args.append(new_ec)
        args.append(name)
        self.db.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE name=?", args)
        rt = self.running.get(name)
        if rt is not None:
            if new_em is not None:
                rt.estimated_mem_bytes = new_em
                rt.mem_overrun_count = 0
            if new_ec is not None:
                rt.estimated_cpu_cores = new_ec
                rt.cpu_overrun_count = 0
        self.log(f"[{name}] adjusted estimates: mem={new_em} cpu={new_ec} live={rt is not None}")
        return {
            "ok": True,
            "name": name,
            "estimated_mem_bytes": new_em,
            "estimated_cpu_cores": new_ec,
            "live": rt is not None,
        }

    def _op_shutdown(self, req: dict) -> dict:
        self._begin_shutdown()
        return {"ok": True}

    def _op_ping(self, req: dict) -> dict:
        return {"ok": True, "pid": os.getpid(), "running": len(self.running)}

    def _op_clean(self, req: dict) -> dict:
        ot = req.get("older_than")
        older_than = float(ot) if ot is not None else self.cleanup_ttl
        statuses_req = req.get("statuses") or []
        statuses = tuple(s for s in statuses_req if s in TERMINAL) or tuple(TERMINAL)
        dry_run = bool(req.get("dry_run"))
        cleaned, log_failed = self._clean_terminal(older_than, statuses, dry_run)
        return {
            "ok": True,
            "cleaned": cleaned,
            "log_unlink_failed": log_failed,
            "dry_run": dry_run,
            "older_than": older_than,
            "statuses": list(statuses),
        }

    # ── cleanup of terminal rows + log files ───────────────────────────────
    def _clean_terminal(
        self, older_than: float, statuses: tuple[str, ...], dry_run: bool
    ) -> tuple[list[dict], list[str]]:
        cutoff = now() - older_than
        placeholders = ",".join("?" for _ in statuses)
        rows = self.db.execute(
            f"SELECT name, log_path, status, ended_at FROM tasks "
            f"WHERE status IN ({placeholders}) AND ended_at IS NOT NULL "
            f"AND ended_at < ?",
            (*statuses, cutoff),
        ).fetchall()
        cleaned: list[dict] = []
        log_failed: list[str] = []
        for r in rows:
            entry = {
                "name": r["name"],
                "status": r["status"],
                "ended_at": r["ended_at"],
                "log_path": r["log_path"],
            }
            if not dry_run:
                if r["log_path"]:
                    try:
                        Path(r["log_path"]).unlink()
                    except FileNotFoundError:
                        pass
                    except OSError:
                        log_failed.append(r["log_path"])
                self.db.execute("DELETE FROM tasks WHERE name=?", (r["name"],))
            cleaned.append(entry)
        return cleaned, log_failed

    def _op_wait_for_capacity(self, req: dict) -> dict:
        em = int(req.get("mem_bytes") or 0)
        ec = float(req.get("cpu_cores") or 0)
        deny = self._capacity_check(em, ec)
        if deny is None:
            return {"ok": True, "ready": True}
        return {"ok": True, "ready": False, **deny}

    # ── capacity gate (soft-deny) ──────────────────────────────────────────
    def _capacity_check(self, new_mem_bytes: int, new_cpu_cores: float) -> dict | None:
        """Return None if a task with the given estimates fits under headroom,
        else a structured `capacity_exceeded` dict.

        Memory (counts external use — RAM exhaustion is catastrophic):
          (total_ram - MemAvailable) + sum_of_pending_estimates +
          2 × new_estimate ≤ max_sys_mem_pct × total_ram

        CPU (only babysit's own tasks counted — external processes outside
        babysit's control can't block admission):
          sum_of_running_babysit_cores + sum_of_pending_estimates +
          2 × new_estimate ≤ max_babysit_cpu_pct × total_cores

        Memory is measured as `total - MemAvailable` rather than `vm.used`.
        `vm.used` counts buff/cache as used; on hosts with stale page cache
        (large parquet/dataset reads in prior sessions) it over-rejects
        because the kernel can readily reclaim that cache without thrashing.
        `MemAvailable` already discounts the non-reclaimable shmem / dirty
        portions and reserves min_free_kbytes for the safety margin -- it's
        the right "effective used" metric for admission control.
        """
        vm = psutil.virtual_memory()
        total_mem = vm.total
        cur_mem_used = total_mem - vm.available
        n_cores = float(os.cpu_count() or 1)

        rows = self.db.execute(
            "SELECT estimated_mem_bytes, estimated_cpu_cores "
            "FROM tasks WHERE status='pending'"
        ).fetchall()
        pending_mem = sum((r["estimated_mem_bytes"] or 0) for r in rows)
        pending_cpu = sum((r["estimated_cpu_cores"] or 0.0) for r in rows)
        running_cpu = sum(
            (rt.last_stats.cpu_cores if rt.last_stats else (rt.estimated_cpu_cores or 0.0))
            for rt in self.running.values()
        )

        mem_limit = self.max_sys_mem_pct / 100 * total_mem
        cpu_limit = self.max_babysit_cpu_pct / 100 * n_cores
        mem_projected = cur_mem_used + pending_mem + 2 * new_mem_bytes
        cpu_projected = running_cpu + pending_cpu + 2 * new_cpu_cores

        suggest = (
            f"babysit wait_for_capacity --mem_bytes={new_mem_bytes} "
            f"--cpu_cores={new_cpu_cores}"
        )
        if mem_projected > mem_limit:
            return {
                "error": "capacity_exceeded",
                "dim": "mem",
                "projected_bytes": int(mem_projected),
                "limit_bytes": int(mem_limit),
                "current_sys_used_bytes": int(cur_mem_used),
                "pending_estimates_bytes": int(pending_mem),
                "your_estimate_bytes": int(new_mem_bytes),
                "hint": (
                    f"projected memory {fmt_bytes(int(mem_projected))} "
                    f"exceeds {self.max_sys_mem_pct:.0f}% of system RAM "
                    f"({fmt_bytes(int(mem_limit))}). Wait for capacity, "
                    f"reduce --estimated_mem_bytes, or pass --force."
                ),
                "suggested_command": suggest,
            }
        if cpu_projected > cpu_limit:
            return {
                "error": "capacity_exceeded",
                "dim": "cpu",
                "projected_cores": cpu_projected,
                "limit_cores": cpu_limit,
                "current_babysit_cores": running_cpu,
                "pending_estimates_cores": pending_cpu,
                "your_estimate_cores": new_cpu_cores,
                "hint": (
                    f"projected babysit cpu {cpu_projected:.1f}c exceeds "
                    f"{self.max_babysit_cpu_pct:.0f}% of system cores "
                    f"({cpu_limit:.1f}c). Wait for running babysit tasks "
                    f"to finish, reduce --estimated_cpu_cores, or pass --force."
                ),
                "suggested_command": suggest,
            }
        return None

    # ── enrichment for list/status responses ───────────────────────────────
    def _enrich(self, r: sqlite3.Row) -> dict:
        d = dict(r)
        d["kill_hint"] = kill_hint_for(d.get("kill_reason"))
        raw_detail = d.get("kill_detail")
        if isinstance(raw_detail, str) and raw_detail:
            with contextlib.suppress(ValueError):
                d["kill_detail"] = json.loads(raw_detail)
        rt = self.running.get(d["name"])
        # runtime stats: present for running, None for terminal/pending
        stat_keys = ("cpu_pct", "cpu_cores", "mem_bytes", "mem_pct",
                     "disk_read_bytes", "disk_write_bytes", "num_procs", "num_threads")
        if rt and rt.last_stats:
            s = rt.last_stats
            for k in stat_keys:
                d[k] = getattr(s, k)
        else:
            for k in stat_keys:
                d.setdefault(k, None)
        # elapsed
        if d.get("started_at") and not d.get("ended_at"):
            d["elapsed_time"] = now() - d["started_at"]
        elif d.get("started_at") and d.get("ended_at"):
            d["elapsed_time"] = d["ended_at"] - d["started_at"]
        else:
            d["elapsed_time"] = None
        # observability
        if rt and rt.last_log_mtime:
            d["time_since_last_observe"] = now() - rt.last_log_mtime
            d["last_observed_log"] = time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(rt.last_log_mtime)
            )
        else:
            d.setdefault("last_observed_log", None)
            d.setdefault("time_since_last_observe", None)
        # ensure every spec column key exists
        for k in SPEC_COLUMNS:
            d.setdefault(k, None)
        return d

    # ── monitor tick ────────────────────────────────────────────────────────
    def _tick(self) -> None:
        # 1. reap completed tasks & enforce per-task limits
        for name in list(self.running):
            self._check_task(name)

        # 2. system-level checks (per-dimension counters, spec rule #3.x3)
        sys_stats = probe_system(self.disk_dir)
        dim_violated = {
            "mem": sys_stats.mem_pct > self.max_sys_mem_pct,
            "disk": sys_stats.disk_pct > self.max_sys_disk_pct,
        }
        for dim, v in dim_violated.items():
            self.sys_pressure[dim] = self.sys_pressure[dim] + 1 if v else 0
        for dim in ("disk", "mem"):  # disk > mem priority
            if self.sys_pressure[dim] >= self.monitor_tolerance_count:
                self._enforce_system_dim(dim, sys_stats)
                self.sys_pressure[dim] = 0
                break  # at most one kill per tick; let system recover before next

        # 3. dispatch pending tasks
        if not self.shutting_down and not any(dim_violated.values()):
            self._schedule_pending()

        # 4. auto-cleanup of stale terminal rows + log files (≤ 1× / minute)
        if now() - self._last_cleanup_at >= 60:
            cleaned, log_failed = self._clean_terminal(
                self.cleanup_ttl, tuple(TERMINAL), dry_run=False
            )
            self._last_cleanup_at = now()
            if cleaned:
                self.log(
                    f"cleanup: removed {len(cleaned)} terminal rows older than "
                    f"{fmt_duration(self.cleanup_ttl)}"
                    + (f", {len(log_failed)} log unlink failures" if log_failed else "")
                )

        # 5. heartbeat
        if int(now()) % 60 < self.monitor_interval:
            self.log(
                f"tick: running={len(self.running)} "
                f"sys mem={sys_stats.mem_pct:.0f}% cpu={sys_stats.cpu_pct:.0f}% "
                f"disk={sys_stats.disk_pct:.0f}%"
            )

    def _check_task(self, name: str) -> None:
        rt = self.running[name]
        # liveness check — Popen.poll() if owned, psutil.pid_exists if adopted.
        # On non-zero exit / vanish, probe the cgroup's memory.events BEFORE the
        # scope is stopped (collect=yes removes the cgroup on stop) so we can
        # attribute kernel OOM kills to estimate undershoot rather than losing
        # them in a generic "failed".
        if rt.popen is not None:
            rc = rt.popen.poll()
            if rc is not None:
                if rc != 0 and cgroup_oom_killed(rt.scope_unit):
                    self._finalize(name, status="killed", exit_code=rc,
                                  reason="cgroup_oom_killed")
                    return
                if rc == 137 or rc == -9:
                    self._finalize(name, status="killed", exit_code=rc,
                                  reason="kernel_oom")
                    return
                status = "completed" if rc == 0 else "failed"
                self._finalize(name, status=status, exit_code=rc)
                return
        else:
            if not psutil.pid_exists(rt.pid):
                if cgroup_oom_killed(rt.scope_unit):
                    self._finalize(name, status="killed", exit_code=None,
                                  reason="cgroup_oom_killed")
                    return
                # PID gone — can't waitpid cross-process, so success/failure is unobservable
                self._finalize(name, status="unknown", exit_code=None,
                              reason="adopted_exited")
                return

        result = probe_task(rt.pid, rt.prev_cpu_times)
        if result is None:
            rc = rt.popen.poll() if rt.popen else None
            if cgroup_oom_killed(rt.scope_unit):
                self._finalize(name, status="killed", exit_code=rc,
                              reason="cgroup_oom_killed")
                return
            self._finalize(name, status="failed", exit_code=(rc if rc is not None else -1),
                          reason="process_vanished")
            return
        stats, new_cpu_times = result
        rt.last_stats = stats
        rt.prev_cpu_times = new_cpu_times

        # observability: log mtime (baseline = started_at if log never written)
        mtime = log_last_mtime(rt.log_path)
        if mtime is not None and (rt.last_log_mtime is None or mtime > rt.last_log_mtime):
            rt.last_log_mtime = mtime
            rt.obs_violation_count = 0
        else:
            baseline = rt.last_log_mtime if rt.last_log_mtime is not None else rt.started_at
            silent_for = now() - baseline
            if silent_for > rt.obs_interval:
                rt.obs_violation_count += 1
                self.log(f"[{name}] silent {fmt_duration(silent_for)} (> {fmt_duration(rt.obs_interval)}) — violation {rt.obs_violation_count}")

        # per-task rule enforcement (immediate kill per spec)
        elapsed = now() - rt.started_at

        # Agent-declared estimate enforcement (soft-then-hard).
        # Soft warning at 1× is emitted client-side by `babysit wait`; the daemon
        # only enforces the 2× × monitor_tolerance_count hard kill here. Resets
        # when usage drops back below 2× — the agent gets a chance to recover.
        if rt.estimated_mem_bytes:
            if stats.mem_bytes > 2 * rt.estimated_mem_bytes:
                rt.mem_overrun_count += 1
                if rt.mem_overrun_count >= self.monitor_tolerance_count:
                    self.log(
                        f"[{name}] mem {fmt_bytes(stats.mem_bytes)} > 2× estimate "
                        f"({fmt_bytes(rt.estimated_mem_bytes)}) for {rt.mem_overrun_count} ticks — KILL"
                    )
                    self._kill_task(name, reason="estimated_mem_exceeded")
                    return
            else:
                rt.mem_overrun_count = 0
        if rt.estimated_cpu_cores:
            if stats.cpu_cores > 2 * rt.estimated_cpu_cores:
                rt.cpu_overrun_count += 1
                if rt.cpu_overrun_count >= self.monitor_tolerance_count:
                    self.log(
                        f"[{name}] cpu {stats.cpu_cores:.1f}c > 2× estimate "
                        f"({rt.estimated_cpu_cores:.1f}c) for {rt.cpu_overrun_count} ticks — KILL"
                    )
                    self._kill_task(name, reason="estimated_cpu_exceeded")
                    return
            else:
                rt.cpu_overrun_count = 0

        if stats.mem_pct > rt.mem_pct_limit:
            self.log(f"[{name}] mem {stats.mem_pct:.1f}% > {rt.mem_pct_limit}% — KILL")
            self._kill_task(name, reason="mem_exceeded")
            return
        if stats.cpu_pct > rt.cpu_pct_limit * (os.cpu_count() or 1):
            self.log(f"[{name}] cpu {stats.cpu_pct:.0f}% > {rt.cpu_pct_limit * (os.cpu_count() or 1):.0f}% — KILL")
            self._kill_task(name, reason="cpu_exceeded")
            return
        if elapsed > rt.kill_timeout:
            self.log(f"[{name}] elapsed {fmt_duration(elapsed)} > kill_timeout {fmt_duration(rt.kill_timeout)} — KILL")
            self._kill_task(name, reason="elapsed_exceeded")
            return
        if rt.obs_violation_count >= 1:
            self.log(f"[{name}] observability stall — KILL")
            self._kill_task(name, reason="observability_stall")
            return

    def _enforce_system_dim(self, dim: str, sys_stats: SysStats) -> None:
        if not self.running:
            return
        cur = {"mem": sys_stats.mem_pct, "disk": sys_stats.disk_pct}[dim]

        def abs_use(rt: RunningTask) -> float:
            if rt.last_stats is None:
                return 0.0
            if dim == "disk":
                return rt.last_stats.disk_write_bytes
            return rt.last_stats.mem_bytes

        # ── external-cause shortcut (mem only) ────────────────────────────
        # Babysit can only kill its own managed tasks. If the *sum* of all
        # managed tasks' usage is smaller than the excess over threshold,
        # the pressure is driven by an external (non-babysit) process —
        # killing even every managed task would not bring the system below
        # threshold. In that case the kill is collateral damage: the
        # external process continues unscathed and the user loses their
        # work for nothing. Skip and let the next tolerance-count window
        # re-check; if the external process eventually finishes, pressure
        # clears on its own. (Disk: no external-cause shortcut — every
        # writer shares the same pool and we can't distinguish.)
        if dim == "mem":
            total_managed = sum(abs_use(rt) for rt in self.running.values())
            total_resource = float(psutil.virtual_memory().total)
            limit_pct = self.max_sys_mem_pct
            excess_abs = max(0.0, (cur - limit_pct) / 100.0 * total_resource)
            if excess_abs > 0 and total_managed < excess_abs:
                self.log(
                    f"sys-{dim} pressure ({cur:.0f}%) but all babysit tasks "
                    f"combined cannot relieve the excess — external process "
                    f"is the cause, skipping kill"
                )
                return

        # Fair-ranking tiers (protects sunk progress of well-behaved old tasks):
        #   tier 0: task exceeds its declared estimate for this dim — most likely culprit
        #   tier 1: task declared no estimate — opted out of protection
        #   tier 2: task is within its declared estimate — well-behaved, last to die
        # Within each tier, rank by absolute resource use (descending).
        # Disk has no estimate concept — everyone is tier 1, falls back to write-byte ranking.
        def tier_of(rt: RunningTask) -> int:
            if dim == "disk" or rt.last_stats is None:
                return 1
            est, use = rt.estimated_mem_bytes, rt.last_stats.mem_bytes
            if est is None:
                return 1
            return 0 if use > est else 2

        ranked = sorted(self.running.values(), key=lambda rt: (tier_of(rt), -abs_use(rt)))
        victim = ranked[0]
        tier_label = ("exceeds-estimate", "no-estimate", "within-estimate")[tier_of(victim)]
        self.log(f"sys-{dim} pressure ({cur:.0f}%) sustained — KILL {victim.name} ({tier_label})")
        detail = self._build_sys_kill_detail(dim, cur, sys_stats, victim, tier_label)
        self._kill_task(victim.name, reason=f"system_{dim}_pressure", detail=detail)

    def _build_sys_kill_detail(
        self, dim: str, cur: float, sys_stats: SysStats,
        victim: RunningTask, tier_label: str,
    ) -> dict:
        """Per-incident telemetry for system_<dim>_pressure kills.

        Captures: sustained duration, system metric at kill, threshold, victim's
        own footprint, total babysit-managed footprint, and (mem only) the top
        external process so the agent can see whether external load was the
        actual culprit.
        """
        d: dict[str, object] = {
            "dim": dim,
            "kill_time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
            "system_pct": round(cur, 1),
            "threshold_pct": (self.max_sys_mem_pct if dim == "mem"
                              else self.max_sys_disk_pct),
            "sustained_seconds": round(self.sys_pressure[dim] * self.monitor_interval, 1),
            "victim_name": victim.name,
            "victim_tier": tier_label,
        }
        vs = victim.last_stats
        if dim == "mem":
            total_ram = float(psutil.virtual_memory().total)
            babysit_total = sum(
                (rt.last_stats.mem_bytes if rt.last_stats else 0)
                for rt in self.running.values()
            )
            d["victim_mem_bytes"] = int(vs.mem_bytes) if vs else None
            d["victim_mem_pct"] = round(vs.mem_pct, 1) if vs else None
            d["babysit_total_mem_bytes"] = int(babysit_total)
            d["babysit_total_mem_pct"] = round(babysit_total / total_ram * 100.0, 1)
            d["top_external"] = self._top_external_mem_proc()
        elif dim == "disk":
            du = shutil.disk_usage(self.disk_dir)
            d["disk_dir"] = self.disk_dir
            d["disk_used_bytes"] = int(du.used)
            d["disk_total_bytes"] = int(du.total)
            d["victim_disk_write_bytes"] = int(vs.disk_write_bytes) if vs else None
        return d

    def _top_external_mem_proc(self) -> dict | None:
        """Highest-RSS process whose PID-tree is NOT under any babysit-managed PID."""
        managed_tree: set[int] = set()
        for rt in self.running.values():
            with contextlib.suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                p = psutil.Process(rt.pid)
                managed_tree.add(p.pid)
                for child in p.children(recursive=True):
                    managed_tree.add(child.pid)
        total_ram = float(psutil.virtual_memory().total)
        best: dict | None = None
        for p in psutil.process_iter(["pid", "name", "memory_info"]):
            info = p.info
            if info["pid"] in managed_tree or info["memory_info"] is None:
                continue
            rss = int(info["memory_info"].rss)
            if best is None or rss > best["mem_bytes"]:
                best = {
                    "pid": int(info["pid"]),
                    "name": info["name"] or "",
                    "mem_bytes": rss,
                    "mem_pct": round(rss / total_ram * 100.0, 1),
                }
        return best

    def _schedule_pending(self) -> None:
        rows = self.db.execute(
            "SELECT * FROM tasks WHERE status='pending' ORDER BY created_at"
        ).fetchall()
        for r in rows:
            if self.shutting_down:
                return
            self._start_task(r)

    def _start_task(self, r: sqlite3.Row) -> None:
        name = r["name"]
        mem_lim = r["mem_pct_limit"] or DEFAULTS["mem_pct_limit"]
        cpu_lim = r["cpu_pct_limit"] or DEFAULTS["cpu_pct_limit"]
        log_path = Path(r["log_path"])
        try:
            proc, scope_unit = spawn_under_scope(
                name=name,
                command=r["command"],
                mem_pct_limit=mem_lim,
                cpu_pct_limit=cpu_lim,
                log_path=log_path,
                estimated_mem_bytes=r["estimated_mem_bytes"],
                estimated_cpu_cores=r["estimated_cpu_cores"],
                cwd=r["cwd"],
            )
        except Exception as e:  # noqa: BLE001
            self.log(f"[{name}] spawn failed: {e}")
            self.db.execute(
                "UPDATE tasks SET status='failed', kill_reason=?, ended_at=? WHERE name=?",
                (f"spawn_error: {e}", now(), name),
            )
            return
        started = now()
        rt = RunningTask(
            name=name,
            popen=proc,
            pid=proc.pid,
            scope_unit=scope_unit,
            log_path=log_path,
            obs_interval=r["observability_interval"] or parse_duration(DEFAULTS["observability_interval"]),
            kill_timeout=r["kill_timeout"] or parse_duration(DEFAULTS["kill_timeout"]),
            mem_pct_limit=mem_lim,
            cpu_pct_limit=cpu_lim,
            started_at=started,
            estimated_mem_bytes=r["estimated_mem_bytes"],
            estimated_cpu_cores=r["estimated_cpu_cores"],
        )
        # prime cpu_times baseline for accurate per-PID delta on first tick
        with contextlib.suppress(psutil.NoSuchProcess, psutil.AccessDenied):
            p = psutil.Process(proc.pid)
            ct = p.cpu_times()
            rt.prev_cpu_times = {proc.pid: (ct.user + ct.system, time.time())}
        self.running[name] = rt
        self.db.execute(
            "UPDATE tasks SET status='running', pid=?, scope_unit=?, started_at=? WHERE name=?",
            (proc.pid, scope_unit, started, name),
        )
        self.log(f"[{name}] started pid={proc.pid} scope={scope_unit}")

    def _kill_task(self, name: str, *, reason: str, detail: dict | None = None) -> None:
        rt = self.running.get(name)
        if rt is None:
            return
        # SIGTERM, grace, then SIGKILL via scope stop. Two code paths:
        # owned (have Popen → can wait()) vs adopted (psutil + polling).
        if rt.popen is not None:
            with contextlib.suppress(ProcessLookupError):
                rt.popen.terminate()
            try:
                rt.popen.wait(timeout=10)
            except subprocess.TimeoutExpired:
                stop_scope(rt.scope_unit)
                with contextlib.suppress(ProcessLookupError):
                    rt.popen.kill()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    rt.popen.wait(timeout=5)
            rc = rt.popen.returncode if rt.popen.returncode is not None else -signal.SIGKILL
        else:
            with contextlib.suppress(psutil.NoSuchProcess):
                psutil.Process(rt.pid).terminate()
            deadline = time.time() + 10
            while time.time() < deadline and psutil.pid_exists(rt.pid):
                time.sleep(0.1)
            if psutil.pid_exists(rt.pid):
                if rt.scope_unit:
                    stop_scope(rt.scope_unit)
                with contextlib.suppress(psutil.NoSuchProcess):
                    psutil.Process(rt.pid).kill()
                deadline = time.time() + 5
                while time.time() < deadline and psutil.pid_exists(rt.pid):
                    time.sleep(0.1)
            rc = None  # adopted — can't waitpid cross-process
        self._finalize(name, status="killed", exit_code=rc, reason=reason, detail=detail)

    def _finalize(self, name: str, *, status: str, exit_code: int, reason: str | None = None,
                  detail: dict | None = None) -> None:
        rt = self.running.pop(name, None)
        if rt is not None:
            stop_scope(rt.scope_unit)
        self.db.execute(
            "UPDATE tasks SET status=?, exit_code=?, ended_at=?, kill_reason=?, kill_detail=? "
            "WHERE name=?",
            (status, exit_code, now(), reason,
             json.dumps(detail) if detail else None, name),
        )
        self.log(f"[{name}] {status} exit={exit_code} reason={reason or '-'}")


# ──────────────────────────────────────────────────────────────────────────────
# Daemon entry — double-fork detach
# ──────────────────────────────────────────────────────────────────────────────


def daemonize() -> None:
    """Standard double-fork. Parent returns immediately; grandchild continues."""
    if os.fork() != 0:
        os._exit(0)
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    os.chdir("/")
    os.umask(0o077)
    sys.stdout.flush()
    sys.stderr.flush()
    DAEMON_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    null = open("/dev/null", "rb")
    out = open(DAEMON_LOG_PATH, "ab", buffering=0)
    os.dup2(null.fileno(), 0)
    os.dup2(out.fileno(), 1)
    os.dup2(out.fileno(), 2)
    null.close()
    out.close()


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    pretty_exceptions_enable=False,
    help="Supervised background task runner with cgroup-enforced caps.",
)


def _project(row: dict, columns: list[str]) -> dict:
    return {c: row.get(c) for c in columns}


def _print(out: Any, fmt: str, columns: list[str] | None = None) -> None:
    if columns:
        if isinstance(out, list):
            out = [_project(r, columns) for r in out]
        elif isinstance(out, dict):
            out = _project(out, columns)
    if fmt == "json":
        typer.echo(json.dumps(out, indent=2, default=str))
        return
    if isinstance(out, list):
        if not out:
            typer.echo("(no tasks)")
            return
        cols = columns or list(out[0].keys())
        tbl = Table(show_header=True, header_style="bold")
        for c in cols:
            tbl.add_column(c)
        for r in out:
            tbl.add_row(*[_fmt_cell(c, r.get(c)) for c in cols])
        console.print(tbl)
    elif isinstance(out, dict):
        cols = columns or list(out.keys())
        for k in cols:
            console.print(f"[bold]{k}[/]: {_fmt_cell(k, out.get(k))}")
    else:
        typer.echo(str(out))


def _fmt_cell(col: str, v: Any) -> str:
    if v is None:
        return "-"
    if col.endswith("_bytes"):
        return fmt_bytes(int(v))
    if col in ("elapsed_time", "estimated_time", "kill_timeout",
               "observability_interval", "time_since_last_observe"):
        return fmt_duration(float(v))
    if col in ("cpu_pct", "mem_pct"):
        return f"{float(v):.1f}"
    if col in ("cpu_cores", "estimated_cpu_cores"):
        return f"{float(v):.2f}"
    return str(v)


@app.command("daemon-start")
def cmd_daemon_start(
    max_sys_mem_pct: float = typer.Option(DEFAULTS["max_sys_mem_pct"], "--max_sys_mem_pct"),
    max_sys_disk_pct: float = typer.Option(DEFAULTS["max_sys_disk_pct"], "--max_sys_disk_pct"),
    max_babysit_cpu_pct: float = typer.Option(DEFAULTS["max_babysit_cpu_pct"], "--max_babysit_cpu_pct"),
    monitor_interval: str = typer.Option(DEFAULTS["monitor_interval"], "--monitor_interval"),
    monitor_tolerance_count: int = typer.Option(DEFAULTS["monitor_tolerance_count"], "--monitor_tolerance_count"),
    monitor_disk_infer_by_dir: str = typer.Option(DEFAULTS["monitor_disk_infer_by_dir"], "--monitor_disk_infer_by_dir"),
    cleanup_ttl: str = typer.Option(DEFAULTS["cleanup_ttl"], "--cleanup_ttl", help="Terminal-task rows + their log files are auto-deleted after this age. Default 7d."),
    foreground: bool = typer.Option(False, "--foreground", "-f", help="Run in foreground (no detach)."),
) -> None:
    """Start the babysit daemon (idempotent — exits 0 if already running)."""
    if daemon_alive():
        typer.echo(f"daemon already running (pid={DAEMON_PID_PATH.read_text().strip()})")
        return
    for k, v in (
        ("max_sys_mem_pct", max_sys_mem_pct),
        ("max_sys_disk_pct", max_sys_disk_pct),
    ):
        if not (0 < v <= 100):
            typer.echo(f"error: {k} {v} must be in (0, 100]", err=True)
            raise typer.Exit(1)
    if max_babysit_cpu_pct <= 0:
        typer.echo(f"error: max_babysit_cpu_pct {max_babysit_cpu_pct} must be > 0", err=True)
        raise typer.Exit(1)
    if monitor_tolerance_count <= 0:
        typer.echo(f"error: monitor_tolerance_count {monitor_tolerance_count} must be > 0", err=True)
        raise typer.Exit(1)
    if parse_duration(monitor_interval) <= 0:
        typer.echo(f"error: monitor_interval {monitor_interval!r} must be > 0", err=True)
        raise typer.Exit(1)
    if parse_duration(cleanup_ttl) <= 0:
        typer.echo(f"error: cleanup_ttl {cleanup_ttl!r} must be > 0", err=True)
        raise typer.Exit(1)

    STATE_DIR.mkdir(parents=True, exist_ok=True)

    if not foreground:
        daemonize()

    DAEMON_PID_PATH.write_text(str(os.getpid()))
    try:
        d = Daemon(
            max_sys_mem_pct=max_sys_mem_pct,
            max_sys_disk_pct=max_sys_disk_pct,
            max_babysit_cpu_pct=max_babysit_cpu_pct,
            monitor_interval=parse_duration(monitor_interval),
            monitor_tolerance_count=monitor_tolerance_count,
            monitor_disk_infer_by_dir=monitor_disk_infer_by_dir,
            cleanup_ttl=parse_duration(cleanup_ttl),
        )
        d.run_forever()
    finally:
        with contextlib.suppress(FileNotFoundError):
            DAEMON_PID_PATH.unlink()
        with contextlib.suppress(FileNotFoundError):
            SOCK_PATH.unlink()


@app.command("daemon-stop")
def cmd_daemon_stop(
    force: bool = typer.Option(
        False, "--force",
        help="Stop even if tasks are running (will mark each as killed with kill_reason=daemon_shutdown). Without --force, daemon-stop refuses while any task is running/pending — kill them first.",
    ),
) -> None:
    """Stop the daemon. Refuses if any task is running/pending unless --force."""
    if not daemon_alive():
        typer.echo("daemon not running")
        return
    if not force:
        try:
            resp = rpc_call("list")
            active = [t for t in resp.get("tasks", []) if t["status"] in ("running", "pending")]
        except Exception as e:  # noqa: BLE001
            typer.echo(f"error: cannot query running tasks before stop: {e}", err=True)
            raise typer.Exit(1)
        if active:
            names = ", ".join(t["name"] for t in active)
            typer.echo(
                f"error: daemon-stop refused — {len(active)} task(s) running/pending: {names}. "
                "Use `babysit kill --name=<name>` per task first, or pass --force to kill them all.",
                err=True,
            )
            raise typer.Exit(1)
    try:
        rpc_call("shutdown")
    except Exception:
        pid = int(DAEMON_PID_PATH.read_text().strip())
        os.kill(pid, signal.SIGTERM)
    # wait up to 30s
    for _ in range(60):
        if not daemon_alive():
            typer.echo("daemon stopped")
            return
        time.sleep(0.5)
    typer.echo("daemon did not exit cleanly", err=True)
    raise typer.Exit(1)


@app.command("run")
def cmd_run(
    name: str = typer.Option(..., help="Unique task name."),
    command: str = typer.Option(..., help="Shell command to run."),
    estimated_time: str = typer.Option(DEFAULTS["estimated_time"], "--estimated_time"),
    kill_timeout: str | None = typer.Option(None, "--kill_timeout", help="Default = 2 × estimated_time."),
    observability_interval: str = typer.Option(DEFAULTS["observability_interval"], "--observability_interval"),
    mem_pct_limit: float = typer.Option(DEFAULTS["mem_pct_limit"], "--mem_pct_limit"),
    cpu_pct_limit: float = typer.Option(DEFAULTS["cpu_pct_limit"], "--cpu_pct_limit"),
    estimated_mem_bytes: str = typer.Option(
        DEFAULTS["estimated_mem_bytes"],
        "--estimated_mem_bytes",
        help="Predicted peak memory (e.g. '4G', '512M'). Soft warn at 1×, hard kill if >2× sustained for monitor tolerance window. Under system memory pressure, estimate-exceeders are killed before within-estimate tasks; if the pressure is caused by an external (non-babysit) process and managed tasks combined cannot relieve the excess, the kill is skipped.",
    ),
    estimated_cpu_cores: float = typer.Option(
        DEFAULTS["estimated_cpu_cores"],
        "--estimated_cpu_cores",
        help="Predicted peak CPU cores. Soft warn at 1×, hard kill if >2× sustained.",
    ),
    force: bool = typer.Option(
        False, "--force",
        help="Skip the capacity soft-deny gate. Use only when you've verified the system can absorb the load (e.g. you're replacing a just-killed task).",
    ),
    cwd: str | None = typer.Option(
        None, "--cwd",
        help="Existing absolute directory to run the task in (default: current shell cwd).",
    ),
) -> None:
    """Enqueue a task. Returns immediately (non-blocking).

    On capacity soft-deny: exits 2 with a `{"error":"capacity_exceeded", ...}`
    JSON line on stderr (carrying `dim`, `projected_*`, `limit_*`, `hint`,
    `suggested_command`). Run the suggested `babysit wait_for_capacity` or
    re-run with `--force` / smaller estimates.
    """
    est = parse_duration(estimated_time)
    kt = parse_duration(kill_timeout) if kill_timeout else est * 2
    obs = parse_duration(observability_interval)
    em = parse_bytes(estimated_mem_bytes)
    try:
        resp = rpc_call(
            "run",
            name=name,
            command=command,
            estimated_time=est,
            kill_timeout=kt,
            observability_interval=obs,
            mem_pct_limit=mem_pct_limit,
            cpu_pct_limit=cpu_pct_limit,
            estimated_mem_bytes=em,
            estimated_cpu_cores=estimated_cpu_cores,
            force=force,
            cwd=cwd or os.getcwd(),
            claude_session_id=os.environ.get("CLAUDE_CODE_SESSION_ID"),
        )
    except RPCError as e:
        if e.payload.get("error") == "capacity_exceeded":
            print(json.dumps(e.payload), file=sys.stderr, flush=True)
            raise typer.Exit(2)
        raise
    name = resp['name']
    typer.echo(f"queued: {name}  (babysit wait --name={shlex.quote(name)} to monitor)")


_DEFAULT_COLS = ",".join(SPEC_COLUMNS)


def _split_cols(s: str) -> list[str]:
    return [c.strip() for c in s.split(",") if c.strip()]


@app.command("list")
def cmd_list(
    columns: str = typer.Option(_DEFAULT_COLS, "--columns", help="Comma-separated columns."),
    format: str = typer.Option("json", "--format", help="json|table"),
    since: str = typer.Option("24h", "--since", help="Hide terminal tasks ended longer ago than this. Running/pending tasks are always shown."),
    show_all: bool = typer.Option(False, "--all", help="Show every task in the DB (overrides --since)."),
) -> None:
    """List tasks. By default shows running/pending plus terminal tasks whose
    `ended_at` is within --since (default 24h). Use --all for full history.
    """
    resp = rpc_call("list")
    tasks = resp["tasks"]
    if not show_all:
        cutoff = now() - parse_duration(since)
        tasks = [
            t for t in tasks
            if t["status"] not in TERMINAL
            or (t.get("ended_at") is not None and t["ended_at"] >= cutoff)
        ]
    _print(tasks, format, columns=_split_cols(columns))


@app.command("status")
def cmd_status(
    name: str = typer.Option(..., help="Task name."),
    columns: str = typer.Option(_DEFAULT_COLS, "--columns"),
    format: str = typer.Option("json", "--format"),
) -> None:
    """Show one task's status."""
    resp = rpc_call("status", name=name)
    _print(resp["task"], format, columns=_split_cols(columns))


@app.command("wait")
def cmd_wait(
    name: str = typer.Option(..., help="Task name."),
    poll_interval: float = typer.Option(0.5, "--poll_interval", help="Poll interval seconds."),
    columns: str = typer.Option(_DEFAULT_COLS, "--columns"),
    format: str = typer.Option("json", "--format"),
) -> None:
    """Block until a task reaches a terminal status.

    stdout: single terminal-status JSON object (unchanged contract).
    stderr: zero-or-more mid-flight event JSON lines —
        `{"event":"runaway_risk","dim":"elapsed|mem|cpu", ...}` emitted at most
        once per dim the first time the actual exceeds its declared estimate
        (`elapsed_time` vs `estimated_time`, `mem_bytes` vs `estimated_mem_bytes`,
        `cpu_cores` vs `estimated_cpu_cores`). Pair with Monitor / Bash
        run_in_background=true — the harness merges both streams and surfaces
        each new line as a notification.
    """
    alerted = {"elapsed": False, "mem": False, "cpu": False}
    # Last-seen estimates: if `babysit adjust` raises an estimate while wait
    # is in-flight, reset the matching dim's alert latch so a fresh warning
    # can fire against the new threshold (and a lowered estimate doesn't
    # re-warn for already-counted overruns).
    last_estimates: dict[str, float | int | None] = {
        "elapsed": None, "mem": None, "cpu": None,
    }
    while True:
        resp = rpc_call("status", name=name)
        t = resp["task"]
        if t["status"] in TERMINAL:
            _print(t, format, columns=_split_cols(columns))
            raise typer.Exit(0 if t["status"] == "completed" else 1)
        for dim, key in (("elapsed", "estimated_time"),
                         ("mem", "estimated_mem_bytes"),
                         ("cpu", "estimated_cpu_cores")):
            cur = t.get(key)
            if last_estimates[dim] is not None and cur != last_estimates[dim]:
                alerted[dim] = False
            last_estimates[dim] = cur
        if not alerted["elapsed"]:
            elapsed = t.get("elapsed_time")
            estimated = t.get("estimated_time")
            if elapsed is not None and estimated and elapsed > estimated:
                print(json.dumps({
                    "event": "runaway_risk",
                    "dim": "elapsed",
                    "name": name,
                    "elapsed_time": elapsed,
                    "estimated_time": estimated,
                    "kill_timeout": t.get("kill_timeout"),
                    "hint": "elapsed exceeded estimated_time; inspect `babysit log --tail` or kill if stuck",
                }), file=sys.stderr, flush=True)
                alerted["elapsed"] = True
        if not alerted["mem"]:
            mb, em = t.get("mem_bytes"), t.get("estimated_mem_bytes")
            if mb is not None and em and mb > em:
                print(json.dumps({
                    "event": "runaway_risk",
                    "dim": "mem",
                    "name": name,
                    "mem_bytes": mb,
                    "estimated_mem_bytes": em,
                    "hint": "current memory exceeded estimated_mem_bytes; daemon will kill at 2× for monitor_tolerance_count ticks. Re-check footprint or raise --estimated_mem_bytes",
                }), file=sys.stderr, flush=True)
                alerted["mem"] = True
        if not alerted["cpu"]:
            cc, ec = t.get("cpu_cores"), t.get("estimated_cpu_cores")
            if cc is not None and ec and cc > ec:
                print(json.dumps({
                    "event": "runaway_risk",
                    "dim": "cpu",
                    "name": name,
                    "cpu_cores": cc,
                    "estimated_cpu_cores": ec,
                    "hint": "current cpu exceeded estimated_cpu_cores; daemon will kill at 2× for monitor_tolerance_count ticks. Reduce parallelism or raise --estimated_cpu_cores",
                }), file=sys.stderr, flush=True)
                alerted["cpu"] = True
        time.sleep(poll_interval)


@app.command("wait_for_capacity")
def cmd_wait_for_capacity(
    mem_bytes: str = typer.Option(
        DEFAULTS["estimated_mem_bytes"], "--mem_bytes",
        help="Estimated peak memory the task you intend to queue will use (same semantics as `babysit run --estimated_mem_bytes`).",
    ),
    cpu_cores: float = typer.Option(
        DEFAULTS["estimated_cpu_cores"], "--cpu_cores",
        help="Estimated peak CPU cores (same semantics as `babysit run --estimated_cpu_cores`).",
    ),
    poll_interval: float = typer.Option(
        5.0, "--poll_interval", help="Seconds between capacity checks."
    ),
    debounce_min: str = typer.Option(
        "1m", "--debounce_min",
        help="Minimum sustained-cool window required before exit.",
    ),
    debounce_max: str = typer.Option(
        "3m", "--debounce_max",
        help="Maximum sustained-cool window. The actual debounce per ready streak is picked uniformly at random in [min, max] — desynchronizes concurrent waiters to avoid the philosopher's-chopstick where multiple agents all race to `babysit run` the moment capacity opens.",
    ),
) -> None:
    """Block until the daemon has sustained room for a task with the given
    estimates. Exits 0 on success.

    Per poll the daemon checks two gates: memory (counts external use —
    RAM exhaustion is catastrophic) and CPU (only counts babysit's own
    tasks — external CPU doesn't block admission). To pass, both gates
    must stay open for a *sustained* random window in [--debounce_min,
    --debounce_max] (default 1–3 min). Any pressure tick during the
    window resets the debounce. The random window breaks symmetry
    between concurrent waiters.

    Emits `{"event":"waiting_for_capacity","phase":"pressured|debounce", ...}`
    JSON lines on stderr each poll — pair with Monitor / Bash
    run_in_background=true to subscribe.
    """
    em = parse_bytes(mem_bytes)
    dmin = parse_duration(debounce_min)
    dmax = parse_duration(debounce_max)
    if dmax < dmin:
        raise typer.BadParameter("--debounce_max must be >= --debounce_min")
    debounce_start: float | None = None
    debounce_target: float | None = None
    while True:
        resp = rpc_call("wait_for_capacity", mem_bytes=em, cpu_cores=cpu_cores)
        ready = resp.get("ready")
        if ready:
            now_t = time.time()
            if debounce_start is None:
                debounce_start = now_t
                debounce_target = random.uniform(dmin, dmax)
            elapsed = now_t - debounce_start
            if elapsed >= (debounce_target or 0):
                return
            event = {
                "event": "waiting_for_capacity",
                "phase": "debounce",
                "elapsed_debounce_s": round(elapsed, 1),
                "target_debounce_s": round(debounce_target or 0, 1),
            }
        else:
            debounce_start = None
            debounce_target = None
            event = {k: v for k, v in resp.items() if k not in ("ok", "ready")}
            event["event"] = "waiting_for_capacity"
            event["phase"] = "pressured"
        print(json.dumps(event), file=sys.stderr, flush=True)
        time.sleep(poll_interval)


@app.command("kill")
def cmd_kill(
    name: str = typer.Option(..., help="Task name."),
) -> None:
    """Kill a running task."""
    rpc_call("kill", name=name)
    typer.echo(f"killed: {name}")


@app.command("adjust")
def cmd_adjust(
    name: str = typer.Option(..., help="Task name."),
    estimated_mem_bytes: str | None = typer.Option(
        None, "--estimated_mem_bytes",
        help="New peak-memory estimate (e.g. 32G). Accepted suffixes: B/K/M/G/T.",
    ),
    estimated_cpu_cores: float | None = typer.Option(
        None, "--estimated_cpu_cores",
        help="New peak-CPU estimate (cores).",
    ),
) -> None:
    """Adjust a pending or running task's resource estimate.

    Updates the DB so the next admission check (`run` / `wait_for_capacity`)
    sees the new numbers. If the task is running, the in-memory estimate is
    swapped in and the 2×-sustained overrun counter is reset so the kill
    threshold restarts against the new estimate. The cgroup memory.max set
    at launch (= min(3× estimate, 40% host RAM)) is NOT re-set on the live
    scope — re-queue if you need a tighter hard cap.
    """
    if estimated_mem_bytes is None and estimated_cpu_cores is None:
        raise typer.BadParameter(
            "pass --estimated_mem_bytes and/or --estimated_cpu_cores"
        )
    kwargs: dict = {"name": name}
    if estimated_mem_bytes is not None:
        kwargs["estimated_mem_bytes"] = parse_bytes(estimated_mem_bytes)
    if estimated_cpu_cores is not None:
        kwargs["estimated_cpu_cores"] = estimated_cpu_cores
    resp = rpc_call("adjust", **kwargs)
    typer.echo(json.dumps({k: v for k, v in resp.items() if k != "ok"}))


@app.command("log")
def cmd_log(
    name: str = typer.Option(..., help="Task name."),
    tail: int | None = typer.Option(None, help="Last N lines."),
    head: int | None = typer.Option(None, help="First N lines."),
    full: bool = typer.Option(False, help="Print whole log to stdout."),
    follow: bool = typer.Option(False, "--follow", "-F", help="Stream new lines (tail -F)."),
) -> None:
    """Show task log."""
    resp = rpc_call("status", name=name)
    log_path = Path(resp["task"]["log_path"])
    if not log_path.exists():
        typer.echo(f"(no log file at {log_path})", err=True)
        raise typer.Exit(1)
    if follow:
        os.execvp("tail", ["tail", "-n", "+1", "-F", str(log_path)])
    if full:
        with open(log_path, "rb") as f:
            shutil.copyfileobj(f, sys.stdout.buffer)
        return
    if head is not None:
        with open(log_path, "rb") as f:
            for i, line in enumerate(f):
                if i >= head:
                    break
                sys.stdout.buffer.write(line)
        return
    if tail is None:
        tail = 15
    out = tail_n(log_path, tail)
    sys.stdout.write(out)
    if not out.endswith("\n"):
        sys.stdout.write("\n")


@app.command("clean")
def cmd_clean(
    older_than: str = typer.Option(
        "24h", "--older_than",
        help="Only purge terminal-status rows older than this. Default 24h. Pass `0s` to purge all terminals.",
    ),
    status: str = typer.Option(
        ",".join(sorted(TERMINAL)), "--status",
        help="Comma-separated terminal statuses to purge (subset of completed/failed/killed/unknown).",
    ),
    dry_run: bool = typer.Option(False, "--dry_run", help="Show what would be purged, don't delete."),
    format: str = typer.Option("json", "--format", help="json|table"),
) -> None:
    """Purge stale terminal-status tasks and their log files.

    The daemon also auto-purges terminal rows past `--cleanup_ttl` (default 7d)
    on its tick loop. Use this verb for explicit immediate cleanup.
    """
    statuses = [s.strip() for s in status.split(",") if s.strip()]
    invalid = [s for s in statuses if s not in TERMINAL]
    if invalid:
        raise typer.BadParameter(
            f"non-terminal status(es): {invalid}. Allowed: {sorted(TERMINAL)}"
        )
    resp = rpc_call(
        "clean",
        older_than=parse_duration(older_than),
        statuses=statuses,
        dry_run=dry_run,
    )
    out = {
        "dry_run": resp["dry_run"],
        "count": len(resp["cleaned"]),
        "log_unlink_failed": resp["log_unlink_failed"],
        "cleaned": resp["cleaned"],
    }
    _print(out, format)


@app.command("ping")
def cmd_ping() -> None:
    """Check daemon liveness."""
    resp = rpc_call("ping")
    typer.echo(json.dumps({k: v for k, v in resp.items() if k != "ok"}))


# ──────────────────────────────────────────────────────────────────────────────
# Human-facing TUI dashboard (textual)
# ──────────────────────────────────────────────────────────────────────────────


@app.command("tui")
def cmd_tui(
    refresh: str = typer.Option("1s", help="Refresh interval (e.g. 1s, 5s)."),
) -> None:
    """Interactive dashboard for humans. Other subcommands are for agents.

    Keys: ↑/↓ navigate · Enter open log · k kill · s sort · f filter · r refresh · q quit
    Sorts cycle: started → cpu → mem → elapsed → silent → name. Running tasks float to top.
    """
    if not daemon_alive():
        typer.echo("babysit daemon not running. Start with: babysit daemon-start", err=True)
        raise typer.Exit(1)

    # Lazy import — textual is heavy and only this command needs it.
    from textual.app import App, ComposeResult
    from textual.binding import Binding
    from textual.containers import Vertical
    from textual.screen import ModalScreen, Screen
    from textual.widgets import DataTable, Footer, Label, RichLog, Static

    SORT_KEYS: list[tuple[str, Any]] = [
        ("started", lambda r: -(r.get("started_at") or r.get("created_at") or 0)),
        ("cpu", lambda r: -(r.get("cpu_cores") or 0)),
        ("mem", lambda r: -(r.get("mem_bytes") or 0)),
        ("elapsed", lambda r: -(r.get("elapsed_time") or 0)),
        ("silent", lambda r: -(r.get("time_since_last_observe") or 0)),
        ("name", lambda r: r.get("name") or ""),
    ]
    FILTERS: list[tuple[str, Any]] = [
        ("recent (24h)", lambda r: (
            r["status"] not in TERMINAL
            or (r.get("ended_at") is not None and r["ended_at"] >= now() - 86400)
        )),
        ("running", lambda r: r["status"] == "running"),
        ("all", lambda r: True),
        ("terminal", lambda r: r["status"] in TERMINAL),
    ]
    STATUS_COLOR = {
        "running": "green",
        "pending": "yellow",
        "completed": "blue",
        "killed": "red",
        "failed": "red",
        "unknown": "magenta",
    }

    def progress_bar(elapsed, estimated, kill_timeout) -> str:
        if not elapsed:
            return "-"
        if not estimated:
            return fmt_duration(elapsed)
        ratio = elapsed / estimated
        width = 10
        filled = min(width, int(ratio * width))
        bar = "█" * filled + "░" * (width - filled)
        if ratio <= 1.0:
            color = "green"
        elif kill_timeout and elapsed >= kill_timeout * 0.9:
            color = "red"
        else:
            color = "yellow"
        return f"[{color}]{bar}[/] {fmt_duration(elapsed)}/{fmt_duration(estimated)}"

    def last_log_line(log_path: Path) -> str:
        try:
            size = log_path.stat().st_size
            if size == 0:
                return ""
            with open(log_path, "rb") as f:
                f.seek(max(0, size - 4096))
                data = f.read()
            for line in reversed(data.decode("utf-8", "replace").splitlines()):
                if line.strip():
                    return line[:200]
        except (FileNotFoundError, OSError):
            pass
        return ""

    class KillConfirm(ModalScreen[bool]):
        DEFAULT_CSS = """
        KillConfirm { align: center middle; }
        KillConfirm > Vertical {
            background: $surface;
            border: heavy $error;
            padding: 1 2;
            width: 60;
            height: auto;
        }
        """

        def __init__(self, task_name: str) -> None:
            super().__init__()
            self._task_name = task_name

        def compose(self) -> ComposeResult:
            yield Vertical(
                Label(f"Kill task [b]{self._task_name}[/]?"),
                Label(""),
                Label("[bold]y[/] = yes    [bold]n[/] / Esc = cancel"),
            )

        def on_key(self, event) -> None:
            if event.key == "y":
                self.dismiss(True)
            elif event.key in ("n", "escape"):
                self.dismiss(False)

    class LogScreen(Screen):
        BINDINGS = [Binding("escape,q", "app.pop_screen", "back")]

        def __init__(self, task_name: str, log_path: Path) -> None:
            super().__init__()
            self._task_name = task_name
            self._log_path = log_path
            self._pos = 0

        def compose(self) -> ComposeResult:
            yield Label(f" log: [b]{self._task_name}[/] — {self._log_path}    (Esc to close)")
            self._viewer = RichLog(highlight=False, markup=False, wrap=False, auto_scroll=True)
            yield self._viewer
            yield Footer()

        def on_mount(self) -> None:
            self._load_tail()
            self.set_interval(0.5, self._tail_new)

        def _load_tail(self) -> None:
            try:
                with open(self._log_path, "rb") as f:
                    f.seek(0, os.SEEK_END)
                    size = f.tell()
                    start = max(0, size - 64 * 1024)
                    f.seek(start)
                    data = f.read()
                self._pos = size
                for line in data.decode("utf-8", "replace").splitlines():
                    self._viewer.write(line)
            except FileNotFoundError:
                self._viewer.write("(no log file)")

        def _tail_new(self) -> None:
            try:
                with open(self._log_path, "rb") as f:
                    f.seek(self._pos)
                    data = f.read()
                    self._pos = f.tell()
                if data:
                    for line in data.decode("utf-8", "replace").splitlines():
                        self._viewer.write(line)
            except FileNotFoundError:
                pass

    class BabysitTUI(App):
        CSS = """
        Screen { layout: vertical; }
        #header { dock: top; height: 1; padding: 0 1; background: $boost; }
        DataTable { height: 1fr; }
        #log-pane {
            height: 12;
            border-top: solid $accent;
            padding: 0 1;
        }
        """
        BINDINGS = [
            Binding("q", "quit", "quit"),
            Binding("k", "kill_task", "kill"),
            Binding("enter", "open_log", "log"),
            Binding("s", "cycle_sort", "sort"),
            Binding("f", "cycle_filter", "filter"),
            Binding("r", "refresh_now", "refresh"),
        ]

        def __init__(self, refresh_secs: float) -> None:
            super().__init__()
            self._refresh_secs = refresh_secs
            self._sort_idx = 0
            self._filter_idx = 0
            self._displayed: list[dict] = []

        def compose(self) -> ComposeResult:
            yield Label(self._header_text(), id="header")
            self._table = DataTable(cursor_type="row", zebra_stripes=True)
            self._table.add_columns(
                "NAME", "PROJECT", "STATUS", "ELAPSED / ETA", "CPU", "MEM", "SILENT", "LAST LINE"
            )
            yield self._table
            self._log_pane = Static("", id="log-pane", markup=True)
            yield self._log_pane
            yield Footer()

        def on_mount(self) -> None:
            self._tick()
            self.set_interval(self._refresh_secs, self._tick)

        def _header_text(self) -> str:
            sort_name = SORT_KEYS[self._sort_idx][0]
            filter_name = FILTERS[self._filter_idx][0]
            return (
                f"[b]babysit[/]   sort=[cyan]{sort_name}[/]   "
                f"filter=[cyan]{filter_name}[/]   "
                f"refresh={self._refresh_secs:g}s   {time.strftime('%H:%M:%S')}"
            )

        def _tick(self) -> None:
            try:
                resp = rpc_call("list")
                tasks = resp.get("tasks", [])
            except Exception as e:  # noqa: BLE001
                self.query_one("#header", Label).update(f"[red]daemon error: {e}[/]")
                return

            sort_fn = SORT_KEYS[self._sort_idx][1]
            filter_fn = FILTERS[self._filter_idx][1]
            rows = [r for r in tasks if filter_fn(r)]
            rows.sort(key=lambda r: (0 if r["status"] == "running" else 1, sort_fn(r)))

            cur_name = None
            if 0 <= self._table.cursor_row < len(self._displayed):
                cur_name = self._displayed[self._table.cursor_row]["name"]
            # DataTable.clear() resets scroll to (0, 0); snapshot and restore
            # so refreshes don't yank the viewport away from the user.
            saved_scroll = (self._table.scroll_x, self._table.scroll_y)

            self._table.clear()
            self._displayed = rows
            for r in rows:
                status = r["status"]
                color = STATUS_COLOR.get(status, "white")
                kr = r.get("kill_reason")
                ec = r.get("exit_code")
                status_cell = f"[{color}]{status}[/]"
                if kr:
                    status_cell += f" [dim]({kr})[/]"
                elif status == "failed" and ec is not None:
                    status_cell += f" [dim](exit code {ec})[/]"
                cpu = f"{r['cpu_cores']:.1f}c" if r.get("cpu_cores") is not None else "-"
                mem = fmt_bytes(r["mem_bytes"]) if r.get("mem_bytes") is not None else "-"
                silent_secs = r.get("time_since_last_observe")
                obs_int = r.get("observability_interval") or 0
                if silent_secs is None:
                    silent_cell = "-"
                elif silent_secs > obs_int and status == "running":
                    silent_cell = f"[bold red]{fmt_duration(silent_secs)}[/]"
                else:
                    silent_cell = fmt_duration(silent_secs)
                last = last_log_line(Path(r["log_path"])) if r.get("log_path") else ""
                project = Path(r["cwd"]).name if r.get("cwd") else "-"
                self._table.add_row(
                    r["name"],
                    project,
                    status_cell,
                    progress_bar(r.get("elapsed_time"), r.get("estimated_time"), r.get("kill_timeout")),
                    cpu,
                    mem,
                    silent_cell,
                    last,
                )

            if cur_name:
                for i, r in enumerate(rows):
                    if r["name"] == cur_name:
                        self._table.move_cursor(row=i, scroll=False)
                        break
            self._table.scroll_to(x=saved_scroll[0], y=saved_scroll[1], animate=False)

            self.query_one("#header", Label).update(self._header_text())
            self._update_log_pane()

        def _current_task(self) -> dict | None:
            cur = self._table.cursor_row
            if 0 <= cur < len(self._displayed):
                return self._displayed[cur]
            return None

        def _update_log_pane(self) -> None:
            t = self._current_task()
            if not t or not t.get("log_path"):
                self._log_pane.update("(no task selected)")
                return
            text = tail_n(Path(t["log_path"]), 8)
            self._log_pane.update(f"[dim]log: {t['name']}[/]\n{text}")

        def on_data_table_row_highlighted(self, event) -> None:
            self._update_log_pane()

        def action_cycle_sort(self) -> None:
            self._sort_idx = (self._sort_idx + 1) % len(SORT_KEYS)
            self._tick()

        def action_cycle_filter(self) -> None:
            self._filter_idx = (self._filter_idx + 1) % len(FILTERS)
            self._tick()

        def action_refresh_now(self) -> None:
            self._tick()

        def action_open_log(self) -> None:
            t = self._current_task()
            if t and t.get("log_path"):
                self.push_screen(LogScreen(t["name"], Path(t["log_path"])))

        def action_kill_task(self) -> None:
            t = self._current_task()
            if not t or t["status"] in TERMINAL:
                return

            def after(confirmed: bool | None) -> None:
                if confirmed:
                    with contextlib.suppress(Exception):
                        rpc_call("kill", name=t["name"])
                    self._tick()

            self.push_screen(KillConfirm(t["name"]), after)

    BabysitTUI(refresh_secs=parse_duration(refresh)).run()


def main() -> None:
    try:
        app()
    except RuntimeError as e:
        typer.echo(f"error: {e}", err=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
