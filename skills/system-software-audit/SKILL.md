---
name: system-software-audit
description: >-
  Audit consequential software after implementation or material changes and before
  production deployment. Use for services, daemons, long-running/background/silent
  jobs, system software, shared or machine-wide changes, security-sensitive or
  high-attack-surface components, state machines, error-prone or poorly testable
  code, heavy/resource-bounded workloads, and software whose failure is costly.
  Also use for explicit security, deadlock, concurrency, state-machine, log-storm,
  reliability, or time/space-complexity audits. Apply based on failure consequences,
  not language or project size; ordinary low-impact edits do not need a full audit.
---

# System Software Audit

Audit the final implementation and its operational context before exposing production
state or users to it. Passing normal-path tests is evidence, not a deployment verdict.

## Trigger and scope

Use after writing or materially changing software with any of the risks in the
description, and before its production deployment. Re-run affected checks after fixes
or changes to configuration, dependencies, privileges, scheduling, or rollout design.
An explicit audit request also triggers this skill on existing software.

Scale depth to blast radius, longevity, attack surface, observability, reversibility,
and failure cost. A short privileged script can need more scrutiny than a large UI.
Cover every applicable dimension below; explain material exclusions and add checks
for domain-specific hazards. This inventory is a starting point, not a closed list.

An audit-only request remains read-only. During authorized implementation or repair,
fix in-scope findings and verify them before deployment. Failure injection belongs in
isolated fixtures unless live testing is explicitly authorized. Existing authorization
continues to apply; this skill neither grants deployment permission nor requires an
extra confirmation for work already authorized.

## Establish the model

Inspect the actual code, effective configuration, runtime versions, service units,
consumers, and existing tests. Identify:

- Protected assets, trust boundaries, privileges, external inputs and side effects.
- Resource owners and identities across processes, users, containers, paths and aliases.
- Lifecycle and durable states: start, prepare, apply, commit, cancel, recover, stop,
  restart, upgrade and rollback; distinguish disk state, running state and reported state.
- Expected workload, worst credible input, uptime, resource budgets and failure impact.

State the invariants that must survive faults. Trace an input through its real consumer,
and a mutation through persistence, activation, acknowledgment and recovery. Start with
cheap probes that discriminate among plausible failures; use the deployed interface and
runtime when a mock could conceal the behavior under investigation.

## Audit dimensions

1. **Security and trust.** Check authentication, authorization, exposure, least privilege,
   transport, dependencies and configuration ownership. Treat downloaded configuration as
   input with defined authority. Trace injection into commands, paths, regular expressions,
   templates and secondary interpreters. Check traversal, symlinks and TOCTOU where relevant.
   Inspect secret handling in files, environment, argv, logs, errors, backups and version
   control; permissions alone do not prevent accidental commits. Verify effective listener
   and access behavior, including parent-directory permissions and authentication failures.

2. **Concurrency and deadlocks.** Enumerate actors and shared resources; build lock order
   and wait dependencies, including callbacks, awaits, subprocesses and backpressure.
   Check races, atomicity, starvation, livelock, reentrancy and stale reads. Coordination
   must follow the actual shared resource across aliases, users and configuration roots.
   Include manual commands, timers, multiple instances and old/new versions. Trace cancellation
   while holding locks, and shutdown while producers are blocked on full queues.

3. **State machines and data integrity.** Exercise legal and illegal transitions, partial
   writes, crashes between steps, replay, duplicate requests and recovery failure. Check
   atomic replacement, durability, migration, rollback and idempotency against the required
   guarantees. A lost response or timeout after a side effect means the outcome is unknown;
   reconcile it rather than declaring failure-with-no-effect or success. Ensure rollback
   cannot overwrite another writer, and late completion cannot silently undo recovery.

4. **Lifecycle and error handling.** Verify startup readiness, normal exit, signals, task
   cancellation, panic/exception paths, hung dependencies, restart loops and orphan cleanup.
   Audit ownership of tasks, sockets, descriptors, locks, temporary files and child processes.
   Normal shutdown must finish or recover mutations; completed tasks must be reaped during
   operation. Distinguish safe retry, permanent failure and unknown outcome, with bounded
   timeouts, retry budgets and backoff. A quiet stream and a dead connection need different
   treatment when silence is normal.

5. **Resources and time/space complexity.** Define input dimensions and derive time, peak
   space, retained space, I/O and network/request cost. Include runtime duration, concurrency,
   queue depth, fan-out, retries, copies, serialization, caches and adversarial input shapes.
   Look for repeated scans, front deletion, nested searches and parser/regex amplification.
   Bound bytes as well as item counts, before allocation or parsing where possible, including
   streamed/decompressed data. Measure allocated capacity and retained ownership, not just
   logical lengths. Verify limits on success, failure, cancellation and idle paths. Choose
   budgets from requirements and workload evidence rather than importing arbitrary constants.

6. **Logs and observability.** Examine generation, formatting, transport, filtering, retention,
   rotation and disk exhaustion separately. Check bursts and repeated failures for log storms,
   retry amplification, secret leakage and feedback loops. Hidden views can still process
   every event. Require proportionate sampling, aggregation, rate limits or backpressure;
   suppressing all errors is not a fix. Confirm silent/background failures remain detectable,
   health reflects useful work, and dropped events or exceeded limits are visible.

7. **Correctness and compatibility.** Audit boundary arithmetic, overflow, time/clocks,
   ordering, encoding, ownership and language-specific hazards. Verify protocol, ABI, file
   format, dependency and runtime assumptions against actual consumers. Test cold starts,
   persisted state, version skew and upgrades, not only a clean development environment.

8. **Deployment and recovery.** Inspect the exact artifact, launch environment, permissions,
   service limits, dependencies and credentials. Plan migration, staged verification and
   rollback before mutation; keep recovery independent of the component being changed.
   Verify effective runtime behavior after deployment, persistence across relevant reloads
   or restarts, and representative user operations. A process being active is insufficient.

## Evidence and repair loop

- Rank findings by reachable preconditions, impact and likelihood. Record the trigger,
  location, violated invariant, outcome and supporting evidence. Separate reproduced faults,
  code-proven defects, hypotheses and untested conditions; do not inflate theoretical risks.
- Reproduce with bounded fixtures, controlled scheduling, malformed inputs, interrupted I/O,
  saturation or fault injection appropriate to the claim. For low-coverage or hard-to-test
  systems, add instrumentation or isolate the boundary; name what remains unverified.
- Repair the underlying ownership, lifecycle or trust boundary. Turn consequential repros
  into regression tests, rerun them on the final implementation, and check affected behavior
  for regressions. Use real-core/OS/integration checks when unit mocks omit the failure mode.
- An independent review can expose shared assumptions when available and authorized. Give
  it code and requirements without the intended verdict; verify its claims yourself.
- Inspect the final diff and exact deployment artifact. Unresolved severe security, data-loss,
  liveness or resource risks, and critical unverified invariants, block deployment until fixed
  or explicitly accepted within the user's authority. Continue safe independent work instead
  of repeatedly asking for approval. Passing the gate does not require a new approval ritual.

## Report

Lead with deployment readiness or the highest-impact finding. Include scope, prioritized
findings with locations and evidence, repairs performed, meaningful verification, and residual
risks or coverage gaps. Give measured resource costs and defined complexity variables when
relevant. State whether production was changed. Avoid checklist theater, unsupported claims
of no bugs or deadlocks, and treating a test count or a quiet log as proof of reliability.
