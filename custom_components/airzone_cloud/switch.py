"""Support for the Airzone Cloud switch."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Final

from aioairzone_cloud.const import API_POWER, API_VALUE, AZD_POWER, AZD_ZONES
from homeassistant.components.switch import (
    SwitchDeviceClass,
    SwitchEntity,
    SwitchEntityDescription,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN
from .coordinator import AirzoneCloudConfigEntry, AirzoneUpdateCoordinator
from .entity import AirzoneEntity, AirzoneZoneEntity

_LOGGER = logging.getLogger(__name__)

SCHEDULE_SCAN_INTERVAL = timedelta(minutes=5)


@dataclass(frozen=True, kw_only=True)
class AirzoneSwitchDescription(SwitchEntityDescription):
    """Class to describe an Airzone switch entity."""

    api_param: str


ZONE_SWITCH_TYPES: Final[tuple[AirzoneSwitchDescription, ...]] = (
    AirzoneSwitchDescription(
        api_param=API_POWER,
        device_class=SwitchDeviceClass.SWITCH,
        key=AZD_POWER,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: AirzoneCloudConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add Airzone Cloud switch from a config_entry."""
    coordinator = entry.runtime_data

    # Zones
    async_add_entities(
        AirzoneZoneSwitch(
            coordinator,
            description,
            zone_id,
            zone_data,
        )
        for description in ZONE_SWITCH_TYPES
        for zone_id, zone_data in coordinator.data.get(AZD_ZONES, {}).items()
        if description.key in zone_data
    )

    # Schedule switches
    airzone = coordinator.airzone
    installation = airzone.get_installation_id(entry.data["id"])
    if installation:
        try:
            schedules = await airzone.api_get_installation_schedules(installation)
            if isinstance(schedules, list):
                async_add_entities(
                    AirzoneScheduleSwitch(airzone, installation, s) for s in schedules if s.get("_id") and s.get("name")
                )
        except Exception:
            _LOGGER.exception("Failed to load schedule switches")


class AirzoneBaseSwitch(AirzoneEntity, SwitchEntity):
    """Define an Airzone Cloud switch."""

    entity_description: AirzoneSwitchDescription

    @callback
    def _handle_coordinator_update(self) -> None:
        """Update attributes when the coordinator updates."""
        self._async_update_attrs()
        super()._handle_coordinator_update()

    @callback
    def _async_update_attrs(self) -> None:
        """Update switch attributes."""
        self._attr_is_on = self.get_airzone_value(self.entity_description.key)


class AirzoneZoneSwitch(AirzoneZoneEntity, AirzoneBaseSwitch):
    """Define an Airzone Cloud Zone switch."""

    def __init__(
        self,
        coordinator: AirzoneUpdateCoordinator,
        description: AirzoneSwitchDescription,
        zone_id: str,
        zone_data: dict[str, Any],
    ) -> None:
        """Initialize."""
        super().__init__(coordinator, zone_id, zone_data)

        self._attr_name = None
        self._attr_unique_id = f"{zone_id}_{description.key}"
        self.entity_description = description

        self._async_update_attrs()

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn the entity on."""
        param = self.entity_description.api_param
        params: dict[str, Any] = {
            param: {
                API_VALUE: True,
            }
        }
        await self._async_update_params(params)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn the entity off."""
        param = self.entity_description.api_param
        params: dict[str, Any] = {
            param: {
                API_VALUE: False,
            }
        }
        await self._async_update_params(params)


class AirzoneScheduleSwitch(SwitchEntity):
    """Switch entity to enable/disable an Airzone Cloud schedule."""

    _attr_has_entity_name = True
    _attr_device_class = SwitchDeviceClass.SWITCH
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, airzone, installation, schedule_data: dict[str, Any]) -> None:
        """Initialize."""
        self._airzone = airzone
        self._installation = installation
        self._schedule_id = schedule_data["_id"]
        self._schedule_data = schedule_data

        self._attr_name = f"Schedule {schedule_data['name']}"
        self._attr_unique_id = f"{DOMAIN}_schedule_{self._schedule_id}"
        self._attr_is_on = schedule_data.get("prog_enabled", False)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return extra state attributes."""
        sc = self._schedule_data.get("start_conf", {})
        return {
            "schedule_id": self._schedule_id,
            "schedule_name": self._schedule_data.get("name"),
            "mode": sc.get("mode"),
            "setpoint_celsius": self._schedule_data.get("setpoint"),
            "days": sc.get("days"),
            "hour": sc.get("hour"),
            "minutes": sc.get("minutes"),
        }

    async def _async_set_enabled(self, enabled: bool) -> None:
        """Enable or disable the schedule via the API."""
        from .services import _get_setpoint_celsius, _make_setpoint_obj

        sc = self._schedule_data.get("start_conf", {})
        sp_celsius = _get_setpoint_celsius(self._schedule_data)
        sp_obj = _make_setpoint_obj(sp_celsius)

        payload = {
            "schedule": {
                "name": self._schedule_data.get("name"),
                "type": self._schedule_data.get("type", "week"),
                "prog_enabled": enabled,
                "setpoint": sp_celsius,
                "start_conf": {
                    k: v
                    for k, v in {
                        "mode": sc.get("mode"),
                        "pspeed": sc.get("pspeed"),
                        "days": sc.get("days"),
                        "hour": sc.get("hour"),
                        "minutes": sc.get("minutes"),
                        "setpoint": sp_obj,
                    }.items()
                    if v is not None
                },
                "device_ids": self._schedule_data.get("device_ids", []),
            }
        }

        await self._airzone.api_patch_installation_schedule(self._installation, self._schedule_id, payload)
        self._attr_is_on = enabled
        self._schedule_data["prog_enabled"] = enabled
        self.async_write_ha_state()

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable the schedule."""
        await self._async_set_enabled(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable the schedule."""
        await self._async_set_enabled(False)

    async def async_update(self) -> None:
        """Fetch latest schedule state from the API."""
        try:
            schedules = await self._airzone.api_get_installation_schedules(self._installation)
            if isinstance(schedules, list):
                for s in schedules:
                    if s.get("_id") == self._schedule_id:
                        self._schedule_data = s
                        self._attr_is_on = s.get("prog_enabled", False)
                        return
        except Exception:
            _LOGGER.debug("Failed to update schedule %s", self._schedule_id)
