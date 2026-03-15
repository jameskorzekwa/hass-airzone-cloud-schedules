import logging

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv

_LOGGER = logging.getLogger(__name__)

DOMAIN = "airzone_cloud"

ATTR_CONFIG_ENTRY = "config_entry"
ATTR_SCHEDULE_ID = "schedule_id"
ATTR_SCHEDULE_DATA = "schedule_data"
ATTR_SCHEDULE_NAME = "schedule_name"
ATTR_ACTIVE = "active"
ATTR_ENABLED = "enabled"
ATTR_SEASON = "season"
ATTR_AWAY = "away"

GET_SCHEDULES_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
    }
)

DELETE_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_SCHEDULE_ID): cv.string,
    }
)

POST_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_SCHEDULE_DATA): dict,
    }
)

PATCH_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_SCHEDULE_ID): cv.string,
        vol.Required(ATTR_SCHEDULE_DATA): dict,
    }
)

PATCH_SCHEDULES_ACTIVATE_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_ACTIVE): cv.boolean,
    }
)

GET_SCHEDULE_TAGS_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
    }
)

SET_SCHEDULE_TAGS_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_SCHEDULE_ID): cv.string,
        vol.Optional(ATTR_SEASON): vol.Any("winter", "summer", None),
        vol.Optional(ATTR_AWAY): cv.boolean,
    }
)

TOGGLE_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
        vol.Optional(ATTR_SCHEDULE_NAME): vol.All(cv.ensure_list, [cv.string]),
        vol.Optional(ATTR_SEASON): vol.Any("winter", "summer"),
        vol.Optional(ATTR_AWAY): cv.boolean,
        vol.Required(ATTR_ENABLED): cv.boolean,
    }
)


async def async_setup_services(hass: HomeAssistant) -> None:
    """Set up the Airzone Cloud Schedules services."""

    def _get_api_and_installation(hass: HomeAssistant, entry_id: str | None = None):
        if entry_id is None:
            # If no config entry is provided, just use the first one found
            entries = hass.config_entries.async_entries(DOMAIN)
            if not entries:
                raise HomeAssistantError("No Airzone Cloud config entries found")
            entry = entries[0]
        else:
            entry = hass.config_entries.async_get_entry(entry_id)
            if not entry:
                raise HomeAssistantError(f"Config entry {entry_id} not found")

        coordinator = entry.runtime_data
        airzone = coordinator.airzone
        installation = airzone.get_installation_id(entry.data["id"])

        if not installation:
            raise HomeAssistantError("Installation not found")

        return airzone, installation

    async def async_get_installation_schedules(call: ServiceCall) -> dict:
        """Get all schedules for the installation (read-only)."""
        _LOGGER.debug("get_installation_schedules called")
        airzone, installation = _get_api_and_installation(hass, call.data.get(ATTR_CONFIG_ENTRY))
        res = await airzone.api_get_installation_schedules(installation)
        return {"schedules": res}

    async def async_delete_installation_schedule(call: ServiceCall) -> None:
        """Delete a single schedule by ID."""
        schedule_id = call.data[ATTR_SCHEDULE_ID]
        _LOGGER.warning("delete_installation_schedule called for schedule_id=%s", schedule_id)
        airzone, installation = _get_api_and_installation(hass, call.data.get(ATTR_CONFIG_ENTRY))
        await airzone.api_delete_installation_schedule(installation, schedule_id)
        tag_store = hass.data.get(DOMAIN, {}).get("tag_store")
        if tag_store:
            await tag_store.remove_tags(schedule_id)

    async def async_post_installation_schedule(call: ServiceCall) -> dict:
        """Create a new schedule."""
        _LOGGER.debug("post_installation_schedule called")
        airzone, installation = _get_api_and_installation(hass, call.data.get(ATTR_CONFIG_ENTRY))
        # The Airzone Cloud API expects POST payloads wrapped in a "schedule" key
        wrapped = {"schedule": call.data[ATTR_SCHEDULE_DATA]}
        res = await airzone.api_post_installation_schedule(installation, wrapped)
        return {"response": res}

    async def async_patch_installation_schedule(call: ServiceCall) -> dict:
        """Update an existing schedule."""
        schedule_id = call.data[ATTR_SCHEDULE_ID]
        schedule_data = call.data[ATTR_SCHEDULE_DATA]
        # Strip any keys with None/undefined values to avoid sending nulls to the API
        if "start_conf" in schedule_data and isinstance(schedule_data["start_conf"], dict):
            schedule_data["start_conf"] = {k: v for k, v in schedule_data["start_conf"].items() if v is not None}
        # The Airzone Cloud API expects PATCH payloads wrapped in a "schedule" key
        wrapped = {"schedule": schedule_data}
        _LOGGER.warning("patch_installation_schedule: id=%s data=%s", schedule_id, wrapped)
        airzone, installation = _get_api_and_installation(hass, call.data.get(ATTR_CONFIG_ENTRY))
        res = await airzone.api_patch_installation_schedule(installation, schedule_id, wrapped)
        return {"response": res}

    async def async_patch_installation_schedules_activate(call: ServiceCall) -> dict:
        """Activate or deactivate all schedules globally."""
        _LOGGER.debug("patch_installation_schedules_activate called with active=%s", call.data[ATTR_ACTIVE])
        airzone, installation = _get_api_and_installation(hass, call.data.get(ATTR_CONFIG_ENTRY))
        res = await airzone.api_patch_installation_schedules_activate(installation, call.data[ATTR_ACTIVE])
        return {"response": res}

    async def async_toggle_schedule(call: ServiceCall) -> None:
        """Enable or disable schedules by name and/or tag filters."""
        schedule_names = call.data.get(ATTR_SCHEDULE_NAME)
        filter_season = call.data.get(ATTR_SEASON)
        filter_away = call.data.get(ATTR_AWAY)
        enabled = call.data[ATTR_ENABLED]

        if not schedule_names and filter_season is None and filter_away is None:
            raise HomeAssistantError("Provide schedule_name, season, away, or a combination to select schedules")

        airzone, installation = _get_api_and_installation(hass, call.data.get(ATTR_CONFIG_ENTRY))

        # Fetch all schedules
        schedules = await airzone.api_get_installation_schedules(installation)
        if not isinstance(schedules, list):
            raise HomeAssistantError("Unexpected response from Airzone API")

        # Get tag store for tag-based filtering
        tag_store = hass.data.get(DOMAIN, {}).get("tag_store")
        all_tags = tag_store.get_all_tags() if tag_store else {}

        # Find matching schedules
        matched = []
        not_found = []

        if schedule_names:
            # Filter by name(s)
            by_name = {}
            for s in schedules:
                by_name[s.get("name", "").lower()] = s
            for name in schedule_names:
                match = by_name.get(name.lower())
                if match:
                    matched.append(match)
                else:
                    not_found.append(name)
        else:
            # Start with all schedules when filtering by tags only
            matched = list(schedules)

        # Apply tag filters
        if filter_season is not None:
            matched = [s for s in matched if all_tags.get(s.get("_id"), {}).get("season") == filter_season]
        if filter_away is not None:
            matched = [s for s in matched if bool(all_tags.get(s.get("_id"), {}).get("away", False)) == filter_away]

        if not matched:
            filters = []
            if schedule_names:
                filters.append(f"names={schedule_names}")
            if filter_season is not None:
                filters.append(f"season={filter_season}")
            if filter_away is not None:
                filters.append(f"away={filter_away}")
            raise HomeAssistantError(f"No schedules matched filters: {', '.join(filters)}")

        for match in matched:
            schedule_id = match["_id"]
            sc = match.get("start_conf", {})

            payload = {
                "schedule": {
                    "name": match.get("name"),
                    "type": match.get("type", "week"),
                    "prog_enabled": enabled,
                    "setpoint": sc.get("setpoint", {}).get("celsius")
                    if isinstance(sc.get("setpoint"), dict)
                    else sc.get("setpoint"),
                    "start_conf": {
                        "mode": sc.get("mode"),
                        "pspeed": sc.get("pspeed"),
                        "days": sc.get("days"),
                        "hour": sc.get("hour"),
                        "minutes": sc.get("minutes"),
                    },
                    "device_ids": match.get("device_ids", []),
                }
            }

            _LOGGER.info(
                "toggle_schedule: %s schedule '%s' (id=%s)",
                "Enabling" if enabled else "Disabling",
                match.get("name"),
                schedule_id,
            )
            await airzone.api_patch_installation_schedule(installation, schedule_id, payload)

        if not_found:
            _LOGGER.warning("toggle_schedule: schedules not found: %s", ", ".join(not_found))

    hass.services.async_register(
        DOMAIN,
        "get_installation_schedules",
        async_get_installation_schedules,
        schema=GET_SCHEDULES_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )

    hass.services.async_register(
        DOMAIN,
        "delete_installation_schedule",
        async_delete_installation_schedule,
        schema=DELETE_SCHEDULE_SCHEMA,
    )

    # NOTE: "delete_installation_schedules" (delete ALL) has been intentionally
    # removed. It is far too dangerous to expose as a service with no
    # confirmation mechanism. Use single-delete instead.

    hass.services.async_register(
        DOMAIN,
        "post_installation_schedule",
        async_post_installation_schedule,
        schema=POST_SCHEDULE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )

    hass.services.async_register(
        DOMAIN,
        "patch_installation_schedule",
        async_patch_installation_schedule,
        schema=PATCH_SCHEDULE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )

    hass.services.async_register(
        DOMAIN,
        "patch_installation_schedules_activate",
        async_patch_installation_schedules_activate,
        schema=PATCH_SCHEDULES_ACTIVATE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )

    hass.services.async_register(
        DOMAIN,
        "toggle_schedule",
        async_toggle_schedule,
        schema=TOGGLE_SCHEDULE_SCHEMA,
    )

    async def async_get_schedule_tags(call: ServiceCall) -> dict:
        """Get all schedule tags."""
        tag_store = hass.data.get(DOMAIN, {}).get("tag_store")
        if not tag_store:
            return {"tags": {}}
        return {"tags": tag_store.get_all_tags()}

    async def async_set_schedule_tags(call: ServiceCall) -> None:
        """Set tags for a schedule."""
        tag_store = hass.data.get(DOMAIN, {}).get("tag_store")
        if not tag_store:
            raise HomeAssistantError("Tag store not initialized")
        schedule_id = call.data[ATTR_SCHEDULE_ID]
        current = tag_store.get_tags(schedule_id)
        season = call.data.get(ATTR_SEASON, current["season"])
        away = call.data.get(ATTR_AWAY, current["away"])
        await tag_store.set_tags(schedule_id, season, away)

    hass.services.async_register(
        DOMAIN,
        "get_schedule_tags",
        async_get_schedule_tags,
        schema=GET_SCHEDULE_TAGS_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )

    hass.services.async_register(
        DOMAIN,
        "set_schedule_tags",
        async_set_schedule_tags,
        schema=SET_SCHEDULE_TAGS_SCHEMA,
    )
