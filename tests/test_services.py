"""Tests for the Airzone Cloud Schedules services."""

from unittest.mock import AsyncMock, MagicMock

import pytest
import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError

from custom_components.airzone_cloud.services import (
    ATTR_ACTIVE,
    ATTR_CONFIG_ENTRY,
    ATTR_ENABLED,
    ATTR_SCHEDULE_DATA,
    ATTR_SCHEDULE_ID,
    ATTR_SCHEDULE_NAME,
    DELETE_SCHEDULE_SCHEMA,
    GET_SCHEDULES_SCHEMA,
    PATCH_SCHEDULE_SCHEMA,
    PATCH_SCHEDULES_ACTIVATE_SCHEMA,
    POST_SCHEDULE_SCHEMA,
    TOGGLE_SCHEDULE_SCHEMA,
    async_setup_services,
)


@pytest.fixture
def mock_installation():
    """Create a mock installation."""
    inst = MagicMock()
    inst.get_id.return_value = "test-installation-id"
    return inst


@pytest.fixture
def mock_airzone(mock_installation):
    """Create a mock airzone API."""
    airzone = MagicMock()
    airzone.get_installation_id.return_value = mock_installation
    airzone.api_get_installation_schedules = AsyncMock(return_value={"schedule-1": {"name": "Morning", "active": True}})
    airzone.api_delete_installation_schedule = AsyncMock(return_value={})
    airzone.api_post_installation_schedule = AsyncMock(return_value={"_id": "new-schedule-id"})
    airzone.api_patch_installation_schedule = AsyncMock(return_value={"ok": True})
    airzone.api_patch_installation_schedules_activate = AsyncMock(return_value={"ok": True})
    return airzone


@pytest.fixture
def mock_coordinator(mock_airzone):
    """Create a mock coordinator."""
    coordinator = MagicMock()
    coordinator.airzone = mock_airzone
    return coordinator


@pytest.fixture
def mock_config_entry(mock_coordinator):
    """Create a mock config entry."""
    entry = MagicMock()
    entry.entry_id = "test-entry-id"
    entry.data = {"id": "test-installation-id"}
    entry.runtime_data = mock_coordinator
    return entry


@pytest.fixture
def mock_hass(mock_config_entry):
    """Create a mock Home Assistant instance."""
    hass = MagicMock(spec=HomeAssistant)
    hass.services = MagicMock()
    hass.config_entries = MagicMock()
    hass.config_entries.async_get_entry.return_value = mock_config_entry
    hass.data = {
        "airzone_cloud": {"tag_store": MagicMock(get_all_tags=MagicMock(return_value={}), remove_tags=AsyncMock())}
    }
    return hass


class TestSchemaValidation:
    """Test service schema validation."""

    def test_get_schedules_schema_valid(self):
        """Test valid get schedules schema."""
        data = {ATTR_CONFIG_ENTRY: "entry-123"}
        result = GET_SCHEDULES_SCHEMA(data)
        assert result[ATTR_CONFIG_ENTRY] == "entry-123"

    def test_get_schedules_schema_missing_entry(self):
        """Test get schedules schema allows missing config_entry."""
        result = GET_SCHEDULES_SCHEMA({})
        assert ATTR_CONFIG_ENTRY not in result

    def test_delete_schedule_schema_valid(self):
        """Test valid delete schedule schema."""
        data = {ATTR_CONFIG_ENTRY: "entry-123", ATTR_SCHEDULE_ID: "sched-456"}
        result = DELETE_SCHEDULE_SCHEMA(data)
        assert result[ATTR_SCHEDULE_ID] == "sched-456"

    def test_delete_schedule_schema_missing_id(self):
        """Test delete schedule schema fails without schedule_id."""
        with pytest.raises(vol.MultipleInvalid):
            DELETE_SCHEDULE_SCHEMA({ATTR_CONFIG_ENTRY: "entry-123"})

    def test_post_schedule_schema_valid(self):
        """Test valid post schedule schema."""
        data = {
            ATTR_CONFIG_ENTRY: "entry-123",
            ATTR_SCHEDULE_DATA: {"name": "Test", "active": True},
        }
        result = POST_SCHEDULE_SCHEMA(data)
        assert result[ATTR_SCHEDULE_DATA]["name"] == "Test"

    def test_post_schedule_schema_missing_data(self):
        """Test post schedule schema fails without schedule_data."""
        with pytest.raises(vol.MultipleInvalid):
            POST_SCHEDULE_SCHEMA({ATTR_CONFIG_ENTRY: "entry-123"})

    def test_patch_schedule_schema_valid(self):
        """Test valid patch schedule schema."""
        data = {
            ATTR_CONFIG_ENTRY: "entry-123",
            ATTR_SCHEDULE_ID: "sched-456",
            ATTR_SCHEDULE_DATA: {"name": "Updated"},
        }
        result = PATCH_SCHEDULE_SCHEMA(data)
        assert result[ATTR_SCHEDULE_DATA]["name"] == "Updated"

    def test_patch_schedules_activate_schema_valid(self):
        """Test valid activate schema."""
        data = {ATTR_CONFIG_ENTRY: "entry-123", ATTR_ACTIVE: True}
        result = PATCH_SCHEDULES_ACTIVATE_SCHEMA(data)
        assert result[ATTR_ACTIVE] is True

    def test_patch_schedules_activate_schema_rejects_non_bool(self):
        """Test activate schema rejects non-boolean-like values."""
        with pytest.raises(vol.MultipleInvalid):
            PATCH_SCHEDULES_ACTIVATE_SCHEMA({ATTR_CONFIG_ENTRY: "entry-123", ATTR_ACTIVE: [1, 2, 3]})


class TestServiceRegistration:
    """Test that services are properly registered."""

    @pytest.mark.asyncio
    async def test_services_registered(self, mock_hass):
        """Test all services are registered during setup."""
        await async_setup_services(mock_hass)

        registered_services = [call.args[1] for call in mock_hass.services.async_register.call_args_list]
        assert "get_installation_schedules" in registered_services
        assert "delete_installation_schedule" in registered_services
        assert "post_installation_schedule" in registered_services
        assert "patch_installation_schedule" in registered_services
        assert "patch_installation_schedules_activate" in registered_services
        assert "toggle_schedule" in registered_services

    @pytest.mark.asyncio
    async def test_delete_all_not_registered(self, mock_hass):
        """Test that the dangerous delete-all service is NOT registered."""
        await async_setup_services(mock_hass)

        registered_services = [call.args[1] for call in mock_hass.services.async_register.call_args_list]
        assert "delete_installation_schedules" not in registered_services


class TestServiceHandlers:
    """Test the actual service handler logic."""

    @pytest.mark.asyncio
    async def test_get_schedules(self, mock_hass, mock_airzone, mock_installation):
        """Test get_installation_schedules returns schedule data."""
        await async_setup_services(mock_hass)

        # Extract the handler function that was registered
        handler = self._get_handler(mock_hass, "get_installation_schedules")

        call = MagicMock(spec=ServiceCall)
        call.data = {ATTR_CONFIG_ENTRY: "test-entry-id"}

        result = await handler(call)

        mock_airzone.api_get_installation_schedules.assert_called_once_with(mock_installation)
        assert "schedules" in result
        assert result["schedules"]["schedule-1"]["name"] == "Morning"

    @pytest.mark.asyncio
    async def test_delete_schedule(self, mock_hass, mock_airzone, mock_installation):
        """Test delete_installation_schedule calls the API correctly."""
        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "delete_installation_schedule")

        call = MagicMock(spec=ServiceCall)
        call.data = {
            ATTR_CONFIG_ENTRY: "test-entry-id",
            ATTR_SCHEDULE_ID: "sched-to-delete",
        }

        await handler(call)

        mock_airzone.api_delete_installation_schedule.assert_called_once_with(mock_installation, "sched-to-delete")

    @pytest.mark.asyncio
    async def test_post_schedule(self, mock_hass, mock_airzone, mock_installation):
        """Test post_installation_schedule creates a new schedule."""
        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "post_installation_schedule")

        schedule_data = {"name": "Evening", "mode": 1, "setpoint": 22.5}
        call = MagicMock(spec=ServiceCall)
        call.data = {
            ATTR_CONFIG_ENTRY: "test-entry-id",
            ATTR_SCHEDULE_DATA: schedule_data,
        }

        result = await handler(call)

        mock_airzone.api_post_installation_schedule.assert_called_once_with(
            mock_installation, {"schedule": schedule_data}
        )
        assert result["response"]["_id"] == "new-schedule-id"

    @pytest.mark.asyncio
    async def test_patch_schedule(self, mock_hass, mock_airzone, mock_installation):
        """Test patch_installation_schedule updates a schedule."""
        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "patch_installation_schedule")

        schedule_data = {"name": "Updated Morning"}
        call = MagicMock(spec=ServiceCall)
        call.data = {
            ATTR_CONFIG_ENTRY: "test-entry-id",
            ATTR_SCHEDULE_ID: "sched-1",
            ATTR_SCHEDULE_DATA: schedule_data,
        }

        result = await handler(call)

        mock_airzone.api_patch_installation_schedule.assert_called_once_with(
            mock_installation, "sched-1", {"schedule": schedule_data}
        )
        assert result["response"]["ok"] is True

    @pytest.mark.asyncio
    async def test_activate_schedules(self, mock_hass, mock_airzone, mock_installation):
        """Test patch_installation_schedules_activate toggles activation."""
        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "patch_installation_schedules_activate")

        call = MagicMock(spec=ServiceCall)
        call.data = {ATTR_CONFIG_ENTRY: "test-entry-id", ATTR_ACTIVE: True}

        await handler(call)

        mock_airzone.api_patch_installation_schedules_activate.assert_called_once_with(mock_installation, True)

    @pytest.mark.asyncio
    async def test_deactivate_schedules(self, mock_hass, mock_airzone, mock_installation):
        """Test deactivating schedules."""
        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "patch_installation_schedules_activate")

        call = MagicMock(spec=ServiceCall)
        call.data = {ATTR_CONFIG_ENTRY: "test-entry-id", ATTR_ACTIVE: False}

        await handler(call)

        mock_airzone.api_patch_installation_schedules_activate.assert_called_once_with(mock_installation, False)

    @pytest.mark.asyncio
    async def test_missing_config_entry_raises(self, mock_hass):
        """Test that a missing config entry raises HomeAssistantError."""
        mock_hass.config_entries.async_get_entry.return_value = None

        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "get_installation_schedules")

        call = MagicMock(spec=ServiceCall)
        call.data = {ATTR_CONFIG_ENTRY: "nonexistent-entry"}

        with pytest.raises(HomeAssistantError, match="not found"):
            await handler(call)

    @pytest.mark.asyncio
    async def test_missing_installation_raises(self, mock_hass, mock_airzone):
        """Test that a missing installation raises HomeAssistantError."""
        mock_airzone.get_installation_id.return_value = None

        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "get_installation_schedules")

        call = MagicMock(spec=ServiceCall)
        call.data = {ATTR_CONFIG_ENTRY: "test-entry-id"}

        with pytest.raises(HomeAssistantError, match="Installation not found"):
            await handler(call)

    @pytest.mark.asyncio
    async def test_toggle_schedule_disable(self, mock_hass, mock_airzone, mock_installation):
        """Test toggle_schedule disables a schedule by name."""
        mock_airzone.api_get_installation_schedules = AsyncMock(
            return_value=[
                {
                    "_id": "sched-abc",
                    "name": "Winter Day",
                    "type": "week",
                    "prog_enabled": True,
                    "start_conf": {
                        "mode": 3,
                        "pspeed": "auto",
                        "setpoint": {"celsius": 20, "fah": 68},
                        "days": [1, 2, 3],
                        "hour": 9,
                        "minutes": 30,
                    },
                    "device_ids": ["dev-1"],
                }
            ]
        )
        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "toggle_schedule")

        call = MagicMock(spec=ServiceCall)
        call.data = {
            ATTR_CONFIG_ENTRY: "test-entry-id",
            ATTR_SCHEDULE_NAME: ["Winter Day"],
            ATTR_ENABLED: False,
        }

        await handler(call)

        mock_airzone.api_patch_installation_schedule.assert_called_once()
        args = mock_airzone.api_patch_installation_schedule.call_args
        assert args[0][1] == "sched-abc"
        payload = args[0][2]["schedule"]
        assert payload["prog_enabled"] is False
        assert payload["setpoint"] == 20
        assert "setpoint" not in payload.get("start_conf", {})

    @pytest.mark.asyncio
    async def test_toggle_schedule_not_found(self, mock_hass, mock_airzone, mock_installation):
        """Test toggle_schedule raises error when schedule name not found."""
        mock_airzone.api_get_installation_schedules = AsyncMock(return_value=[{"_id": "s1", "name": "Other"}])
        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "toggle_schedule")

        call = MagicMock(spec=ServiceCall)
        call.data = {
            ATTR_CONFIG_ENTRY: "test-entry-id",
            ATTR_SCHEDULE_NAME: ["Nonexistent"],
            ATTR_ENABLED: True,
        }

        with pytest.raises(HomeAssistantError, match="No matching schedules|No schedules matched"):
            await handler(call)

    @pytest.mark.asyncio
    async def test_toggle_schedule_case_insensitive(self, mock_hass, mock_airzone, mock_installation):
        """Test toggle_schedule matches schedule name case-insensitively."""
        mock_airzone.api_get_installation_schedules = AsyncMock(
            return_value=[
                {
                    "_id": "s1",
                    "name": "Winter Day",
                    "type": "week",
                    "prog_enabled": False,
                    "start_conf": {"mode": 3, "days": [1]},
                    "device_ids": [],
                }
            ]
        )
        await async_setup_services(mock_hass)
        handler = self._get_handler(mock_hass, "toggle_schedule")

        call = MagicMock(spec=ServiceCall)
        call.data = {
            ATTR_CONFIG_ENTRY: "test-entry-id",
            ATTR_SCHEDULE_NAME: ["winter day"],
            ATTR_ENABLED: True,
        }

        await handler(call)

        mock_airzone.api_patch_installation_schedule.assert_called_once()
        payload = mock_airzone.api_patch_installation_schedule.call_args[0][2]
        assert payload["schedule"]["prog_enabled"] is True

    def test_toggle_schedule_schema_valid(self):
        """Test valid toggle schedule schema."""
        data = {
            ATTR_CONFIG_ENTRY: "entry-123",
            ATTR_SCHEDULE_NAME: ["Winter Day"],
            ATTR_ENABLED: False,
        }
        result = TOGGLE_SCHEDULE_SCHEMA(data)
        assert result[ATTR_SCHEDULE_NAME] == ["Winter Day"]
        assert result[ATTR_ENABLED] is False

    def test_toggle_schedule_schema_valid_without_name(self):
        """Test toggle schedule schema allows omitting schedule_name (for tag-based filtering)."""
        result = TOGGLE_SCHEDULE_SCHEMA({ATTR_ENABLED: True})
        assert ATTR_SCHEDULE_NAME not in result
        assert result[ATTR_ENABLED] is True

    @staticmethod
    def _get_handler(mock_hass, service_name):
        """Extract a registered service handler by name."""
        for call in mock_hass.services.async_register.call_args_list:
            if call.args[1] == service_name:
                return call.args[2]
        raise ValueError(f"Service {service_name} not registered")
