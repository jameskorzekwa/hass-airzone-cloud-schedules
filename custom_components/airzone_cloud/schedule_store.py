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
      "season": str | None,            # winter | summer | None  (UI filter only)
      "away": bool
    }

``last_applied`` maps an Airzone device id to the last applied transition key
``"<schedule_id>@<fired_iso>"`` so a reconcile only (re)applies on a NEW period
or a MISSED transition (HA was down/broken), never fighting manual mid-period
changes. It is persisted so the catch-up survives restarts.
"""

from __future__ import annotations

import uuid

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

STORAGE_KEY = "airzone_cloud_ha_schedules"
STORAGE_VERSION = 1


class HAScheduleStore:
    """HA-owned schedule definitions + per-device last-applied transition state."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict = {"schedules": [], "last_applied": {}}

    async def load(self) -> None:
        stored = await self._store.async_load()
        if stored and isinstance(stored, dict):
            self._data = {
                "schedules": stored.get("schedules", []),
                "last_applied": stored.get("last_applied", {}),
            }
        else:
            self._data = {"schedules": [], "last_applied": {}}

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
        sched.setdefault("season", None)
        sched.setdefault("away", False)
        self._data["schedules"].append(sched)
        await self._save()
        return sched

    async def update_schedule(self, schedule_id: str, changes: dict) -> dict | None:
        changes = {k: v for k, v in changes.items() if k != "id"}  # never let id change
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
