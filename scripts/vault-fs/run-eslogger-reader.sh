#!/usr/bin/env bash
# Tail the eslogger sink file (populated by the root LaunchDaemon) and pipe
# into vault-fs-watcher. Runs as the user so it can use nvm-installed pnpm/tsx.
#
# `tail -F -n 0` follows by name (handles rotation) starting from the end so
# we don't reprocess history on reload. `--retry` keeps trying if the sink
# file doesn't exist yet (daemon hasn't booted).

set -euo pipefail

SINK="/var/log/espejo-vault-fs.jsonl"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
fi
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_BIN="$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" | tail -1)/bin"
  export PATH="$NVM_BIN:$PATH"
fi

cd "$(dirname "$0")/../.."

if [ -f .env.production.local ]; then
  set -a
  # shellcheck disable=SC1091
  . .env.production.local
  set +a
elif [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
fi

VAULT_ROOT="${VAULT_FS_ROOT:-$HOME/Documents/Artifacts}"
export VAULT_FS_ROOT="$VAULT_ROOT"

echo "[run-eslogger-reader] tailing: $SINK (vault: $VAULT_ROOT)" >&2

exec /usr/bin/tail -F -n 0 "$SINK" \
  | pnpm -s tsx scripts/vault-fs-watcher.ts --source eslogger
