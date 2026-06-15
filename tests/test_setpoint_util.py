"""Tests for the edge-minimal setpoint helper (setpoint_util.setpoint_changed).

Regression guard for the band-collapse bug: re-writing an *unchanged* setpoint
edge (in particular re-pinning cool to the Aidoo/Mitsubishi cooling floor)
re-arms a firmware reconcile (device differential = 0) that ~24 min later drags
heat up to cool. ``climate.async_set_temperature`` uses this helper to send only
the edge(s) that actually changed — mirroring a manual single-edge app change,
which is exactly why a manual fix sticks. The tricky part is the comparison
resolution: °F→°C of an unchanged value must NOT read as changed.
"""

from custom_components.airzone_cloud.setpoint_util import setpoint_changed


def test_unknown_current_is_changed():
    assert setpoint_changed(19.5, None, 0.5) is True


def test_equal_is_unchanged():
    assert setpoint_changed(19.5, 19.5, 0.5) is False


def test_unchanged_cool_within_step_rounding():
    # 67°F is 19.444°C unrounded vs the device-stored 19.5°C. Same edge — must
    # NOT count as changed, or we'd re-pin cool and re-arm the collapse.
    assert setpoint_changed(19.444444, 19.5, 0.5) is False


def test_changed_heat_from_collapsed_band():
    # Heal 67/67 -> 65/67: heat 65°F (18.333°C) differs from collapsed 19.5°C.
    assert setpoint_changed(18.333333, 19.5, 0.5) is True


def test_real_half_degree_step_is_changed():
    assert setpoint_changed(19.0, 19.5, 0.5) is True


def test_default_step_when_none():
    assert setpoint_changed(18.0, 19.5, None) is True


def test_sub_step_noise_is_unchanged():
    # Pure float noise well under the step must read as unchanged.
    assert setpoint_changed(19.5000001, 19.5, 0.5) is False
