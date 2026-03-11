"""Tests for Airzone Cloud __init__.py constants and structure."""

from homeassistant.const import Platform

from custom_components.airzone_cloud import (
    CARD_URL,
    PLATFORMS,
)


class TestConstants:
    """Test module-level constants."""

    def test_platforms_contains_expected(self):
        """Test that required platforms are defined."""
        assert Platform.CLIMATE in PLATFORMS
        assert Platform.SENSOR in PLATFORMS
        assert Platform.SWITCH in PLATFORMS
        assert Platform.BINARY_SENSOR in PLATFORMS

    def test_card_url_is_valid(self):
        """Test that card URL is a sensible path."""
        assert CARD_URL.startswith("/")
        assert CARD_URL.endswith(".js")
        assert "airzone" in CARD_URL


class TestNoDeleteAllService:
    """Verify the delete-all service was intentionally removed."""

    def test_services_module_has_no_delete_all(self):
        """Confirm delete_installation_schedules is not exposed."""
        import inspect

        from custom_components.airzone_cloud import services

        source = inspect.getsource(services)
        # The service should NOT be registered (it's only in a comment)
        assert 'async_register(\n        DOMAIN,\n        "delete_installation_schedules"' not in source
