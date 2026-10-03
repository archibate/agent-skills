#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# ///
"""Decode HTML entities (&quot;, &#39;, &amp; …) in text read from stdin."""
import html, sys
sys.stdout.write(html.unescape(sys.stdin.read()))
