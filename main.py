"""Decky backend: runs the Fluxer desktop app and talks to it over CDP.

Fluxer is an Electron app. We start it with --remote-debugging-port and drive
its page with Runtime.evaluate. Account data is sanitized in the page: tokens
and stored local data never leave the Fluxer process.
"""

import asyncio
import json
import os
import shutil
import signal
import subprocess
from typing import Any, Optional

import decky  # type: ignore
from aiohttp import ClientSession, ClientTimeout, WSMsgType  # type: ignore

CDP_PORT = 9224
CDP_BASE = f"http://127.0.0.1:{CDP_PORT}"
APP_URL_PREFIX = "fluxer-app://"

# Runs inside the Fluxer page. Returns ONLY non-secret fields: the stored
# records also hold tokens (localStorageData / managedStorageData).
ACCOUNTS_JS = """
(async () => {
  const all = await window.electron.desktopAccounts.getAll();
  const host = (e) => { try { return new URL(e).host } catch { return e || null } };
  return (Array.isArray(all) ? all : []).map((a) => {
    const r = (a && a.record) || {};
    const u = r.userData || {};
    const name = [u.global_name, u.globalName, u.username].find((v) => typeof v === 'string' && v.trim());
    const inst = r.instance || {};
    return {
      accountKey: a.storageKey,
      userId: r.userId || null,
      displayName: name || r.userId || null,
      instanceHost: host(inst.webAppEndpoint || inst.apiEndpoint),
      lastActive: typeof r.lastActive === 'number' ? r.lastActive : 0,
      isValid: r.isValid !== false,
    };
  });
})()
"""


class CdpError(Exception):
    pass


class Plugin:
    _proc: Optional[subprocess.Popen] = None
    _session: Optional[ClientSession] = None

    # --- lifecycle -------------------------------------------------------

    async def _main(self):
        self._session = ClientSession(timeout=ClientTimeout(total=5))
        decky.logger.info("Fluxer plugin loaded")

    async def _unload(self):
        # Leave a Fluxer we did not start alone; stop only our own child.
        await self._terminate_own_process()
        if self._session:
            await self._session.close()
        decky.logger.info("Fluxer plugin unloaded")

    # --- process control -------------------------------------------------

    def _fluxer_command(self) -> list[str]:
        binary = shutil.which("fluxer") or "/usr/bin/fluxer"
        cmd = [binary, "--ozone-platform=x11", f"--remote-debugging-port={CDP_PORT}"]
        # Decky may run as root; Fluxer must run as the desktop user.
        if os.getuid() == 0 and decky.DECKY_USER:
            cmd = ["runuser", "-u", decky.DECKY_USER, "--"] + cmd
        return cmd

    async def _cdp_up(self) -> bool:
        try:
            async with self._session.get(f"{CDP_BASE}/json/version") as r:
                return r.status == 200
        except Exception:
            return False

    async def start(self) -> dict:
        if await self._cdp_up():
            return {"ok": True, "already_running": True}
        env = dict(os.environ)
        env.setdefault("DISPLAY", ":0")
        env.setdefault("XDG_SESSION_TYPE", "x11")
        try:
            self._proc = subprocess.Popen(
                self._fluxer_command(),
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as e:
            decky.logger.error(f"could not start fluxer: {e}")
            return {"ok": False, "error": str(e)}
        for _ in range(40):
            if await self._cdp_up():
                return {"ok": True}
            await asyncio.sleep(0.5)
        return {"ok": False, "error": "cdp_timeout"}

    async def _terminate_own_process(self):
        proc = self._proc
        self._proc = None
        if proc and proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except ProcessLookupError:
                return
            for _ in range(20):
                if proc.poll() is not None:
                    return
                await asyncio.sleep(0.25)
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass

    async def stop(self) -> dict:
        own = self._proc is not None
        await self._terminate_own_process()
        # A Fluxer started by someone else is not ours to kill.
        return {"ok": True, "stopped_own": own, "still_up": await self._cdp_up()}

    # --- CDP -------------------------------------------------------------

    async def _page_ws_url(self) -> str:
        async with self._session.get(f"{CDP_BASE}/json") as r:
            targets = await r.json()
        for t in targets:
            if t.get("type") == "page" and str(t.get("url", "")).startswith(APP_URL_PREFIX):
                return t["webSocketDebuggerUrl"]
        raise CdpError("no_app_page")

    async def _evaluate(self, expression: str) -> Any:
        ws_url = await self._page_ws_url()
        async with self._session.ws_connect(ws_url, max_msg_size=0) as ws:
            await ws.send_json(
                {
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {"expression": expression, "returnByValue": True, "awaitPromise": True},
                }
            )
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                if data.get("id") != 1:
                    continue
                if "error" in data:
                    raise CdpError(data["error"].get("message", "cdp_error"))
                res = data["result"]
                if "exceptionDetails" in res:
                    raise CdpError(res["exceptionDetails"].get("text", "js_exception"))
                return res["result"].get("value")
        raise CdpError("ws_closed")

    # --- state for the frontend -----------------------------------------

    async def get_state(self) -> dict:
        state: dict = {"running": False, "ready": False, "logged_in": False, "accounts": [], "error": None}
        if not await self._cdp_up():
            return state
        state["running"] = True
        try:
            accounts = await self._evaluate(ACCOUNTS_JS)
        except Exception as e:  # app page not loaded yet, bridge missing, ...
            state["error"] = str(e)
            return state
        accounts = sorted(accounts or [], key=lambda a: a.get("lastActive", 0), reverse=True)
        state["accounts"] = accounts
        state["ready"] = True
        state["logged_in"] = any(a.get("isValid") for a in accounts)
        # Fluxer does not tell us which account is in the foreground yet;
        # the most recently active one is the best guess until we hook the
        # account engine events.
        state["active_account_guess"] = accounts[0]["accountKey"] if accounts else None
        return state

    async def switch_account(self, account_key: str) -> dict:
        # TODO: drive the renderer's own switchAccount path (see
        # docs/fluxer-internals.md). Never write the account store directly.
        decky.logger.info(f"switch_account requested (not implemented): {account_key!r}")
        return {"ok": False, "error": "not_implemented"}
