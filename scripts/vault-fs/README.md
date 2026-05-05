# Vault FS Monitoring

Stream filesystem events under `~/Documents/Artifacts` to `vault_fs_events` so we
can correlate "Mitch's `rm`" with "Remotely Save dropped a canonical" — the
recurring failure mode tracked in
`Note/Vault Sync Conflicts — Problem Statement.md`.

Two parallel watchers:

| Watcher  | Privilege | Process attribution | Install effort |
|----------|-----------|---------------------|----------------|
| fswatch  | user      | no                  | brew install   |
| eslogger | root      | yes (pid + exe)     | sudo + FDA     |

Both write into the same table; queries can `WHERE source = ...` to pick.

## fswatch (no sudo)

```bash
brew install fswatch
mkdir -p ~/Library/Logs/espejo
cp scripts/vault-fs/com.espejo.vault-fs.fswatch.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.espejo.vault-fs.fswatch.plist

# Verify
tail -f ~/Library/Logs/espejo/vault-fs-fswatch.stderr.log
```

Stop / restart:

```bash
launchctl unload ~/Library/LaunchAgents/com.espejo.vault-fs.fswatch.plist
launchctl load -w ~/Library/LaunchAgents/com.espejo.vault-fs.fswatch.plist
```

## eslogger (sudo, process attribution)

`eslogger` ships with macOS 13+ and requires root. It also requires the running
process to have **Full Disk Access** (System Settings → Privacy & Security →
Full Disk Access) for `/bin/bash` (or whichever shell launchd invokes), because
`~/Documents` is TCC-protected.

```bash
sudo cp scripts/vault-fs/com.espejo.vault-fs.eslogger.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/com.espejo.vault-fs.eslogger.plist
sudo launchctl load -w /Library/LaunchDaemons/com.espejo.vault-fs.eslogger.plist

# Verify
sudo tail -f /var/log/espejo-vault-fs-eslogger.stderr.log
```

If you see `Operation not permitted`, grant Full Disk Access to `/bin/bash`
(or the absolute path of bash from `which bash`) and reload.

Stop:

```bash
sudo launchctl unload /Library/LaunchDaemons/com.espejo.vault-fs.eslogger.plist
```

## Smoke test

```bash
touch ~/Documents/Artifacts/Note/_smoke-test.md
sleep 5
rm ~/Documents/Artifacts/Note/_smoke-test.md
sleep 5

PSQL=/opt/homebrew/opt/libpq/bin/psql
PGURL=$(grep ^DATABASE_URL .env.production.local | cut -d= -f2-)
$PSQL "$PGURL" -c "SELECT ts, source, event_type, path, process_name FROM vault_fs_events WHERE path LIKE '%_smoke-test%' ORDER BY ts;"
```

You should see rows from `fswatch` and (if installed) `eslogger`. The eslogger
rows will have `process_name` populated.

## Useful queries

```sql
-- Last 24h of canonical-loss-window events around a known incident time
SELECT ts, source, event_type, path, process_name, pid
FROM vault_fs_events
WHERE ts BETWEEN '2026-05-05 09:21:00+00' AND '2026-05-05 09:35:00+00'
ORDER BY ts;

-- "Did Remotely Save touch this path before it disappeared?"
SELECT ts, source, event_type, path, process_name
FROM vault_fs_events
WHERE path LIKE '%Weekly Review%'
ORDER BY ts DESC
LIMIT 50;

-- Top processes mutating the vault in the last 24h (eslogger only)
SELECT process_name, event_type, COUNT(*)
FROM vault_fs_events
WHERE source = 'eslogger' AND ts > NOW() - INTERVAL '1 day'
GROUP BY 1, 2
ORDER BY 3 DESC;

-- Cross-check vault delete events against the obsidian sync run that
-- propagated them. Joins on the deleted_paths jsonb array (added in 052).
SELECT r.started_at, r.deleted_paths,
       v.ts AS fs_unlink_ts, v.process_name
FROM obsidian_sync_runs r
LEFT JOIN LATERAL (
  SELECT ts, process_name FROM vault_fs_events
  WHERE event_type = 'unlink'
    AND path = ANY(SELECT jsonb_array_elements_text(r.deleted_paths))
    AND ts BETWEEN r.started_at - INTERVAL '15 min' AND r.started_at
  ORDER BY ts DESC LIMIT 1
) v ON true
WHERE jsonb_array_length(r.deleted_paths) > 0
  AND r.started_at > NOW() - INTERVAL '7 days'
ORDER BY r.started_at DESC;
```

## Volume / housekeeping

Expect ~1k–10k rows/day under normal use. The table has no TTL — add one if
volume grows.

```sql
DELETE FROM vault_fs_events WHERE ts < NOW() - INTERVAL '30 days';
```
