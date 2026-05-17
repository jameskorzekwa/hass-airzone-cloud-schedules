"""HA-owned scheduler for Airzone zones.

Reconciles every 60s and on HA start / integration reload. For each zone it
finds the most-recently-fired *enabled* schedule and builds a transition key
``"<schedule_id>@<fired_iso>"``. It (re)applies only when that key differs from
the persisted last-applied key, so:

* a new schedule period -> applied,
* a transition missed while HA was down/broken -> applied on the next
  reconcile / on startup (the safeguard),
* the same period already applied -> left alone (manual mid-period changes are
  respected).

Dual setpoints are applied via ``climate.set_temperature`` with
``target_temp_low``/``target_temp_high`` (works because the zone reports
``double_sp`` -> the climate entity exposes TARGET_TEMPERATURE_RANGE).
"""

from __future__ import annotations

import contextlib
import logging
from datetime import datetime, timedelta

import voluptuous as vol
from homeassistant.components.climate import ClimateEntityFeature
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN
from .schedule_store import HAScheduleStore

_LOGGER = logging.getLogger(__name__)

RECONCILE_INTERVAL = timedelta(seconds=60)

# Airzone schedule mode number -> HA HVAC mode string
SCHEDULE_MODE_TO_HVAC: dict[int, str] = {
    1: "heat_cool",
    2: "cool",
    3: "heat",
    4: "fan_only",
    5: "dry",
    7: "heat",
}


def get_last_fired(schedule: dict, now: datetime) -> datetime | None:
    """Most recent datetime this schedule would have fired at/just before ``now``.

    ``days`` entries use the card's day numbering (JS ``Date.getDay()``):
    Sun=0, Mon=1, ... Sat=6. Python ``datetime.weekday()`` is Mon=0..Sun=6, so
    convert with ``(weekday() + 1) % 7`` to match what the editor stores.
    """
    days = schedule.get("days") or []
    hour = schedule.get("hour")
    if not days or hour is None:
        return None
    minutes = schedule.get("minutes") or 0
    today = (now.weekday() + 1) % 7  # -> Sun=0..Sat=6 (matches the card)
    now_mins = now.hour * 60 + now.minute
    sched_mins = hour * 60 + minutes
    # range(8): offset 0 = today, 1..6 = previous days, 7 = same weekday last
    # week (covers a once-weekly schedule whose time hasn't passed today yet).
    for offset in range(8):
        check_day = (today - offset) % 7
        if check_day not in days:
            continue
        if offset == 0:
            if now_mins >= sched_mins:
                return now.replace(hour=hour, minute=minutes, second=0, microsecond=0)
            continue
        d = now - timedelta(days=offset)
        return d.replace(hour=hour, minute=minutes, second=0, microsecond=0)
    return None


class AirzoneScheduler:
    """Owns schedule execution for Airzone zones (replaces the Airzone cloud scheduler)."""

    def __init__(self, hass: HomeAssistant, store: HAScheduleStore) -> None:
        self.hass = hass
        self.store = store
        self._unsubs: list = []
        self._started_unsub = None

    # --- lifecycle ---

    async def async_start(self) -> None:
        self._unsubs.append(
            async_track_time_interval(self.hass, self._interval_cb, RECONCILE_INTERVAL)
        )
        if self.hass.is_running:
            await self.async_reconcile("startup")
        else:
            self._started_unsub = self.hass.bus.async_listen_once(
                EVENT_HOMEASSISTANT_STARTED, self._started_cb
            )
        self._register_services()

    async def async_stop(self) -> None:
        if self._started_unsub is not None:
            with contextlib.suppress(Exception):
                self._started_unsub()
            self._started_unsub = None
        for unsub in self._unsubs:
            with contextlib.suppress(Exception):
                unsub()
        self._unsubs.clear()

    async def _interval_cb(self, _now) -> None:
        await self.async_reconcile("interval")

    async def _started_cb(self, _event) -> None:
        self._started_unsub = None  # once-listener auto-removes itself after firing
        await self.async_reconcile("ha_started")

    # --- core reconcile ---

    def _device_entity_map(self) -> dict[str, str]:
        """Airzone device id -> this integration's climate entity id."""
        registry = er.async_get(self.hass)
        out: dict[str, str] = {}
        for entry in registry.entities.values():
            if entry.platform == DOMAIN and entry.entity_id.startswith("climate."):
                out[entry.unique_id] = entry.entity_id
        return out

    async def async_reconcile(self, reason: str) -> None:
        try:
            schedules = [s for s in self.store.list_schedules() if s.get("enabled", True)]
            if not schedules:
                return
            device_map = self._device_entity_map()
            if not device_map:
                return
            now = datetime.now()

            # For each Airzone device, pick the most-recently-fired enabled schedule.
            for device_id, entity_id in device_map.items():
                best = None
                best_time = None
                for sched in schedules:
                    if device_id not in (sched.get("device_ids") or []):
                        continue
                    fired = get_last_fired(sched, now)
                    if fired and (best_time is None or fired > best_time):
                        best_time = fired
                        best = sched
                if not best:
                    continue

                key = f"{best['id']}@{best_time.isoformat(timespec='minutes')}"
                if self.store.get_last_applied(device_id) == key:
                    continue  # same period already applied — respect manual changes

                applied = await self._apply(entity_id, best)
                if applied:
                    await self.store.set_last_applied(device_id, key)
                    _LOGGER.info(
                        "Airzone scheduler (%s): applied '%s' to %s [%s]",
                        reason, best.get("name"), entity_id, key,
                    )
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Airzone scheduler reconcile failed (%s)", reason)

    def _to_ha_temp(self, celsius: float) -> float:
        unit = self.hass.config.units.temperature_unit
        if unit == "°F":
            return round(celsius * 9 / 5 + 32)
        return celsius

    async def _apply(self, entity_id: str, sched: dict) -> bool:
        hvac = SCHEDULE_MODE_TO_HVAC.get(sched.get("mode"))
        state = self.hass.states.get(entity_id)
        if state is None:
            _LOGGER.warning("Airzone scheduler: entity %s unavailable, skipping", entity_id)
            return False

        if hvac:
            try:
                await self.hass.services.async_call(
                    "climate", "set_hvac_mode",
                    {"entity_id": entity_id, "hvac_mode": hvac}, blocking=True,
                )
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Airzone scheduler: set_hvac_mode failed for %s", entity_id)

        sf = state.attributes.get("supported_features", 0)
        supports_range = bool(sf & ClimateEntityFeature.TARGET_TEMPERATURE_RANGE)
        sp_heat = sched.get("setpoint_heat")
        sp_cool = sched.get("setpoint_cool")
        sp_single = sched.get("setpoint")

        try:
            if hvac == "heat_cool" and supports_range and sp_heat is not None and sp_cool is not None:
                await self.hass.services.async_call(
                    "climate", "set_temperature",
                    {
                        "entity_id": entity_id,
                        "target_temp_low": self._to_ha_temp(sp_heat),
                        "target_temp_high": self._to_ha_temp(sp_cool),
                    },
                    blocking=True,
                )
            elif sp_single is not None:
                await self.hass.services.async_call(
                    "climate", "set_temperature",
                    {"entity_id": entity_id, "temperature": self._to_ha_temp(sp_single)},
                    blocking=True,
                )
            else:
                _LOGGER.warning(
                    "Airzone scheduler: '%s' has no usable setpoint for %s (range=%s)",
                    sched.get("name"), entity_id, supports_range,
                )
                return False
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Airzone scheduler: set_temperature failed for %s", entity_id)
            return False
        return True

    async def _force_devices(self, sched: dict | None) -> None:
        """Clear last-applied for a schedule's zones so the next reconcile
        re-applies the currently-active schedule immediately.

        An explicit add/enable/update is deliberate user intent — unlike a
        passive mid-period manual nudge — so the change should take effect now,
        even if the transition key is unchanged (e.g. only the setpoints were
        edited on the already-active schedule). The autonomous interval/startup
        reconciles still skip on an unchanged key, preserving manual overrides.
        """
        if not sched:
            return
        for dev in sched.get("device_ids") or []:
            await self.store.clear_last_applied(dev)

    # --- schedule CRUD + admin services (called by the card) ---

    def _register_services(self) -> None:
        store = self.store

        async def add(call: ServiceCall) -> dict:
            sched = await store.add_schedule(dict(call.data["schedule"]))
            await self._force_devices(sched)
            await self.async_reconcile("schedule_added")
            return {"schedule": sched}

        async def update(call: ServiceCall) -> dict:
            sched = await store.update_schedule(call.data["id"], dict(call.data["changes"]))
            await self._force_devices(sched)
            await self.async_reconcile("schedule_updated")
            return {"schedule": sched}

        async def delete(call: ServiceCall) -> dict:
            ok = await store.remove_schedule(call.data["id"])
            # Re-evaluate so a zone whose active schedule was deleted falls
            # back to the next applicable one (no force: unchanged zones keep
            # any manual override).
            await self.async_reconcile("schedule_deleted")
            return {"removed": ok}

        async def list_(call: ServiceCall) -> dict:
            return {
                "schedules": store.list_schedules(),
                "last_applied": store.get_all_last_applied(),
            }

        async def clear_last_applied(call: ServiceCall) -> dict:
            await store.clear_last_applied(call.data.get("device_id"))
            return {"cleared": True}

        async def reconcile_now(call: ServiceCall) -> dict:
            await self.async_reconcile("manual")
            return {"ok": True}

        self.hass.services.async_register(
            DOMAIN, "ha_schedule_add", add,
            schema=vol.Schema({vol.Required("schedule"): dict}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN, "ha_schedule_update", update,
            schema=vol.Schema({vol.Required("id"): cv.string, vol.Required("changes"): dict}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN, "ha_schedule_delete", delete,
            schema=vol.Schema({vol.Required("id"): cv.string}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN, "ha_schedule_list", list_,
            schema=vol.Schema({}), supports_response=SupportsResponse.ONLY,
        )
        self.hass.services.async_register(
            DOMAIN, "ha_schedule_clear_last_applied", clear_last_applied,
            schema=vol.Schema({vol.Optional("device_id"): cv.string}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN, "ha_reconcile_now", reconcile_now,
            schema=vol.Schema({}), supports_response=SupportsResponse.OPTIONAL,
        )
