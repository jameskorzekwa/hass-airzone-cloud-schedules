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
from homeassistant.helpers.event import async_call_later, async_track_time_interval

from .const import DOMAIN
from .schedule_store import HAScheduleStore

_LOGGER = logging.getLogger(__name__)

RECONCILE_INTERVAL = timedelta(seconds=60)
# Re-read the entity this long after _apply to confirm the values stuck.
# Today's Downstairs miss showed an Airzone-side snapback ~83s after apply.
POST_APPLY_VERIFY_DELAY_S = 90
# Fires within this window of "now" are always applied — this is the normal
# "a transition just happened" path and must not be gated on prior state.
# Wider than RECONCILE_INTERVAL to absorb jitter (a fire at 22:00:00 caught
# by a reconcile at 22:01:30 is still "fresh").
RECENT_FIRE_WINDOW = timedelta(seconds=180)

# A live heat/cool band whose gap has fallen this far below the configured
# differential (in the HA display unit) is treated as a device-side collapse
# and re-asserted by the differential watchdog. Small enough to ignore float /
# °F↔°C rounding, large enough to catch a real collapse (gap -> 0).
DIFFERENTIAL_EPSILON = 0.01

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
        # entity_id -> cancel callback for a pending post-apply verifier
        self._verifiers: dict = {}

    # --- lifecycle ---

    async def async_start(self) -> None:
        self._unsubs.append(async_track_time_interval(self.hass, self._interval_cb, RECONCILE_INTERVAL))
        if self.hass.is_running:
            await self.async_reconcile("startup")
        else:
            self._started_unsub = self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, self._started_cb)
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
        for cancel in self._verifiers.values():
            with contextlib.suppress(Exception):
                cancel()
        self._verifiers.clear()

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

    async def async_reconcile(self, reason: str, *, bypass_catch_up_bound: bool = False) -> None:
        try:
            now = datetime.now()
            schedules = [s for s in self.store.list_schedules() if s.get("enabled", True)]
            device_map = self._device_entity_map()
            last_recon = self.store.get_last_reconciled_at()
            if schedules and device_map:
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

                    # Differential watchdog: heal a device-side band collapse
                    # (the Aidoo firmware dragging heat up to cool ~24 min after
                    # a period is written) by re-asserting the active schedule's
                    # band. Runs every reconcile, independent of the transition
                    # gating below, because the collapse happens minutes *after*
                    # the period was applied (so last_applied already matches).
                    await self._enforce_differential(entity_id, best)

                    key = f"{best['id']}@{best_time.isoformat(timespec='minutes')}"
                    if self.store.get_last_applied(device_id) == key:
                        continue  # same period already applied — respect manual changes

                    # Catch-up bound: a fire within RECENT_FIRE_WINDOW is a
                    # real transition just happening, always apply. An OLDER
                    # fire only applies if HA was demonstrably down at the
                    # fire time (i.e., the fire happened AFTER our last
                    # successful reconcile). If we'd already reconciled
                    # past the fire, HA was up at the time and handled it
                    # — re-applying now would clobber whatever state has
                    # accumulated since (the 2026-05-22 midnight bug).
                    is_stale = (now - best_time) > RECENT_FIRE_WINDOW
                    ha_was_up_at_fire = last_recon is None or best_time <= last_recon
                    if not bypass_catch_up_bound and is_stale and ha_was_up_at_fire:
                        _LOGGER.debug(
                            "Airzone scheduler (%s): skipping stale catch-up for %s (fire=%s, last_recon=%s, now=%s)",
                            reason,
                            entity_id,
                            best_time.isoformat(timespec="minutes"),
                            last_recon.isoformat(timespec="seconds") if last_recon else "never",
                            now.isoformat(timespec="seconds"),
                        )
                        continue

                    applied = await self._apply(entity_id, best)
                    if applied:
                        await self.store.set_last_applied(device_id, key)
                        _LOGGER.info(
                            "Airzone scheduler (%s): applied '%s' to %s [%s]",
                            reason,
                            best.get("name"),
                            entity_id,
                            key,
                        )
            # Always advance the reconcile watermark — even if we had no
            # work to do, we just observed wall time "now" with HA running,
            # which is what lets future startups know HA was up at any
            # transition before now.
            await self.store.set_last_reconciled_at(now)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Airzone scheduler reconcile failed (%s)", reason)

    def _to_ha_temp(self, celsius: float) -> float:
        unit = self.hass.config.units.temperature_unit
        if unit == "°F":
            return round(celsius * 9 / 5 + 32)
        return celsius

    def _configured_differential(self) -> float:
        """Configured minimum heat/cool gap, in the HA display unit.

        Mirrors the card's ``_getDifferential`` — the store keeps the value in
        the unit it was entered in. Returns 0 when unset or non-positive.
        """
        settings = self.store.get_settings()
        try:
            value = float(settings.get("setpoint_differential") or 0)
        except (TypeError, ValueError):
            return 0.0
        if value <= 0:
            return 0.0
        unit = settings.get("setpoint_differential_unit") or "F"
        want = "F" if self.hass.config.units.temperature_unit == "°F" else "C"
        if unit == want:
            return value
        if unit == "F" and want == "C":
            return value / 1.8
        if unit == "C" and want == "F":
            return value * 1.8
        return value

    async def _enforce_differential(self, entity_id: str, sched: dict) -> None:
        """Re-assert a dual schedule's band when the live gap has collapsed.

        The Aidoo/Mitsubishi firmware (with its own differential at 0) drags the
        heat setpoint up to cool ~24 min after a band is written, leaving a
        zero-gap band. Re-applying the schedule's setpoints heals it: because
        ``climate.set_temperature`` is now edge-minimal, when only heat collapsed
        this re-writes heat alone (cool stays pinned at its floor) — a single-edge
        write the firmware does not reconcile away, exactly like a manual app fix.

        Only fires when the live gap is *below* the configured differential, so a
        valid manual mid-period band (gap >= differential) is left untouched.
        """
        if SCHEDULE_MODE_TO_HVAC.get(sched.get("mode")) != "heat_cool":
            return
        sp_heat = sched.get("setpoint_heat")
        sp_cool = sched.get("setpoint_cool")
        if sp_heat is None or sp_cool is None:
            return
        diff = self._configured_differential()
        if diff <= 0:
            return
        state = self.hass.states.get(entity_id)
        if state is None or state.state != "heat_cool":
            return
        attrs = state.attributes
        if not (attrs.get("supported_features", 0) & ClimateEntityFeature.TARGET_TEMPERATURE_RANGE):
            return
        low = attrs.get("target_temp_low")
        high = attrs.get("target_temp_high")
        if low is None or high is None:
            return
        if (high - low) >= diff - DIFFERENTIAL_EPSILON:
            return  # band still satisfies the differential — nothing to heal
        target_low = self._to_ha_temp(sp_heat)
        target_high = self._to_ha_temp(sp_cool)
        if (target_high - target_low) < diff - DIFFERENTIAL_EPSILON:
            return  # the schedule's own band is sub-differential — don't fight it
        _LOGGER.info(
            "Airzone scheduler: %s band collapsed to %s/%s (gap < %s%s) — re-asserting %s/%s",
            entity_id,
            low,
            high,
            round(diff),
            self.hass.config.units.temperature_unit,
            target_low,
            target_high,
        )
        try:
            await self.hass.services.async_call(
                "climate",
                "set_temperature",
                {
                    "entity_id": entity_id,
                    "target_temp_low": target_low,
                    "target_temp_high": target_high,
                },
                blocking=True,
            )
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Airzone scheduler: differential re-assert failed for %s", entity_id)

    async def _apply(self, entity_id: str, sched: dict) -> bool:
        hvac = SCHEDULE_MODE_TO_HVAC.get(sched.get("mode"))
        state = self.hass.states.get(entity_id)
        if state is None:
            _LOGGER.warning("Airzone scheduler: entity %s unavailable, skipping", entity_id)
            return False

        if hvac:
            try:
                await self.hass.services.async_call(
                    "climate",
                    "set_hvac_mode",
                    {"entity_id": entity_id, "hvac_mode": hvac},
                    blocking=True,
                )
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Airzone scheduler: set_hvac_mode failed for %s", entity_id)
            # Re-read AFTER the mode switch: which setpoint shape an Airzone
            # zone exposes (single vs heat/cool range) depends on its mode,
            # so deciding from the pre-switch snapshot (e.g. taken while the
            # zone was in Cool) would wrongly conclude "no range" and skip
            # the schedule entirely.
            state = self.hass.states.get(entity_id) or state

        sf = state.attributes.get("supported_features", 0)
        supports_range = bool(sf & ClimateEntityFeature.TARGET_TEMPERATURE_RANGE)
        sp_heat = sched.get("setpoint_heat")
        sp_cool = sched.get("setpoint_cool")
        sp_single = sched.get("setpoint")
        dual = hvac == "heat_cool" and sp_heat is not None and sp_cool is not None

        sent: dict = {}
        try:
            if dual and supports_range:
                sent = {
                    "target_temp_low": self._to_ha_temp(sp_heat),
                    "target_temp_high": self._to_ha_temp(sp_cool),
                }
                await self.hass.services.async_call(
                    "climate",
                    "set_temperature",
                    {"entity_id": entity_id, **sent},
                    blocking=True,
                )
            elif sp_single is not None:
                sent = {"temperature": self._to_ha_temp(sp_single)}
                await self.hass.services.async_call(
                    "climate",
                    "set_temperature",
                    {"entity_id": entity_id, **sent},
                    blocking=True,
                )
            elif dual:
                # Auto schedule but the zone currently exposes only a single
                # setpoint (double-setpoint off for this zone). Apply the
                # heat/cool midpoint so the schedule still takes effect
                # instead of silently doing nothing forever.
                mid = round(((sp_heat + sp_cool) / 2) * 2) / 2
                _LOGGER.info(
                    "Airzone scheduler: '%s' -> %s is single-setpoint; applying midpoint %s°C of heat %s / cool %s",
                    sched.get("name"),
                    entity_id,
                    mid,
                    sp_heat,
                    sp_cool,
                )
                sent = {"temperature": self._to_ha_temp(mid)}
                await self.hass.services.async_call(
                    "climate",
                    "set_temperature",
                    {"entity_id": entity_id, **sent},
                    blocking=True,
                )
            else:
                _LOGGER.warning(
                    "Airzone scheduler: '%s' has no usable setpoint for %s (range=%s)",
                    sched.get("name"),
                    entity_id,
                    supports_range,
                )
                return False
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Airzone scheduler: set_temperature failed for %s", entity_id)
            return False
        if sent:
            self._schedule_post_apply_verify(entity_id, sched, sent)
        return True

    # --- post-apply verification ---

    def _schedule_post_apply_verify(self, entity_id: str, sched: dict, sent: dict) -> None:
        """Re-read the entity ~90s after _apply and warn if the device snapped
        back to different values (Airzone has been observed silently reverting
        a successfully-issued setpoint within ~80s)."""
        prev = self._verifiers.pop(entity_id, None)
        if prev is not None:
            with contextlib.suppress(Exception):
                prev()

        async def _cb(_now) -> None:
            self._verifiers.pop(entity_id, None)
            await self._post_apply_verify(entity_id, sched, sent)

        self._verifiers[entity_id] = async_call_later(
            self.hass,
            POST_APPLY_VERIFY_DELAY_S,
            _cb,
        )

    async def _post_apply_verify(self, entity_id: str, sched: dict, sent: dict) -> None:
        state = self.hass.states.get(entity_id)
        if state is None:
            return
        attrs = state.attributes
        mismatches = {k: (sent[k], attrs.get(k)) for k in sent if attrs.get(k) != sent[k]}
        if mismatches:
            _LOGGER.warning(
                "Airzone scheduler: '%s' applied to %s did not stick after %ds — "
                "sent %s, device reports %s (likely a device-side rejection)",
                sched.get("name"),
                entity_id,
                POST_APPLY_VERIFY_DELAY_S,
                sent,
                {k: attrs.get(k) for k in sent},
            )

    async def apply_now(self, schedule_id: str) -> dict:
        """Force-apply a schedule's setpoints to all its devices right now.

        Unlike reconcile, this ignores last_applied — it's user-driven (the
        "Apply" button on the schedule card) and is meant to push the schedule
        back into effect after a device-side snapback or other drift.
        """
        sched = next((s for s in self.store.list_schedules() if s.get("id") == schedule_id), None)
        if sched is None:
            return {"applied": [], "error": f"schedule '{schedule_id}' not found"}
        device_map = self._device_entity_map()
        applied: list[dict] = []
        for did in sched.get("device_ids") or []:
            eid = device_map.get(did)
            if not eid:
                applied.append({"device_id": did, "entity_id": None, "ok": False, "reason": "no entity"})
                continue
            ok = await self._apply(eid, sched)
            applied.append({"device_id": did, "entity_id": eid, "ok": ok})
        _LOGGER.info("Airzone scheduler (apply_now): '%s' -> %s", sched.get("name"), applied)
        return {"applied": applied}

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
            # Explicit user intent: bypass the staleness bound so a just-added
            # schedule takes effect immediately, even if its most-recent fire
            # is hours stale (e.g., adding a 9:30 schedule at 14:00).
            await self.async_reconcile("schedule_added", bypass_catch_up_bound=True)
            return {"schedule": sched}

        async def update(call: ServiceCall) -> dict:
            sched = await store.update_schedule(call.data["id"], dict(call.data["changes"]))
            await self._force_devices(sched)
            await self.async_reconcile("schedule_updated", bypass_catch_up_bound=True)
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
            # Manual user trigger — bypass the staleness bound (this is
            # explicit "apply the current period").
            await self.async_reconcile("manual", bypass_catch_up_bound=True)
            return {"ok": True}

        async def apply_now_svc(call: ServiceCall) -> dict:
            return await self.apply_now(call.data["schedule_id"])

        async def settings_get(call: ServiceCall) -> dict:
            return {"settings": store.get_settings()}

        async def settings_update(call: ServiceCall) -> dict:
            return {"settings": await store.update_settings(dict(call.data["changes"]))}

        self.hass.services.async_register(
            DOMAIN,
            "ha_schedule_add",
            add,
            schema=vol.Schema({vol.Required("schedule"): dict}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN,
            "ha_schedule_update",
            update,
            schema=vol.Schema({vol.Required("id"): cv.string, vol.Required("changes"): dict}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN,
            "ha_schedule_delete",
            delete,
            schema=vol.Schema({vol.Required("id"): cv.string}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN,
            "ha_schedule_list",
            list_,
            schema=vol.Schema({}),
            supports_response=SupportsResponse.ONLY,
        )
        self.hass.services.async_register(
            DOMAIN,
            "ha_schedule_clear_last_applied",
            clear_last_applied,
            schema=vol.Schema({vol.Optional("device_id"): cv.string}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN,
            "ha_reconcile_now",
            reconcile_now,
            schema=vol.Schema({}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN,
            "ha_schedule_apply_now",
            apply_now_svc,
            schema=vol.Schema({vol.Required("schedule_id"): cv.string}),
            supports_response=SupportsResponse.OPTIONAL,
        )
        self.hass.services.async_register(
            DOMAIN,
            "ha_settings_get",
            settings_get,
            schema=vol.Schema({}),
            supports_response=SupportsResponse.ONLY,
        )
        self.hass.services.async_register(
            DOMAIN,
            "ha_settings_update",
            settings_update,
            schema=vol.Schema({vol.Required("changes"): dict}),
            supports_response=SupportsResponse.OPTIONAL,
        )
