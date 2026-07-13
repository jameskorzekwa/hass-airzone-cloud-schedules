# hass-airzone-cloud-schedules — KNOWLEDGE BASE

## OVERVIEW
HA custom integration that **transparently overrides the core `airzone_cloud`** (same `domain`) to add HA-owned scheduling + a ~115 KB Lovelace card (`airzone-schedules-card.js`). Python 3.12, HA, voluptuous, pytest. Depends on **James's fork** `git+https://github.com/jameskorzekwa/aioairzone-cloud` (in `manifest.json` + `requirements_test.txt`). Also see `CLAUDE.md` (agent operating rules — do not delete).

## STRUCTURE
```
custom_components/airzone_cloud/
  __init__.py            # setup_entry: logs into fork API, boots coordinator, registers card (extra-js + panel), inits scheduler + stores, wires services
  scheduler.py           # ★ AirzoneScheduler — the HA-owned execution engine (largest logic file); also registers the ha_* services the CARD calls
  schedule_store.py      # ★ HAScheduleStore — schedule dicts + last_applied + last_reconciled_at + settings (HA Store, key airzone_cloud_ha_schedules)
  services.py            # legacy-NAMED services (get/post/patch/delete_installation_schedule, toggle_schedule, get/set_schedule_tags) now delegating to the HA store
  store.py               # LEGACY ScheduleTagStore (season/away) — superseded by tags in schedule_store; still loaded, effectively vestigial
  setpoint_util.py       # dep-free setpoint_changed() helper (unit-testable w/o HA climate stack)
  climate.py / entity.py / sensor.py / switch.py / select.py / binary_sensor.py / water_heater.py / coordinator.py / config_flow.py / diagnostics.py  # forked-from-core platforms
  const.py               # DOMAIN="airzone_cloud"
  services.yaml          # UI schema for the legacy-named services only (ha_* + settings services are code-registered, not listed here)
  airzone-schedules-card.js   # the card (COPY A)
airzone-schedules-card.js       # the card (COPY B, repo root) — MUST be byte-identical to COPY A
tests/                    # pytest (python) — test_scheduler.py is 872 lines
tests/card/*.mjs          # node --check-style DOM/logic tests for the card
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/modify a schedule service (card-facing) | `scheduler.py` → `_register_services()` | `ha_schedule_add/update/delete/list/apply_now/clear_last_applied`, `ha_reconcile_now`, `ha_settings_get/update` |
| Add/modify legacy-named service | `services.py` + `services.yaml` | `*_installation_schedule*`, `toggle_schedule`, `*_schedule_tags`; `config_entry` accepted but IGNORED |
| Schedule execution / reconcile logic | `scheduler.py` `async_reconcile`, `get_last_fired`, `_apply`, `_enforce_differential` | 60s interval + startup + HA-started |
| Persisted schedule shape / migration / settings | `schedule_store.py` (module docstring = the schema) | tags migrated from legacy season/away on load |
| Card UI | `custom_components/airzone_cloud/airzone-schedules-card.js` | edit COPY A, then sync COPY B (see ANTI-PATTERNS) |
| Fork dependency | `manifest.json`, `requirements_test.txt` | both pin `jameskorzekwa/aioairzone-cloud` |
| Deploy card to live HA | `.claude/skills/deploy-card/SKILL.md` (`/deploy-card`) | scp both targets + `www/`, sha1 verify, reload entry |

## CODE MAP
- **AirzoneScheduler** (`scheduler.py`): reconciles per zone → picks most-recently-fired *enabled* schedule → builds transition key `"<schedule_id>@<fired_iso>"` → applies only when key ≠ persisted `last_applied` (respects manual mid-period changes). Extras: **differential watchdog** (`_enforce_differential`, heals Aidoo/Mitsubishi band collapse), **post-apply verify** (~90s re-read warns on device snapback), **catch-up bound** via `last_reconciled_at` (stale fire re-applied only if HA was down at fire time). `bypass_catch_up_bound=True` on explicit user add/update/manual reconcile.
- **HAScheduleStore** (`schedule_store.py`): CRUD + `last_applied` + `last_reconciled_at` + `settings` (`setpoint_differential` + unit). `normalize_tags`, `migrate_schedule_tags`.
- **Override mechanism**: this component ships `domain: airzone_cloud` (see `manifest.json`/`const.py`); installed as a custom_component it shadows HA's built-in `airzone_cloud`. Platforms are forked copies of core; the *added* surface is scheduling + card + tags/settings.
- **Two service layers, one store**: `services.py` (backward-compat names, `config_entry` ignored) and `scheduler._register_services` (`ha_*`, used by the card) both read/write the same `HAScheduleStore` and call `async_reconcile`.
- **Mode map** (both Python + card): `1 heat_cool/auto, 2 cool, 3 heat, 4 fan_only, 5 dry, 7 heat`.

## CONVENTIONS
- ruff: line-length 120, target py312, select `E,W,F,I,UP,B,SIM` (E501 ignored); `known-first-party=["custom_components"]`.
- pytest `asyncio_mode=auto`.
- `_apply` writes dual setpoints via `climate.set_temperature` `target_temp_low/high` (needs zone reporting `double_sp` → `TARGET_TEMPERATURE_RANGE`); single via `temperature`; falls back to heat/cool midpoint if a dual schedule's zone only exposes a single setpoint.

## ANTI-PATTERNS / GOTCHAS (THIS PROJECT)
- **Day numbering is JS `getDay()`: Sun=0 … Sat=6** — the card's `DAY_LABELS` order and `scheduler.get_last_fired` (which converts `(weekday()+1)%7`) are authoritative. NOTE: `schedule_store.py`'s docstring comment says "Python weekday Mon=0..Sun=6" — that comment is **stale/inconsistent**; the runtime uses Sun=0. Tests must cover day-specific (not just all-days) schedules.
- **Both card copies MUST stay byte-identical** — pre-commit (`card-copies-in-sync`) and CI `validate` both `diff -q` them; a mismatch fails the build. Edit COPY A under `custom_components/…`, then mirror to root.
- **Python changes need a full HA restart** (config-entry reload is not enough). Card cache-bust version (`?v=<mtime>`) also only re-stamps on full restart → hard-refresh browser after a card deploy.
- Bug fixes get a **regression test that fails before / passes after** (CLAUDE.md rule); `scheduler.py`+`schedule_store.py` are gated at **85% coverage** in CI.
- `store.py` (ScheduleTagStore) is legacy — don't build new features on it; tags now live in `schedule_store`.
- Don't re-expose a delete-ALL service (intentionally omitted — no confirmation UX).

## COMMANDS
```bash
python3 -m pytest tests/ -q                                  # full suite (pre-push hook)
python3 -m ruff check custom_components tests                # lint
node --check custom_components/airzone_cloud/airzone-schedules-card.js   # card syntax
node tests/card/test_*.mjs                                   # card logic tests
# pre-commit: pip install pre-commit && pre-commit install && pre-commit install --hook-type pre-push
```
- **Release**: merge PR to `main` → CI `release` job bumps patch in `manifest.json`, zips `airzone_cloud.zip`, cuts GitHub release. Never commit to `main` directly. "release the changes" = branch → push → PR → merge.

## NOTES
- Airzone's own cloud scheduler is **intentionally, permanently deactivated** — it can't execute dual heat/cool setpoints; HA owns scheduling. The legacy `patch_installation_schedules_activate` service is deliberately gone.
- `config_entry` is threaded through many services purely for backward compatibility and is ignored (scheduling is global/HA-owned).
- HACS install (`hacs.json`, `zip_release`). Card also installable standalone into `config/www/` per README.
