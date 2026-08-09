"""
FoulFox host-browser CDP client.

Connects to the Chromium instance running on the FoulFox kiosk via Chrome
DevTools Protocol (CDP) on the loopback debug port (default 9222).

The kiosk must be started with --remote-debugging-port=9222 for this to work.

Usage (async):
    async with HostBrowser() as browser:
        await browser.navigate("https://replit.com")
        await browser.wait_for_load()
        await browser.focus_selector("textarea")
        await browser.insert_text("hello world")
        await browser.key("Enter")
        screenshot = await browser.screenshot()   # base64 PNG
"""
from __future__ import annotations

import asyncio
import base64
import json
import time
import urllib.request
from typing import Any, Optional

CDP_HOST = "127.0.0.1"
CDP_PORT = 9222


def _cdp_http(path: str, timeout: float = 5.0) -> Any:
    """Synchronous helper for CDP HTTP endpoints."""
    url = f"http://{CDP_HOST}:{CDP_PORT}{path}"
    resp = urllib.request.urlopen(url, timeout=timeout)
    return json.loads(resp.read())


class CDPSession:
    """Async CDP session connected to a single browser tab."""

    def __init__(self, ws_url: str):
        self._ws_url = ws_url
        self._ws: Any = None          # asyncio WebSocket connection
        self._recv_task: Any = None
        self._id_counter = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._events: asyncio.Queue = asyncio.Queue(maxsize=200)

    async def connect(self) -> None:
        import websockets  # type: ignore
        self._ws = await websockets.connect(self._ws_url, ping_interval=None, open_timeout=10)
        self._recv_task = asyncio.create_task(self._recv_loop())

    async def disconnect(self) -> None:
        if self._recv_task:
            self._recv_task.cancel()
        if self._ws:
            await self._ws.close()

    async def _recv_loop(self) -> None:
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                if "id" in msg and msg["id"] in self._pending:
                    self._pending.pop(msg["id"]).set_result(msg)
                else:
                    try:
                        self._events.put_nowait(msg)
                    except asyncio.QueueFull:
                        pass
        except Exception:
            pass

    async def send(self, method: str, params: dict | None = None, timeout: float = 15.0) -> dict:
        call_id = self._id_counter
        self._id_counter += 1
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[call_id] = fut
        msg = {"id": call_id, "method": method, "params": params or {}}
        await self._ws.send(json.dumps(msg))
        try:
            result = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(call_id, None)
            raise TimeoutError(f"CDP timeout waiting for {method}")
        if "error" in result:
            raise RuntimeError(f"CDP error: {result['error']}")
        return result.get("result", {})

    async def wait_for_event(self, method: str, timeout: float = 30.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                event = await asyncio.wait_for(self._events.get(), timeout=min(remaining, 1.0))
            except asyncio.TimeoutError:
                continue
            if event.get("method") == method:
                return event.get("params", {})
        raise TimeoutError(f"Timeout waiting for CDP event: {method}")


class HostBrowser:
    """High-level browser automation over CDP."""

    def __init__(self, debug_port: int = CDP_PORT):
        self._port = debug_port
        self._session: Optional[CDPSession] = None
        self._target_id: Optional[str] = None

    # ── Context manager ──────────────────────────────────────────────────────

    async def __aenter__(self) -> "HostBrowser":
        await self.connect()
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.disconnect()

    # ── Connect / disconnect ─────────────────────────────────────────────────

    async def connect(self, prefer_new_tab: bool = True) -> None:
        """Connect to a browser tab. Prefers to open a new tab to avoid disrupting the kiosk."""
        global CDP_PORT
        CDP_PORT = self._port

        # Get list of targets
        targets = _cdp_http("/json/list")

        # Prefer an existing blank tab; fall back to first page tab
        target = None
        for t in targets:
            if t.get("type") == "page" and t.get("url") in ("about:blank", "about:newtab"):
                target = t
                break
        if target is None:
            for t in targets:
                if t.get("type") == "page":
                    target = t
                    break

        if target is None:
            # Create a new tab
            new_tab = _cdp_http("/json/new?about:blank")
            target = new_tab

        self._target_id = target["id"]
        ws_url = target["webSocketDebuggerUrl"]

        self._session = CDPSession(ws_url)
        await self._session.connect()

        # Enable Page domain so we get load events
        await self._session.send("Page.enable")

    async def disconnect(self) -> None:
        if self._session:
            await self._session.disconnect()

    # ── Navigation ───────────────────────────────────────────────────────────

    async def navigate(self, url: str, wait_load: bool = True, timeout: float = 30.0) -> None:
        assert self._session
        await self._session.send("Page.navigate", {"url": url})
        if wait_load:
            await self.wait_for_load(timeout=timeout)

    async def wait_for_load(self, timeout: float = 30.0) -> None:
        assert self._session
        try:
            await self._session.wait_for_event("Page.loadEventFired", timeout=timeout)
        except TimeoutError:
            pass  # Some SPAs never fire loadEventFired; continue anyway

    # ── JS evaluation ────────────────────────────────────────────────────────

    async def eval(self, js: str, timeout: float = 10.0) -> Any:
        assert self._session
        result = await self._session.send("Runtime.evaluate", {
            "expression": js,
            "returnByValue": True,
            "awaitPromise": True,
            "timeout": int(timeout * 1000),
        })
        exc = result.get("exceptionDetails")
        if exc:
            raise RuntimeError(f"JS exception: {exc.get('text', exc)}")
        val = result.get("result", {})
        if val.get("type") == "undefined":
            return None
        return val.get("value")

    async def wait_for_selector(self, selector: str, timeout: float = 20.0) -> bool:
        deadline = time.monotonic() + timeout
        js = f"!!document.querySelector({json.dumps(selector)})"
        while time.monotonic() < deadline:
            found = await self.eval(js)
            if found:
                return True
            await asyncio.sleep(0.5)
        return False

    # ── Input ────────────────────────────────────────────────────────────────

    async def focus_selector(self, selector: str) -> None:
        assert self._session
        js = f"""
        (function() {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return false;
            el.focus();
            el.click();
            return true;
        }})()
        """
        found = await self.eval(js)
        if not found:
            raise RuntimeError(f"Element not found: {selector}")

    async def insert_text(self, text: str) -> None:
        """Insert text at the current focus point (does not require selector)."""
        assert self._session
        await self._session.send("Input.insertText", {"text": text})

    async def set_value(self, selector: str, text: str) -> None:
        """Set value of an input/textarea element directly via JS."""
        js = f"""
        (function() {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return false;
            const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (nativeInput) {{
                nativeInput.set.call(el, {json.dumps(text)});
            }} else {{
                el.value = {json.dumps(text)};
            }}
            el.dispatchEvent(new Event('input', {{ bubbles: true }}));
            el.dispatchEvent(new Event('change', {{ bubbles: true }}));
            return true;
        }})()
        """
        await self.eval(js)

    async def key(self, key_name: str) -> None:
        """Dispatch a key press (e.g. 'Enter', 'Tab')."""
        assert self._session
        # keyDown
        await self._session.send("Input.dispatchKeyEvent", {
            "type": "keyDown", "key": key_name,
            "code": f"Key{key_name}" if len(key_name) == 1 else key_name,
        })
        await asyncio.sleep(0.05)
        await self._session.send("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": key_name,
            "code": f"Key{key_name}" if len(key_name) == 1 else key_name,
        })

    async def click_selector(self, selector: str) -> None:
        assert self._session
        # Get element center coords via JS
        js = f"""
        (function() {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {{ x: r.left + r.width/2, y: r.top + r.height/2 }};
        }})()
        """
        pos = await self.eval(js)
        if pos is None:
            raise RuntimeError(f"Click target not found: {selector}")
        x, y = pos["x"], pos["y"]
        for evt in ("mousePressed", "mouseReleased"):
            await self._session.send("Input.dispatchMouseEvent", {
                "type": evt, "x": x, "y": y, "button": "left", "clickCount": 1,
            })
            await asyncio.sleep(0.05)

    # ── Screenshot ───────────────────────────────────────────────────────────

    async def screenshot(self) -> str:
        """Return a base64-encoded PNG screenshot of the current viewport."""
        assert self._session
        result = await self._session.send("Page.captureScreenshot", {"format": "png"})
        return result.get("data", "")

    async def get_url(self) -> str:
        return await self.eval("window.location.href") or ""

    async def get_title(self) -> str:
        return await self.eval("document.title") or ""

    async def get_text(self) -> str:
        return await self.eval("document.body?.innerText || ''") or ""


# ── Replit paste helper ────────────────────────────────────────────────────────

# Selectors for the Replit AI chat input. Replit may change their DOM;
# we try multiple selectors in order and use the first one that works.
REPLIT_CHAT_SELECTORS = [
    # Current Replit AI chat textarea (as of 2025)
    "textarea[placeholder*='message']",
    "textarea[placeholder*='Message']",
    "textarea[placeholder*='chat']",
    "textarea[data-testid='chat-input']",
    "div[contenteditable='true'][role='textbox']",
    "textarea",  # last resort
]

REPLIT_SUBMIT_SELECTORS = [
    "button[data-testid='send-button']",
    "button[aria-label='Send']",
    "button[aria-label='send']",
    "button[type='submit']",
]


_REPLIT_PROJECT_URL = "https://replit.com/@foulfoxnation/Odysseus-VM?settings.tab=usage"


async def paste_report_to_replit(
    report_markdown: str,
    replit_url: str = _REPLIT_PROJECT_URL,
    debug_port: int = 9222,
) -> dict:
    """
    Open the Replit project URL in the host browser and paste the bug report
    into the AI agent chat.

    Returns {"ok": bool, "detail": str, "screenshot": str|None}
    """
    try:
        async with HostBrowser(debug_port=debug_port) as browser:
            current = await browser.get_url()

            # Only navigate if not already on the right page
            if replit_url not in current:
                await browser.navigate(replit_url, wait_load=True, timeout=30)
                await asyncio.sleep(3)  # wait for SPA to hydrate

            # Try to find the chat input
            input_sel = None
            for sel in REPLIT_CHAT_SELECTORS:
                if await browser.wait_for_selector(sel, timeout=5):
                    input_sel = sel
                    break

            if input_sel is None:
                screenshot = await browser.screenshot()
                return {
                    "ok": False,
                    "detail": "Could not find Replit chat input — is the AI chat panel open?",
                    "screenshot": screenshot,
                }

            # Focus and paste the report
            await browser.focus_selector(input_sel)
            await asyncio.sleep(0.3)

            # Use insertText for large text (more reliable than typing char by char)
            await browser.insert_text(report_markdown)
            await asyncio.sleep(0.5)

            # Try to submit
            submitted = False
            for sel in REPLIT_SUBMIT_SELECTORS:
                try:
                    await browser.click_selector(sel)
                    submitted = True
                    break
                except Exception:
                    continue
            if not submitted:
                # Fallback: press Enter
                await browser.key("Enter")

            await asyncio.sleep(1)
            screenshot = await browser.screenshot()
            return {
                "ok": True,
                "detail": f"Report pasted to {await browser.get_url()}",
                "screenshot": screenshot,
            }

    except Exception as exc:
        return {"ok": False, "detail": str(exc), "screenshot": None}


# ── Firefox CDP helpers ────────────────────────────────────────────────────────

FIREFOX_CDP_PORT = 9223   # Firefox is launched with --remote-debugging-port=9223

# Replit project title must contain this string for the confirmation to pass.
REPLIT_PROJECT_TITLE = "Odysseus VM"


async def _wait_for_firefox_cdp(debug_port: int = FIREFOX_CDP_PORT, timeout: float = 30.0) -> bool:
    """
    Poll the Firefox CDP HTTP endpoint until it responds or timeout.
    Firefox must already be running with --remote-debugging-port=<debug_port>.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            url = f"http://127.0.0.1:{debug_port}/json/version"
            resp = urllib.request.urlopen(url, timeout=3)
            if resp.status == 200:
                return True
        except Exception:
            pass
        await asyncio.sleep(2)
    return False


async def paste_report_via_firefox(
    report_markdown: str,
    replit_url: str = _REPLIT_PROJECT_URL,
    expected_project: str = REPLIT_PROJECT_TITLE,
    debug_port: int = FIREFOX_CDP_PORT,
) -> dict:
    """
    Connect to the always-running Firefox instance via CDP on port 9223.
    Navigate to the Replit project, confirm the page title contains
    expected_project, then paste report_markdown into the AI chat input.

    Firefox is launched at OS startup with --remote-debugging-port=9223 so it
    is always available without needing to spawn a new process here.

    Returns {"ok": bool, "detail": str, "screenshot": str|None}
    """
    # ── 1. Make sure Firefox CDP is up ────────────────────────────────────────
    cdp_ready = await _wait_for_firefox_cdp(debug_port=debug_port, timeout=30)
    if not cdp_ready:
        return {
            "ok":     False,
            "detail": (
                f"Firefox CDP not reachable on port {debug_port}. "
                "Check that Firefox was launched with --remote-debugging-port=9223."
            ),
            "screenshot": None,
        }

    try:
        async with HostBrowser(debug_port=debug_port) as browser:
            # ── 2. Navigate to the Replit project ─────────────────────────────
            current = await browser.get_url()
            if replit_url not in current:
                await browser.navigate(replit_url, wait_load=True, timeout=40)
                await asyncio.sleep(4)   # give Replit SPA time to hydrate

            # ── 3. Confirm project name (warning only — never blocks the paste) ──
            title = await browser.get_title()
            if expected_project and expected_project.lower() not in title.lower():
                # SPAs update <title> lazily; try once more before logging
                await asyncio.sleep(3)
                title = await browser.get_title()
            title_ok   = not expected_project or expected_project.lower() in title.lower()
            title_note = f"✅ '{title}'" if title_ok else f"⚠️  title='{title}' (expected '{expected_project}') — pasting anyway"

            # ── 4. Find the chat input ─────────────────────────────────────────
            input_sel = None
            for sel in REPLIT_CHAT_SELECTORS:
                if await browser.wait_for_selector(sel, timeout=6):
                    input_sel = sel
                    break

            if input_sel is None:
                screenshot = await browser.screenshot()
                return {
                    "ok":     False,
                    "detail": "Could not find Replit chat input — is the AI chat panel open?",
                    "screenshot": screenshot,
                }

            # ── 5. Paste the report ────────────────────────────────────────────
            await browser.focus_selector(input_sel)
            await asyncio.sleep(0.3)
            await browser.insert_text(report_markdown)
            await asyncio.sleep(0.5)

            # Submit
            submitted = False
            for sel in REPLIT_SUBMIT_SELECTORS:
                try:
                    await browser.click_selector(sel)
                    submitted = True
                    break
                except Exception:
                    continue
            if not submitted:
                await browser.key("Enter")

            await asyncio.sleep(1)
            screenshot = await browser.screenshot()
            final_url  = await browser.get_url()
            return {
                "ok":     True,
                "detail": f"Report submitted. {title_note}",
                "screenshot": screenshot,
            }

    except Exception as exc:
        return {"ok": False, "detail": str(exc), "screenshot": None}
