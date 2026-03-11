import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.helpers import config_validation as cv
from homeassistant.exceptions import HomeAssistantError

from .coordinator import AirzoneCloudConfigEntry

DOMAIN = "airzone_cloud"

ATTR_CONFIG_ENTRY = "config_entry"
ATTR_SCHEDULE_ID = "schedule_id"
ATTR_SCHEDULE_DATA = "schedule_data"
ATTR_ACTIVE = "active"

GET_SCHEDULES_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CONFIG_ENTRY): cv.string,
    }
)

DELETE_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_SCHEDULE_ID): cv.string,
    }
)

DELETE_SCHEDULES_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CONFIG_ENTRY): cv.string,
    }
)

POST_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_SCHEDULE_DATA): dict,
    }
)

PATCH_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_SCHEDULE_ID): cv.string,
        vol.Required(ATTR_SCHEDULE_DATA): dict,
    }
)

PATCH_SCHEDULES_ACTIVATE_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CONFIG_ENTRY): cv.string,
        vol.Required(ATTR_ACTIVE): cv.boolean,
    }
)

async def async_setup_services(hass: HomeAssistant) -> None:
    """Set up the Airzone Cloud Schedules services."""

    def _get_api_and_installation(hass: HomeAssistant, entry_id: str):
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
        airzone, installation = _get_api_and_installation(hass, call.data[ATTR_CONFIG_ENTRY])
        res = await airzone.api_get_installation_schedules(installation)
        return {"schedules": res}

    async def async_delete_installation_schedule(call: ServiceCall) -> None:
        airzone, installation = _get_api_and_installation(hass, call.data[ATTR_CONFIG_ENTRY])
        await airzone.api_delete_installation_schedule(installation, call.data[ATTR_SCHEDULE_ID])

    async def async_delete_installation_schedules(call: ServiceCall) -> None:
        airzone, installation = _get_api_and_installation(hass, call.data[ATTR_CONFIG_ENTRY])
        await airzone.api_delete_installation_schedules(installation)

    async def async_post_installation_schedule(call: ServiceCall) -> dict:
        airzone, installation = _get_api_and_installation(hass, call.data[ATTR_CONFIG_ENTRY])
        res = await airzone.api_post_installation_schedule(installation, call.data[ATTR_SCHEDULE_DATA])
        return {"response": res}

    async def async_patch_installation_schedule(call: ServiceCall) -> dict:
        airzone, installation = _get_api_and_installation(hass, call.data[ATTR_CONFIG_ENTRY])
        res = await airzone.api_patch_installation_schedule(installation, call.data[ATTR_SCHEDULE_ID], call.data[ATTR_SCHEDULE_DATA])
        return {"response": res}

    async def async_patch_installation_schedules_activate(call: ServiceCall) -> dict:
        airzone, installation = _get_api_and_installation(hass, call.data[ATTR_CONFIG_ENTRY])
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

    hass.services.async_register(
        DOMAIN,
        "delete_installation_schedules",
        async_delete_installation_schedules,
        schema=DELETE_SCHEDULES_SCHEMA,
    )

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
