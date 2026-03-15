"""Local storage for Airzone Cloud schedule tags."""

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

STORAGE_KEY = "airzone_cloud_schedule_tags"
STORAGE_VERSION = 1


class ScheduleTagStore:
    """Store for schedule tags (season, away) keyed by schedule ID."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict = {"schedules": {}}

    async def load(self) -> None:
        stored = await self._store.async_load()
        if stored and isinstance(stored, dict):
            self._data = stored
        else:
            self._data = {"schedules": {}}

    def get_tags(self, schedule_id: str) -> dict:
        return self._data["schedules"].get(schedule_id, {"season": None, "away": False})

    def get_all_tags(self) -> dict:
        return dict(self._data["schedules"])

    async def set_tags(self, schedule_id: str, season: str | None, away: bool) -> None:
        self._data["schedules"][schedule_id] = {"season": season, "away": away}
        await self._store.async_save(self._data)

    async def remove_tags(self, schedule_id: str) -> None:
        if schedule_id in self._data["schedules"]:
            del self._data["schedules"][schedule_id]
            await self._store.async_save(self._data)
