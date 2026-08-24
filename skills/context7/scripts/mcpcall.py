#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=2,<3", "anyio", "httpx2"]
# ///
"""Context7 MCP tool caller.

Usage:
    mcpcall.py <tool_name> key:"value" key2:10
    mcpcall.py <tool_name> --args '{"key": ["array"]}'
    mcpcall.py --list

Requires CONTEXT7_API_KEY environment variable.
"""

import argparse
import json
import os
import sys
from functools import partial

import anyio
import httpx2
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

# === EDIT THESE ===
SERVER_URL = "https://mcp.context7.com/mcp"
ENV_VAR = "CONTEXT7_API_KEY"
# ==================

CONNECTION_FAILURES = (
    httpx2.ConnectError,
    httpx2.ConnectTimeout,
    httpx2.ProxyError,
)


def find_connection_failure(error: BaseException) -> httpx2.TransportError | None:
    pending = [error]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, CONNECTION_FAILURES):
            return current
        nested = getattr(current, "exceptions", ())
        if isinstance(nested, tuple):
            pending.extend(nested)
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)
    return None


def run_with_network_diagnostic(async_fn):
    try:
        return anyio.run(async_fn, backend="asyncio")
    except Exception as error:
        if os.environ.get("CODEX_SANDBOX_NETWORK_DISABLED") != "1":
            raise
        connection_failure = find_connection_failure(error)
        if connection_failure is None:
            raise
    print(
        f"error: failed to connect to Context7 MCP: {connection_failure}",
        file=sys.stderr,
    )
    print(
        "  sandbox indicator: CODEX_SANDBOX_NETWORK_DISABLED=1; "
        "the Codex sandbox may have blocked this connection",
        file=sys.stderr,
    )
    print(f"  required outbound HTTPS: {SERVER_URL}", file=sys.stderr)
    print(
        "  network justification: query Context7 MCP; sends "
        f"${ENV_VAR} to mcp.context7.com for authentication",
        file=sys.stderr,
    )
    raise SystemExit(1) from None


def get_headers() -> dict[str, str]:
    key = os.environ.get(ENV_VAR)
    if not key:
        print(f"error: ${ENV_VAR} not set", file=sys.stderr)
        print(f"  export {ENV_VAR}=<key>", file=sys.stderr)
        sys.exit(1)
    return {"Authorization": f"Bearer {key}"}


def create_http_client(headers: dict[str, str]) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(
        headers=headers,
        follow_redirects=True,
        timeout=httpx2.Timeout(30, read=300),
    )


def parse_kv_args(args: list[str]) -> dict:
    result = {}
    for arg in args:
        if ":" not in arg:
            print(f"error: bad arg '{arg}', expected key:value", file=sys.stderr)
            sys.exit(1)
        key, val = arg.split(":", 1)
        if val.lower() == "true":
            result[key] = True
        elif val.lower() == "false":
            result[key] = False
        else:
            try:
                result[key] = int(val)
            except ValueError:
                try:
                    result[key] = float(val)
                except ValueError:
                    result[key] = val
    return result


async def call_tool(headers: dict, tool_name: str, arguments: dict) -> bool:
    async with create_http_client(headers) as http_client:
        async with streamable_http_client(SERVER_URL, http_client=http_client) as (
            rs,
            ws,
        ):
            async with ClientSession(rs, ws) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)
                for item in result.content:
                    if hasattr(item, "text"):
                        print(item.text)
                    elif hasattr(item, "data"):
                        print(f"[binary: {item.mime_type}, {len(item.data)} bytes]")
                    else:
                        print(item)
                return result.is_error or False


async def list_tools(headers: dict):
    async with create_http_client(headers) as http_client:
        async with streamable_http_client(SERVER_URL, http_client=http_client) as (
            rs,
            ws,
        ):
            async with ClientSession(rs, ws) as session:
                await session.initialize()
                result = await session.list_tools()
                for tool in result.tools:
                    desc = (tool.description or "")[:60]
                    print(f"  {tool.name:30s} {desc}")


def main():
    parser = argparse.ArgumentParser(description="Call MCP tools")
    parser.add_argument("tool", nargs="?", help="Tool name")
    parser.add_argument("kv_args", nargs="*", help="key:value arguments")
    parser.add_argument("--args", dest="json_args", help="JSON arguments string")
    parser.add_argument("--list", action="store_true", help="List available tools")
    args = parser.parse_args()

    headers = get_headers()

    if args.list:
        run_with_network_diagnostic(partial(list_tools, headers))
    elif args.tool:
        arguments = {}
        if args.kv_args:
            arguments.update(parse_kv_args(args.kv_args))
        if args.json_args:
            arguments.update(json.loads(args.json_args))
        is_error = run_with_network_diagnostic(
            partial(call_tool, headers, args.tool, arguments)
        )
        if is_error:
            sys.exit(1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
