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
    """Run all 15 system-health checks and return a structured + markdown report."""
    try:
        from src.diagnostics import build_report
    except ImportError as e:
        return {"error": f"diagnostics module unavailable: {e}", "exit_code": 1}

    try:
        args: Dict[str, Any] = json.loads(content) if content.strip().startswith("{") else {}
    except (json.JSONDecodeError, TypeError):
        args = {}

    include_markdown: bool = args.get("include_markdown", True)

    try:
        report = await build_report()
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
    """Control the kiosk Chromium via CDP."""
    try:
        from src.host_browser import HostBrowser
    except ImportError as e:
        return {"error": f"host_browser module unavailable: {e}", "exit_code": 1}

    try:
        args: Dict[str, Any] = json.loads(content) if content.strip().startswith("{") else {}
    except (json.JSONDecodeError, TypeError):
        return {"error": "content must be a JSON object", "exit_code": 1}

    action   = args.get("action", "")
    url      = args.get("url", "")
    selector = args.get("selector", "")
    text     = args.get("text", "")
    key_name = args.get("key", "")

    if not action:
        return {"error": "action is required", "exit_code": 1}

    try:
        async with HostBrowser() as browser:
            if action == "navigate":
                if not url:
                    return {"error": "url is required for navigate", "exit_code": 1}
                await browser.navigate(url)
                await browser.wait_for_load()
                current = await browser.get_url()
                return {"output": f"Navigated to {current}", "exit_code": 0}

            elif action == "get_url":
                result = await browser.get_url()
                return {"output": result, "exit_code": 0}

            elif action == "get_title":
                result = await browser.get_title()
                return {"output": result, "exit_code": 0}

            elif action == "get_text":
                result = await browser.get_text()
                return {"output": result[:4000], "exit_code": 0}

            elif action == "focus":
                if not selector:
                    return {"error": "selector is required for focus", "exit_code": 1}
                await browser.focus(selector)
                return {"output": f"Focused {selector}", "exit_code": 0}

            elif action == "insert_text":
                if not text:
                    return {"error": "text is required for insert_text", "exit_code": 1}
                if selector:
                    await browser.focus(selector)
                await browser.insert_text(text)
                return {"output": f"Inserted {len(text)} chars", "exit_code": 0}

            elif action == "set_value":
                if not selector:
                    return {"error": "selector is required for set_value", "exit_code": 1}
                await browser.set_value(selector, text)
                return {"output": f"Set value of {selector}", "exit_code": 0}

            elif action == "click":
                if not selector:
                    return {"error": "selector is required for click", "exit_code": 1}
                await browser.click(selector)
                return {"output": f"Clicked {selector}", "exit_code": 0}

            elif action == "key":
                if not key_name:
                    return {"error": "key is required for key action", "exit_code": 1}
                await browser.key(key_name)
                return {"output": f"Sent key {key_name}", "exit_code": 0}

            elif action == "screenshot":
                img_b64 = await browser.screenshot()
                return {"output": f"Screenshot taken ({len(img_b64)} chars base64)", "image": img_b64, "exit_code": 0}

            else:
                return {"error": f"Unknown action: {action}", "exit_code": 1}

    except ConnectionRefusedError:
        return {
            "error": (
                "Cannot connect to Chromium CDP on port 9222. "
                "Check that the kiosk is running with --remote-debugging-port=9222."
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
        from src.host_browser import paste_report_to_replit
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
        report = await build_report()
    except Exception as exc:
        return {"error": f"Diagnostics failed: {exc}", "exit_code": 1}

    markdown = report.get("markdown", "")
    if extra_context:
        markdown = f"**Additional context from agent:**\n{extra_context}\n\n---\n\n{markdown}"

    # 2. Send via browser
    try:
        result = await paste_report_to_replit(markdown, replit_url)
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
