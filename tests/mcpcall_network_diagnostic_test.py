# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "anyio",
#   "exceptiongroup; python_version < '3.11'",
#   "httpx2",
#   "mcp>=2,<3",
# ]
# ///
import importlib.util
import io
import os
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

import httpx2

try:
    from builtins import ExceptionGroup
except ImportError:
    from exceptiongroup import ExceptionGroup


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATHS = {
    "context7": ROOT / "skills/context7/scripts/mcpcall.py",
    "grep_app": ROOT / "skills/grep-app/scripts/mcpcall.py",
}
SANDBOX_MARKER = "CODEX_SANDBOX_NETWORK_DISABLED"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def async_result(value):
    async def run():
        return value

    return run


def async_failure(error: BaseException):
    async def run():
        raise error

    return run


class NetworkDiagnosticTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.modules = {
            name: load_module(f"test_{name}_mcpcall", path)
            for name, path in MODULE_PATHS.items()
        }

    def test_stale_marker_does_not_block_success(self):
        for name, module in self.modules.items():
            with self.subTest(name=name), patch.dict(os.environ, {SANDBOX_MARKER: "1"}):
                self.assertEqual(
                    module.run_with_network_diagnostic(async_result("ok")), "ok"
                )

    def test_nested_connection_failure_gets_sandbox_diagnostic(self):
        for name, module in self.modules.items():
            leaf = httpx2.ConnectError("synthetic connection refusal")
            grouped = ExceptionGroup("transport task group", [leaf])
            wrapper = RuntimeError("outer transport failure")
            wrapper.__cause__ = grouped
            stderr = io.StringIO()
            with (
                self.subTest(name=name),
                patch.dict(os.environ, {SANDBOX_MARKER: "1"}),
                redirect_stderr(stderr),
                self.assertRaisesRegex(SystemExit, "1"),
            ):
                module.run_with_network_diagnostic(async_failure(wrapper))
            output = stderr.getvalue()
            self.assertIn("synthetic connection refusal", output)
            self.assertIn("sandbox may have blocked", output)
            self.assertIn("required outbound", output)
            self.assertIn("network justification", output)
            self.assertIn(module.SERVER_URL, output)

    def test_unmarked_connection_failure_is_preserved(self):
        for name, module in self.modules.items():
            failure = ExceptionGroup(
                "transport task group", [httpx2.ConnectTimeout("synthetic timeout")]
            )
            with (
                self.subTest(name=name),
                patch.dict(os.environ, {SANDBOX_MARKER: "0"}),
                self.assertRaises(ExceptionGroup) as raised,
            ):
                module.run_with_network_diagnostic(async_failure(failure))
            self.assertIs(raised.exception, failure)

    def test_non_connection_errors_are_preserved(self):
        request = httpx2.Request("POST", "https://example.test/mcp")
        response = httpx2.Response(401, request=request)
        errors = [
            httpx2.HTTPStatusError(
                "synthetic authentication failure", request=request, response=response
            ),
            httpx2.ReadError("synthetic post-connect read failure"),
            ValueError("synthetic application failure"),
        ]
        for name, module in self.modules.items():
            for error in errors:
                with (
                    self.subTest(name=name, error=type(error).__name__),
                    patch.dict(os.environ, {SANDBOX_MARKER: "1"}),
                    self.assertRaises(type(error)) as raised,
                ):
                    module.run_with_network_diagnostic(async_failure(error))
                self.assertIs(raised.exception, error)

    def test_missing_context7_key_wins_before_network_diagnostic(self):
        module = self.modules["context7"]
        stderr = io.StringIO()
        with (
            patch.dict(
                os.environ,
                {SANDBOX_MARKER: "1", module.ENV_VAR: ""},
            ),
            redirect_stderr(stderr),
            self.assertRaisesRegex(SystemExit, "1"),
        ):
            module.get_headers()
        output = stderr.getvalue()
        self.assertIn(f"${module.ENV_VAR} not set", output)
        self.assertNotIn("network justification", output)


if __name__ == "__main__":
    unittest.main()
