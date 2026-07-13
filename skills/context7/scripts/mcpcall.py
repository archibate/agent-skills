#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=1.25", "anyio", "httpx", "httpx-sse"]
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

from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamablehttp_client

# === EDIT THESE ===
SERVER_URL = "https://mcp.context7.com/mcp"
ENV_VAR = "CONTEXT7_API_KEY"
# ==================


def get_headers() -> dict[str, str]:
    key = os.environ.get(ENV_VAR)
    if not key:
        print(f"error: ${ENV_VAR} not set", file=sys.stderr)
        print(f"  export {ENV_VAR}=<key>", file=sys.stderr)
        sys.exit(1)
    return {"Authorization": f"Bearer {key}"}


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
    async with streamablehttp_client(SERVER_URL, headers=headers, timeout=15) as (rs, ws, _):
        async with ClientSession(rs, ws) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, arguments)
            for item in result.content:
                if hasattr(item, "text"):
                    print(item.text)
                elif hasattr(item, "data"):
                    print(f"[binary: {item.mimeType}, {len(item.data)} bytes]")
                else:
                    print(item)
            return result.isError or False


async def list_tools(headers: dict):
    async with streamablehttp_client(SERVER_URL, headers=headers, timeout=15) as (rs, ws, _):
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
        anyio.run(partial(list_tools, headers), backend="asyncio")
    elif args.tool:
        arguments = {}
        if args.kv_args:
            arguments.update(parse_kv_args(args.kv_args))
        if args.json_args:
            arguments.update(json.loads(args.json_args))
        is_error = anyio.run(partial(call_tool, headers, args.tool, arguments), backend="asyncio")
        if is_error:
            sys.exit(1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
