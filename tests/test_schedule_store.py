"""Tests for the HA-owned schedule store (schedule_store.HAScheduleStore)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.airzone_cloud.schedule_store import (
    HAScheduleStore,
    migrate_schedule_tags,
    normalize_tags,
)


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
        # Migration adds an empty tags list to a tag-less stored schedule.
        assert s.list_schedules() == [{"id": "a", "tags": []}]
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
        # A schedule with no tags gets an empty list via migration.
        assert s.list_schedules() == [{"id": "x", "tags": []}]
        assert s.get_all_last_applied() == {}

    async def test_load_migrates_legacy_season_away(self, fake_store_cls):
        fake_store_cls.async_load = AsyncMock(
            return_value={
                "schedules": [
                    {"id": "a", "name": "W", "season": "winter", "away": False},
                    {"id": "b", "name": "V", "season": None, "away": True},
                    {"id": "c", "name": "B", "season": "summer", "away": True},
                ]
            }
        )
        s = HAScheduleStore(MagicMock())
        await s.load()
        a, b, c = s.get_schedule("a"), s.get_schedule("b"), s.get_schedule("c")
        assert a["tags"] == ["winter"] and "season" not in a and "away" not in a
        assert b["tags"] == ["away"]
        assert c["tags"] == ["summer", "away"]


class TestScheduleCrud:
    async def test_add_sets_defaults_and_persists(self, store, fake_store_cls):
        sched = await store.add_schedule({"name": "Day", "mode": 1})
        assert sched["name"] == "Day"
        assert sched["id"]  # generated
        assert sched["enabled"] is True
        assert sched["tags"] == []
        assert store.list_schedules() == [sched]
        fake_store_cls.async_save.assert_awaited()

    async def test_add_keeps_explicit_id_and_flags(self, store):
        sched = await store.add_schedule({"id": "fixed", "name": "N", "enabled": False, "tags": ["winter", "away"]})
        assert sched["id"] == "fixed"
        assert sched["enabled"] is False
        assert sched["tags"] == ["winter", "away"]

    async def test_add_migrates_legacy_season_away(self, store):
        sched = await store.add_schedule({"name": "N", "season": "summer", "away": True})
        assert sched["tags"] == ["summer", "away"]
        assert "season" not in sched and "away" not in sched

    async def test_add_normalizes_tags(self, store):
        sched = await store.add_schedule({"name": "N", "tags": ["  away ", "away", "", "Winter"]})
        assert sched["tags"] == ["away", "Winter"]

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

    async def test_update_normalizes_tags(self, store):
        await store.add_schedule({"id": "a", "name": "A"})
        updated = await store.update_schedule("a", {"tags": ["x", " x ", "", "Y"]})
        assert updated["tags"] == ["x", "Y"]

    async def test_update_strips_legacy_keys(self, store):
        await store.add_schedule({"id": "a", "name": "A", "tags": ["keep"]})
        updated = await store.update_schedule("a", {"season": "winter", "away": True, "name": "B"})
        assert "season" not in updated and "away" not in updated
        assert updated["name"] == "B"
        assert updated["tags"] == ["keep"]  # untouched

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


class TestSettings:
    async def test_default_settings_on_empty_store(self, store):
        s = store.get_settings()
        # First-install default: 2°F differential, matching the Airzone
        # backend's own default; lives in the user's display unit so the
        # round-trip back to the dialog shows the same whole number.
        assert s == {"setpoint_differential": 2, "setpoint_differential_unit": "F"}

    async def test_update_persists_and_overrides(self, store, fake_store_cls):
        s = await store.update_settings({"setpoint_differential": 1, "setpoint_differential_unit": "C"})
        assert s["setpoint_differential"] == 1
        assert s["setpoint_differential_unit"] == "C"
        assert store.get_settings()["setpoint_differential"] == 1
        fake_store_cls.async_save.assert_awaited()

    async def test_update_merges_with_existing(self, store):
        # Partial update keeps other fields.
        await store.update_settings({"setpoint_differential": 3})
        s = store.get_settings()
        assert s["setpoint_differential"] == 3
        assert s["setpoint_differential_unit"] == "F"  # default kept

    async def test_load_preserves_stored_settings(self, fake_store_cls):
        fake_store_cls.async_load = AsyncMock(
            return_value={"settings": {"setpoint_differential": 4, "setpoint_differential_unit": "C"}}
        )
        from custom_components.airzone_cloud.schedule_store import HAScheduleStore

        s = HAScheduleStore(MagicMock())
        await s.load()
        assert s.get_settings() == {"setpoint_differential": 4, "setpoint_differential_unit": "C"}

    async def test_load_fills_missing_default_keys(self, fake_store_cls):
        # Stored settings missing the unit key — defaults fill it in.
        fake_store_cls.async_load = AsyncMock(return_value={"settings": {"setpoint_differential": 3}})
        from custom_components.airzone_cloud.schedule_store import HAScheduleStore

        s = HAScheduleStore(MagicMock())
        await s.load()
        got = s.get_settings()
        assert got["setpoint_differential"] == 3
        assert got["setpoint_differential_unit"] == "F"  # default backfilled

    async def test_get_returns_copy(self, store):
        snap = store.get_settings()
        snap["setpoint_differential"] = 99
        assert store.get_settings()["setpoint_differential"] == 2  # internal untouched


class TestTagHelpers:
    def test_normalize_strips_dedups_drops_empty(self):
        assert normalize_tags(["  away ", "away", "", None, "Winter"]) == ["away", "Winter"]

    def test_normalize_accepts_bare_string(self):
        assert normalize_tags("solo") == ["solo"]

    def test_normalize_falsy_is_empty(self):
        assert normalize_tags(None) == []
        assert normalize_tags([]) == []

    def test_normalize_dedup_is_case_insensitive_keeps_first(self):
        assert normalize_tags(["Away", "away", "AWAY"]) == ["Away"]

    def test_migrate_seeds_tags_from_legacy(self):
        s = migrate_schedule_tags({"season": "winter", "away": True})
        assert s["tags"] == ["winter", "away"]
        assert "season" not in s and "away" not in s

    def test_migrate_prefers_existing_tags_over_legacy(self):
        s = migrate_schedule_tags({"tags": ["x"], "season": "winter", "away": True})
        assert s["tags"] == ["x"]
        assert "season" not in s and "away" not in s

    def test_migrate_empty_when_no_legacy(self):
        assert migrate_schedule_tags({})["tags"] == []
