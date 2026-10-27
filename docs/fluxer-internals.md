# Fluxer internals (spike findings)

Spike date: 2026-10-27. Target: Fluxer desktop `2026.1025.12517` (Arch package `fluxer`, Electron 44 / Chrome 152) on the Steam Machine (CachyOS, gamescope session). Sources: `github.com/fluxerapp/fluxer` at `e1760537`.

## Verdict: GO for CDP injection

| Check | Result |
|---|---|
| Start with `--remote-debugging-port=9224` | Works. `/json` lists the app page (`fluxer-app://app/...`), the updater splash and a worker. |
| Reuses the existing login in `~/.config/fluxer` | Yes, app came up logged in. |
| Evaluate JS in the app page | Works (`Runtime.evaluate`). |
| Reach app modules | Works, see below. |
| Account list | Works via the preload bridge, see below. |
| Voice while window hidden under gamescope | **Not tested yet.** |
| Start hidden/minimized | **Not tested yet.** `startMinimized` exists in desktop settings but is documented for autostart launches only. |

Launch used for the spike (transient user unit, stopped afterwards):

```
systemd-run --user --unit=fluxer-spike --setenv=DISPLAY=:0 --setenv=XDG_SESSION_TYPE=x11 \
  /usr/bin/fluxer --ozone-platform=x11 --remote-debugging-port=9224
```

## Reaching modules from injected JS

The web client is bundled with rspack and nothing store-like is on `window`. The bundler's chunk array is, though:

```js
let req;
rspackChunkfluxer_app.push([[Symbol('x')], {}, (r) => { req = r; }]);
// req.m = module factories (3420 modules), req(id) = load/get a module
```

- Minification keeps property names (`toggleSelfMute`, `switchAccount`, `accountKey`, `MediaEngineFacade` all occur in module source), but function names such as `joinCall` are mangled. Locate modules by scanning `req.m[id].toString()` for stable property names, then pick the export by shape. Do not hard-code module ids, they change every build.
- `req.c` (module cache) is absent; calling `req(id)` is how modules are obtained.
- Other globals: `window.__FLUXER_DEBUG__` (client info and voice subscription debug only), `window.electron` (preload bridge), `window.__mobxGlobals`.

Source layout worth knowing (`fluxer_app/src/features/`): `voice/commands/CallCommands.ts` (`joinCall(channelId)`, `leaveCall(channelId)`), `voice/engine/MediaEngineFacade.ts` (LiveKit based), `voice/state/`, `guild/`, `channel/`, `presence/`, `account_engine/`.

## Accounts and "multiple instances"

A Fluxer *instance* is a Fluxer server deployment (hosted fluxer.app or self-hosted, e.g. `https://fluxhouse.eu`). One desktop install can hold several accounts across several instances.

- Desktop main process: `fluxer_desktop/src/main/AccountEngineAccounts.ts`, `AccountEngineHost.ts`, `AccountMenu.ts`. Each stored account has an `accountKey`, an `instanceHost` (derived from `instance.webAppEndpoint` or the API endpoint) and a `switcherPosition`. The tray menu switches with `switchAccount(accountKey)`.
- Preload bridge (all available on `window.electron` in the page):
  - `desktopAccounts`: `getAll`, `get`, `upsert`, `compareAndSwap`, `delete`, `import`, `prune`.
  - `accountEngine`: `isAvailable`, `request`, `onEvent`, `provideAccounts`.
  - `desktopKnownInstances`: `getAll`, `upsert`, `delete`.
- `desktopAccounts.getAll()` returns `{storageKey, record}` entries. `record` keys: `userId`, `localStorageData`, `lastActive`, `userData`, `managedStorageData`, `isValid`, `instance`, `storageKey`. **Treat `localStorageData` / `managedStorageData` as secrets (they hold tokens): never log or send them.** The plugin must only surface `userId`, display name, instance host and the account key.
- The renderer also contains a `switchAccount` code path (several modules reference it); the account switcher UI should be driven through that, not by writing storage directly.

## Open questions for the build

1. Hidden/minimized start and voice (mic in, audio out) with the window hidden in gamescope.
2. Which module/export pair performs: join voice, leave, mute, deafen, start DM call, send message, switch account. Find by property name at runtime and feature-detect.
3. Whether two Fluxer instances (accounts) can be connected at the same time or only one active account at a time. Check `AccountEngineHost.ts`.
4. How to reflect state changes to the plugin (MobX `reaction`/`autorun` on the stores found above vs. polling).
