"""Decky backend: runs the Fluxer desktop app and talks to it over CDP.

Fluxer is an Electron app. We start it with --remote-debugging-port and drive
its page with Runtime.evaluate. Account data is sanitized in the page: tokens
and stored local data never leave the Fluxer process.
"""

import asyncio
import glob
import json
import os
import platform
import shutil
import signal
import subprocess
import tarfile
from typing import Any, Optional

import decky  # type: ignore
from aiohttp import ClientSession, ClientTimeout, WSMsgType  # type: ignore

BRIDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "defaults", "bridge.js")
CDP_PORT = 9224
CDP_BASE = f"http://127.0.0.1:{CDP_PORT}"
APP_URL_PREFIX = "fluxer-app://"
# Official desktop build (tar.gz): installs without root, so it also works on a
# read-only SteamOS root.
FLUXER_DOWNLOAD = "https://pkgs.fluxer.com/desktop/stable/linux/{arch}/latest/tar_gz"

# Runs inside the Fluxer page. Reports which login step is on screen. Never
# reads field values.
LOGIN_STATE_JS = """
(() => {
  const q = (s) => document.querySelector(s);
  const text = document.body ? document.body.innerText : '';
  const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
  const err = q('[role=alert]');
  const error = err ? err.textContent.trim().slice(0, 200) : null;
  if (location.pathname.startsWith('/channels')) return { step: 'logged_in' };
  if (q('input[name=email]') && q('input[name=password]')) return { step: 'credentials', error };
  if (/Choose your defaults/i.test(text)) return { step: 'language' };
  if (/Choose your instance/i.test(text)) {
    const instances = [...document.querySelectorAll('button')]
      .filter((b) => b.innerText.trim() && !/Add another instance/i.test(b.innerText) && b.innerText.trim() !== 'Continue')
      .map((b) => { const [name, host] = b.innerText.trim().split('\\n'); return { name, host: host || name }; });
    return { step: 'instance', instances, adding: !!q('input'), error };
  }
  if (/Sign in with email/i.test(text)) return { step: 'method' };
  if (q('input') && /code|authenticat|verif/i.test(text)) return { step: 'mfa', error };
  return { step: 'unknown', text: text.slice(0, 160) };
})()
"""


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
      avatar: (u.avatar && r.userId && (inst.webAppEndpoint || inst.apiEndpoint))
        ? new URL(inst.webAppEndpoint || inst.apiEndpoint).origin + '/media/avatars/' + r.userId + '/' + String(u.avatar).replace(/^a_/, '') + '.webp?size=80'
        : null,
      lastActive: typeof r.lastActive === 'number' ? r.lastActive : 0,
      isValid: r.isValid !== false,
    };
  });
})()
"""


# Persist startMinimized through Fluxer's own settings bridge (editing
# settings.json directly gets overwritten by the running app). Only hide the
# current window when closing it goes to the tray, otherwise closing quits.
ENSURE_HIDDEN_JS = """
(async () => {
  const e = window.electron;
  const s = await e.getDesktopWindowBehaviorSettings();
  if (s.startMinimized) return 'already';
  await e.setDesktopWindowBehaviorSettings({ startMinimized: true });
  if (s.closeToTray && s.showTrayIcon) { e.windowClose(); return 'set+hidden'; }
  return 'set';
})()
"""


class CdpError(Exception):
    pass


class Plugin:
    _proc: Optional[subprocess.Popen] = None
    _session: Optional[ClientSession] = None
    _install: dict = {"stage": "idle", "pct": 0, "error": None}

    # --- lifecycle -------------------------------------------------------

    async def _main(self):
        self._session = ClientSession(timeout=ClientTimeout(total=5))
        decky.logger.info("Fluxer plugin loaded")
        if self._read_settings().get("autostart"):
            asyncio.create_task(self.start())

    async def _unload(self):
        # Fluxer outlives plugin reloads: killing it here would drop a running
        # voice call. Only the panel's Stop button ends it.
        if self._session:
            await self._session.close()
        decky.logger.info("Fluxer plugin unloaded")

    # --- process control -------------------------------------------------

    def _install_dir(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "fluxer")

    def _find_binary(self) -> tuple[Optional[str], bool]:
        """(path, managed): a system install wins over the plugin's own copy."""
        system = shutil.which("fluxer") or ("/usr/bin/fluxer" if os.path.exists("/usr/bin/fluxer") else None)
        if system:
            return system, False
        builds = sorted(glob.glob(os.path.join(self._install_dir(), "Fluxer-*", "fluxer")))
        if builds and os.access(builds[-1], os.X_OK):
            return builds[-1], True
        return None, False

    def _fluxer_command(self) -> list[str]:
        binary, managed = self._find_binary()
        binary = binary or "/usr/bin/fluxer"
        # --autostart + the app's own startMinimized setting = window created hidden.
        cmd = [binary, "--autostart", "--ozone-platform=x11", f"--remote-debugging-port={CDP_PORT}"]
        if managed:
            # The extracted chrome-sandbox is not setuid root.
            cmd.append("--no-sandbox")
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
        for _ in range(60):
            if await self._cdp_up():
                break
            await asyncio.sleep(0.5)
        else:
            return {"ok": False, "error": "cdp_timeout"}
        # First run: the setting is not set yet, so the window was shown.
        # Persist it through the app's own bridge and hide the window.
        try:
            await self._wait_for_page()
            await self._evaluate(ENSURE_HIDDEN_JS)
        except Exception as e:
            decky.logger.warning(f"ensure hidden failed: {e}")
        return {"ok": True}

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
        # After a plugin reload the child handle is gone: close the browser
        # gracefully over CDP instead.
        if not own and await self._cdp_up():
            try:
                async with self._session.get(f"{CDP_BASE}/json/version") as r:
                    ws_url = (await r.json())["webSocketDebuggerUrl"]
                async with self._session.ws_connect(ws_url) as ws:
                    await ws.send_json({"id": 1, "method": "Browser.close"})
                    await asyncio.sleep(1)
            except Exception as e:
                decky.logger.warning(f"graceful close failed: {e}")
        return {"ok": True, "stopped_own": own, "still_up": await self._cdp_up()}

    # --- CDP -------------------------------------------------------------

    async def _page_ws_url(self) -> str:
        async with self._session.get(f"{CDP_BASE}/json") as r:
            targets = await r.json()
        for t in targets:
            if t.get("type") == "page" and str(t.get("url", "")).startswith(APP_URL_PREFIX):
                return t["webSocketDebuggerUrl"]
        raise CdpError("no_app_page")

    async def _wait_for_page(self, tries: int = 40):
        for _ in range(tries):
            try:
                await self._page_ws_url()
                return
            except Exception:
                await asyncio.sleep(0.5)
        raise CdpError("no_app_page")

    def _bridge_source(self) -> str:
        with open(BRIDGE_PATH, "r", encoding="utf-8") as f:
            return f.read()

    async def _bridge(self, call: str) -> Any:
        """Evaluate a bridge call, e.g. 'state()' or 'join("123")'."""
        return await self._evaluate(f"(async () => {{ const b = {self._bridge_source()}\n return await b.{call}; }})()")

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
        state: dict = {"running": False, "ready": False, "logged_in": False, "accounts": [], "error": None, "installed": self._find_binary()[0] is not None}
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
        state["active_account"] = None
        state["voice"] = None
        state["guilds"] = []
        state["dms"] = []
        state["friends"] = []
        try:
            live = await self._bridge("state()")
            state["active_account"] = live.get("currentAccountKey")
            state["voice"] = live.get("voice")
            state["guilds"] = live.get("guilds", [])
            state["dms"] = live.get("dms", [])
            state["friends"] = live.get("friends", [])
        except Exception as e:  # logged out / app still booting
            state["error"] = str(e)
        return state

    async def _act(self, call: str) -> dict:
        try:
            await self._bridge(call)
            return {"ok": True}
        except Exception as e:
            decky.logger.error(f"bridge call {call.split('(')[0]} failed: {e}")
            return {"ok": False, "error": str(e)}

    async def get_friends(self) -> dict:
        return await self._bridge("friends()")

    async def friend_request(self, tag: str) -> dict:
        return await self._act(f"friendRequest({json.dumps(tag)})")

    async def friend_accept(self, user_id: str) -> dict:
        return await self._act(f"friendAccept({json.dumps(user_id)})")

    async def friend_remove(self, user_id: str) -> dict:
        return await self._act(f"friendRemove({json.dumps(user_id)})")

    async def open_dm(self, user_id: str) -> dict:
        try:
            return {"ok": True, "id": await self._bridge(f"openDm({json.dumps(user_id)})")}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def get_messages(self, channel_id: str) -> list:
        return await self._bridge(f"messages({json.dumps(channel_id)})")

    async def send_message(self, channel_id: str, content: str) -> dict:
        return await self._act(f"send({json.dumps(channel_id)}, {json.dumps(content)})")

    # --- install -----------------------------------------------------------

    async def install_status(self) -> dict:
        path, managed = self._find_binary()
        return {"installed": path is not None, "managed": managed, **self._install}

    def _extract(self, archive: str, dest: str):
        os.makedirs(dest, exist_ok=True)
        with tarfile.open(archive, "r:gz") as tar:
            base = os.path.realpath(dest)
            for m in tar.getmembers():
                if not os.path.realpath(os.path.join(dest, m.name)).startswith(base + os.sep):
                    raise ValueError(f"unsafe path in archive: {m.name}")
            tar.extractall(dest)

    async def install_fluxer(self, source: Optional[str] = None) -> dict:
        """Download and unpack the official Linux build into the plugin's own dir.

        `source` (a local .tar.gz) is for offline installs and tests.
        """
        if self._install.get("stage") in ("download", "extract"):
            return {"ok": False, "error": "already_installing"}
        dest = self._install_dir()
        archive = source or os.path.join(dest, "download.tar.gz")
        self._install = {"stage": "download", "pct": 0, "error": None}
        try:
            os.makedirs(dest, exist_ok=True)
            if not source:
                arch = "arm64" if platform.machine() in ("aarch64", "arm64") else "x64"
                timeout = ClientTimeout(total=None, sock_connect=15, sock_read=60)
                async with ClientSession(timeout=timeout) as session:
                    async with session.get(FLUXER_DOWNLOAD.format(arch=arch)) as r:
                        if r.status != 200:
                            raise RuntimeError(f"download failed (HTTP {r.status})")
                        total = int(r.headers.get("Content-Length") or 0)
                        done = 0
                        with open(archive, "wb") as f:
                            async for chunk in r.content.iter_chunked(1 << 20):
                                f.write(chunk)
                                done += len(chunk)
                                if total:
                                    self._install["pct"] = int(done * 100 / total)
            self._install.update(stage="extract", pct=100)
            await asyncio.to_thread(self._extract, archive, dest)
            if not source and os.path.exists(archive):
                os.remove(archive)
            self._install = {"stage": "done", "pct": 100, "error": None}
            return {"ok": True}
        except Exception as e:
            decky.logger.error(f"install failed: {e}")
            self._install = {"stage": "error", "pct": 0, "error": str(e)}
            return {"ok": False, "error": str(e)}

    # --- login wizard ------------------------------------------------------
    # Drives Fluxer's own login screens, so instance handling, MFA and captcha
    # stay the app's business. Credentials go straight into the page and are
    # neither stored nor logged.

    async def login_state(self) -> dict:
        if not await self._cdp_up():
            return {"step": "not_running"}
        try:
            await self._wait_for_page(tries=4)
            st = await self._evaluate(LOGIN_STATE_JS)
            # Screens with nothing to decide: accept the first-run defaults and
            # pick e-mail sign-in (browser hand-off needs a desktop browser).
            for _ in range(3):
                step = st.get("step")
                if step == "language":
                    await self._login_click("Continue")
                elif step == "method":
                    await self._login_click("Sign in with email")
                else:
                    break
                await asyncio.sleep(1.2)
                st = await self._evaluate(LOGIN_STATE_JS)
            return st
        except Exception as e:
            return {"step": "unknown", "text": str(e)}

    async def _login_click(self, label: str):
        try:
            await self._evaluate(
                f"(() => {{ const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === {json.dumps(label)}); if (b) b.click(); }})()"
            )
        except CdpError:
            pass  # the page may reload on click

    async def _settle(self, seconds: float = 5.0) -> dict:
        end = asyncio.get_event_loop().time() + seconds
        st: dict = {"step": "unknown"}
        while asyncio.get_event_loop().time() < end:
            await asyncio.sleep(0.8)
            try:
                st = await self._evaluate(LOGIN_STATE_JS)
            except Exception:
                continue  # navigating
        return st

    async def login_back(self) -> dict:
        """One screen back; the e-mail/browser chooser is skipped, as going
        forward skips it."""
        back = "(() => { const b = document.querySelector('[aria-label=\"Go back\"]'); if (b) b.click(); })()"
        st: dict = {"step": "unknown"}
        for _ in range(2):
            try:
                await self._evaluate(back)
            except CdpError:
                pass
            await asyncio.sleep(1.2)
            try:
                st = await self._evaluate(LOGIN_STATE_JS)
            except Exception:
                continue
            if st.get("step") != "method":
                break
        return st

    async def login_choose_instance(self, host: str, is_new: bool = False) -> dict:
        host = (host or "").strip()
        if not host:
            return {"ok": False, "error": "Enter an instance address."}
        try:
            if is_new:
                await self._evaluate(
                    "(() => { const b = [...document.querySelectorAll('button')].find((x) => /Add another instance/i.test(x.textContent)); if (b) b.click(); })()"
                )
                await asyncio.sleep(0.8)
                await self._evaluate(
                    f"(() => {{ const el = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, {json.dumps(host)}); el.dispatchEvent(new Event('input', {{ bubbles: true }})); }})()"
                )
                await asyncio.sleep(0.4)
                await self._login_click("Continue")
            else:
                await self._evaluate(
                    f"(() => {{ const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes({json.dumps(host)})); if (b) b.click(); }})()"
                )
        except CdpError:
            pass
        return {"ok": True, **(await self._settle(4.0))}

    async def login_submit(self, email: str, password: str) -> dict:
        fill = (
            "(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };"
            f"set(document.querySelector('input[name=email]'), {json.dumps(email)});"
            f"set(document.querySelector('input[name=password]'), {json.dumps(password)}); }})()"
        )
        try:
            await self._evaluate(fill)
            await asyncio.sleep(0.4)
            await self._login_click("Sign in")
        except CdpError as e:
            return {"ok": False, "error": "Could not use the login form."}
        return {"ok": True, **(await self._settle(7.0))}

    async def login_code(self, code: str) -> dict:
        try:
            await self._evaluate(
                "(() => { const el = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, "
                + json.dumps(code)
                + "); el.dispatchEvent(new Event('input', { bubbles: true })); })()"
            )
            await asyncio.sleep(0.4)
            for label in ("Verify", "Continue", "Sign in", "Submit"):
                await self._login_click(label)
        except CdpError:
            return {"ok": False, "error": "Could not use the code field."}
        return {"ok": True, **(await self._settle(6.0))}

    # --- plugin settings -------------------------------------------------

    def _settings_path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

    def _read_settings(self) -> dict:
        try:
            with open(self._settings_path(), "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    async def get_settings(self) -> dict:
        st = self._read_settings()
        return {"autostart": bool(st.get("autostart", False)), "menu_entry": bool(st.get("menu_entry", True))}

    async def set_settings(self, patch: dict) -> dict:
        try:
            settings = self._read_settings()
            if "autostart" in patch:
                settings["autostart"] = bool(patch["autostart"])
            if "menu_entry" in patch:
                settings["menu_entry"] = bool(patch["menu_entry"])
            os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
            with open(self._settings_path(), "w", encoding="utf-8") as f:
                json.dump(settings, f)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def join_voice(self, channel_id: str) -> dict:
        return await self._act(f"join({json.dumps(channel_id)})")

    async def leave_voice(self) -> dict:
        return await self._act("leave()")

    async def toggle_stream(self) -> dict:
        return await self._act("toggleStream()")

    async def toggle_mute(self) -> dict:
        return await self._act("toggleMute()")

    async def toggle_deafen(self) -> dict:
        return await self._act("toggleDeafen()")

    async def switch_account(self, account_key: str) -> dict:
        # Goes through the app's own Accounts.switchToAccount; the account
        # store is never written directly.
        return await self._act(f"switchAccount({json.dumps(account_key)})")
