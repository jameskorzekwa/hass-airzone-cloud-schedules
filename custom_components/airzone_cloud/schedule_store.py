"""Local (HA-owned) schedule storage for the Airzone Cloud integration.

Airzone's own cloud scheduler cannot execute dual heat/cool setpoints (verified:
it stores ``setpoint_air_heat``/``setpoint_air_cool`` in a schedule but never
applies them, and on a ``double_sp`` zone the single auto setpoint is ignored).
So schedules are owned entirely by Home Assistant here and executed by
``scheduler.AirzoneScheduler``.

Schedule dict shape::

    {
      "id": "<uuid>",
      "name": str,
      "enabled": bool,
      "mode": int,            # Airzone mode number (1=auto/heat_cool, 2=cool, 3=heat, ...)
      "days": [int, ...],     # Python weekday(): Mon=0 .. Sun=6
      "hour": int,
      "minutes": int,
      "device_ids": [str],    # Airzone device ids (== climate entity unique_id)
      "setpoint_heat": float | None,   # Celsius, used for auto/heat_cool (target_temp_low)
      "setpoint_cool": float | None,   # Celsius, used for auto/heat_cool (target_temp_high)
      "setpoint": float | None,        # Celsius, single value for non-auto modes
      "tags": [str]                    # free-form labels (UI filter / toggle only)
    }

Tags are a generic, user-defined labelling system (e.g. ``"away"``,
``"winter"``, ``"summer"``, or anything else). They replaced the old fixed
``season``/``away`` fields; legacy schedules are migrated on load
(``season`` value -> a tag, ``away: true`` -> a ``"away"`` tag).

``last_applied`` maps an Airzone device id to the last applied transition key
``"<schedule_id>@<fired_iso>"`` so a reconcile only (re)applies on a NEW period
or a MISSED transition (HA was down/broken), never fighting manual mid-period
changes. It is persisted so the catch-up survives restarts.

``last_reconciled_at`` is the wall-clock time of the last successful reconcile,
persisted across restarts. The scheduler uses it to bound catch-up: a stale
fire is only re-applied if it happened AFTER our last reconcile (i.e., HA was
actually down at the fire time). Without this, a missing/cleared
``last_applied`` would let the reconciler re-apply yesterday's morning
schedule at midnight, clobbering whatever state has accumulated.

``settings`` is a free-form dict of UI-facing preferences. Currently:

* ``setpoint_differential`` (number) + ``setpoint_differential_unit`` ("F"/"C")
  — the minimum gap the card enforces between heat and cool when bumping
  setpoints in either the zone or the schedule UI. Mirrors the Airzone
  backend's differential setting; the user disables enforcement on the
  device side and we enforce it here in the UI instead, so the device
  doesn't quietly widen the band an hour after we set it.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

STORAGE_KEY = "airzone_cloud_ha_schedules"
STORAGE_VERSION = 1

# Sensible first-install default: 2°F (the Airzone backend's own default).
# Stored with the unit it was entered in to avoid round-trip rounding.
DEFAULT_SETTINGS: dict[str, Any] = {
    "setpoint_differential": 2,
    "setpoint_differential_unit": "F",
}


def normalize_tags(value: Any) -> list[str]:
    """Coerce arbitrary input into a clean tag list.

    Accepts a list (or a bare string); strips whitespace, drops empties, and
    de-duplicates case-insensitively while preserving order and the first
    casing seen. Anything falsy yields ``[]``.
    """
    if not value:
        return []
    if isinstance(value, str):
        value = [value]
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        if item is None:
            continue
        tag = str(item).strip()
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
    return out


def migrate_schedule_tags(sched: dict) -> dict:
    """Fold the legacy ``season``/``away`` fields into the generic ``tags`` list.

    Mutates and returns ``sched``. If ``tags`` is already present it is just
    normalized; otherwise it is seeded from any legacy ``season`` value and an
    ``away: true`` flag. The legacy keys are always removed.
    """
    tags = list(sched["tags"]) if isinstance(sched.get("tags"), list) else []
    if not tags:
        season = sched.get("season")
        if season:
            tags.append(season)
        if sched.get("away"):
            tags.append("away")
    sched.pop("season", None)
    sched.pop("away", None)
    sched["tags"] = normalize_tags(tags)
    return sched


class HAScheduleStore:
    """HA-owned schedule definitions + per-device last-applied transition state."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict = {
            "schedules": [],
            "last_applied": {},
            "last_reconciled_at": None,
            "settings": dict(DEFAULT_SETTINGS),
        }

    async def load(self) -> None:
        stored = await self._store.async_load()
        if stored and isinstance(stored, dict):
            settings = dict(DEFAULT_SETTINGS)
            settings.update(stored.get("settings") or {})
            self._data = {
                "schedules": stored.get("schedules", []),
                "last_applied": stored.get("last_applied", {}),
                "last_reconciled_at": stored.get("last_reconciled_at"),
                "settings": settings,
            }
            # Migrate legacy season/away fields into generic tags.
            for sched in self._data["schedules"]:
                migrate_schedule_tags(sched)
        else:
            self._data = {
                "schedules": [],
                "last_applied": {},
                "last_reconciled_at": None,
                "settings": dict(DEFAULT_SETTINGS),
            }

    async def _save(self) -> None:
        await self._store.async_save(self._data)

    # --- schedules ---

    def list_schedules(self) -> list[dict]:
        return list(self._data["schedules"])

    def get_schedule(self, schedule_id: str) -> dict | None:
        return next((s for s in self._data["schedules"] if s.get("id") == schedule_id), None)

    async def add_schedule(self, schedule: dict) -> dict:
        sched = dict(schedule)
        sched.setdefault("id", uuid.uuid4().hex)
        sched.setdefault("enabled", True)
        migrate_schedule_tags(sched)  # normalize tags + drop any legacy season/away
        self._data["schedules"].append(sched)
        await self._save()
        return sched

    async def update_schedule(self, schedule_id: str, changes: dict) -> dict | None:
        changes = {k: v for k, v in changes.items() if k != "id"}  # never let id change
        if "tags" in changes:
            changes["tags"] = normalize_tags(changes["tags"])
        # Legacy keys are no longer stored; never let them sneak back in.
        changes.pop("season", None)
        changes.pop("away", None)
        for sched in self._data["schedules"]:
            if sched.get("id") == schedule_id:
                sched.update(changes)
                await self._save()
                return sched
        return None

    async def remove_schedule(self, schedule_id: str) -> bool:
        before = len(self._data["schedules"])
        self._data["schedules"] = [s for s in self._data["schedules"] if s.get("id") != schedule_id]
        if len(self._data["schedules"]) != before:
            await self._save()
            return True
        return False

    # --- last-applied transition tracking ---

    def get_last_applied(self, device_id: str) -> str | None:
        return self._data["last_applied"].get(device_id)

    def get_all_last_applied(self) -> dict:
        return dict(self._data["last_applied"])

    async def set_last_applied(self, device_id: str, transition_key: str) -> None:
        self._data["last_applied"][device_id] = transition_key
        await self._save()

    async def clear_last_applied(self, device_id: str | None = None) -> None:
        """Clear last-applied state (used to simulate/force a missed-transition catch-up)."""
        if device_id is None:
            self._data["last_applied"] = {}
        else:
            self._data["last_applied"].pop(device_id, None)
        await self._save()

    # --- last-reconciled wall time (catch-up bound) ---

    def get_last_reconciled_at(self) -> datetime | None:
        v = self._data.get("last_reconciled_at")
        if not v:
            return None
        if isinstance(v, datetime):
            return v
        try:
            return datetime.fromisoformat(v)
        except (TypeError, ValueError):
            return None

    async def set_last_reconciled_at(self, dt: datetime) -> None:
        self._data["last_reconciled_at"] = dt.isoformat(timespec="seconds")
        await self._save()

    # --- settings ---

    def get_settings(self) -> dict:
        return dict(self._data.get("settings") or {})

    async def update_settings(self, changes: dict) -> dict:
        """Patch the settings dict and persist. Returns the new settings."""
        settings = dict(self._data.get("settings") or {})
        settings.update(changes)
        self._data["settings"] = settings
        await self._save()
        return settings
