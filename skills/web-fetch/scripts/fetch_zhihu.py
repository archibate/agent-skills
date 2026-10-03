#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright", "markdownify"]
# ///
"""Fetch a public Zhihu article as clean markdown — no login, no cookie file.

Usage: fetch_zhihu.py <article-url>
       uv run --script fetch_zhihu.py <article-url>

Zhihu serves anonymous curl a bot-challenge page and 403s its API on any
non-browser TLS fingerprint. The only thing that works is a real headless
Chromium: it runs the JS challenge at the homepage, earns the anonymous `d_c0`
device cookie, then the article's embedded `js-initialData` is served. This
script does exactly that warmup, extracts the structured article payload, and
prints markdown to stdout. No sidecar files.

Login-gated content (collections, paywall, "登录后查看") still needs a real
session — print an error and let the caller escalate to /chrome-cdp.
"""
import asyncio
import glob
import json
import os
import random
import re
import shutil
import sys

from markdownify import markdownify
from playwright.async_api import async_playwright

STEALTH_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en'] });
delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };
"""

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def find_chromium():
    """Prefer an already-downloaded browser so we don't re-fetch ~150MB."""
    cands = []
    cands += glob.glob(os.path.expanduser(
        "~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"))
    cands += ["/usr/bin/chromium", "/usr/bin/chromium-browser",
              "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
    cands += [shutil.which("chromium"), shutil.which("google-chrome")]
    return next((c for c in cands if c and os.path.isfile(c)), None)


async def main(url):
    async with async_playwright() as p:
        kw = dict(headless=True, args=[
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox", "--disable-setuid-sandbox",
            "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
        ])
        exe = find_chromium()
        if exe:
            kw["executable_path"] = exe
        browser = await p.chromium.launch(**kw)
        try:
            ctx = await browser.new_context(
                user_agent=UA, viewport={"width": 1440, "height": 900},
                locale="zh-CN", timezone_id="Asia/Shanghai",
                extra_http_headers={
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"macOS"',
                },
            )
            await ctx.add_init_script(STEALTH_SCRIPT)
            page = await ctx.new_page()

            # Earn the anonymous d_c0 device cookie via the homepage challenge.
            await page.goto("https://www.zhihu.com/",
                            wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(random.randint(2000, 4000))
            await page.evaluate("window.scrollBy(0, 300)")
            await page.wait_for_timeout(random.randint(800, 1500))

            await page.goto(url, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(random.randint(4000, 7000))
            for _ in range(3):
                await page.evaluate(f"window.scrollBy(0, {random.randint(200, 500)})")
                await page.wait_for_timeout(random.randint(400, 1200))

            title, author, content_html = await extract(page)
        finally:
            await browser.close()

    if not content_html.strip():
        sys.exit("fetch_zhihu.py: no content — page may be login-gated or a "
                 "bot-challenge landed; escalate to /chrome-cdp with a session.")

    body = markdownify(content_html, heading_style="ATX").strip()
    head = f"# {title}\n\n> 作者: {author}　|　{url}\n\n" if title else ""
    print(head + body)


async def extract(page):
    """Pull (title, author, content_html) from js-initialData, then DOM."""
    data = await page.evaluate("""() => {
        const el = document.getElementById('js-initialData');
        return el ? el.textContent : '';
    }""")
    if data:
        try:
            j = json.loads(data)
            ents = j.get("initialState", {}).get("entities", {})
            for kind in ("articles", "answers"):
                items = ents.get(kind, {})
                if items:
                    a = next(iter(items.values()))
                    return (a.get("title", ""), a.get("author", {}).get("name", ""),
                            a.get("content", ""))
        except (json.JSONDecodeError, StopIteration):
            pass

    # DOM fallback.
    return await page.evaluate("""() => {
        const q = s => document.querySelector(s);
        const t = q('h1.Post-Title, h1[class*="Title"], h1');
        const a = q('.AuthorInfo-name, a[class*="Author"]');
        const b = q('.Post-RichText, .RichText, article, main');
        return [t ? t.innerText.trim() : '',
                a ? a.innerText.trim() : '',
                b ? b.innerHTML : ''];
    }""")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: fetch_zhihu.py <article-url>")
    if "zhihu.com" not in sys.argv[1]:
        sys.exit("fetch_zhihu.py: URL doesn't look like a zhihu page")
    asyncio.run(main(sys.argv[1]))
