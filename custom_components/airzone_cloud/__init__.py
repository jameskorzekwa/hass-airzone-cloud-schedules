"""The Airzone Cloud integration."""

from __future__ import annotations

import logging
import os

from aioairzone_cloud.cloudapi import AirzoneCloudApi
from aioairzone_cloud.common import ConnectionOptions
from homeassistant.const import CONF_ID, CONF_PASSWORD, CONF_USERNAME, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import aiohttp_client
from homeassistant.helpers.typing import ConfigType

from .coordinator import AirzoneCloudConfigEntry, AirzoneUpdateCoordinator
from .store import ScheduleTagStore

_LOGGER = logging.getLogger(__name__)
logging.getLogger("aioairzone_cloud").setLevel(logging.DEBUG)

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


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Airzone Cloud component."""
    return True


async def async_setup_entry(hass: HomeAssistant, entry: AirzoneCloudConfigEntry) -> bool:
    """Set up Airzone Cloud from a config entry."""
    # Register the custom Lovelace card here so it loads for UI-configured instances.
    if CARD_REGISTERED_KEY not in hass.data:
        try:
            card_path = os.path.join(os.path.dirname(__file__), "airzone-schedules-card.js")
            if os.path.isfile(card_path):
                from homeassistant.components.frontend import add_extra_js_url
                from homeassistant.components.http import StaticPathConfig
                from homeassistant.components.panel_custom import async_register_panel

                mtime = str(os.path.getmtime(card_path))
                card_url_with_version = f"{CARD_URL}?v={mtime}"

                await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL, card_path, False)])
                add_extra_js_url(hass, card_url_with_version)

                await async_register_panel(
                    hass,
                    frontend_url_path="airzone-schedules",
                    webcomponent_name="airzone-schedules-card",
                    sidebar_title="Airzone",
                    sidebar_icon="mdi:calendar-clock",
                    module_url=card_url_with_version,
                    config={"config_entry": entry.entry_id},
                    require_admin=False,
                )

                _LOGGER.debug("Registered Airzone schedules card at %s and as a panel", card_url_with_version)
            else:
                _LOGGER.warning("Airzone schedules card JS not found at %s", card_path)
            hass.data[CARD_REGISTERED_KEY] = True
        except Exception:
            _LOGGER.exception("Failed to register Airzone schedules card")

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

    from .const import DOMAIN
    from .services import async_setup_services

    hass.data.setdefault(DOMAIN, {})
    if "tag_store" not in hass.data[DOMAIN]:
        tag_store = ScheduleTagStore(hass)
        await tag_store.load()
        hass.data[DOMAIN]["tag_store"] = tag_store

    await async_setup_services(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: AirzoneCloudConfigEntry) -> bool:
    """Unload a config entry."""

    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        coordinator = entry.runtime_data
        await coordinator.airzone.logout()

    return unload_ok
