"""The Airzone Cloud integration."""

from __future__ import annotations

import os

from aioairzone_cloud.cloudapi import AirzoneCloudApi
from aioairzone_cloud.common import ConnectionOptions

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.const import CONF_ID, CONF_PASSWORD, CONF_USERNAME, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import aiohttp_client

from .coordinator import AirzoneCloudConfigEntry, AirzoneUpdateCoordinator

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.CLIMATE,
    Platform.SELECT,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.WATER_HEATER,
]

CARD_URL = "/airzone_cloud/airzone-schedules-card.js"
CARD_REGISTERED_KEY = "airzone_cloud_card_registered"


async def async_setup_entry(
    hass: HomeAssistant, entry: AirzoneCloudConfigEntry
) -> bool:
    """Set up Airzone Cloud from a config entry."""
    options = ConnectionOptions(
        entry.data[CONF_USERNAME],
        entry.data[CONF_PASSWORD],
        True,
    )

    airzone = AirzoneCloudApi(aiohttp_client.async_get_clientsession(hass), options)
    await airzone.login()
    inst_list = await airzone.list_installations()
    for inst in inst_list:
        if inst.get_id() == entry.data[CONF_ID]:
            airzone.select_installation(inst)
            await airzone.update_installation(inst)

    coordinator = AirzoneUpdateCoordinator(hass, entry, airzone)
    await coordinator.async_config_entry_first_refresh()

    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    from .services import async_setup_services
    await async_setup_services(hass)

    # Register the custom Lovelace card (only once across multiple entries)
    if CARD_REGISTERED_KEY not in hass.data:
        hass.data[CARD_REGISTERED_KEY] = True
        hass.http.register_static_path(
            CARD_URL,
            os.path.join(os.path.dirname(__file__), "airzone-schedules-card.js"),
            cache_headers=False,
        )
        add_extra_js_url(hass, CARD_URL)

    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: AirzoneCloudConfigEntry
) -> bool:
    """Unload a config entry."""

    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        coordinator = entry.runtime_data
        await coordinator.airzone.logout()

    return unload_ok

