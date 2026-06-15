"""Small, dependency-free helpers for setpoint writes.

Kept out of ``climate.py`` so the logic is unit-testable without importing the
full Home Assistant climate stack (the test env pins an older HA).
"""

from __future__ import annotations


def setpoint_changed(new: float, current: float | None, step: float | None) -> bool:
    """Whether a dual-setpoint edge differs from the device's current value.

    Compared at the device's step resolution so float / °F↔°C rounding noise
    doesn't read an unchanged edge as changed — which would re-pin that edge.
    Re-pinning the *cool* edge to the Aidoo/Mitsubishi cooling floor re-arms a
    firmware reconcile (device differential = 0) that ~24 min later drags heat
    up to cool, collapsing the band; a manual single-edge change in the app
    never re-pins the other edge, which is why it sticks. An unknown current
    value is treated as changed (write it).
    """
    if current is None:
        return True
    s = step or 0.5
    return round(new / s) != round(current / s)
