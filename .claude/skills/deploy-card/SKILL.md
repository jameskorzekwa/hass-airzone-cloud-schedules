---
name: deploy-card
description: Deploy the Lovelace card to the live Home Assistant server (both copies + www) with checksum verification and an integration reload. Manual, side-effecting — invoke with /deploy-card.
disable-model-invocation: true
---

# Deploy the Airzone schedules card to the live HA server

Side-effecting: touches the live HA host. This is an "ask first" action per
CLAUDE.md — confirm with the user before running if not already authorized.

SSH/host details and the HA REST token are NOT in this repo. Read them from
agent memory: `reference_ha_ssh.md` (host/paths) and `reference_ha_token.md`
(REST token). Never echo the token; never write either into the repo.

## Steps

1. **Sync + verify locally**
   - `cp custom_components/airzone_cloud/airzone-schedules-card.js airzone-schedules-card.js`
   - `node --check custom_components/airzone_cloud/airzone-schedules-card.js`
   - `diff -q` the two copies → must be byte-identical.
   - `shasum` the local file; note the hash.

2. **Deploy both server targets** (paths from `reference_ha_ssh`):
   - `scp` the card to `…/custom_components/airzone_cloud/airzone-schedules-card.js`
   - `scp` the card to `…/www/airzone-schedules-card.js`

3. **Verify on server**
   - `sha1sum` both server copies → must equal the local hash and each other.
   - Abort and report if any hash mismatches.

4. **Activate**
   - Reload the integration via the HA REST API
     (`homeassistant.reload_config_entry`, entry id from memory) using the token.
   - Note: a config-entry reload does NOT re-stamp the card cache-bust version
     (only a full HA restart does). Tell the user to hard-refresh the browser
     (Cmd/Ctrl+Shift+R) to pick up the new card.

5. **Report** the local hash, both server hashes (confirm equal), reload HTTP
   status, and the hard-refresh reminder.

Do not restart the whole HA server for a card-only change — reload + hard
refresh is sufficient. A full restart is only needed for Python changes and
requires explicit user approval.
