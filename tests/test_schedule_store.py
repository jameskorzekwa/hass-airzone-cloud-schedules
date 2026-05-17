"""Tests for the HA-owned schedule store (schedule_store.HAScheduleStore)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.airzone_cloud.schedule_store import HAScheduleStore


@pytest.fixture
def fake_store_cls():
    """Patch homeassistant Store with a fake whose load/save are AsyncMocks."""
    with patch("custom_components.airzone_cloud.schedule_store.Store") as cls:
        inst = MagicMock()
        inst.async_load = AsyncMock(return_value=None)
        inst.async_save = AsyncMock()
        cls.return_value = inst
        yield inst


@pytest.fixture
async def store(fake_store_cls):
    s = HAScheduleStore(MagicMock())
    await s.load()
    return s


class TestLoad:
    async def test_load_empty_when_no_stored_data(self, fake_store_cls):
        fake_store_cls.async_load = AsyncMock(return_value=None)
        s = HAScheduleStore(MagicMock())
        await s.load()
        assert s.list_schedules() == []
        assert s.get_all_last_applied() == {}

    async def test_load_existing_data(self, fake_store_cls):
        fake_store_cls.async_load = AsyncMock(
            return_value={"schedules": [{"id": "a"}], "last_applied": {"dev1": "a@2026-05-16T09:00"}}
        )
        s = HAScheduleStore(MagicMock())
        await s.load()
        assert s.list_schedules() == [{"id": "a"}]
        assert s.get_last_applied("dev1") == "a@2026-05-16T09:00"

    async def test_load_ignores_non_dict(self, fake_store_cls):
        fake_store_cls.async_load = AsyncMock(return_value=["not", "a", "dict"])
        s = HAScheduleStore(MagicMock())
        await s.load()
        assert s.list_schedules() == []
        assert s.get_all_last_applied() == {}

    async def test_load_partial_data_defaults_missing_keys(self, fake_store_cls):
        fake_store_cls.async_load = AsyncMock(return_value={"schedules": [{"id": "x"}]})
        s = HAScheduleStore(MagicMock())
        await s.load()
        assert s.list_schedules() == [{"id": "x"}]
        assert s.get_all_last_applied() == {}


class TestScheduleCrud:
    async def test_add_sets_defaults_and_persists(self, store, fake_store_cls):
        sched = await store.add_schedule({"name": "Day", "mode": 1})
        assert sched["name"] == "Day"
        assert sched["id"]  # generated
        assert sched["enabled"] is True
        assert sched["season"] is None
        assert sched["away"] is False
        assert store.list_schedules() == [sched]
        fake_store_cls.async_save.assert_awaited()

    async def test_add_keeps_explicit_id_and_flags(self, store):
        sched = await store.add_schedule(
            {"id": "fixed", "name": "N", "enabled": False, "season": "winter", "away": True}
        )
        assert sched["id"] == "fixed"
        assert sched["enabled"] is False
        assert sched["season"] == "winter"
        assert sched["away"] is True

    async def test_list_returns_copy(self, store):
        await store.add_schedule({"id": "a", "name": "A"})
        lst = store.list_schedules()
        lst.append({"id": "injected"})
        assert len(store.list_schedules()) == 1  # internal list untouched

    async def test_get_schedule(self, store):
        await store.add_schedule({"id": "a", "name": "A"})
        assert store.get_schedule("a")["name"] == "A"
        assert store.get_schedule("missing") is None

    async def test_update_merges_changes(self, store):
        await store.add_schedule({"id": "a", "name": "A", "enabled": True})
        updated = await store.update_schedule("a", {"enabled": False, "setpoint_heat": 18})
        assert updated["enabled"] is False
        assert updated["setpoint_heat"] == 18
        assert updated["name"] == "A"

    async def test_update_cannot_change_id(self, store):
        await store.add_schedule({"id": "a", "name": "A"})
        updated = await store.update_schedule("a", {"id": "hacked", "name": "B"})
        assert updated["id"] == "a"
        assert updated["name"] == "B"

    async def test_update_missing_returns_none(self, store):
        assert await store.update_schedule("nope", {"x": 1}) is None

    async def test_remove(self, store):
        await store.add_schedule({"id": "a", "name": "A"})
        assert await store.remove_schedule("a") is True
        assert store.list_schedules() == []
        assert await store.remove_schedule("a") is False


class TestLastApplied:
    async def test_set_get_clear_single(self, store, fake_store_cls):
        await store.set_last_applied("dev1", "sched-a@2026-05-16T09:00")
        assert store.get_last_applied("dev1") == "sched-a@2026-05-16T09:00"
        assert store.get_last_applied("dev2") is None
        fake_store_cls.async_save.assert_awaited()

        await store.clear_last_applied("dev1")
        assert store.get_last_applied("dev1") is None

    async def test_clear_all(self, store):
        await store.set_last_applied("d1", "k1")
        await store.set_last_applied("d2", "k2")
        await store.clear_last_applied()
        assert store.get_all_last_applied() == {}

    async def test_get_all_returns_copy(self, store):
        await store.set_last_applied("d1", "k1")
        snap = store.get_all_last_applied()
        snap["d1"] = "mutated"
        assert store.get_last_applied("d1") == "k1"
