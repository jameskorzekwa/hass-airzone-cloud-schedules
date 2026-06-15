"""Tests for the HA-owned scheduler (scheduler.AirzoneScheduler / get_last_fired).

2026-05-16 is a Saturday; 2026-05-13 a Wednesday; 2026-05-11 a Monday.
Card/JS day numbering (what schedules store): Sun=0, Mon=1, ... Sat=6.
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.airzone_cloud.schedule_store import HAScheduleStore
from custom_components.airzone_cloud.scheduler import (
    SCHEDULE_MODE_TO_HVAC,
    AirzoneScheduler,
    get_last_fired,
)

SAT = datetime(2026, 5, 16, 15, 0)  # Saturday 15:00  (JS getDay = 6)
WED = datetime(2026, 5, 13, 15, 0)  # Wednesday 15:00 (JS getDay = 3)


class TestGetLastFired:
    def test_none_when_no_days_or_hour(self):
        assert get_last_fired({"days": [], "hour": 9}, SAT) is None
        assert get_last_fired({"days": [6], "hour": None}, SAT) is None

    def test_fires_today_when_time_passed(self):
        # Sat (JS=6), 09:00 already passed at 15:00 -> today 09:00
        r = get_last_fired({"days": [6], "hour": 9, "minutes": 0}, SAT)
        assert r == datetime(2026, 5, 16, 9, 0)

    def test_today_match_uses_card_day_numbering_saturday(self):
        # Regression guard for the day-convention bug: Sat must be day 6,
        # not Python weekday() 5. days=[6] on a Saturday => fires today.
        r = get_last_fired({"days": [6], "hour": 8, "minutes": 30}, SAT)
        assert r == datetime(2026, 5, 16, 8, 30)
        # Python-weekday value (5) must NOT match.
        assert get_last_fired({"days": [5], "hour": 8}, SAT) != datetime(2026, 5, 16, 8, 0)

    def test_today_match_wednesday(self):
        # Wed -> JS getDay 3. days=[3] on a Wednesday fires today.
        r = get_last_fired({"days": [3], "hour": 9}, WED)
        assert r == datetime(2026, 5, 13, 9, 0)

    def test_looks_back_when_time_not_yet_reached(self):
        # Sat 15:00, schedule at 22:00 today -> last fire is previous Sat
        r = get_last_fired({"days": [6], "hour": 22, "minutes": 0}, SAT)
        assert r == datetime(2026, 5, 9, 22, 0)

    def test_looks_back_to_other_weekday(self):
        # On Sat, a Monday(=1) schedule's last fire is the most recent Monday
        r = get_last_fired({"days": [1], "hour": 8}, SAT)
        assert r == datetime(2026, 5, 11, 8, 0)  # Mon 2026-05-11

    def test_all_days_fires_today(self):
        r = get_last_fired({"days": [0, 1, 2, 3, 4, 5, 6], "hour": 9}, SAT)
        assert r == datetime(2026, 5, 16, 9, 0)

    def test_minutes_default_zero(self):
        r = get_last_fired({"days": [6], "hour": 10}, SAT)
        assert r == datetime(2026, 5, 16, 10, 0)


def _make_scheduler(schedules=None, last_applied=None, *, unit="°C", entity_state=None, devices=None):
    """Build an AirzoneScheduler with a real store (mocked Store) + mocked hass."""
    with patch("custom_components.airzone_cloud.schedule_store.Store") as store_cls:
        si = MagicMock()
        si.async_load = AsyncMock(return_value=None)
        si.async_save = AsyncMock()
        store_cls.return_value = si
        store = HAScheduleStore(MagicMock())
    store._data = {
        "schedules": schedules or [],
        "last_applied": dict(last_applied or {}),
        "settings": {"setpoint_differential": 2, "setpoint_differential_unit": "F"},
    }
    store._save = AsyncMock()

    hass = MagicMock()
    hass.is_running = True
    hass.config.units.temperature_unit = unit
    hass.services.async_call = AsyncMock()
    if entity_state is None:
        entity_state = MagicMock()
        entity_state.attributes = {"supported_features": 2}  # TARGET_TEMPERATURE_RANGE
    hass.states.get = MagicMock(return_value=entity_state)

    sched = AirzoneScheduler(hass, store)

    # device_id -> entity_id map (default: one Upstairs device)
    devmap = devices or {"dev-up": "climate.upstairs"}
    reg = MagicMock()
    entries = []
    for uid, eid in devmap.items():
        e = MagicMock()
        e.platform = "airzone_cloud"
        e.entity_id = eid
        e.unique_id = uid
        entries.append(e)
    reg.entities.values.return_value = entries
    return sched, hass, store, reg


class TestReconcile:
    async def test_noop_when_no_schedules(self):
        sched, hass, store, reg = _make_scheduler(schedules=[])
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("test")
        hass.services.async_call.assert_not_called()

    async def test_disabled_schedule_ignored(self):
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "s1",
                    "enabled": False,
                    "mode": 1,
                    "days": [6],
                    "hour": 9,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                },
            ]
        )
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("test")
        hass.services.async_call.assert_not_called()

    async def test_applies_and_records_transition(self):
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "s1",
                    "name": "Day",
                    "enabled": True,
                    "mode": 1,
                    "days": [6],
                    "hour": 9,
                    "minutes": 0,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                },
            ]
        )
        # Reconcile at 09:00:30 — the fire just happened, well within the
        # RECENT_FIRE_WINDOW, so the catch-up bound does not apply.
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = datetime(2026, 5, 16, 9, 0, 30)
            await sched.async_reconcile("test")
        # set_hvac_mode heat_cool + set_temperature low/high
        calls = hass.services.async_call.await_args_list
        assert any(c.args[:2] == ("climate", "set_hvac_mode") for c in calls)
        sp = next(c for c in calls if c.args[:2] == ("climate", "set_temperature"))
        assert sp.args[2]["target_temp_low"] == 18
        assert sp.args[2]["target_temp_high"] == 26
        assert store.get_last_applied("dev-up") == "s1@2026-05-16T09:00"

    async def test_same_period_not_reapplied_manual_override_respected(self):
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "s1",
                    "enabled": True,
                    "mode": 1,
                    "days": [6],
                    "hour": 9,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                }
            ],
            last_applied={"dev-up": "s1@2026-05-16T09:00"},
        )
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("test")
        hass.services.async_call.assert_not_called()  # respected, no re-apply

    async def test_missed_transition_catch_up_when_ha_was_down(self):
        # last_applied points at a stale/old key AND last_recon predates the
        # last fire -> HA was demonstrably down at the fire time, so catch up.
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "s1",
                    "enabled": True,
                    "mode": 1,
                    "days": [6],
                    "hour": 9,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                }
            ],
            last_applied={"dev-up": "s1@2026-05-09T09:00"},  # last week
        )
        # last_recon BEFORE today's 09:00 fire -> HA was down at the transition.
        store._data["last_reconciled_at"] = "2026-05-16T08:55:00"
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("test")
        assert hass.services.async_call.await_count >= 1
        assert store.get_last_applied("dev-up") == "s1@2026-05-16T09:00"

    async def test_most_recently_fired_wins(self):
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "morning",
                    "enabled": True,
                    "mode": 1,
                    "days": [6],
                    "hour": 6,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 17,
                    "setpoint_cool": 24,
                },
                {
                    "id": "day",
                    "enabled": True,
                    "mode": 1,
                    "days": [6],
                    "hour": 9,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 19,
                    "setpoint_cool": 26,
                },
            ]
        )
        # last_recon BEFORE today's 09:00 fire so the catch-up bound allows
        # picking up the most-recent transition. With both 06:00 and 09:00
        # in the past, 09:00 (the day schedule) wins.
        store._data["last_reconciled_at"] = "2026-05-16T08:00:00"
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT  # 15:00, both fired today; 09:00 is latest
            await sched.async_reconcile("test")
        assert store.get_last_applied("dev-up") == "day@2026-05-16T09:00"

    async def test_device_with_no_matching_schedule_skipped(self):
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "s1",
                    "enabled": True,
                    "mode": 1,
                    "days": [6],
                    "hour": 9,
                    "device_ids": ["other-dev"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                }
            ],
        )
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("test")
        hass.services.async_call.assert_not_called()
        assert store.get_last_applied("dev-up") is None


class TestApply:
    async def test_dual_setpoint_fahrenheit_conversion(self):
        sched, hass, store, reg = _make_scheduler(unit="°F")
        s = {"name": "X", "mode": 1, "setpoint_heat": 20, "setpoint_cool": 27}
        ok = await sched._apply("climate.upstairs", s)
        assert ok is True
        sp = next(c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature"))
        assert sp.args[2]["target_temp_low"] == 68  # 20C -> 68F
        assert sp.args[2]["target_temp_high"] == 81  # 27C -> 80.6 -> 81F

    async def test_single_setpoint_non_auto(self):
        sched, hass, store, reg = _make_scheduler()
        ok = await sched._apply("climate.upstairs", {"name": "Heat", "mode": 3, "setpoint": 21})
        assert ok is True
        sp = next(c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature"))
        assert sp.args[2] == {"entity_id": "climate.upstairs", "temperature": 21}

    async def test_dual_schedule_on_single_setpoint_zone_applies_midpoint(self):
        # Regression: an Auto (mode 1) schedule whose zone only exposes a
        # single setpoint (double-setpoint off) must still take effect —
        # previously this returned False and the schedule silently no-op'd
        # forever (the "Upstairs - Day didn't turn on at 9:30" bug).
        st = MagicMock()
        st.attributes = {"supported_features": 0}  # no TARGET_TEMPERATURE_RANGE
        sched, hass, store, reg = _make_scheduler(entity_state=st)
        ok = await sched._apply("climate.upstairs", {"name": "X", "mode": 1, "setpoint_heat": 18, "setpoint_cool": 26})
        assert ok is True
        sp = next(c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature"))
        assert sp.args[2] == {"entity_id": "climate.upstairs", "temperature": 22}  # midpoint of 18/26

    async def test_supports_range_read_after_mode_switch(self):
        # Regression: capability is decided from the state AFTER set_hvac_mode,
        # not a snapshot taken while the zone was still in Cool/single.
        st_single = MagicMock()
        st_single.attributes = {"supported_features": 0}  # before: single
        st_range = MagicMock()
        st_range.attributes = {"supported_features": 2}  # after switch: range
        sched, hass, store, reg = _make_scheduler()
        hass.states.get = MagicMock(side_effect=[st_single, st_range, st_range, st_range])
        ok = await sched._apply("climate.upstairs", {"name": "X", "mode": 1, "setpoint_heat": 18, "setpoint_cool": 26})
        assert ok is True
        sp = next(c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature"))
        assert sp.args[2]["target_temp_low"] == 18 and sp.args[2]["target_temp_high"] == 26

    async def test_entity_unavailable_returns_false(self):
        sched, hass, store, reg = _make_scheduler()
        hass.states.get = MagicMock(return_value=None)
        ok = await sched._apply("climate.upstairs", {"mode": 1, "setpoint_heat": 18, "setpoint_cool": 26})
        assert ok is False

    async def test_mode_mapping(self):
        assert SCHEDULE_MODE_TO_HVAC[1] == "heat_cool"
        assert SCHEDULE_MODE_TO_HVAC[2] == "cool"
        assert SCHEDULE_MODE_TO_HVAC[3] == "heat"


class TestLifecycle:
    async def test_start_registers_services_and_reconciles_when_running(self):
        sched, hass, store, reg = _make_scheduler()
        with (
            patch("custom_components.airzone_cloud.scheduler.async_track_time_interval", return_value=lambda: None),
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_start()
        registered = {c.args[1] for c in hass.services.async_register.call_args_list}
        for name in (
            "ha_schedule_add",
            "ha_schedule_update",
            "ha_schedule_delete",
            "ha_schedule_list",
            "ha_schedule_clear_last_applied",
            "ha_reconcile_now",
        ):
            assert name in registered

    async def test_stop_unsubscribes_cleanly(self):
        sched, hass, store, reg = _make_scheduler()
        called = []
        sched._unsubs = [lambda: called.append("interval")]
        sched._started_unsub = lambda: called.append("started")
        await sched.async_stop()
        assert set(called) == {"interval", "started"}
        assert sched._unsubs == []
        assert sched._started_unsub is None


class TestForceApplyOnEdit:
    """An explicit add/enable/update must take effect immediately, even when the
    transition key is unchanged (e.g. only setpoints edited on the active sched).
    """

    async def test_force_devices_clears_only_listed(self):
        sched, hass, store, reg = _make_scheduler(last_applied={"dev-up": "k1", "dev-other": "k2"})
        await sched._force_devices({"device_ids": ["dev-up"]})
        assert store.get_last_applied("dev-up") is None
        assert store.get_last_applied("dev-other") == "k2"  # untouched

    async def test_force_devices_none_is_safe(self):
        sched, hass, store, reg = _make_scheduler(last_applied={"dev-up": "k1"})
        await sched._force_devices(None)
        await sched._force_devices({})
        assert store.get_last_applied("dev-up") == "k1"

    async def test_editing_active_schedule_setpoints_reapplies_now(self):
        # Active schedule already applied this period (same transition key).
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "s1",
                    "enabled": True,
                    "mode": 1,
                    "days": [6],
                    "hour": 9,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 21,
                    "setpoint_cool": 27,
                }
            ],  # edited values
            last_applied={"dev-up": "s1@2026-05-16T09:00"},
        )
        # Without the force, reconcile would skip (same key). Simulate the
        # add/update service path: clear the schedule's devices, then
        # reconcile with the catch-up bound bypassed (as the real service
        # handler does — explicit user intent).
        await sched._force_devices(store.list_schedules()[0])
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("schedule_updated", bypass_catch_up_bound=True)
        sp = next(c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature"))
        assert sp.args[2]["target_temp_low"] == 21
        assert sp.args[2]["target_temp_high"] == 27
        assert store.get_last_applied("dev-up") == "s1@2026-05-16T09:00"

    async def test_update_service_forces_then_reconciles(self):
        # End-to-end through the registered ha_schedule_update handler.
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "s1",
                    "enabled": True,
                    "mode": 1,
                    "days": [6],
                    "hour": 9,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                }
            ],
            last_applied={"dev-up": "s1@2026-05-16T09:00"},
        )
        with (
            patch("custom_components.airzone_cloud.scheduler.async_track_time_interval", return_value=lambda: None),
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_start()
            hass.services.async_call.reset_mock()  # ignore the startup reconcile
            handlers = {c.args[1]: c.args[2] for c in hass.services.async_register.call_args_list}
            call = MagicMock()
            call.data = {"id": "s1", "changes": {"setpoint_heat": 19, "setpoint_cool": 28}}
            await handlers["ha_schedule_update"](call)
        sp = next(c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature"))
        assert sp.args[2]["target_temp_low"] == 19  # edited value applied now
        assert sp.args[2]["target_temp_high"] == 28

    async def test_delete_triggers_reconcile(self):
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "s1",
                    "enabled": True,
                    "mode": 1,
                    "days": [6],
                    "hour": 9,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                }
            ]
        )
        with (
            patch("custom_components.airzone_cloud.scheduler.async_track_time_interval", return_value=lambda: None),
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_start()
            handlers = {c.args[1]: c.args[2] for c in hass.services.async_register.call_args_list}
            call = MagicMock()
            call.data = {"id": "s1"}
            res = await handlers["ha_schedule_delete"](call)
        assert res == {"removed": True}


class TestPostApplyVerify:
    async def test_warns_when_device_snaps_back(self, caplog):
        # Apply 65/75 then have the device "report" 68/75 -> must warn.
        st = MagicMock()
        st.attributes = {"target_temp_low": 68, "target_temp_high": 75}
        sched, hass, store, reg = _make_scheduler(entity_state=st)
        sched_def = {"name": "Home - Downstairs", "id": "x"}
        sent = {"target_temp_low": 65, "target_temp_high": 75}
        with caplog.at_level("WARNING", logger="custom_components.airzone_cloud.scheduler"):
            await sched._post_apply_verify("climate.main_floor", sched_def, sent)
        assert any("did not stick" in r.message for r in caplog.records)
        assert any("Home - Downstairs" in r.message for r in caplog.records)

    async def test_silent_when_values_match(self, caplog):
        st = MagicMock()
        st.attributes = {"target_temp_low": 65, "target_temp_high": 75}
        sched, hass, store, reg = _make_scheduler(entity_state=st)
        sent = {"target_temp_low": 65, "target_temp_high": 75}
        with caplog.at_level("WARNING", logger="custom_components.airzone_cloud.scheduler"):
            await sched._post_apply_verify("climate.main_floor", {"name": "X"}, sent)
        assert not any("did not stick" in r.message for r in caplog.records)

    async def test_apply_schedules_a_verifier(self):
        sched, hass, store, reg = _make_scheduler()
        with patch("custom_components.airzone_cloud.scheduler.async_call_later") as acl:
            ok = await sched._apply(
                "climate.upstairs",
                {"name": "X", "mode": 1, "setpoint_heat": 20, "setpoint_cool": 21},
            )
        assert ok is True
        assert acl.call_count == 1


class TestCatchUpBound:
    """Catch-up only fires for transitions that happened AFTER our last
    successful reconcile — i.e., genuinely missed while HA was down. A fire
    that pre-dates last_reconciled_at was already evaluated; re-applying it
    after a restart would clobber whatever state the system has accumulated
    in the meantime (the 2026-05-22 main_floor midnight bug).
    """

    async def test_stale_fire_before_last_recon_is_not_caught_up(self):
        # Regression for the 2026-05-23 main_floor midnight bug. Day schedule
        # fires at 09:30 daily. HA was running through yesterday 09:30 (so
        # last_recon advanced past that). At ~midnight HA briefly restarted;
        # last_applied is missing on startup (storage hiccup / not yet
        # flushed). On the startup reconcile, the most-recent fire is
        # yesterday-09:30 — 15h stale. It must NOT be re-applied: HA was up
        # at the fire time, so whatever happened then is final.
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "day",
                    "name": "Home - Downstairs",
                    "enabled": True,
                    "mode": 1,
                    "days": [0, 1, 2, 3, 4, 5, 6],
                    "hour": 9,
                    "minutes": 30,
                    "device_ids": ["dev-down"],
                    "setpoint_heat": 18.5,
                    "setpoint_cool": 24,
                },
            ],
            devices={"dev-down": "climate.main_floor"},
            last_applied={},  # missing, simulates the storage hiccup
        )
        # Last reconcile ran late yesterday evening, well AFTER yesterday's
        # 09:30 fire — so we know HA was up when the fire happened.
        store._data["last_reconciled_at"] = "2026-05-22T23:42:00"

        now_midnight = datetime(2026, 5, 23, 0, 40)  # Fri 00:40, post-restart
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = now_midnight
            await sched.async_reconcile("ha_started")
        set_temp = [c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature")]
        assert set_temp == [], f"Stale catch-up applied: {set_temp}"

    async def test_fresh_fire_applies_even_with_no_last_recon(self):
        # A fire within the last RECENT_FIRE_WINDOW (a "real" transition that
        # just happened) always applies, regardless of last_reconciled_at.
        # Without this, the very first reconcile after a fresh install /
        # boot would never apply anything.
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "day",
                    "enabled": True,
                    "mode": 1,
                    "days": [0, 1, 2, 3, 4, 5, 6],
                    "hour": 9,
                    "minutes": 0,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                },
            ],
        )
        # No last_reconciled_at set; now is 09:01 = 60s after the fire.
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = datetime(2026, 5, 16, 9, 1)
            await sched.async_reconcile("interval")
        sp = [c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature")]
        assert len(sp) == 1
        assert store.get_last_applied("dev-up") == "day@2026-05-16T09:00"

    async def test_genuine_missed_transition_is_caught_up(self):
        # HA was down DURING a fire time: last_recon is BEFORE the fire,
        # and HA comes back AFTER it. This is the legitimate catch-up case
        # and must still work.
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "night",
                    "enabled": True,
                    "mode": 1,
                    "days": [0, 1, 2, 3, 4, 5, 6],
                    "hour": 22,
                    "minutes": 0,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18.5,
                    "setpoint_cool": 19.5,
                },
            ],
        )
        # last_recon was 21:55 (just before the fire); now is 22:05 (just
        # after) — HA was down for 10 minutes spanning 22:00.
        store._data["last_reconciled_at"] = "2026-05-16T21:55:00"
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = datetime(2026, 5, 16, 22, 5)
            await sched.async_reconcile("ha_started")
        sp = [c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature")]
        assert len(sp) == 1
        assert store.get_last_applied("dev-up") == "night@2026-05-16T22:00"

    async def test_stale_fire_with_no_last_recon_is_skipped(self):
        # Cold start (e.g., fresh install) with last_reconciled_at = None:
        # don't auto-apply a stale schedule. The user can use Apply Now to
        # bootstrap if they want the active period applied immediately.
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "day",
                    "enabled": True,
                    "mode": 1,
                    "days": [0, 1, 2, 3, 4, 5, 6],
                    "hour": 9,
                    "minutes": 0,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                },
            ],
        )
        # No last_recon. Now is 6h after fire — well past RECENT window.
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = datetime(2026, 5, 16, 15, 0)
            await sched.async_reconcile("ha_started")
        sp = [c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature")]
        assert sp == []

    async def test_bypass_catch_up_bound_applies_even_when_stale(self):
        # The add/update service handlers and apply_now want the schedule
        # pushed regardless of recency — they're explicit user intent.
        sched, hass, store, reg = _make_scheduler(
            schedules=[
                {
                    "id": "day",
                    "enabled": True,
                    "mode": 1,
                    "days": [0, 1, 2, 3, 4, 5, 6],
                    "hour": 9,
                    "minutes": 0,
                    "device_ids": ["dev-up"],
                    "setpoint_heat": 18,
                    "setpoint_cool": 26,
                },
            ],
        )
        store._data["last_reconciled_at"] = "2026-05-16T14:00:00"  # past the fire
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = datetime(2026, 5, 16, 15, 0)
            await sched.async_reconcile("schedule_updated", bypass_catch_up_bound=True)
        sp = [c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature")]
        assert len(sp) == 1

    async def test_reconcile_advances_last_reconciled_at(self):
        sched, hass, store, reg = _make_scheduler(schedules=[])
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("interval")
        assert store.get_last_reconciled_at() == SAT


class TestApplyNow:
    async def test_applies_to_each_device_of_schedule(self):
        sched_def = {
            "id": "s1",
            "name": "Home - Downstairs",
            "mode": 1,
            "setpoint_heat": 18.5,
            "setpoint_cool": 24,
            "device_ids": ["dev-down", "dev-up"],
        }
        sched, hass, store, reg = _make_scheduler(
            schedules=[sched_def],
            devices={"dev-down": "climate.main_floor", "dev-up": "climate.upstairs"},
        )
        with patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg):
            res = await sched.apply_now("s1")
        assert [a["entity_id"] for a in res["applied"]] == ["climate.main_floor", "climate.upstairs"]
        assert all(a["ok"] is True for a in res["applied"])
        sp_calls = [c for c in hass.services.async_call.await_args_list if c.args[:2] == ("climate", "set_temperature")]
        entities = sorted(c.args[2]["entity_id"] for c in sp_calls)
        assert entities == ["climate.main_floor", "climate.upstairs"]
        for c in sp_calls:
            assert c.args[2]["target_temp_low"] == 18.5
            assert c.args[2]["target_temp_high"] == 24

    async def test_unknown_schedule_returns_error(self):
        sched, hass, store, reg = _make_scheduler(schedules=[{"id": "s1", "name": "X"}])
        with patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg):
            res = await sched.apply_now("missing")
        assert res["applied"] == []
        assert "not found" in res["error"]


class TestSettingsServices:
    """ha_settings_get / ha_settings_update — read and patch the UI setting
    that the card uses to enforce min heat/cool gap (mirrors the Airzone
    backend's differential, but enforced in HA so the user can disable
    device-side correction)."""

    async def test_settings_get_returns_defaults(self):
        sched, hass, store, reg = _make_scheduler()
        with (
            patch("custom_components.airzone_cloud.scheduler.async_track_time_interval", return_value=lambda: None),
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_start()
            handlers = {c.args[1]: c.args[2] for c in hass.services.async_register.call_args_list}
            res = await handlers["ha_settings_get"](MagicMock())
        assert res["settings"]["setpoint_differential"] == 2
        assert res["settings"]["setpoint_differential_unit"] == "F"

    async def test_settings_update_patches_and_returns(self):
        sched, hass, store, reg = _make_scheduler()
        with (
            patch("custom_components.airzone_cloud.scheduler.async_track_time_interval", return_value=lambda: None),
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_start()
            handlers = {c.args[1]: c.args[2] for c in hass.services.async_register.call_args_list}
            call = MagicMock()
            call.data = {"changes": {"setpoint_differential": 3, "setpoint_differential_unit": "C"}}
            res = await handlers["ha_settings_update"](call)
        assert res["settings"]["setpoint_differential"] == 3
        assert res["settings"]["setpoint_differential_unit"] == "C"
        # Re-read via the get handler — change persisted.
        get_call = MagicMock()
        get_call.data = {}
        # Use same handlers map.
        re_get = await handlers["ha_settings_get"](get_call)
        assert re_get["settings"]["setpoint_differential"] == 3


def _dual_sched(sid="s1", **over):
    s = {
        "id": sid,
        "name": "Night",
        "enabled": True,
        "mode": 1,
        "days": [0, 1, 2, 3, 4, 5, 6],
        "hour": 9,
        "minutes": 0,
        "device_ids": ["dev-up"],
        "setpoint_heat": 18.5,  # 65°F
        "setpoint_cool": 19.5,  # 67°F
    }
    s.update(over)
    return s


def _range_state(low, high, state="heat_cool"):
    st = MagicMock()
    st.state = state
    st.attributes = {"supported_features": 2, "target_temp_low": low, "target_temp_high": high}
    return st


class TestDifferentialWatchdog:
    """The device (Aidoo, differential=0) drags heat up to cool ~24 min after a
    band is written, leaving a zero-gap band. The watchdog must re-assert it."""

    async def test_reasserts_collapsed_band(self):
        # Live band collapsed to 67/67 *mid-period* — last_applied matches the
        # active schedule, so the normal apply path is skipped (would do nothing
        # before this fix). The watchdog must still re-assert 65/67, mode-free.
        sched, hass, store, reg = _make_scheduler(
            schedules=[_dual_sched()],
            last_applied={"dev-up": "s1@2026-05-16T09:00"},
            unit="°F",
            entity_state=_range_state(67, 67),
        )
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("test")
        calls = hass.services.async_call.await_args_list
        sp = [c for c in calls if c.args[:2] == ("climate", "set_temperature")]
        assert len(sp) == 1
        assert sp[0].args[2]["target_temp_low"] == 65
        assert sp[0].args[2]["target_temp_high"] == 67
        # The watchdog re-asserts setpoints only — never the mode (a mode
        # re-assert is one of the writes that can re-arm the collapse).
        assert not any(c.args[:2] == ("climate", "set_hvac_mode") for c in calls)

    async def test_healthy_band_left_untouched(self):
        # Gap == differential (65/67 with a 2°F diff): nothing to heal.
        sched, hass, store, reg = _make_scheduler(
            schedules=[_dual_sched()],
            last_applied={"dev-up": "s1@2026-05-16T09:00"},
            unit="°F",
            entity_state=_range_state(65, 67),
        )
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("test")
        hass.services.async_call.assert_not_called()

    async def test_no_reassert_when_differential_zero(self):
        sched, hass, store, reg = _make_scheduler(
            schedules=[_dual_sched()],
            last_applied={"dev-up": "s1@2026-05-16T09:00"},
            unit="°F",
            entity_state=_range_state(67, 67),
        )
        store._data["settings"] = {"setpoint_differential": 0, "setpoint_differential_unit": "F"}
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("test")
        hass.services.async_call.assert_not_called()

    async def test_single_setpoint_schedule_not_watched(self):
        # A cool-only (single-setpoint) schedule has no heat/cool band to guard.
        sched, hass, store, reg = _make_scheduler(
            schedules=[_dual_sched(mode=2, setpoint=19.5, setpoint_heat=None, setpoint_cool=None)],
            last_applied={"dev-up": "s1@2026-05-16T09:00"},
            unit="°F",
            entity_state=_range_state(67, 67),
        )
        with (
            patch("custom_components.airzone_cloud.scheduler.er.async_get", return_value=reg),
            patch("custom_components.airzone_cloud.scheduler.datetime") as dt,
        ):
            dt.now.return_value = SAT
            await sched.async_reconcile("test")
        hass.services.async_call.assert_not_called()
