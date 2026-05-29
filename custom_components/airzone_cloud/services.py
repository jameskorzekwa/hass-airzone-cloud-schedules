"""Airzone Cloud schedule services — operate on the HA-owned schedule store.

Scheduling moved out of Airzone Cloud into Home Assistant (see scheduler.py /
schedule_store.py). These services keep their original names and schemas so
existing automations keep working, but now read/write the HA store and let
``AirzoneScheduler`` apply the result. ``config_entry`` is still accepted for
backward compatibility and is ignored. ``schedule_id`` is the HA schedule id;
``schedule_data`` is the HA schedule shape ({name, enabled, mode, days, hour,
minutes, device_ids, setpoint/ setpoint_heat/ setpoint_cool, tags}).

The legacy ``patch_installation_schedules_activate`` is intentionally gone —
Airzone's own scheduler is permanently deactivated; HA owns scheduling.
"""

import logging

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

ATTR_CONFIG_ENTRY = "config_entry"
ATTR_SCHEDULE_ID = "schedule_id"
ATTR_SCHEDULE_DATA = "schedule_data"
ATTR_SCHEDULE_NAME = "schedule_name"
ATTR_ENABLED = "enabled"
ATTR_TAGS = "tags"
ATTR_ALL = "all"

GET_SCHEDULES_SCHEMA = vol.Schema({vol.Optional(ATTR_CONFIG_ENTRY): cv.string})

DELETE_SCHEDULE_SCHEMA = vol.Schema(
    {vol.Optional(ATTR_CONFIG_ENTRY): cv.string, vol.Required(ATTR_SCHEDULE_ID): cv.string}
)

POST_SCHEDULE_SCHEMA = vol.Schema({vol.Optional(ATTR_CONFIG_ENTRY): cv.string, vol.Required(ATTR_SCHEDULE_DATA): dict})

PATCH_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_SCHEDULE_ID): cv.string,
        vol.Required(ATTR_SCHEDULE_DATA): dict,
    }
)

GET_SCHEDULE_TAGS_SCHEMA = vol.Schema({vol.Optional(ATTR_CONFIG_ENTRY): cv.string})

SET_SCHEDULE_TAGS_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_SCHEDULE_ID): cv.string,
        vol.Required(ATTR_TAGS): vol.All(cv.ensure_list, [cv.string]),
    }
)

TOGGLE_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
        vol.Optional(ATTR_SCHEDULE_NAME): vol.All(cv.ensure_list, [cv.string]),
        vol.Optional(ATTR_TAGS): vol.All(cv.ensure_list, [cv.string]),
        vol.Optional(ATTR_ALL): cv.boolean,
        vol.Required(ATTR_ENABLED): cv.boolean,
    }
)


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register the schedule services (operating on the HA-owned store)."""

    def _store_scheduler():
        data = hass.data.get(DOMAIN, {})
        store = data.get("ha_schedule_store")
        scheduler = data.get("ha_scheduler")
        if store is None or scheduler is None:
            raise HomeAssistantError("Airzone schedule store not initialized")
        return store, scheduler

    async def _apply(scheduler, scheds) -> None:
        """Re-assert affected zones after a change (mirrors the card edit path)."""
        for s in scheds:
            if s:
                await scheduler._force_devices(s)
        await scheduler.async_reconcile("service")

    async def async_get_installation_schedules(call: ServiceCall) -> dict:
        store, _ = _store_scheduler()
        return {"schedules": store.list_schedules()}

    async def async_delete_installation_schedule(call: ServiceCall) -> None:
        store, scheduler = _store_scheduler()
        sid = call.data[ATTR_SCHEDULE_ID]
        sched = store.get_schedule(sid)
        await store.remove_schedule(sid)
        await _apply(scheduler, [sched])

    async def async_post_installation_schedule(call: ServiceCall) -> dict:
        store, scheduler = _store_scheduler()
        sched = await store.add_schedule(dict(call.data[ATTR_SCHEDULE_DATA]))
        await _apply(scheduler, [sched])
        return {"schedule": sched}

    async def async_patch_installation_schedule(call: ServiceCall) -> dict:
        store, scheduler = _store_scheduler()
        sid = call.data[ATTR_SCHEDULE_ID]
        sched = await store.update_schedule(sid, dict(call.data[ATTR_SCHEDULE_DATA]))
        if sched is None:
            raise HomeAssistantError(f"Schedule '{sid}' not found")
        await _apply(scheduler, [sched])
        return {"schedule": sched}

    async def async_toggle_schedule(call: ServiceCall) -> None:
        store, scheduler = _store_scheduler()
        names = call.data.get(ATTR_SCHEDULE_NAME)
        tags = call.data.get(ATTR_TAGS)
        toggle_all = call.data.get(ATTR_ALL, False)
        enabled = call.data[ATTR_ENABLED]

        if not toggle_all and not names and not tags:
            raise HomeAssistantError("Provide schedule_name, tags, or all to select schedules")

        scheds = store.list_schedules()
        if toggle_all:
            matched = list(scheds)
        else:
            # A schedule is selected if its name matches OR it carries ANY of
            # the requested tags (union/OR across all selectors).
            wanted_names = {n.lower() for n in (names or [])}
            wanted_tags = {t.lower() for t in (tags or [])}
            matched = []
            for s in scheds:
                name_hit = bool(wanted_names) and (s.get("name") or "").lower() in wanted_names
                tag_hit = bool(wanted_tags) and any(str(t).lower() in wanted_tags for t in (s.get("tags") or []))
                if name_hit or tag_hit:
                    matched.append(s)

        if not matched:
            parts = []
            if names:
                parts.append(f"names={names}")
            if tags:
                parts.append(f"tags={tags}")
            if toggle_all:
                parts.append("all=true")
            raise HomeAssistantError(f"No schedules matched filters: {', '.join(parts) or '(none)'}")

        for s in matched:
            await store.update_schedule(s["id"], {"enabled": enabled})
        _LOGGER.info(
            "toggle_schedule: %s %d schedule(s)",
            "enabled" if enabled else "disabled",
            len(matched),
        )
        await _apply(scheduler, matched)

    async def async_get_schedule_tags(call: ServiceCall) -> dict:
        store, _ = _store_scheduler()
        return {"tags": {s["id"]: list(s.get("tags") or []) for s in store.list_schedules()}}

    async def async_set_schedule_tags(call: ServiceCall) -> None:
        store, scheduler = _store_scheduler()
        sid = call.data[ATTR_SCHEDULE_ID]
        sched = await store.update_schedule(sid, {"tags": call.data[ATTR_TAGS]})
        if sched is None:
            raise HomeAssistantError(f"Schedule '{sid}' not found")
        await _apply(scheduler, [sched])

    reg = hass.services.async_register
    reg(
        DOMAIN,
        "get_installation_schedules",
        async_get_installation_schedules,
        schema=GET_SCHEDULES_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    reg(
        DOMAIN,
        "delete_installation_schedule",
        async_delete_installation_schedule,
        schema=DELETE_SCHEDULE_SCHEMA,
    )
    # NOTE: a delete-ALL service is intentionally not exposed (too dangerous
    # with no confirmation). Use single-delete.
    reg(
        DOMAIN,
        "post_installation_schedule",
        async_post_installation_schedule,
        schema=POST_SCHEDULE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    reg(
        DOMAIN,
        "patch_installation_schedule",
        async_patch_installation_schedule,
        schema=PATCH_SCHEDULE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    reg(DOMAIN, "toggle_schedule", async_toggle_schedule, schema=TOGGLE_SCHEDULE_SCHEMA)
    reg(
        DOMAIN,
        "get_schedule_tags",
        async_get_schedule_tags,
        schema=GET_SCHEDULE_TAGS_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    reg(
        DOMAIN,
        "set_schedule_tags",
        async_set_schedule_tags,
        schema=SET_SCHEDULE_TAGS_SCHEMA,
    )
