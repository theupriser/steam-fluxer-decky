# steam-fluxer-decky

A standalone [Decky Loader](https://decky.xyz) plugin that puts [Fluxer](https://fluxer.app) one step away from the Steam button on a Steam Machine / SteamOS Game Mode, with account switching across Fluxer instances.

**Status: early scaffold.** What works today:

- Start/stop the installed Fluxer desktop app from the Quick Access Menu panel (it is run with `--remote-debugging-port=9224`).
- A "Fluxer" entry in Steam's main menu, shown only when Fluxer is running and logged in. Selecting it opens a view listing your accounts grouped by instance.
- Pressing Steam / Alt+Tab while the view is open closes it and shows the Steam menu.

Not done yet: switching accounts (stubbed), voice and chat in the view, running Fluxer hidden. See [`docs/fluxer-internals.md`](docs/fluxer-internals.md) for what the spike found and the open questions.

## How it works

Fluxer is an Electron app. The backend (`main.py`) starts it with remote debugging and drives its page over the Chrome DevTools Protocol. Account data is sanitized inside the page, so tokens never leave Fluxer. The frontend patches Steam's main menu and registers a `/fluxer` route that opens the view.

## Development

```bash
pnpm install
pnpm run build                      # -> dist/index.js
scripts/deploy.sh user@steammachine # builds, copies to ~/homebrew/plugins/Fluxer, restarts Decky
```

Requires the `fluxer` desktop package on the Steam Machine. `npx tsc --noEmit` is a useful check for errors under `src/`.

## Credits

The Steam menu technique comes from [DeckWebBrowser](https://github.com/jessebofill/DeckWebBrowser) as adapted in [Steamcord](https://github.com/Necrosiak/Steamcord) (BSD-3-Clause).

The Fluxer logo is from the [Fluxer repository](https://github.com/fluxerapp/fluxer) (`fluxer_app/src/media/images/fluxer-logo-color.svg`), CC-BY-SA-4.0, (c) Fluxer Platform AB.
