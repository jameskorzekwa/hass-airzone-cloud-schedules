# CLAUDE.md — agent operating rules

Home Assistant custom integration (`custom_components/airzone_cloud/`) + a Lovelace
card. Schedules are HA-owned (`scheduler.py` / `schedule_store.py`); the Airzone
cloud scheduler is intentionally deactivated.

## Commands (run these to verify — do not assume)

- Tests: `python3 -m pytest tests/ -q`
- Lint: `python3 -m ruff check custom_components tests`
- Python syntax: `python3 -m py_compile <file>`
- Card JS syntax: `node --check custom_components/airzone_cloud/airzone-schedules-card.js`

## Engineering rules (YOU MUST)

- **Tests are mandatory.** Every new feature ships with tests. Every bug fix
  ships with a regression test that **fails before the fix and passes after**
  (write it first, watch it fail, then fix). No "done" without it.
- **Verify before claiming done.** Run the full test suite + ruff + a syntax
  check on every changed file. If you can't verify a change, say so explicitly —
  never report unverified work as working.
- **Fix root causes, not symptoms.** No swallowing errors, no suppressing
  warnings, no hardcoding around a failure. Explain the actual cause.
- **Explore → plan → implement → verify.** For multi-file or unfamiliar changes,
  understand the code and state the plan before editing. Skip the ceremony only
  for one-line/obvious changes.
- **Smallest correct diff.** Match the surrounding code's style, naming, and
  patterns. Don't refactor or reformat unrelated code in the same change.
- **Report faithfully.** If tests fail, show the output. If a step was skipped,
  say so. State what was verified and what wasn't.
- **Self-correct, don't thrash.** If a fix fails twice on the same issue, stop,
  re-read the code, and form a new hypothesis before trying again.

## Definition of Done (a change is not "done" until ALL are true)

1. New feature → tests added; bug fix → regression test that failed before, passes now.
2. `python3 -m pytest tests/ -q` — full suite green (not just new tests).
3. `python3 -m ruff check custom_components tests` — clean.
4. Syntax check passed on every changed file (`py_compile` / `node --check`).
5. Card change → both copies byte-identical.
6. Outcome reported honestly, incl. anything unverified or deferred.

## Boundaries

- **Always:** keep both copies of `airzone-schedules-card.js` (repo root +
  `custom_components/airzone_cloud/`) byte-identical; `git pull` before starting
  work; checksum-verify any deploy.
- **Ask first:** restarting/​reloading the live HA server; deploying to the live
  server; `git commit`/`push`; deleting user data; schema/storage format changes.
- **Never:** commit secrets or the HA token; weaken or delete a test to make it
  pass; push to `main` directly; report green when it isn't.

## Project gotchas (non-obvious — get these wrong and it breaks)

- Schedule `days` use JS `getDay()` numbering: **Sun=0 … Sat=6** (the card's
  `DAY_LABELS` order). Python `scheduler.get_last_fired` converts via
  `(weekday()+1)%7`. Tests must cover day-specific (not just all-days) schedules.
- Python changes to the custom component need a **full HA restart**; a
  config-entry reload is not enough. The card's cache-bust version also only
  re-stamps on full restart — hard-refresh the browser after card deploys.
- Deploy targets on the HA host: `custom_components/airzone_cloud/` **and**
  `config/www/` for the card. Verify with `sha1sum` after `scp`.
- `pyproject.toml`: ruff line-length 120, target py312; pytest `asyncio_mode=auto`.
