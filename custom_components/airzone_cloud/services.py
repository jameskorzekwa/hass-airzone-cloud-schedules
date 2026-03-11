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
ATTR_ACTIVE = "active"

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

    async def async_post_installation_schedule(call: ServiceCall) -> dict:
        """Create a new schedule."""
        _LOGGER.debug("post_installation_schedule called")
        airzone, installation = _get_api_and_installation(hass, call.data.get(ATTR_CONFIG_ENTRY))
        res = await airzone.api_post_installation_schedule(installation, call.data[ATTR_SCHEDULE_DATA])
        return {"response": res}

    async def async_patch_installation_schedule(call: ServiceCall) -> dict:
        """Update an existing schedule."""
        _LOGGER.debug("patch_installation_schedule called for schedule_id=%s", call.data[ATTR_SCHEDULE_ID])
        airzone, installation = _get_api_and_installation(hass, call.data.get(ATTR_CONFIG_ENTRY))
        res = await airzone.api_patch_installation_schedule(
            installation, call.data[ATTR_SCHEDULE_ID], call.data[ATTR_SCHEDULE_DATA]
        )
        return {"response": res}

    async def async_patch_installation_schedules_activate(call: ServiceCall) -> dict:
        """Activate or deactivate all schedules globally."""
        _LOGGER.debug("patch_installation_schedules_activate called with active=%s", call.data[ATTR_ACTIVE])
        airzone, installation = _get_api_and_installation(hass, call.data.get(ATTR_CONFIG_ENTRY))
        res = await airzone.api_patch_installation_schedules_activate(installation, call.data[ATTR_ACTIVE])
        return {"response": res}

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
