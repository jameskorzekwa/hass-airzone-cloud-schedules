# Airzone Cloud Schedules (Custom Integration)

This acts as a transparent override to the core `airzone_cloud` integration to add schedule support via Home Assistant Services, referencing the specific [aioairzone-cloud fork](https://github.com/jameskorzekwa/aioairzone-cloud).

## Installation via HACS

1. Go to HACS -> Integrations.
2. Click the 3 dots in the top right corner and select `Custom repositories`.
3. Add the URL of this repository and select category `Integration`.
4. Click `Install` on the newly added Airzone Cloud Schedules integration.
5. Restart Home Assistant.
6. The `airzone_cloud` integration will now be overridden with this one, activating the custom schedule services.

## Services

The following services are added:

### `airzone_cloud.get_installation_schedules`
Gets a JSON response containing all schedules for the installation linked to the config entry.

**Data:**
- `config_entry`: Your integration Config ID.

### `airzone_cloud.delete_installation_schedule`
Deletes an individual schedule attached to your installation.

**Data:**
- `config_entry`: Your integration Config ID.
- `schedule_id`: The ID of the schedule to delete.

### `airzone_cloud.delete_installation_schedules`
Clears all schedules on your installation.

### `airzone_cloud.post_installation_schedule`
Creates a new schedule for this installation. Returns the new schedule as a response.

**Data:**
- `config_entry`: Your integration Config ID.
- `schedule_data`: The JSON payload representing the schedule you are creating.

### `airzone_cloud.patch_installation_schedule`
Edits the details of an existing schedule.

**Data:**
- `config_entry`: Your integration Config ID.
- `schedule_id`: The ID of the schedule to edit.
- `schedule_data`: The updated JSON payload.

### `airzone_cloud.patch_installation_schedules_activate`
Toggles the global active state for installation schedules.

**Data:**
- `config_entry`: Your integration Config ID.
- `active`: Boolean (True/False) representing whether to enable or disable schedules globally.

## Custom Lovelace UI Card

To make editing schedules painless, this repository also includes a custom frontend card!

### Installation
1. Copy `custom_components/airzone_cloud/airzone-schedules-card.js` from this repository into your Home Assistant's `config/www/` directory. (If the `www` directory does not exist, create it and restart Home Assistant).
2. In Home Assistant, navigate to **Settings** -> **Dashboards** -> click the three dots in the top right -> **Resources**.
3. Click "Add Resource".
4. For the URL enter `/local/airzone-schedules-card.js` and set the type to **JavaScript Module**.
5. Go to your Dashboard, Edit the Dashboard, and click **Add Card**. Scroll down to **Manual**.

### Configuration Example
Add the following YAML to your card, substituting your specific Config Entry ID. (You can find your Config Entry ID by examining the URL when clicking on the Integration inside Settings -> Integrations, or by creating a schedule entry manually in Developer Tools where the UI allows you to select your integration).
```yaml
type: custom:airzone-schedules-card
config_entry: "YOUR_CONFIG_ENTRY_ID_HERE"
```
