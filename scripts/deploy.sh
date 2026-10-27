#!/usr/bin/env bash
# Build and install the plugin on a Steam Machine and restart Decky.
# usage: scripts/deploy.sh theupriser@10.0.0.63 [ssh options...]
set -euo pipefail
HOST="${1:?usage: deploy.sh user@host [ssh options]}"; shift || true
SSH=(ssh -o BatchMode=yes "$@")
NAME=steam-fluxer-decky
pnpm run build
STAGE="/tmp/$NAME-deploy"
"${SSH[@]}" "$HOST" "rm -rf $STAGE && mkdir -p $STAGE" 
tar -c dist main.py plugin.json package.json | "${SSH[@]}" "$HOST" "tar -x -C $STAGE"
# The remote login shell may be fish: send the script to bash on stdin.
"${SSH[@]}" "$HOST" "bash -s" <<REMOTE
set -e
DEST=\$HOME/homebrew/plugins/Fluxer
sudo -n mkdir -p "\$DEST"
sudo -n rsync -a --delete $STAGE/ "\$DEST/"
sudo -n systemctl restart plugin_loader
REMOTE
