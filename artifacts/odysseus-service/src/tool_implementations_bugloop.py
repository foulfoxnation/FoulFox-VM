"""
Self-report / host-browser / send-report tool implementations.

Imported lazily in tool_execution.py as:
  from src.tool_implementations_bugloop import (
      do_generate_system_report, do_host_browser, do_send_report_to_replit
  )

These are also re-exported via tool_implementations.py's module namespace
so that the existing `from src.tool_implementations import do_*` pattern works.
"""
import json
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


async def do_generate_system_report(
    content: str = "",
    owner: Optional[str] = None,
) -> Dict[str, Any]:
    """Run all capability checks and return a structured + markdown report."""
    try:
        from src.diagnostics import run_all_checks, build_report
    except ImportError as e:
        return {"error": f"diagnostics module unavailable: {e}", "exit_code": 1}

    try:
        args: Dict[str, Any] = json.loads(content) if content.strip().startswith("{") else {}
    except (json.JSONDecodeError, TypeError):
        args = {}

    include_markdown: bool = args.get("include_markdown", True)

    try:
        all_checks = await run_all_checks()
        report = build_report(all_checks)
        summary = report.get("summary", {})
        checks  = report.get("checks", [])

        lines = [
            f"System Report — {report.get('generated_at', 'unknown')}",
            f"Status: {summary.get('ok', 0)} OK · {summary.get('warn', 0)} warn · {summary.get('fail', 0)} fail",
            "",
        ]
        for c in checks:
            icon = {"ok": "✅", "warn": "⚠️", "fail": "❌"}.get(c.get("status", ""), "❓")
            lines.append(f"{icon} {c['name']}: {c['detail']}")

        output = "\n".join(lines)
        if include_markdown and report.get("markdown"):
            output += "\n\n---\n" + report["markdown"]

        return {
            "output": output,
            "report": {k: v for k, v in report.items() if k != "checks"},
            "checks": checks,
            "exit_code": 0,
        }
    except Exception as exc:
        logger.exception("generate_system_report failed")
        return {"error": str(exc), "exit_code": 1}


async def do_host_browser(
    content: str = "",
    owner: Optional[str] = None,
) -> Dict[str, Any]:
    """Control a browser via CDP.

    Defaults to Firefox on port 9223 (the external browser used for web browsing
    and Replit access). Pass {"port": 9222} in the JSON to target the kiosk
    Chromium instead.

    Actions:
      screenshot          — take a screenshot; returns it to the vision model
      navigate            — go to a URL; requires {"url": "..."}
      get_url / get_title / get_text — read page state
      click               — click at {"x": N, "y": N} pixel coords
                            (use coordinates from the most recent screenshot)
      insert_text         — type text at the current focus point; requires {"text": "..."}
      key                 — press a key; requires {"key": "Enter"|"Tab"|"Escape"|...}
      focus               — focus a CSS selector; requires {"selector": "..."}
      set_value           — set an input value via JS; requires {"selector","text"}
    """
    try:
        from src.host_browser import HostBrowser, CDP_PORT
    except ImportError as e:
        return {"error": f"host_browser module unavailable: {e}", "exit_code": 1}

    try:
        args: Dict[str, Any] = json.loads(content) if content.strip().startswith("{") else {}
    except (json.JSONDecodeError, TypeError):
        return {"error": "content must be a JSON object with an 'action' field", "exit_code": 1}

    action   = args.get("action", "")
    url      = args.get("url", "")
    selector = args.get("selector", "")
    text     = args.get("text", "")
    key_name = args.get("key", "")
    # Default to Firefox (9223); pass port=9222 for the kiosk Chromium
    port: int = int(args.get("port", 9223))

    if not action:
        return {"error": "action is required", "exit_code": 1}

    try:
        async with HostBrowser(debug_port=port) as browser:
            if action == "screenshot":
                img_b64 = await browser.screenshot()
                cur = await browser.get_url()
                title = await browser.get_title()
                return {
                    # Return in the standard images format so the vision model
                    # can SEE the screenshot and reason about where to click/type.
                    "images": [{"data": img_b64, "mimeType": "image/png"}],
                    "output": (
                        f"Screenshot of Firefox (port {port}) captured. "
                        f"Current URL: {cur} | Title: {title}\n"
                        "Examine the screenshot to identify element positions "
                        "before clicking. Use x/y pixel coordinates from the image."
                    ),
                    "exit_code": 0,
                }

            elif action == "navigate":
                if not url:
                    return {"error": "url is required for navigate", "exit_code": 1}
                await browser.navigate(url, wait_load=True, timeout=30)
                await __import__("asyncio").sleep(2)   # SPA hydration
                cur = await browser.get_url()
                return {"output": f"Navigated to: {cur}", "exit_code": 0}

            elif action == "get_url":
                return {"output": await browser.get_url(), "exit_code": 0}

            elif action == "get_title":
                return {"output": await browser.get_title(), "exit_code": 0}

            elif action == "get_text":
                result = await browser.get_text()
                return {"output": result[:4000], "exit_code": 0}

            elif action == "focus":
                if not selector:
                    return {"error": "selector is required for focus", "exit_code": 1}
                await browser.focus_selector(selector)
                return {"output": f"Focused: {selector}", "exit_code": 0}

            elif action == "insert_text":
                if not text:
                    return {"error": "text is required for insert_text", "exit_code": 1}
                if selector:
                    await browser.focus_selector(selector)
                    await __import__("asyncio").sleep(0.2)
                await browser.insert_text(text)
                return {"output": f"Inserted {len(text)} chars of text", "exit_code": 0}

            elif action == "set_value":
                if not selector:
                    return {"error": "selector is required for set_value", "exit_code": 1}
                await browser.set_value(selector, text)
                return {"output": f"Set value of {selector}", "exit_code": 0}

            elif action == "click":
                # Click at pixel coordinates from the most recent screenshot
                x = args.get("x")
                y = args.get("y")
                if x is not None and y is not None:
                    # Direct coordinate click (from visual inspection of screenshot)
                    session = browser._session
                    assert session
                    for evt in ("mousePressed", "mouseReleased"):
                        await session.send("Input.dispatchMouseEvent", {
                            "type": evt, "x": float(x), "y": float(y),
                            "button": "left", "clickCount": 1,
                        })
                        await __import__("asyncio").sleep(0.05)
                    return {"output": f"Clicked at ({x}, {y})", "exit_code": 0}
                elif selector:
                    await browser.click_selector(selector)
                    return {"output": f"Clicked: {selector}", "exit_code": 0}
                else:
                    return {"error": "click requires {x, y} coordinates or a {selector}", "exit_code": 1}

            elif action == "key":
                if not key_name:
                    return {"error": "key is required for key action", "exit_code": 1}
                await browser.key(key_name)
                return {"output": f"Pressed key: {key_name}", "exit_code": 0}

            else:
                return {"error": f"Unknown action: {action!r}. "
                        "Valid actions: screenshot, navigate, get_url, get_title, "
                        "get_text, click, insert_text, key, focus, set_value", "exit_code": 1}

    except ConnectionRefusedError:
        browser_name = "Firefox" if port == 9223 else "Chromium"
        return {
            "error": (
                f"Cannot connect to {browser_name} CDP on port {port}. "
                f"Ensure {browser_name} is running with --remote-debugging-port={port}."
            ),
            "exit_code": 1,
        }
    except Exception as exc:
        logger.exception("host_browser failed")
        return {"error": str(exc), "exit_code": 1}


async def do_send_report_to_replit(
    content: str = "",
    owner: Optional[str] = None,
) -> Dict[str, Any]:
    """Generate a full system report and send it to Replit via browser automation."""
    try:
        from src.diagnostics import build_report
        from src.host_browser import paste_report_via_firefox
    except ImportError as e:
        return {"error": f"Module unavailable: {e}", "exit_code": 1}

    try:
        args: Dict[str, Any] = json.loads(content) if content.strip().startswith("{") else {}
    except (json.JSONDecodeError, TypeError):
        args = {}

    replit_url    = args.get("replit_url", "")
    extra_context = args.get("extra_context", "")

    if not replit_url:
        return {"error": "replit_url is required", "exit_code": 1}

    # 1. Run diagnostics
    try:
        from src.diagnostics import run_all_checks, build_report as _build
        checks = await run_all_checks()
        report = _build(checks)
    except Exception as exc:
        return {"error": f"Diagnostics failed: {exc}", "exit_code": 1}

    markdown = report.get("markdown", "")
    if extra_context:
        markdown = f"**Additional context from agent:**\n{extra_context}\n\n---\n\n{markdown}"

    # 2. Send via browser — Firefox (port 9223) physically navigates to the URL,
    #    opens the AI chat panel, types the report, and clicks submit.
    try:
        result = await paste_report_via_firefox(markdown, replit_url)
    except Exception as exc:
        return {"error": f"Browser automation failed: {exc}", "exit_code": 1}

    if result["ok"]:
        summary = report.get("summary", {})
        return {
            "output": (
                f"Report sent to Replit: {result['detail']}\n"
                f"Summary: {summary.get('ok', 0)} OK · "
                f"{summary.get('warn', 0)} warn · {summary.get('fail', 0)} fail"
            ),
            "exit_code": 0,
        }
    else:
        return {
            "output": f"Send failed: {result['detail']}",
            "exit_code": 1,
        }
