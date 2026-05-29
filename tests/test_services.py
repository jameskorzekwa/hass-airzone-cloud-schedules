"""Tests for the Airzone Cloud schedule services (now HA-store backed)."""

import copy
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import voluptuous as vol
from homeassistant.core import ServiceCall
from homeassistant.exceptions import HomeAssistantError

from custom_components.airzone_cloud.schedule_store import HAScheduleStore
from custom_components.airzone_cloud.services import (
    ATTR_CONFIG_ENTRY,
    ATTR_ENABLED,
    ATTR_SCHEDULE_DATA,
    ATTR_SCHEDULE_ID,
    ATTR_SCHEDULE_NAME,
    ATTR_TAGS,
    DELETE_SCHEDULE_SCHEMA,
    GET_SCHEDULES_SCHEMA,
    PATCH_SCHEDULE_SCHEMA,
    POST_SCHEDULE_SCHEMA,
    SET_SCHEDULE_TAGS_SCHEMA,
    TOGGLE_SCHEDULE_SCHEMA,
    async_setup_services,
)


def _make_hass(schedules=None):
    """mock hass with a real HAScheduleStore (mocked Store) + mock scheduler."""
    with patch("custom_components.airzone_cloud.schedule_store.Store") as store_cls:
        si = MagicMock()
        si.async_load = AsyncMock(return_value=None)
        si.async_save = AsyncMock()
        store_cls.return_value = si
        store = HAScheduleStore(MagicMock())
    store._data = {"schedules": copy.deepcopy(list(schedules or [])), "last_applied": {}}
    store._save = AsyncMock()

    scheduler = MagicMock()
    scheduler._force_devices = AsyncMock()
    scheduler.async_reconcile = AsyncMock()

    hass = MagicMock()
    hass.services = MagicMock()
    hass.services.async_register = MagicMock()
    hass.data = {"airzone_cloud": {"ha_schedule_store": store, "ha_scheduler": scheduler}}
    return hass, store, scheduler


def _handler(hass, name):
    for call in hass.services.async_register.call_args_list:
        if call.args[1] == name:
            return call.args[2]
    raise ValueError(f"service {name} not registered")


def _call(**data):
    c = MagicMock(spec=ServiceCall)
    c.data = data
    return c


SCHEDS = [
    {
        "id": "a",
        "name": "Winter Day",
        "enabled": True,
        "mode": 1,
        "device_ids": ["d1"],
        "tags": ["winter"],
    },
    {
        "id": "b",
        "name": "Summer Night",
        "enabled": True,
        "mode": 2,
        "device_ids": ["d2"],
        "tags": ["summer"],
    },
    {"id": "c", "name": "Vacation", "enabled": False, "mode": 1, "device_ids": ["d1"], "tags": ["away"]},
]


class TestSchemaValidation:
    def test_get_schema(self):
        assert GET_SCHEDULES_SCHEMA({ATTR_CONFIG_ENTRY: "e"})[ATTR_CONFIG_ENTRY] == "e"
        assert GET_SCHEDULES_SCHEMA({}) == {}

    def test_delete_schema_requires_id(self):
        assert DELETE_SCHEDULE_SCHEMA({ATTR_SCHEDULE_ID: "x"})[ATTR_SCHEDULE_ID] == "x"
        with pytest.raises(vol.MultipleInvalid):
            DELETE_SCHEDULE_SCHEMA({ATTR_CONFIG_ENTRY: "e"})

    def test_post_schema_requires_data(self):
        assert POST_SCHEDULE_SCHEMA({ATTR_SCHEDULE_DATA: {"name": "X"}})[ATTR_SCHEDULE_DATA]["name"] == "X"
        with pytest.raises(vol.MultipleInvalid):
            POST_SCHEDULE_SCHEMA({})

    def test_patch_schema(self):
        d = PATCH_SCHEDULE_SCHEMA({ATTR_SCHEDULE_ID: "x", ATTR_SCHEDULE_DATA: {"enabled": False}})
        assert d[ATTR_SCHEDULE_ID] == "x" and d[ATTR_SCHEDULE_DATA]["enabled"] is False

    def test_toggle_schema(self):
        d = TOGGLE_SCHEDULE_SCHEMA({ATTR_SCHEDULE_NAME: ["Winter Day"], ATTR_ENABLED: False})
        assert d[ATTR_SCHEDULE_NAME] == ["Winter Day"] and d[ATTR_ENABLED] is False
        assert TOGGLE_SCHEDULE_SCHEMA({ATTR_ENABLED: True})[ATTR_ENABLED] is True
        with pytest.raises(vol.MultipleInvalid):
            TOGGLE_SCHEDULE_SCHEMA({})  # enabled required

    def test_set_tags_schema(self):
        d = SET_SCHEDULE_TAGS_SCHEMA({ATTR_SCHEDULE_ID: "x", "tags": ["winter", "away"]})
        assert d["tags"] == ["winter", "away"]
        # bare string is coerced into a single-element list
        assert SET_SCHEDULE_TAGS_SCHEMA({ATTR_SCHEDULE_ID: "x", "tags": "winter"})["tags"] == ["winter"]
        with pytest.raises(vol.MultipleInvalid):
            SET_SCHEDULE_TAGS_SCHEMA({ATTR_SCHEDULE_ID: "x"})  # tags required

    def test_toggle_tags_schema(self):
        d = TOGGLE_SCHEDULE_SCHEMA({ATTR_TAGS: ["winter", "away"], ATTR_ENABLED: True})
        assert d[ATTR_TAGS] == ["winter", "away"]


class TestRegistration:
    async def test_expected_services_registered(self):
        hass, _, _ = _make_hass()
        await async_setup_services(hass)
        names = {c.args[1] for c in hass.services.async_register.call_args_list}
        assert names == {
            "get_installation_schedules",
            "delete_installation_schedule",
            "post_installation_schedule",
            "patch_installation_schedule",
            "toggle_schedule",
            "get_schedule_tags",
            "set_schedule_tags",
        }

    async def test_legacy_airzone_services_removed(self):
        hass, _, _ = _make_hass()
        await async_setup_services(hass)
        names = {c.args[1] for c in hass.services.async_register.call_args_list}
        assert "patch_installation_schedules_activate" not in names
        assert "delete_installation_schedules" not in names


class TestHandlers:
    async def test_get_returns_store_schedules(self):
        hass, store, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        res = await _handler(hass, "get_installation_schedules")(_call())
        assert [s["name"] for s in res["schedules"]] == ["Winter Day", "Summer Night", "Vacation"]

    async def test_store_not_initialized_raises(self):
        hass, _, _ = _make_hass()
        hass.data = {"airzone_cloud": {}}
        await async_setup_services(hass)
        with pytest.raises(HomeAssistantError, match="not initialized"):
            await _handler(hass, "get_installation_schedules")(_call())

    async def test_post_adds_and_applies(self):
        hass, store, sched = _make_hass()
        await async_setup_services(hass)
        res = await _handler(hass, "post_installation_schedule")(
            _call(schedule_data={"name": "Evening", "mode": 1, "device_ids": ["d1"]})
        )
        assert res["schedule"]["name"] == "Evening"
        assert len(store.list_schedules()) == 1
        sched._force_devices.assert_awaited()
        sched.async_reconcile.assert_awaited()

    async def test_patch_updates_and_not_found(self):
        hass, store, sched = _make_hass(SCHEDS)
        await async_setup_services(hass)
        res = await _handler(hass, "patch_installation_schedule")(
            _call(schedule_id="a", schedule_data={"setpoint_heat": 19})
        )
        assert res["schedule"]["setpoint_heat"] == 19
        assert store.get_schedule("a")["setpoint_heat"] == 19
        with pytest.raises(HomeAssistantError, match="not found"):
            await _handler(hass, "patch_installation_schedule")(_call(schedule_id="zzz", schedule_data={}))

    async def test_delete_removes_and_reconciles(self):
        hass, store, sched = _make_hass(SCHEDS)
        await async_setup_services(hass)
        await _handler(hass, "delete_installation_schedule")(_call(schedule_id="b"))
        assert [s["id"] for s in store.list_schedules()] == ["a", "c"]
        sched.async_reconcile.assert_awaited()

    async def test_toggle_by_name_case_insensitive(self):
        hass, store, sched = _make_hass(SCHEDS)
        await async_setup_services(hass)
        await _handler(hass, "toggle_schedule")(_call(schedule_name=["winter day"], enabled=False))
        assert store.get_schedule("a")["enabled"] is False
        assert store.get_schedule("b")["enabled"] is True  # untouched
        sched.async_reconcile.assert_awaited()

    async def test_toggle_all(self):
        hass, store, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        await _handler(hass, "toggle_schedule")(_call(all=True, enabled=False))
        assert all(s["enabled"] is False for s in store.list_schedules())

    async def test_toggle_filters_by_single_tag(self):
        hass, store, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        await _handler(hass, "toggle_schedule")(_call(tags=["winter"], enabled=False))
        assert store.get_schedule("a")["enabled"] is False  # winter
        assert store.get_schedule("b")["enabled"] is True  # summer, untouched

    async def test_toggle_multiple_tags_is_or(self):
        hass, store, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        # ANY-of semantics: summer OR away selects both b and c.
        await _handler(hass, "toggle_schedule")(_call(tags=["summer", "away"], enabled=True))
        assert store.get_schedule("b")["enabled"] is True  # summer matched
        assert store.get_schedule("c")["enabled"] is True  # away matched (was disabled)
        assert store.get_schedule("a")["enabled"] is True  # winter not in filter -> untouched

    async def test_toggle_name_or_tag_union(self):
        hass, store, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        # name OR tag: "Summer Night" by name + winter by tag -> a and b.
        await _handler(hass, "toggle_schedule")(_call(schedule_name=["Summer Night"], tags=["winter"], enabled=False))
        assert store.get_schedule("a")["enabled"] is False  # winter tag
        assert store.get_schedule("b")["enabled"] is False  # name match

    async def test_toggle_tag_match_is_case_insensitive(self):
        hass, store, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        await _handler(hass, "toggle_schedule")(_call(tags=["WINTER"], enabled=False))
        assert store.get_schedule("a")["enabled"] is False

    async def test_toggle_requires_a_selector(self):
        hass, _, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        with pytest.raises(HomeAssistantError, match="Provide schedule_name"):
            await _handler(hass, "toggle_schedule")(_call(enabled=False))

    async def test_toggle_no_match_raises_with_filters(self):
        hass, _, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        with pytest.raises(HomeAssistantError, match="No schedules matched filters"):
            await _handler(hass, "toggle_schedule")(_call(schedule_name=["Nope"], enabled=True))

    async def test_toggle_all_empty_store_raises(self):
        hass, _, _ = _make_hass([])
        await async_setup_services(hass)
        with pytest.raises(HomeAssistantError, match="No schedules matched filters"):
            await _handler(hass, "toggle_schedule")(_call(all=True, enabled=False))

    async def test_get_and_set_schedule_tags(self):
        hass, store, sched = _make_hass(SCHEDS)
        await async_setup_services(hass)
        tags = (await _handler(hass, "get_schedule_tags")(_call()))["tags"]
        assert tags["a"] == ["winter"]
        assert tags["c"] == ["away"]
        await _handler(hass, "set_schedule_tags")(_call(schedule_id="b", tags=["winter", "away"]))
        assert store.get_schedule("b")["tags"] == ["winter", "away"]
        sched.async_reconcile.assert_awaited()

    async def test_set_schedule_tags_clears_with_empty_list(self):
        hass, store, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        await _handler(hass, "set_schedule_tags")(_call(schedule_id="a", tags=[]))
        assert store.get_schedule("a")["tags"] == []

    async def test_set_schedule_tags_not_found(self):
        hass, _, _ = _make_hass(SCHEDS)
        await async_setup_services(hass)
        with pytest.raises(HomeAssistantError, match="not found"):
            await _handler(hass, "set_schedule_tags")(_call(schedule_id="zzz", tags=["x"]))
