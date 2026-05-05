#!/usr/bin/env bash
# Pipe eslogger events into vault-fs-watcher. Designed to be the ProgramArguments
# entry for a *system* LaunchDaemon (root). Path-filters the JSON stream BEFORE
# parsing because eslogger is global by default and would otherwise emit
# every FS event on the machine.
#
# Requires: eslogger (built-in, macOS 13+); root; Full Disk Access for the
# parent process so the path filter sees vault writes.

set -euo pipefail

# When run from launchd we don't get the user's HOME by default. The plist
# pins HOME=/Users/mitch and WorkingDirectory=/Users/mitch/Projects/espejo.
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

if ! command -v eslogger >/dev/null 2>&1; then
  echo "[run-eslogger] eslogger not found; macOS 13+ required" >&2
  exit 1
fi

if [ "$(id -u)" != "0" ]; then
  echo "[run-eslogger] must run as root (eslogger requires it)" >&2
  exit 1
fi

echo "[run-eslogger] watching: $VAULT_ROOT (root, eslogger)" >&2

# Pre-filter to vault paths with grep -F (literal substring) to keep the
# downstream watcher cheap. We sacrifice events whose JSON happens to mention
# the vault path in some other field, but those are rare enough to ignore.
exec eslogger create unlink rename \
  | grep --line-buffered -F "$VAULT_ROOT" \
  | pnpm -s tsx scripts/vault-fs-watcher.ts --source eslogger
