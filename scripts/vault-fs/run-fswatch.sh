#!/usr/bin/env bash
# Pipe fswatch events into vault-fs-watcher. Designed to be the ProgramArguments
# entry for a user-level launchd agent. Logs are stderr → StandardErrorPath.
#
# Requires: fswatch (`brew install fswatch`) on PATH.

set -euo pipefail

# nvm-installed pnpm/tsx aren't on launchd's PATH. Source nvm if present and
# fall back to the active node version's bin dir.
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

if ! command -v fswatch >/dev/null 2>&1; then
  echo "[run-fswatch] fswatch not found on PATH; install with: brew install fswatch" >&2
  exit 1
fi

echo "[run-fswatch] watching: $VAULT_ROOT" >&2

# fswatch flags:
#   -x          extended event flags (the watcher needs these)
#   -r          recursive (default on macOS but explicit)
#   --event-flags-separator (default is space; matches our parser)
#   --exclude   skip noisy plugin/cache trees BEFORE they hit the parser
exec fswatch -x -r \
  --exclude "/\.obsidian/" \
  --exclude "/\.trash/" \
  --exclude "/\.smart-env/" \
  --exclude "/\.git/" \
  --exclude "/\.claude/" \
  --exclude "\.DS_Store$" \
  "$VAULT_ROOT" \
  | pnpm -s tsx scripts/vault-fs-watcher.ts --source fswatch
