#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["beautifulsoup4", "markdownify"]
# ///
"""Read HTML from stdin, print markdown of all elements matching the CSS selector.

Usage: curl -sL <url> | html-select.py '<css selector>'
"""
import sys
from bs4 import BeautifulSoup
from markdownify import markdownify

if len(sys.argv) != 2:
    sys.exit("usage: html-select.py '<css selector>' < page.html")

html = sys.stdin.read()
if not html.strip():
    sys.exit("html-select.py: empty input on stdin (curl failed?)")

matches = BeautifulSoup(html, "html.parser").select(sys.argv[1])
if not matches:
    sys.exit(f"html-select.py: selector {sys.argv[1]!r} matched nothing")

for el in matches:
    print(markdownify(str(el)))
    print()
