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
import pwd
import re
import shutil
import signal
import ssl
import subprocess
import tarfile
from typing import Any, Optional

import decky  # type: ignore
from aiohttp import ClientError, ClientSession, ClientTimeout, TCPConnector, WSMsgType, web  # type: ignore

BRIDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "defaults", "bridge.js")
CDP_PORT = 9224
CDP_BASE = f"http://127.0.0.1:{CDP_PORT}"
APP_URL_PREFIX = "fluxer-app://"
# Official desktop build (tar.gz): installs without root, so it also works on a
# read-only SteamOS root.
FLATPAK_APP = "app.fluxer.Fluxer"
FLATHUB_REPO = "https://dl.flathub.org/repo/flathub.flatpakrepo"
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


# Screen share in Game Mode. The window X11 capture of Fluxer sees only black
# under gamescope, so the screen comes from gamescope's own PipeWire stream:
# GStreamer encodes it to H.264, a local websocket hands it to Fluxer's page,
# which decodes it into the video track Fluxer shares.
STREAM_RESOLUTIONS = {"720p": (1280, 720, 3000), "1080p": (1920, 1080, 6000), "1440p": (2560, 1440, 10000)}
STREAM_FPS = (15, 30, 60)
AU_MARKER = b"\x00\x00\x00\x01\x09"  # access unit delimiter: starts every frame

# Decky's bundled Python does not always find the system certificates.
CA_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
)


def tls_context() -> ssl.SSLContext:
    for path in CA_BUNDLES:
        if os.path.exists(path):
            return ssl.create_default_context(cafile=path)
    return ssl.create_default_context()


class CdpError(Exception):
    pass


# Failures worth one more try: the page was reloading or the socket dropped.
TRANSIENT = ("ws_closed", "no_app_page", "Execution context was destroyed", "Cannot find context")
EVAL_TIMEOUT = 15


class Plugin:
    _proc: Optional[subprocess.Popen] = None
    _session: Optional[ClientSession] = None
    _install: dict = {"stage": "idle", "pct": 0, "error": None}
    _lock: Optional[asyncio.Lock] = None
    _stream: Optional[dict] = None
    _starting: bool = False

    # --- lifecycle -------------------------------------------------------

    async def _main(self):
        self._session = ClientSession(timeout=ClientTimeout(total=5))
        self._lock = asyncio.Lock()
        decky.logger.info("Fluxer plugin loaded")

    async def _unload(self):
        # Fluxer outlives plugin reloads: killing it here would drop a running
        # voice call. Only the panel's Stop button ends it. A running screen
        # share is stopped: its capture process belongs to this plugin instance.
        await self._stop_stream_backend()
        if self._session:
            await self._session.close()
        decky.logger.info("Fluxer plugin unloaded")

    # --- process control -------------------------------------------------

    def _install_dir(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "fluxer")

    def _user_home(self) -> str:
        return getattr(decky, "DECKY_USER_HOME", None) or os.path.expanduser("~")

    def _user_env(self) -> dict:
        """Environment of the desktop user's session, for Flatpak and Fluxer."""
        env = dict(os.environ)
        env.setdefault("DISPLAY", ":0")
        env.setdefault("XDG_SESSION_TYPE", "x11")
        try:
            uid = pwd.getpwnam(decky.DECKY_USER).pw_uid if decky.DECKY_USER else os.getuid()
        except KeyError:
            uid = os.getuid()
        env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{uid}")
        env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{uid}/bus")
        return env

    def _as_user(self, cmd: list[str]) -> list[str]:
        # Decky may run as root; Flatpak and Fluxer belong to the desktop user.
        if os.getuid() == 0 and decky.DECKY_USER:
            return ["runuser", "-u", decky.DECKY_USER, "--"] + cmd
        return cmd

    def _flatpak_installed(self) -> bool:
        """Cheap file check (this runs on every state poll): user or system install."""
        return any(
            os.path.isdir(os.path.join(base, "app", FLATPAK_APP))
            for base in (os.path.join(self._user_home(), ".local/share/flatpak"), "/var/lib/flatpak")
        )

    def _find_binary(self) -> tuple[Optional[str], bool]:
        """(path, managed) of a native or plugin-managed copy; a native install wins."""
        system = shutil.which("fluxer") or ("/usr/bin/fluxer" if os.path.exists("/usr/bin/fluxer") else None)
        if system:
            return system, False
        builds = sorted(glob.glob(os.path.join(self._install_dir(), "Fluxer-*", "fluxer")))
        if builds and os.access(builds[-1], os.X_OK):
            return builds[-1], True
        return None, False

    def _is_installed(self) -> bool:
        return self._find_binary()[0] is not None or self._flatpak_installed()

    def _fluxer_command(self) -> list[str]:
        args = ["--autostart", "--ozone-platform=x11", f"--remote-debugging-port={CDP_PORT}"]
        native, managed = self._find_binary()
        # Order: native package, then the Flatpak, then the plugin's own copy.
        if native and not managed:
            return self._as_user([native] + args)
        if self._flatpak_installed():
            return self._as_user(["flatpak", "run", FLATPAK_APP] + args)
        if native:
            # The extracted chrome-sandbox is not setuid root.
            return self._as_user([native] + args + ["--no-sandbox"])
        return self._as_user(["/usr/bin/fluxer"] + args)

    async def _cdp_up(self) -> bool:
        try:
            async with self._session.get(f"{CDP_BASE}/json/version") as r:
                return r.status == 200
        except Exception:
            return False

    async def frontend_loaded(self) -> dict:
        """Called when Steam's interface loads the plugin (Game Mode starting,
        a restart of it, a plugin reload). "Start with Steam" belongs here and
        not in _main: the plugin service can come up before the screen exists,
        and restarting Game Mode does not reload it."""
        if not self._read_settings().get("autostart"):
            return {"ok": True, "started": False}
        if self._starting or await self._cdp_up():
            return {"ok": True, "started": False}
        self._starting = True
        try:
            res = await self.start()
        finally:
            self._starting = False
        decky.logger.info(f"autostart: {res}")
        return {**res, "started": True}

    async def start(self) -> dict:
        if await self._cdp_up():
            return {"ok": True, "already_running": True}
        env = self._user_env()
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

    def _bridge_version(self) -> int:
        m = re.search(r"const VERSION = (\d+);", self._bridge_source())
        return int(m.group(1)) if m else 0

    async def _bridge(self, call: str) -> Any:
        """Evaluate a bridge call, e.g. 'state()' or 'join("123")'.

        The bridge is injected once per page load; if the page was reloaded
        (or Fluxer updated) it is injected again and the call retried.
        """
        version = self._bridge_version()
        expr = (
            "(async () => { const b = window.__fluxerDeck && window.__fluxerDeck.v === "
            f"{version} ? window.__fluxerDeck : null; if (!b) return {{ __missing: true }}; return await b.{call}; }})()"
        )
        res = await self._evaluate(expr)
        if isinstance(res, dict) and res.get("__missing"):
            await self._evaluate(self._bridge_source())
            res = await self._evaluate(expr)
            if isinstance(res, dict) and res.get("__missing"):
                raise CdpError("bridge_unavailable")
        return res

    async def _evaluate(self, expression: str) -> Any:
        """One CDP evaluation at a time, bounded, retried once if the page was
        mid-reload. Serialising keeps the 3 s poll from piling up behind a slow
        page."""
        assert self._lock is not None
        async with self._lock:
            for attempt in (1, 2):
                try:
                    return await asyncio.wait_for(self._evaluate_once(expression), EVAL_TIMEOUT)
                except (CdpError, ClientError, OSError, asyncio.TimeoutError) as e:
                    transient = isinstance(e, (ClientError, OSError, asyncio.TimeoutError)) or any(t in str(e) for t in TRANSIENT)
                    if attempt == 2 or not transient:
                        if isinstance(e, asyncio.TimeoutError):
                            raise CdpError("timeout") from e
                        raise
                    await asyncio.sleep(0.8)

    async def _evaluate_once(self, expression: str) -> Any:
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
                    ex = res["exceptionDetails"]
                    desc = (ex.get("exception") or {}).get("description") or ex.get("text", "js_exception")
                    raise CdpError(str(desc).splitlines()[0])
                return res["result"].get("value")
        raise CdpError("ws_closed")

    # --- state for the frontend -----------------------------------------

    async def get_state(self) -> dict:
        state: dict = {"running": False, "ready": False, "logged_in": False, "accounts": [], "error": None, "installed": self._is_installed()}
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
            state["prompt"] = live.get("prompt")
            state["problems"] = live.get("problems", [])
            state["fluxer_version"] = live.get("fluxerVersion")
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

    async def get_diagnostics(self) -> dict:
        """Which features this Fluxer build still supports (settings page)."""
        if not await self._cdp_up():
            return {"running": False, "capabilities": [], "fluxer_version": None}
        try:
            caps = await self._bridge("capabilities()")
            live = await self._bridge("state()")
            return {"running": True, "capabilities": caps, "fluxer_version": live.get("fluxerVersion")}
        except Exception as e:
            return {"running": True, "capabilities": [], "fluxer_version": None, "error": str(e)}

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
        return {"installed": self._is_installed(), "managed": managed, "flatpak": self._flatpak_installed(), **self._install}

    def _extract(self, archive: str, dest: str):
        os.makedirs(dest, exist_ok=True)
        with tarfile.open(archive, "r:gz") as tar:
            base = os.path.realpath(dest)
            for m in tar.getmembers():
                if not os.path.realpath(os.path.join(dest, m.name)).startswith(base + os.sep):
                    raise ValueError(f"unsafe path in archive: {m.name}")
            tar.extractall(dest)

    async def _flatpak(self, args: list[str]) -> asyncio.subprocess.Process:
        return await asyncio.create_subprocess_exec(
            *self._as_user(["flatpak"] + args),
            env=self._user_env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

    async def _install_flatpak(self) -> dict:
        """Install Fluxer from Flathub as a user app, the way Steamcord installs Vesktop."""
        self._install = {"stage": "download", "pct": 0, "error": None}
        tail = ""
        try:
            remote = await self._flatpak(["remote-add", "--user", "--if-not-exists", "flathub", FLATHUB_REPO])
            await remote.communicate()
            proc = await self._flatpak(["install", "--user", "-y", "--noninteractive", "flathub", FLATPAK_APP])
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(512)
                if not chunk:
                    break
                text = chunk.decode("utf-8", "replace")
                tail = (tail + text)[-400:]
                found = re.findall(r"(\d{1,3})%", text)
                if found:
                    self._install["pct"] = min(100, int(found[-1]))
            code = await proc.wait()
            if code != 0:
                raise RuntimeError(f"flatpak install failed ({code}): {tail.strip().splitlines()[-1] if tail.strip() else ''}")
            self._install = {"stage": "done", "pct": 100, "error": None}
            return {"ok": True}
        except Exception as e:
            decky.logger.error(f"flatpak install failed: {e}")
            self._install = {"stage": "error", "pct": 0, "error": str(e)}
            return {"ok": False, "error": str(e)}

    async def install_fluxer(self, source: Optional[str] = None) -> dict:
        """Download and unpack the official Linux build into the plugin's own dir.

        `source` (a local .tar.gz) is for offline installs and tests.
        """
        if self._install.get("stage") in ("download", "extract"):
            return {"ok": False, "error": "already_installing"}
        if not source and self._is_installed():
            # Never install a second copy next to one that is already there.
            return {"ok": True, "already_installed": True}
        if not source and shutil.which("flatpak"):
            return await self._install_flatpak()
        dest = self._install_dir()
        archive = source or os.path.join(dest, "download.tar.gz")
        self._install = {"stage": "download", "pct": 0, "error": None}
        try:
            os.makedirs(dest, exist_ok=True)
            if not source:
                arch = "arm64" if platform.machine() in ("aarch64", "arm64") else "x64"
                timeout = ClientTimeout(total=None, sock_connect=15, sock_read=60)
                async with ClientSession(timeout=timeout, connector=TCPConnector(ssl=tls_context())) as session:
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
        return {
            "autostart": bool(st.get("autostart", False)),
            "menu_entry": bool(st.get("menu_entry", True)),
            "stream_res": st.get("stream_res") if st.get("stream_res") in STREAM_RESOLUTIONS else "720p",
            "stream_fps": st.get("stream_fps") if st.get("stream_fps") in STREAM_FPS else 30,
            "stream_audio": bool(st.get("stream_audio", True)),
        }

    async def set_settings(self, patch: dict) -> dict:
        try:
            settings = self._read_settings()
            if "autostart" in patch:
                settings["autostart"] = bool(patch["autostart"])
            if "menu_entry" in patch:
                settings["menu_entry"] = bool(patch["menu_entry"])
            before = {k: settings.get(k) for k in ("stream_res", "stream_fps", "stream_audio")}
            if patch.get("stream_res") in STREAM_RESOLUTIONS:
                settings["stream_res"] = patch["stream_res"]
            if patch.get("stream_fps") in STREAM_FPS:
                settings["stream_fps"] = patch["stream_fps"]
            if "stream_audio" in patch:
                settings["stream_audio"] = bool(patch["stream_audio"])
            changed = any(settings.get(k) != before[k] for k in before)
            os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
            with open(self._settings_path(), "w", encoding="utf-8") as f:
                json.dump(settings, f)
            restarting = changed and self._stream is not None
            if restarting:
                # A share that is running picks up the new resolution, frame
                # rate and sound setting right away.
                asyncio.create_task(self._restart_stream())
            return {"ok": True, "restarting_stream": restarting}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def join_voice(self, channel_id: str) -> dict:
        return await self._act(f"join({json.dumps(channel_id)})")

    async def leave_voice(self) -> dict:
        return await self._act("leave()")

    # --- screen share ----------------------------------------------------

    def _stream_params(self) -> tuple[int, int, int, int]:
        cfg = self._read_settings()
        res = cfg.get("stream_res") if cfg.get("stream_res") in STREAM_RESOLUTIONS else "720p"
        fps = cfg.get("stream_fps") if cfg.get("stream_fps") in STREAM_FPS else 30
        w, h, bitrate = STREAM_RESOLUTIONS[res]
        if fps > 30:
            bitrate = int(bitrate * 1.5)
        return w, h, fps, bitrate

    def _screen_node(self) -> Optional[str]:
        """PipeWire node of gamescope's screen; None lets pipewiresrc pick the default."""
        try:
            out = subprocess.run(["pw-dump"], capture_output=True, text=True, timeout=5, env=self._user_env()).stdout
            for n in json.loads(out):
                props = (n.get("info") or {}).get("props") or {}
                if str(props.get("media.class", "")).startswith("Video/") and "gamescope" in str(props.get("node.name", "")).lower():
                    return str(n.get("id"))
        except Exception as e:
            decky.logger.warning(f"pw-dump failed: {e}")
        return None

    def _gst_command(self, w: int, h: int, fps: int, bitrate: int, synthetic: bool = False) -> list[str]:
        if synthetic:  # test pattern instead of the screen
            src = ["videotestsrc", "is-live=true", "pattern=ball"]
        else:
            node = self._screen_node()
            src = ["pipewiresrc", "do-timestamp=true", "keepalive-time=100"] + ([f"target-object={node}"] if node else [])
        return (
            ["gst-launch-1.0", "-q", "-e"] + src
            + ["!", "videoconvert", "!", "videoscale", "!", "videorate", "!", f"video/x-raw,width={w},height={h},framerate={fps}/1",
               "!", "x264enc", "tune=zerolatency", "speed-preset=ultrafast", f"bitrate={bitrate}", f"key-int-max={fps * 2}", "aud=true",
               "!", "video/x-h264,stream-format=byte-stream,profile=baseline", "!", "fdsink", "fd=1"]
        )

    def _default_sink(self) -> Optional[str]:
        try:
            out = subprocess.run(["pactl", "get-default-sink"], capture_output=True, text=True, timeout=5, env=self._user_env())
            return out.stdout.strip() or None
        except Exception as e:
            decky.logger.warning(f"pactl failed: {e}")
            return None

    def _gst_audio_command(self, synthetic: bool = False) -> Optional[list[str]]:
        """System sound as raw 48 kHz stereo PCM. Fluxer encodes it itself."""
        if synthetic:
            src = ["audiotestsrc", "is-live=true", "wave=sine", "freq=440"]
        else:
            sink = self._default_sink()
            if not sink:
                return None
            src = ["pipewiresrc", f"target-object={sink}", "stream-properties=props,stream.capture.sink=true", "do-timestamp=true"]
        return (
            ["gst-launch-1.0", "-q", "-e"] + src
            + ["!", "audioconvert", "!", "audioresample", "!", "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved",
               "!", "fdsink", "fd=1"]
        )

    async def _broadcast(self, payload: bytes) -> None:
        st = self._stream
        for ws in list(st["clients"]) if st else []:
            try:
                await asyncio.wait_for(ws.send_bytes(payload), 0.5)
            except Exception:
                st["clients"].discard(ws)

    async def _audio_pump(self, proc) -> None:
        """20 ms PCM packets, tagged 0x01 (video frames are tagged 0x00)."""
        assert proc.stdout is not None
        size = 3840  # 960 frames * 2 channels * 2 bytes
        buf = b""
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            while len(buf) >= size:
                await self._broadcast(b"\x01" + buf[:size])
                buf = buf[size:]

    async def _stream_ws(self, request):
        ws = web.WebSocketResponse(heartbeat=15)
        await ws.prepare(request)
        if self._stream is not None:
            self._stream["clients"].add(ws)
        try:
            async for _ in ws:
                pass
        finally:
            if self._stream is not None:
                self._stream["clients"].discard(ws)
        return ws

    async def _stream_pump(self, proc) -> None:
        """Cut GStreamer's byte stream into frames (access units) and fan them out."""
        buf = b""
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            starts, pos = [], 0
            while (i := buf.find(AU_MARKER, pos)) >= 0:
                starts.append(i)
                pos = i + 1
            for a, b in zip(starts, starts[1:]):
                await self._broadcast(b"\x00" + buf[a:b])
            buf = buf[starts[-1]:] if starts else buf[-2_000_000:]

    async def _stop_stream_backend(self) -> None:
        st, self._stream = self._stream, None
        if not st:
            return
        proc = st["proc"]
        if proc.returncode is None:
            try:
                proc.send_signal(signal.SIGINT)  # -e: lets GStreamer finish cleanly
                await asyncio.wait_for(proc.wait(), 3)
            except Exception:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        st["task"].cancel()
        aproc = st.get("aproc")
        if aproc is not None and aproc.returncode is None:
            try:
                aproc.send_signal(signal.SIGINT)
                await asyncio.wait_for(aproc.wait(), 3)
            except Exception:
                try:
                    aproc.kill()
                except ProcessLookupError:
                    pass
        if st.get("atask"):
            st["atask"].cancel()
        for ws in list(st["clients"]):
            await ws.close()
        await st["runner"].cleanup()

    async def start_stream(self, synthetic: bool = False, dry_run: bool = False) -> dict:
        if self._stream is not None:
            return {"ok": True, "already": True}
        if not shutil.which("gst-launch-1.0"):
            return {"ok": False, "error": "GStreamer is not installed on this device."}
        w, h, fps, bitrate = self._stream_params()
        runner = None
        try:
            app = web.Application()
            app.add_routes([web.get("/stream", self._stream_ws)])
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
            proc = await asyncio.create_subprocess_exec(
                *self._as_user(self._gst_command(w, h, fps, bitrate, synthetic)),
                env=self._user_env(),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            self._stream = {"proc": proc, "runner": runner, "clients": set(), "task": asyncio.create_task(self._stream_pump(proc)), "port": port}
            audio = bool(self._read_settings().get("stream_audio", True))
            acmd = self._gst_audio_command(synthetic) if audio else None
            if acmd:
                aproc = await asyncio.create_subprocess_exec(
                    *self._as_user(acmd), env=self._user_env(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
                )
                self._stream["aproc"] = aproc
                self._stream["atask"] = asyncio.create_task(self._audio_pump(aproc))
            await self._bridge(f"startStream({port}, {w}, {h}, {fps}, {str(not dry_run).lower()}, {str(bool(acmd)).lower()})")
            return {"ok": True}
        except Exception as e:
            decky.logger.error(f"start_stream failed: {e}")
            if self._stream is None and runner is not None:
                await runner.cleanup()
            await self._stop_stream_backend()
            return {"ok": False, "error": str(e)}

    async def _restart_stream(self) -> None:
        await self.stop_stream()
        await asyncio.sleep(0.5)
        res = await self.start_stream()
        if not res.get("ok"):
            decky.logger.warning(f"stream restart failed: {res.get('error')}")

    async def stop_stream(self) -> dict:
        try:
            await self._bridge("stopStream()")
        except Exception as e:
            decky.logger.warning(f"stopStream in page failed: {e}")
        await self._stop_stream_backend()
        return {"ok": True}

    async def stream_stats(self) -> dict:
        """Frames decoded in the page so far (None when no stream link)."""
        try:
            return {"ok": True, "stats": await self._bridge("streamStats()"), "running": self._stream is not None}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def toggle_stream(self) -> dict:
        return await (self.stop_stream() if self._stream is not None else self.start_stream())

    async def answer_prompt(self, index: int) -> dict:
        return await self._act(f"answerPrompt({int(index)})")

    async def toggle_mute(self) -> dict:
        return await self._act("toggleMute()")

    async def toggle_deafen(self) -> dict:
        return await self._act("toggleDeafen()")

    async def switch_account(self, account_key: str) -> dict:
        # Goes through the app's own Accounts.switchToAccount; the account
        # store is never written directly.
        return await self._act(f"switchAccount({json.dumps(account_key)})")
