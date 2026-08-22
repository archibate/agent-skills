#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=2,<3", "anyio"]
# ///
"""grep.app MCP tool caller.

Usage:
    mcpcall.py searchGitHub query:"useState("
    mcpcall.py searchGitHub query:"CORS(" matchCase:true --args '{"language":["Python"]}'
    mcpcall.py --list
"""
import argparse
import json
import os
import sys
from functools import partial

import anyio

from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

SERVER_URL = "https://mcp.grep.app"


def check_sandbox_network() -> None:
    if os.environ.get("CODEX_SANDBOX_NETWORK_DISABLED") != "1":
        return
    print("error: network access is disabled by the Codex sandbox", file=sys.stderr)
    print(f"  required outbound HTTPS: {SERVER_URL}", file=sys.stderr)
    print(
        "  network justification: query grep.app MCP for public code search",
        file=sys.stderr,
    )
    sys.exit(1)


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


async def call_tool(tool_name: str, arguments: dict) -> bool:
    async with streamable_http_client(SERVER_URL) as (rs, ws):
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


async def list_tools():
    async with streamable_http_client(SERVER_URL) as (rs, ws):
        async with ClientSession(rs, ws) as session:
            await session.initialize()
            result = await session.list_tools()
            for tool in result.tools:
                desc = (tool.description or "")[:60]
                print(f"  {tool.name:30s} {desc}")


def main():
    parser = argparse.ArgumentParser(description="Call grep.app MCP tools")
    parser.add_argument("tool", nargs="?", help="Tool name (e.g. searchGitHub)")
    parser.add_argument("kv_args", nargs="*", help="key:value arguments")
    parser.add_argument("--args", dest="json_args", help="JSON arguments string")
    parser.add_argument("--list", action="store_true", help="List available tools")
    args = parser.parse_args()

    if args.list or args.tool:
        check_sandbox_network()

    if args.list:
        anyio.run(list_tools, backend="asyncio")
    elif args.tool:
        arguments = {}
        if args.kv_args:
            arguments.update(parse_kv_args(args.kv_args))
        if args.json_args:
            arguments.update(json.loads(args.json_args))
        is_error = anyio.run(partial(call_tool, args.tool, arguments), backend="asyncio")
        if is_error:
            sys.exit(1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
