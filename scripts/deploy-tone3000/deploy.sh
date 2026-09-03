#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Push the TONE3000 integration to a mod-ui device over SSH and apply it there.
#
# Copies apply.py plus the three asset files (from this checkout) to the device,
# then runs apply.py under sudo. apply.py backs up every file it touches and rolls
# everything back if the service does not come back healthy.
#
#   ./deploy.sh --host patch@patchbox.local --key t3k_pub_xxxxxxxx
#   ./deploy.sh --host patch@patchbox.local --key @~/.secrets/t3k.key
#   ./deploy.sh --host patch@patchbox.local --dry-run
#   ./deploy.sh --host patch@patchbox.local --rollback
#
# SSH auth is whatever your ssh/ssh-agent already does for --host (key-based
# recommended). The key is never written into this repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
REMOTE_DIR="/tmp/mod-ui-tone3000"

HOST=""
KEY=""
PASS_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --key)  KEY="$2";  shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --dry-run|--rollback|--no-restart|--no-grid) PASS_ARGS+=("$1"); shift ;;
    --html-dir|--mod-dir|--data-dir|--service|--port) PASS_ARGS+=("$1" "$2"); shift 2 ;;
    -h|--help) sed -n '4,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$HOST" ] || { echo "need --host user@address" >&2; exit 2; }

# --key @file  ->  read the key out of that file
if [ "${KEY:0:1}" = "@" ]; then
  KEY="$(tr -d '[:space:]' < "${KEY:1}")"
fi

ASSET_SRC=(
  "$REPO/html/js/tone3000.js"
  "$REPO/html/tone3000-callback.html"
  "$REPO/html/tone3000-connect.html"
  "$REPO/html/img/tone3000-icon.png"
  "$REPO/html/js/grid-tone3000.js"
  "$REPO/html/grid.html"
  "$REPO/html/css/grid-dashboard.css"
)
for f in "${ASSET_SRC[@]}"; do
  [ -f "$f" ] || { echo "missing asset in repo: $f" >&2; exit 1; }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/assets"
cp "$HERE/apply.py" "$STAGE/"
cp "${ASSET_SRC[@]}" "$STAGE/assets/"

echo ">> copying to $HOST:$REMOTE_DIR"
ssh "$HOST" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
scp -q -r "$STAGE/." "$HOST:$REMOTE_DIR/"

REMOTE_CMD="sudo python3 $REMOTE_DIR/apply.py --assets $REMOTE_DIR/assets"
[ -n "$KEY" ] && REMOTE_CMD="$REMOTE_CMD --key '$KEY'"
for a in "${PASS_ARGS[@]}"; do REMOTE_CMD="$REMOTE_CMD '$a'"; done

echo ">> running apply.py on $HOST"
set +e
ssh -t "$HOST" "$REMOTE_CMD"
rc=$?
set -e

echo ">> cleaning up $HOST:$REMOTE_DIR"
ssh "$HOST" "rm -rf $REMOTE_DIR" || true

exit $rc
