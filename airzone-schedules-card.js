const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MODES = {
  1: { label: 'Auto', icon: '<ha-icon icon="mdi:autorenew"></ha-icon>', color: '#9b59b6' },
  2: { label: 'Cooling', icon: '<ha-icon icon="mdi:snowflake"></ha-icon>', color: '#3498db' },
  3: { label: 'Heating', icon: '<ha-icon icon="mdi:fire"></ha-icon>', color: '#e74c3c' },
  4: { label: 'Ventilation', icon: '<ha-icon icon="mdi:fan"></ha-icon>', color: '#2ecc71' },
  5: { label: 'Dry', icon: '<ha-icon icon="mdi:water-percent"></ha-icon>', color: '#f39c12' },
  7: { label: 'Emergency Heat', icon: '<ha-icon icon="mdi:fire-alert"></ha-icon>', color: '#c0392b' },
};
const DEFAULT_MODE = { label: 'Unknown', icon: '<ha-icon icon="mdi:help-circle-outline"></ha-icon>', color: '#888' };
const SCHEDULE_MODE_TO_HVAC = { 1: 'heat_cool', 2: 'cool', 3: 'heat', 4: 'fan_only', 5: 'dry', 7: 'heat' };

const HVAC_MODE_MAP = {
  heat: { label: 'Heating', icon: 'mdi:fire', color: '#e74c3c' },
  cool: { label: 'Cooling', icon: 'mdi:snowflake', color: '#3498db' },
  heat_cool: { label: 'Auto', icon: 'mdi:autorenew', color: '#9b59b6' },
  auto: { label: 'Auto', icon: 'mdi:autorenew', color: '#9b59b6' },
  dry: { label: 'Dry', icon: 'mdi:water-percent', color: '#f39c12' },
  fan_only: { label: 'Fan', icon: 'mdi:fan', color: '#2ecc71' },
  off: { label: 'Off', icon: 'mdi:power', color: '#888' },
};

const HVAC_ACTION_MAP = {
  heating: { label: 'Heating', color: '#e74c3c' },
  cooling: { label: 'Cooling', color: '#3498db' },
  drying: { label: 'Drying', color: '#f39c12' },
  fan: { label: 'Fan', color: '#2ecc71' },
  idle: { label: 'Idle', color: '#888' },
  off: { label: 'Off', color: '#555' },
};

function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(h, m) { return pad(h) + ':' + pad(m); }
function cToF(c) { return Math.round(c * 9 / 5 + 32); }
function fToC(f) { return Math.round((f - 32) * 5 / 9 * 2) / 2; }

class AirzoneSchedulesCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._schedules = [];
    this._tags = {};
    this._initialized = false;
    this._useFah = localStorage.getItem('az-temp-unit') !== 'C';
    this._activeTab = localStorage.getItem('az-active-tab') || 'schedules';
    this._filterSeason = null; // null = all, 'winter', 'summer'
    this._filterAway = null;   // null = all, true, false
    this._lastScheduleLoad = 0;
  }

  _displayTemp(celsius) {
    if (celsius == null) return '—';
    return this._useFah ? cToF(celsius) + '°F' : celsius + '°C';
  }

  _displayTempVal(celsius) {
    if (celsius == null) return '—';
    return this._useFah ? cToF(celsius) : celsius;
  }

  _unitLabel() { return this._useFah ? '°F' : '°C'; }
  _haUnitLabel() { return this._hass?.config?.unit_system?.temperature || '°C'; }
  _toDisplay(celsius) { return this._useFah ? cToF(celsius) : celsius; }
  _toCelsius(display) { return this._useFah ? fToC(display) : display; }

  set panel(panel) {
    this._panel = panel;
    if (panel && panel.config) {
      this.setConfig(panel.config);
    }
  }

  set hass(hass) {
    this._hass = hass;
    this._tryInit();
    if (this._initialized && this._activeTab === 'zones') {
      // Only re-render if zone state actually changed
      const zoneHash = this._getZoneHash();
      if (zoneHash !== this._lastZoneHash) {
        this._lastZoneHash = zoneHash;
        this._renderZones();
      }
    }
    if (this._initialized && this._activeTab === 'schedules') {
      const now = Date.now();
      if (now - this._lastScheduleLoad > 60000) {
        this._loadSchedules();
      }
    }
  }

  _getZoneHash() {
    if (!this._hass) return '';
    return Object.entries(this._hass.states)
      .filter(([eid]) => eid.startsWith('climate.'))
      .map(([eid, s]) => `${eid}:${s.state}:${s.attributes.current_temperature}:${s.attributes.temperature}:${s.attributes.target_temp_low}:${s.attributes.target_temp_high}:${s.attributes.hvac_action}:${s.attributes.current_humidity}:${s.attributes.fan_mode}`)
      .join('|');
  }

  setConfig(config) {
    this.config = config || {};
    this._tryInit();
  }

  async _tryInit() {
    if (!this._initialized && this._hass && this.config) {
      this._initialized = true;
      this._render();
      await this._loadData();
      // Re-render active tab now that devices are loaded
      if (this._activeTab === 'zones') this._renderZones();
    }
  }

  _render() {
    this.innerHTML = '';
    const card = document.createElement('ha-card');
    if (this._panel) card.classList.add('is-panel');
    card.innerHTML = `
      <style>
        :host { --az-primary: var(--primary-color, #4a90d9); --az-danger: var(--error-color, #e74c3c); --az-success: var(--success-color, #27ae60); --az-bg: var(--card-background-color, #1c1c1c); --az-surface: var(--primary-background-color, #252525); --az-text: var(--primary-text-color, #e0e0e0); --az-text2: var(--secondary-text-color, #999); --az-border: var(--divider-color, rgba(200,200,200,0.1)); font-family: var(--primary-font-family, -apple-system, sans-serif); }
        ha-card { transition: all 0.3s ease; }
        ha-card.is-panel { background: transparent; border: none; box-shadow: none; padding: 20px; max-width: 1400px; margin: 0 auto; }
        .az-header { display:flex; align-items:center; justify-content:space-between; padding:24px 32px 16px; flex-wrap:wrap; gap:12px; }
        ha-card.is-panel .az-header { padding: 16px 0 16px 0; }
        .az-header h2 { margin:0; font-size:1.8em; font-weight:600; color:var(--az-text); display:flex; align-items:center; gap:12px; }
        .az-header h2 ha-icon { --mdc-icon-size: 36px; color: var(--az-primary); }
        .az-header-actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
        .az-tabs { display:flex; gap:0; padding:0 32px 16px; border-bottom: 1px solid var(--az-border); }
        ha-card.is-panel .az-tabs { padding: 0 0 16px 0; }
        .az-tab { border:none; background:transparent; color:var(--az-text2); font-size:1.05em; font-weight:600; padding:12px 24px; cursor:pointer; transition:all 0.2s; border-bottom:3px solid transparent; font-family: inherit; display:flex; align-items:center; gap:8px; }
        .az-tab:hover { color:var(--az-text); }
        .az-tab.active { color:var(--az-primary); border-bottom-color:var(--az-primary); }
        .az-tab ha-icon { --mdc-icon-size: 20px; }
        .az-btn { border:none; border-radius:10px; padding:10px 20px; font-size:1em; font-weight:600; cursor:pointer; transition:all 0.2s; display:inline-flex; align-items:center; gap:8px; font-family: inherit; }
        .az-btn-primary { background:var(--az-primary); color:var(--text-primary-color, #fff); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .az-btn-primary:hover { filter:brightness(1.15); transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0,0,0,0.2); }
        .az-btn-primary:active { transform: translateY(1px); }
        .az-btn-outline { background:var(--az-surface); border:1px solid var(--az-border); color:var(--az-text); }
        .az-btn-outline:hover { background:var(--az-border); }
        .az-btn-danger { background:var(--az-surface); border:1px solid var(--az-danger); color:var(--az-danger); }
        .az-btn-danger:hover { background:rgba(231,76,60,0.1); }
        .az-btn-sm { padding:8px 16px; font-size:0.9em; }
        .az-btn-icon { padding:8px; min-width:36px; justify-content:center; }
        .az-unit-toggle { background:var(--az-surface); border:1px solid var(--az-border); border-radius:10px; padding:4px; display:inline-flex; gap:0; }
        .az-unit-btn { border:none; background:transparent; color:var(--az-text2); font-size:0.9em; font-weight:700; padding:6px 10px; border-radius:8px; cursor:pointer; transition:all 0.2s; }
        .az-unit-btn.active { background:var(--az-primary); color:var(--text-primary-color, #fff); }
        .az-list { padding:20px 32px 32px; display:grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap:20px; }
        ha-card.is-panel .az-list { padding: 20px 0 0; }
        .az-empty { text-align:center; padding:64px 20px; color:var(--az-text2); grid-column: 1 / -1; font-size: 1.2em; }
        .az-empty-icon { margin-bottom:16px; color: var(--az-border); }
        .az-schedule-group { display:grid; grid-template-columns: repeat(auto-fill, minmax(min(440px, 100%), 1fr)); gap:16px; }
        .az-schedule { background:var(--card-background-color, var(--az-surface)); border-radius:16px; overflow:hidden; border:1px solid var(--az-border); transition:all 0.2s; box-shadow: 0 4px 16px rgba(0,0,0,0.06); display: flex; flex-direction: column; }
        .az-schedule:hover { border-color:var(--az-primary); transform: translateY(-4px); box-shadow: 0 12px 24px rgba(0,0,0,0.1); }
        .az-schedule-top { display:flex; align-items:center; flex-wrap:wrap; padding:24px; gap:20px; }
        .az-schedule-icon { width:64px; height:64px; border-radius:16px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .az-schedule-icon ha-icon { --mdc-icon-size: 32px; }
        .az-schedule-info { flex:1 1 200px; min-width:0; }
        .az-schedule-name { font-weight:600; font-size:1.3em; color:var(--az-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; letter-spacing: 0.3px; }
        .az-schedule-meta { font-size:0.95em; color:var(--az-text2); margin-top:8px; display:flex; gap:16px; flex-wrap:wrap; font-weight: 500; }
        .az-schedule-toggle { position:relative; width:54px; height:30px; flex-shrink:0; cursor: pointer; }
        .az-schedule-toggle input { opacity:0; width:0; height:0; position: absolute; }
        .az-toggle-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:var(--disabled-text-color, #777); border-radius:30px; transition:0.3s; box-shadow: inset 0 2px 4px rgba(0,0,0,0.2); }
        .az-toggle-slider:before { position:absolute; content:""; height:22px; width:22px; left:4px; bottom:4px; background:white; border-radius:50%; transition:0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        .az-schedule-toggle input:checked + .az-toggle-slider { background:var(--az-success); }
        .az-schedule-toggle input:checked + .az-toggle-slider:before { transform:translateX(24px); }
        .az-schedule-actions { display:flex; gap:8px; flex-shrink:0; margin-left: auto; }
        .az-days { display:flex; gap:6px; padding:0 24px 24px; margin-top: auto; }
        .az-day { flex: 1; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:0.85em; font-weight:700; text-transform: uppercase; letter-spacing: 0.5px; }
        .az-day-on { background:var(--az-primary); color:var(--text-primary-color, white); box-shadow: 0 4px 10px rgba(74, 144, 217, 0.3); }
        .az-day-off { background:var(--az-surface); color:var(--az-text2); border: 1px solid var(--az-border); }
        .az-loading { text-align:center; padding:64px; color:var(--az-text2); grid-column: 1 / -1; font-size: 1.2em; }
        .az-spinner { display:inline-block; width:36px; height:36px; border:4px solid var(--az-border); border-top-color:var(--az-primary); border-radius:50%; animation:az-spin 0.8s linear infinite; margin-bottom: 16px; }
        @keyframes az-spin { to { transform:rotate(360deg); } }

        dialog.az-editor-overlay { border:none; background:transparent; padding:0; outline:none; margin:auto; width: 100%; max-width: 600px; overflow:visible; }
        dialog.az-editor-overlay::backdrop { background:rgba(0,0,0,0.8); backdrop-filter: blur(8px); }
        .az-editor { background:var(--card-background-color, var(--az-bg)); border-radius:24px; width:100%; display:flex; flex-direction:column; max-height:90vh; border:1px solid var(--az-border); box-shadow:0 30px 90px rgba(0,0,0,0.6); overflow: hidden; }
        .az-editor-header { display:flex; align-items:center; justify-content:space-between; padding:24px 32px; border-bottom:1px solid var(--az-border); background: var(--secondary-background-color, rgba(0,0,0,0.02)); }
        .az-editor-header h3 { margin:0; font-size:1.4em; color:var(--az-text); font-weight: 600; }
        .az-editor-body { padding:32px; display:flex; flex-direction:column; gap:28px; overflow-y:auto; }
        .az-field label { display:block; font-size:0.85em; font-weight:700; color:var(--az-text2); margin-bottom:10px; text-transform:uppercase; letter-spacing:0.8px; }
        .az-field input[type=text], .az-field input[type=number], .az-field select { width:100%; padding:14px 16px; border:2px solid var(--az-border); border-radius:12px; background:var(--primary-background-color, var(--az-surface)); color:var(--az-text); font-size:1.1em; box-sizing:border-box; outline:none; transition:border 0.2s; font-family: inherit; }
        .az-field input:focus, .az-field select:focus { border-color:var(--az-primary); }
        .az-time-row { display:flex; gap:12px; align-items:center; }
        .az-time-row input { width:100px; text-align:center; font-size: 1.6em; font-weight: 600; padding: 12px; }
        .az-time-row span { color:var(--az-text); font-size:2em; font-weight:600; margin-bottom: 6px; }
        .az-days-editor { display:flex; gap:8px; }
        .az-day-btn { flex:1; height:48px; border:2px solid var(--az-border); border-radius:12px; background:var(--primary-background-color, var(--az-surface)); color:var(--az-text2); font-size:0.9em; font-weight:700; text-transform: uppercase; cursor:pointer; transition:all 0.2s; }
        .az-day-btn.active { background:var(--az-primary); color:white; border-color:var(--az-primary); box-shadow: 0 4px 12px rgba(74, 144, 217, 0.3); }
        .az-modes-editor { display:flex; gap:10px; flex-wrap:wrap; }
        .az-mode-btn { padding:12px 20px; border:2px solid var(--az-border); border-radius:12px; background:var(--primary-background-color, var(--az-surface)); color:var(--az-text); font-size:1em; font-weight: 500; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; gap:8px; }
        .az-mode-btn ha-icon { --mdc-icon-size: 20px; }
        .az-mode-btn.active { border-color:var(--az-primary); background:rgba(74,144,217,0.1); color: var(--az-primary); }
        .az-temp-row { display:flex; align-items:center; gap:24px; }
        .az-temp-val { font-size:3.5em; font-weight:400; color:var(--az-text); min-width:120px; text-align:center; display: flex; align-items: flex-start; justify-content: center; letter-spacing: -2px; }
        .az-temp-unit { font-size:0.35em; color:var(--az-text2); margin-top: 12px; font-weight: 600; letter-spacing: normal; }
        .az-temp-btn { width:64px; height:64px; border-radius:50%; border:none; background:var(--primary-background-color, var(--az-surface)); color:var(--az-text); font-size:2em; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .az-temp-btn:hover { background:var(--az-primary); color:white; transform: scale(1.05); box-shadow: 0 8px 20px rgba(74, 144, 217, 0.4); }
        .az-temp-btn:active { transform: scale(0.95); }
        .az-editor-footer { display:flex; justify-content:flex-end; gap:12px; padding:24px 32px; border-top:1px solid var(--az-border); background: var(--secondary-background-color, rgba(0,0,0,0.02)); }
        .az-toast { position:fixed; bottom:32px; left:50%; transform:translateX(-50%); padding:14px 28px; border-radius:12px; color:white; font-size:1em; font-weight: 600; z-index:1000; animation:az-fade-in 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
        @keyframes az-fade-in { from { opacity:0; transform:translateX(-50%) translateY(20px) scale(0.9); } to { opacity:1; transform:translateX(-50%) translateY(0) scale(1); } }
        .az-devices { font-size:0.85em; color:var(--az-text2); padding:0 24px 20px; margin-top: 4px; font-weight: 500; }

        .az-filters { display:flex; gap:8px; padding:16px 32px 8px; flex-wrap:wrap; align-items:center; }
        ha-card.is-panel .az-filters { padding: 16px 0 8px 0; }
        .az-filter-label { font-size:0.85em; font-weight:600; color:var(--az-text2); text-transform:uppercase; letter-spacing:0.5px; margin-right:4px; }
        .az-filter-btn { border:1px solid var(--az-border); background:var(--az-surface); color:var(--az-text2); font-size:0.85em; font-weight:600; padding:6px 14px; border-radius:20px; cursor:pointer; transition:all 0.2s; font-family:inherit; display:inline-flex; align-items:center; gap:4px; }
        .az-filter-btn:hover { border-color:var(--az-text2); }
        .az-filter-btn.active { background:var(--az-primary); color:var(--text-primary-color, #fff); border-color:var(--az-primary); }
        .az-filter-btn ha-icon { --mdc-icon-size: 14px; }

        .az-zone { background:var(--card-background-color, var(--az-surface)); border-radius:16px; overflow:hidden; border:1px solid var(--az-border); transition:all 0.2s; box-shadow: 0 4px 16px rgba(0,0,0,0.06); display:flex; flex-direction:column; padding:18px 20px; gap:14px; }
        .az-zone:hover { border-color:var(--az-primary); transform: translateY(-4px); box-shadow: 0 12px 24px rgba(0,0,0,0.1); }
        .az-zone-header { display:flex; align-items:center; gap:14px; }
        .az-zone-icon { width:44px; height:44px; border-radius:12px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .az-zone-icon ha-icon { --mdc-icon-size: 22px; }
        .az-zone-name { font-weight:600; font-size:1.2em; color:var(--az-text); flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .az-zone-action { font-size:0.78em; font-weight:600; padding:4px 10px; border-radius:8px; display:inline-flex; align-items:center; gap:4px; }
        .az-zone-temps { display:flex; align-items:flex-end; gap:30px; flex-wrap:wrap; padding-top:14px; border-top:1px solid var(--az-border); }
        .az-zone-cell { display:flex; flex-direction:column; align-items:center; gap:4px; }
        .az-zone-current-val { font-size:2.1em; font-weight:300; color:var(--az-text); letter-spacing:-1px; line-height:1; }
        .az-zone-sp-val { font-size:1.5em; font-weight:700; line-height:1; display:flex; align-items:center; gap:5px; }
        .az-zone-sp-unit { font-size:0.45em; color:var(--az-text2); font-weight:600; }
        .az-zone-current-label { font-size:0.68em; color:var(--az-text2); text-transform:uppercase; font-weight:700; letter-spacing:0.6px; }
        .az-zone-off { font-size:1.3em; font-weight:600; color:var(--az-text2); line-height:1; }
        .az-zone-target { display:flex; align-items:center; gap:10px; }
        .az-zone-target-val { font-size:1.5em; font-weight:600; color:var(--az-text); min-width:54px; text-align:center; }
        .az-zone-temp-btn { width:36px; height:36px; border-radius:50%; border:none; background:var(--primary-background-color, var(--az-surface)); color:var(--az-text); cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .az-zone-temp-btn:hover { background:var(--az-primary); color:white; }
        .az-sched-temp { display:inline-flex; align-items:center; gap:7px; }
        .az-sched-sp-btn { width:22px; height:22px; border-radius:50%; border:none; background:var(--primary-background-color, var(--az-surface)); color:var(--az-text); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:all 0.15s; box-shadow:0 1px 4px rgba(0,0,0,0.15); flex-shrink:0; padding:0; }
        .az-sched-sp-btn:hover { background:var(--az-primary); color:#fff; }
        .az-sched-sp-btn:active { transform:scale(0.9); }
        .az-inline-select { border:1px solid var(--az-border); border-radius:8px; background:var(--primary-background-color, var(--az-surface)); color:var(--az-text); font-family:inherit; font-size:0.95em; font-weight:600; padding:3px 6px; cursor:pointer; outline:none; transition:border 0.2s; max-width:140px; }
        .az-inline-select:hover, .az-inline-select:focus { border-color:var(--az-primary); }
        .az-sched-sel-wrap { display:flex; align-items:center; gap:6px; }
        .az-sched-sel-wrap ha-icon { --mdc-icon-size:16px; flex-shrink:0; }
        .az-sched-select { width:150px; max-width:none; flex-shrink:0; }
        .az-zone-stats { display:flex; gap:18px; flex-wrap:wrap; font-size:0.82em; color:var(--az-text2); font-weight:600; padding-top:12px; border-top:1px solid var(--az-border); }
        .az-zone-stat { display:flex; align-items:center; gap:4px; }
        .az-zone-stat ha-icon { --mdc-icon-size: 15px; }

        @media(max-width: 600px) {
          .az-list { grid-template-columns: 1fr; padding: 0 16px 16px; }
          .az-header { padding: 16px; }
          ha-card.is-panel .az-header { padding: 8px 0 12px; }
          .az-header h2 { font-size: 1.4em; }
          .az-header h2 ha-icon { --mdc-icon-size: 28px; }
          .az-header-actions { gap: 8px; }
          .az-filters { padding: 12px 16px 8px; }
          ha-card.is-panel .az-filters { padding: 12px 0 8px; }
          .az-schedule-top { padding: 16px; flex-wrap: wrap; gap: 14px; }
          .az-schedule-icon { width: 48px; height: 48px; }
          .az-schedule-icon ha-icon { --mdc-icon-size: 24px; }
          .az-schedule-name { font-size: 1.15em; }
          .az-schedule-meta { gap: 10px 14px; }
          .az-schedule-actions { margin-left: 0; width: 100%; justify-content: flex-end; }
          .az-days { padding: 0 16px 16px; }
          .az-devices { padding: 0 16px 16px; }
          .az-sched-select { width: 124px; }
          .az-zone { padding: 16px; }
          .az-zone-temps { gap: 16px; }
          .az-editor-body { padding: 20px; }
          .az-editor-header { padding: 20px; }
          .az-editor-footer { padding: 20px; }
          .az-temp-row { gap: 12px; justify-content: center; }
          .az-tabs { padding: 0 16px 12px; }
          .az-tab { padding: 10px 16px; font-size: 0.95em; }
        }
        @media(max-width: 420px) {
          .az-header h2 { font-size: 1.25em; }
          .az-header h2 ha-icon { --mdc-icon-size: 24px; }
          .az-header-actions { width: 100%; justify-content: space-between; }
          .az-btn { padding: 8px 12px; font-size: 0.9em; }
          .az-tab { padding: 9px 12px; font-size: 0.9em; }
          .az-zone-name { font-size: 1.05em; }
          .az-zone-temps { gap: 12px; justify-content: space-between; }
          .az-zone-current-val { font-size: 1.9em; }
          .az-schedule-meta { gap: 8px 12px; font-size: 0.9em; }
          .az-sched-select { width: 110px; }
          .az-days { gap: 4px; }
          .az-day { font-size: 0.7em; height: 32px; }
        }
      </style>
      <div class="az-header">
        <h2><ha-icon icon="mdi:air-conditioner"></ha-icon> Airzone</h2>
        <div class="az-header-actions">
          <div class="az-unit-toggle">
            <button class="az-unit-btn ${this._useFah ? '' : 'active'}" id="az-unit-c">°C</button>
            <button class="az-unit-btn ${this._useFah ? 'active' : ''}" id="az-unit-f">°F</button>
          </div>
          <button class="az-btn az-btn-outline az-btn-sm" id="az-refresh"><ha-icon icon="mdi:refresh" style="--mdc-icon-size: 16px;"></ha-icon> Refresh</button>
          <button class="az-btn az-btn-primary az-btn-sm" id="az-add" style="display:${this._activeTab === 'schedules' ? 'inline-flex' : 'none'}"><ha-icon icon="mdi:plus" style="--mdc-icon-size: 16px;"></ha-icon> New</button>
        </div>
      </div>
      <div class="az-tabs">
        <button class="az-tab ${this._activeTab === 'zones' ? 'active' : ''}" data-tab="zones"><ha-icon icon="mdi:home-thermometer-outline"></ha-icon> Zones</button>
        <button class="az-tab ${this._activeTab === 'schedules' ? 'active' : ''}" data-tab="schedules"><ha-icon icon="mdi:calendar-clock"></ha-icon> Schedules</button>
      </div>
      <div id="az-filters" class="az-filters" style="display:${this._activeTab === 'schedules' ? 'flex' : 'none'}">
        <span class="az-filter-label">Season:</span>
        <button class="az-filter-btn active" data-filter="season" data-value="all">All</button>
        <button class="az-filter-btn" data-filter="season" data-value="winter"><ha-icon icon="mdi:snowflake"></ha-icon> Winter</button>
        <button class="az-filter-btn" data-filter="season" data-value="summer"><ha-icon icon="mdi:white-balance-sunny"></ha-icon> Summer</button>
        <span class="az-filter-label" style="margin-left:12px;">Away:</span>
        <button class="az-filter-btn active" data-filter="away" data-value="all">All</button>
        <button class="az-filter-btn" data-filter="away" data-value="yes"><ha-icon icon="mdi:airplane"></ha-icon> Away</button>
        <button class="az-filter-btn" data-filter="away" data-value="no"><ha-icon icon="mdi:home"></ha-icon> Not Away</button>
      </div>
      <div id="az-tab-schedules" class="az-list" style="display:${this._activeTab === 'schedules' ? '' : 'none'}">
        <div class="az-loading"><div class="az-spinner"></div><br/>Loading schedules…</div>
      </div>
      <div id="az-tab-zones" class="az-list" style="display:${this._activeTab === 'zones' ? '' : 'none'}">
        <div class="az-loading"><div class="az-spinner"></div><br/>Loading zones…</div>
      </div>
    `;
    this.appendChild(card);
    card.querySelector('#az-unit-c').addEventListener('click', () => this._setUnit(false));
    card.querySelector('#az-unit-f').addEventListener('click', () => this._setUnit(true));
    card.querySelector('#az-refresh').addEventListener('click', () => {
      if (this._activeTab === 'schedules') this._loadData();
      else this._renderZones();
    });
    card.querySelector('#az-add').addEventListener('click', () => this._openEditor(null));
    card.querySelectorAll('.az-tab').forEach(btn => {
      btn.addEventListener('click', () => this._switchTab(btn.dataset.tab));
    });
    card.querySelectorAll('.az-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setFilter(btn.dataset.filter, btn.dataset.value));
    });
  }

  _switchTab(tab) {
    this._activeTab = tab;
    localStorage.setItem('az-active-tab', tab);
    const schedTab = this.querySelector('#az-tab-schedules');
    const zonesTab = this.querySelector('#az-tab-zones');
    const addBtn = this.querySelector('#az-add');
    const filters = this.querySelector('#az-filters');
    schedTab.style.display = tab === 'schedules' ? '' : 'none';
    zonesTab.style.display = tab === 'zones' ? '' : 'none';
    addBtn.style.display = tab === 'schedules' ? 'inline-flex' : 'none';
    if (filters) filters.style.display = tab === 'schedules' ? 'flex' : 'none';
    this.querySelectorAll('.az-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    if (tab === 'zones') this._renderZones();
  }

  _setFilter(type, value) {
    if (type === 'season') {
      this._filterSeason = value === 'all' ? null : value;
    } else if (type === 'away') {
      this._filterAway = value === 'all' ? null : value === 'yes';
    }
    // Update active states on filter buttons
    this.querySelectorAll(`.az-filter-btn[data-filter="${type}"]`).forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === value);
    });
    this._renderList();
  }

  _setUnit(useFah) {
    this._useFah = useFah;
    localStorage.setItem('az-temp-unit', useFah ? 'F' : 'C');
    const cBtn = this.querySelector('#az-unit-c');
    const fBtn = this.querySelector('#az-unit-f');
    cBtn.classList.toggle('active', !useFah);
    fBtn.classList.toggle('active', useFah);
    if (this._activeTab === 'schedules') this._renderList();
    else this._renderZones();
  }

  async _loadData() {
    await this._loadDevices();
    await this._loadSchedules();
  }

  async _loadDevices() {
    if (this._availableDevices) return;
    try {
      const entities = await this._hass.callWS({ type: 'config/entity_registry/list' });
      this._availableDevices = entities
        .filter(e => e.platform === 'airzone_cloud' && e.entity_id.startsWith('climate.'))
        .map(e => ({
          id: e.unique_id,
          entity_id: e.entity_id,
          name: e.name || e.original_name || (this._hass.states[e.entity_id] && this._hass.states[e.entity_id].attributes.friendly_name) || e.entity_id
        }));
    } catch (err) {
      console.error('Failed to load entity registry', err);
      this._availableDevices = [];
    }
  }

  async _loadSchedules() {
    const list = this.querySelector('#az-tab-schedules');
    if (!list) return;
    this._lastScheduleLoad = Date.now();
    list.innerHTML = '<div class="az-loading"><div class="az-spinner"></div><br/>Loading schedules…</div>';
    try {
      const resp = await this._hass.callWS({
        type: 'call_service', domain: 'airzone_cloud', service: 'ha_schedule_list',
        service_data: {}, return_response: true
      });
      const raw = resp.response || resp;
      this._schedules = Array.isArray(raw.schedules) ? raw.schedules : [];
      this._renderList();
    } catch (err) {
      list.innerHTML = '<div class="az-empty"><div class="az-empty-icon"><ha-icon icon="mdi:alert-outline" style="--mdc-icon-size: 48px;"></ha-icon></div>Error loading schedules<br/><small>' + (err.message || '') + '</small></div>';
    }
  }

  _renderList() {
    const list = this.querySelector('#az-tab-schedules');
    if (!list) return;
    if (!this._schedules.length) {
      list.innerHTML = '<div class="az-empty"><div class="az-empty-icon"><ha-icon icon="mdi:calendar-blank-outline" style="--mdc-icon-size: 48px;"></ha-icon></div>No schedules configured<br/><small>Click "New" to create one</small></div>';
      return;
    }
    list.innerHTML = '';
    let sorted = [...this._schedules].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Apply filters
    if (this._filterSeason !== null || this._filterAway !== null) {
      sorted = sorted.filter(s => {
        if (this._filterSeason !== null && (s.season || null) !== this._filterSeason) return false;
        if (this._filterAway !== null && !!s.away !== this._filterAway) return false;
        return true;
      });
    }

    if (!sorted.length) {
      list.innerHTML = '<div class="az-empty"><div class="az-empty-icon"><ha-icon icon="mdi:filter-off-outline" style="--mdc-icon-size: 48px;"></ha-icon></div>No schedules match the current filters</div>';
      return;
    }

    const enabled = sorted.filter(s => s.enabled !== false);
    const disabled = sorted.filter(s => s.enabled === false);

    const buildCard = (s) => {
      const modeInfo = MODES[s.mode] || DEFAULT_MODE;
      const isActive = s.enabled !== false;
      const days = s.days || [];
      const time = (s.hour != null) ? fmtTime(s.hour, s.minutes || 0) : '—';
      // Inline setpoint steppers — adjust the schedule's stored temp on the
      // fly (debounced ha_schedule_update). Mirrors the zone-card steppers.
      const spStepper = (kind, color, icon, celsius) => `
        <span class="az-sched-temp" style="color:${color}; font-weight:700;">
          <button class="az-sched-sp-btn" data-sid="${s.id}" data-kind="${kind}" data-dir="down" title="Lower ${kind} setpoint"><ha-icon icon="mdi:minus" style="--mdc-icon-size:13px;"></ha-icon></button>
          <span style="display:inline-flex; align-items:center; gap:4px;"><ha-icon icon="${icon}" style="--mdc-icon-size:15px;"></ha-icon><span class="az-sched-sp-val" data-kind="${kind}">${this._displayTemp(celsius)}</span></span>
          <button class="az-sched-sp-btn" data-sid="${s.id}" data-kind="${kind}" data-dir="up" title="Raise ${kind} setpoint"><ha-icon icon="mdi:plus" style="--mdc-icon-size:13px;"></ha-icon></button>
        </span>`;
      const tempHtml = (s.mode === 1 && s.setpoint_heat != null && s.setpoint_cool != null)
        ? `<span style="display:flex; align-items:center; flex-wrap:wrap; gap:8px 14px;">${spStepper('heat', '#e74c3c', 'mdi:fire', s.setpoint_heat)}${spStepper('cool', '#3498db', 'mdi:snowflake', s.setpoint_cool)}</span>`
        : s.setpoint != null
          ? spStepper('single', 'var(--az-text2)', 'mdi:thermometer', s.setpoint)
          : `<span style="display:flex; align-items:center; gap:4px;"><ha-icon icon="mdi:thermometer" style="--mdc-icon-size: 16px;"></ha-icon> —</span>`;
      const name = s.name || 'Unnamed Schedule';
      const deviceCount = (s.device_ids || []).length;
      const deviceNamesStr = (s.device_ids || [])
        .map(id => this._availableDevices?.find(d => d.id === id)?.name || id)
        .join(', ');

      const el = document.createElement('div');
      el.className = 'az-schedule';
      el.innerHTML = `
        <div class="az-schedule-top">
          <div class="az-schedule-icon" style="background:${modeInfo.color}22; color:${modeInfo.color}">${modeInfo.icon}</div>
          <div class="az-schedule-info">
            <div class="az-schedule-name">${name}</div>
            <div class="az-schedule-meta">
              <span style="display:flex; align-items:center; gap:4px;"><ha-icon icon="mdi:clock-outline" style="--mdc-icon-size: 16px;"></ha-icon> ${time}</span>
              ${tempHtml}
              <span class="az-sched-sel-wrap">${modeInfo.icon}<select class="az-inline-select az-sched-select az-sched-mode" data-sid="${s.id}" title="Mode">${Object.entries(MODES).map(([v, m]) => '<option value="' + v + '"' + (parseInt(v) === s.mode ? ' selected' : '') + '>' + m.label + '</option>').join('')}</select></span>
              <span class="az-sched-sel-wrap"><ha-icon icon="mdi:fan"></ha-icon><select class="az-inline-select az-sched-select az-sched-fan" data-sid="${s.id}" title="Fan speed">${[['auto', 'Auto'], ['1', 'Low'], ['2', 'Medium'], ['3', 'High']].map(([v, l]) => '<option value="' + v + '"' + ((s.pspeed == null || s.pspeed === '' ? 'auto' : String(s.pspeed)) === v ? ' selected' : '') + '>' + l + '</option>').join('')}</select></span>
            </div>
          </div>
          <label class="az-schedule-toggle">
            <input type="checkbox" ${isActive ? 'checked' : ''} data-id="${s.id}"/>
            <span class="az-toggle-slider"></span>
          </label>
          <div class="az-schedule-actions">
            <button class="az-btn az-btn-outline az-btn-icon az-btn-sm az-edit" data-id="${s.id}" title="Edit"><ha-icon icon="mdi:pencil" style="--mdc-icon-size: 18px;"></ha-icon></button>
            <button class="az-btn az-btn-outline az-btn-icon az-btn-sm az-dup" data-id="${s.id}" title="Duplicate"><ha-icon icon="mdi:content-copy" style="--mdc-icon-size: 18px;"></ha-icon></button>
            <button class="az-btn az-btn-danger az-btn-icon az-btn-sm az-del" data-id="${s.id}" title="Delete"><ha-icon icon="mdi:delete" style="--mdc-icon-size: 18px;"></ha-icon></button>
          </div>
        </div>
        <div class="az-days">${DAY_LABELS.map((d, i) => '<span class="az-day ' + (days.includes(i) ? 'az-day-on' : 'az-day-off') + '">' + d + '</span>').join('')}</div>
        ${(() => { const b = []; if (s.season === 'winter') b.push('<span style="display:inline-flex;align-items:center;gap:4px;background:#3498db22;color:#3498db;padding:4px 10px;border-radius:8px;font-size:0.8em;font-weight:600;"><ha-icon icon="mdi:snowflake" style="--mdc-icon-size:14px;"></ha-icon> Winter</span>'); if (s.season === 'summer') b.push('<span style="display:inline-flex;align-items:center;gap:4px;background:#e7743422;color:#e74c3c;padding:4px 10px;border-radius:8px;font-size:0.8em;font-weight:600;"><ha-icon icon="mdi:white-balance-sunny" style="--mdc-icon-size:14px;"></ha-icon> Summer</span>'); if (s.away) b.push('<span style="display:inline-flex;align-items:center;gap:4px;background:#f39c1222;color:#f39c12;padding:4px 10px;border-radius:8px;font-size:0.8em;font-weight:600;"><ha-icon icon="mdi:airplane" style="--mdc-icon-size:14px;"></ha-icon> Away</span>'); return b.length ? '<div style="display:flex;gap:8px;padding:0 24px 8px;flex-wrap:wrap;">' + b.join('') + '</div>' : ''; })()}
        ${deviceCount ? '<div class="az-devices" style="display:flex; align-items:center; gap:4px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="' + deviceNamesStr + '"><ha-icon icon="mdi:map-marker-outline" style="--mdc-icon-size: 16px; flex-shrink: 0;"></ha-icon> <span style="overflow: hidden; text-overflow: ellipsis;">' + deviceNamesStr + '</span></div>' : ''}
      `;

      el.querySelector('.az-edit').addEventListener('click', () => this._openEditor(s));
      el.querySelector('.az-dup').addEventListener('click', () => this._openEditor(s, true));
      el.querySelector('.az-del').addEventListener('click', () => this._deleteSchedule(s.id));
      el.querySelector('input[type=checkbox]').addEventListener('change', (e) => this._toggleSchedule(s, e.target.checked));
      el.querySelectorAll('.az-sched-sp-btn').forEach((btn) => {
        btn.addEventListener('click', () => this._bumpScheduleSetpoint(s, btn.dataset.kind, btn.dataset.dir, el));
      });
      const schedModeSel = el.querySelector('.az-sched-mode');
      if (schedModeSel) {
        schedModeSel.addEventListener('change', () => {
          const newMode = parseInt(schedModeSel.value);
          // Mode determines setpoint shape: Auto (1) uses dual heat/cool,
          // others a single setpoint. Backfill defaults (like the editor) so
          // the scheduler always has a usable setpoint for the new mode.
          const changes = { mode: newMode };
          if (newMode === 1) {
            changes.setpoint = null;
            changes.setpoint_heat = s.setpoint_heat != null ? s.setpoint_heat : 19;
            changes.setpoint_cool = s.setpoint_cool != null ? s.setpoint_cool : 24;
          } else {
            changes.setpoint = s.setpoint != null ? s.setpoint : 21;
            changes.setpoint_heat = null;
            changes.setpoint_cool = null;
          }
          this._updateSchedule(s.id, changes, 'Mode updated');
        });
      }
      const schedFanSel = el.querySelector('.az-sched-fan');
      if (schedFanSel) {
        schedFanSel.addEventListener('change', () => {
          const v = schedFanSel.value;
          this._updateSchedule(s.id, { pspeed: v === 'auto' ? 'auto' : parseInt(v) }, 'Fan speed updated');
        });
      }
      return el;
    };

    const buildGroup = (schedules, label, open, key) => {
      const details = document.createElement('details');
      if (open) details.setAttribute('open', '');
      details.style.cssText = 'margin-bottom:8px; grid-column: 1 / -1;';
      const summary = document.createElement('summary');
      summary.style.cssText = 'list-style:none; display:flex; align-items:center; gap:8px; padding:10px 4px; cursor:pointer; font-weight:600; font-size:0.95em; color:var(--az-text2); user-select:none;';
      summary.innerHTML = `<ha-icon icon="mdi:chevron-right" class="az-group-chevron" style="--mdc-icon-size:18px; transition:transform 0.2s;"></ha-icon>${label} <span style="margin-left:4px; font-weight:400; font-size:0.9em; opacity:0.7;">(${schedules.length})</span>`;
      details.appendChild(summary);
      const grid = document.createElement('div');
      grid.className = 'az-schedule-group';
      for (const s of schedules) grid.appendChild(buildCard(s));
      details.appendChild(grid);

      // Rotate chevron when open and persist open/closed state
      const updateChevron = () => {
        const icon = summary.querySelector('.az-group-chevron');
        if (icon) icon.style.transform = details.open ? 'rotate(90deg)' : '';
      };
      details.addEventListener('toggle', () => {
        this._groupOpen[key] = details.open;
        updateChevron();
      });
      updateChevron();

      return details;
    };

    if (!this._groupOpen) this._groupOpen = { enabled: true, disabled: false };
    if (enabled.length) list.appendChild(buildGroup(enabled, 'Enabled', this._groupOpen.enabled, 'enabled'));
    if (disabled.length) list.appendChild(buildGroup(disabled, 'Disabled', this._groupOpen.disabled, 'disabled'));
  }

  _renderZones() {
    const container = this.querySelector('#az-tab-zones');
    if (!container || !this._hass) return;

    // Show spinner until devices are loaded
    if (!this._availableDevices) {
      container.innerHTML = '<div class="az-loading"><div class="az-spinner"></div><br/>Loading zones…</div>';
      return;
    }

    // Get climate entities for airzone_cloud
    const climateEntities = Object.entries(this._hass.states)
      .filter(([eid]) => eid.startsWith('climate.'))
      .filter(([eid]) => {
        if (this._availableDevices && this._availableDevices.length) {
          return this._availableDevices.some(d => d.entity_id === eid);
        }
        return eid.includes('airzone');
      })
      .map(([eid, state]) => ({ entity_id: eid, ...state }))
      // Filter out installation/group entities (e.g. "Home") — only show individual zones
      .filter(z => {
        const name = (z.attributes.friendly_name || '').toLowerCase();
        return !name.endsWith('home') && !name.endsWith('installation');
      })
      .sort((a, b) => (a.attributes.friendly_name || '').localeCompare(b.attributes.friendly_name || ''));

    if (!climateEntities.length) {
      container.innerHTML = '<div class="az-empty"><div class="az-empty-icon"><ha-icon icon="mdi:home-thermometer-outline" style="--mdc-icon-size: 48px;"></ha-icon></div>No Airzone zones found</div>';
      return;
    }

    container.innerHTML = '';
    for (const zone of climateEntities) {
      const a = zone.attributes;
      const name = a.friendly_name || zone.entity_id;
      const currentTemp = a.current_temperature;
      const targetTemp = a.temperature;
      const humidity = a.current_humidity;
      const hvacMode = zone.state || 'off';
      const hvacAction = a.hvac_action || 'off';
      const fanMode = a.fan_mode;
      const minTemp = a.min_temp || 15;
      const maxTemp = a.max_temp || 30;
      const isOff = hvacMode === 'off';
      // Dual-setpoint (auto / double_sp) zones expose target_temp_low/high
      // instead of a single temperature.
      const tLow = a.target_temp_low;
      const tHigh = a.target_temp_high;
      const isDual = hvacMode === 'heat_cool' && tLow != null && tHigh != null;
      const uLabel = this._haUnitLabel();

      const modeInfo = HVAC_MODE_MAP[hvacMode] || HVAC_MODE_MAP.off;
      const actionInfo = HVAC_ACTION_MAP[hvacAction] || HVAC_ACTION_MAP.off;

      const el = document.createElement('div');
      el.className = 'az-zone';
      el.innerHTML = `
        <div class="az-zone-header">
          <div class="az-zone-icon" style="background:${modeInfo.color}22; color:${modeInfo.color}">
            <ha-icon icon="${modeInfo.icon}"></ha-icon>
          </div>
          <div class="az-zone-name">${name}</div>
          <span class="az-zone-action" style="background:${actionInfo.color}22; color:${actionInfo.color};">${actionInfo.label}</span>
          <label class="az-schedule-toggle">
            <input type="checkbox" class="az-zone-power" ${!isOff ? 'checked' : ''} data-entity="${zone.entity_id}"/>
            <span class="az-toggle-slider"></span>
          </label>
        </div>
        <div class="az-zone-temps">
          <div class="az-zone-cell">
            <div class="az-zone-current-val">${currentTemp != null ? currentTemp : '—'}<span class="az-zone-sp-unit">${this._haUnitLabel()}</span></div>
            <div class="az-zone-current-label">Current</div>
          </div>
          ${isOff ? `
          <div class="az-zone-cell">
            <div class="az-zone-off">Off</div>
            <div class="az-zone-current-label">Power</div>
          </div>
          ` : isDual ? `
          <div class="az-zone-cell" style="gap:7px;">
            <div class="az-zone-target">
              <button class="az-zone-temp-btn az-zone-sp-btn" data-entity="${zone.entity_id}" data-kind="heat" data-dir="down" title="Lower heat setpoint"><ha-icon icon="mdi:minus" style="--mdc-icon-size:16px;"></ha-icon></button>
              <div class="az-zone-target-val" style="color:#e74c3c;"><ha-icon icon="mdi:fire" style="--mdc-icon-size:16px;"></ha-icon> ${tLow}<span class="az-zone-sp-unit">${uLabel}</span></div>
              <button class="az-zone-temp-btn az-zone-sp-btn" data-entity="${zone.entity_id}" data-kind="heat" data-dir="up" title="Raise heat setpoint"><ha-icon icon="mdi:plus" style="--mdc-icon-size:16px;"></ha-icon></button>
            </div>
            <div class="az-zone-current-label">Heat</div>
          </div>
          <div class="az-zone-cell" style="gap:7px;">
            <div class="az-zone-target">
              <button class="az-zone-temp-btn az-zone-sp-btn" data-entity="${zone.entity_id}" data-kind="cool" data-dir="down" title="Lower cool setpoint"><ha-icon icon="mdi:minus" style="--mdc-icon-size:16px;"></ha-icon></button>
              <div class="az-zone-target-val" style="color:#3498db;"><ha-icon icon="mdi:snowflake" style="--mdc-icon-size:16px;"></ha-icon> ${tHigh}<span class="az-zone-sp-unit">${uLabel}</span></div>
              <button class="az-zone-temp-btn az-zone-sp-btn" data-entity="${zone.entity_id}" data-kind="cool" data-dir="up" title="Raise cool setpoint"><ha-icon icon="mdi:plus" style="--mdc-icon-size:16px;"></ha-icon></button>
            </div>
            <div class="az-zone-current-label">Cool</div>
          </div>
          ` : targetTemp != null ? `
          <div class="az-zone-cell" style="gap:7px;">
            <div class="az-zone-target">
              <button class="az-zone-temp-btn az-zone-temp-down" data-entity="${zone.entity_id}" data-min="${minTemp}"><ha-icon icon="mdi:minus" style="--mdc-icon-size:16px;"></ha-icon></button>
              <div class="az-zone-target-val">${targetTemp}<span class="az-zone-sp-unit">${uLabel}</span></div>
              <button class="az-zone-temp-btn az-zone-temp-up" data-entity="${zone.entity_id}" data-max="${maxTemp}"><ha-icon icon="mdi:plus" style="--mdc-icon-size:16px;"></ha-icon></button>
            </div>
            <div class="az-zone-current-label">Target</div>
          </div>
          ` : ''}
        </div>
        <div class="az-zone-stats">
          ${(a.fan_modes && a.fan_modes.length)
            ? '<span class="az-zone-stat"><ha-icon icon="mdi:fan"></ha-icon> <select class="az-inline-select az-zone-fan" data-entity="' + zone.entity_id + '" title="Fan speed">' + a.fan_modes.map(f => '<option value="' + f + '"' + (f === fanMode ? ' selected' : '') + '>' + f.charAt(0).toUpperCase() + f.slice(1) + '</option>').join('') + '</select></span>'
            : (fanMode ? '<span class="az-zone-stat"><ha-icon icon="mdi:fan"></ha-icon> ' + fanMode + '</span>' : '')}
          <span class="az-zone-stat"><ha-icon icon="mdi:${modeInfo.icon.replace('mdi:', '')}"></ha-icon> <select class="az-inline-select az-zone-mode" data-entity="${zone.entity_id}" title="Mode">${(a.hvac_modes && a.hvac_modes.length ? a.hvac_modes : [hvacMode]).map(m => '<option value="' + m + '"' + (m === hvacMode ? ' selected' : '') + '>' + ((HVAC_MODE_MAP[m] && HVAC_MODE_MAP[m].label) || m) + '</option>').join('')}</select></span>
          ${humidity != null ? '<span class="az-zone-stat"><ha-icon icon="mdi:water-percent"></ha-icon> ' + humidity + '%</span>' : ''}
        </div>
      `;

      // Power toggle
      el.querySelector('.az-zone-power').addEventListener('change', (e) => {
        const eid = e.target.dataset.entity;
        if (e.target.checked) {
          this._hass.callService('climate', 'turn_on', { entity_id: eid });
        } else {
          this._hass.callService('climate', 'turn_off', { entity_id: eid });
        }
      });

      // Temp buttons
      const downBtn = el.querySelector('.az-zone-temp-down');
      const upBtn = el.querySelector('.az-zone-temp-up');
      if (downBtn) {
        downBtn.addEventListener('click', () => {
          const haFah = this._haUnitLabel() === '°F';
          const step = haFah ? 1 : 0.5;
          const curTarget = this._hass.states[zone.entity_id]?.attributes?.temperature || targetTemp || 21;
          const newTemp = Math.max(parseFloat(downBtn.dataset.min), curTarget - step);
          this._hass.callService('climate', 'set_temperature', { entity_id: zone.entity_id, temperature: newTemp });
        });
      }
      if (upBtn) {
        upBtn.addEventListener('click', () => {
          const haFah = this._haUnitLabel() === '°F';
          const step = haFah ? 1 : 0.5;
          const curTarget = this._hass.states[zone.entity_id]?.attributes?.temperature || targetTemp || 21;
          const newTemp = Math.min(parseFloat(upBtn.dataset.max), curTarget + step);
          this._hass.callService('climate', 'set_temperature', { entity_id: zone.entity_id, temperature: newTemp });
        });
      }

      // Dual (heat_cool) inline setpoint steppers. HA's set_temperature needs
      // BOTH target_temp_low and target_temp_high, with low < high; clamp to
      // the entity's reported min/max and keep a step-sized deadband.
      el.querySelectorAll('.az-zone-sp-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const eid = btn.dataset.entity;
          const a = this._hass.states[eid]?.attributes || {};
          let low = a.target_temp_low;
          let high = a.target_temp_high;
          if (low == null || high == null) return;
          const haFah = this._haUnitLabel() === '°F';
          const step = a.target_temp_step || (haFah ? 1 : 0.5);
          const minT = a.min_temp != null ? a.min_temp : (haFah ? 59 : 15);
          const maxT = a.max_temp != null ? a.max_temp : (haFah ? 86 : 30);
          const d = btn.dataset.dir === 'up' ? step : -step;
          if (btn.dataset.kind === 'heat') {
            low = Math.min(Math.max(minT, low + d), high - step);
          } else {
            high = Math.max(Math.min(maxT, high + d), low + step);
          }
          this._hass.callService('climate', 'set_temperature', {
            entity_id: eid,
            target_temp_low: low,
            target_temp_high: high,
          });
        });
      });

      // Inline mode / fan-speed selectors. HA pushes the new state, and
      // _getZoneHash tracks state + fan_mode, so the zone re-renders itself.
      const fanSel = el.querySelector('.az-zone-fan');
      if (fanSel) {
        fanSel.addEventListener('change', () => {
          this._hass.callService('climate', 'set_fan_mode', {
            entity_id: fanSel.dataset.entity, fan_mode: fanSel.value,
          });
        });
      }
      const modeSel = el.querySelector('.az-zone-mode');
      if (modeSel) {
        modeSel.addEventListener('change', () => {
          this._hass.callService('climate', 'set_hvac_mode', {
            entity_id: modeSel.dataset.entity, hvac_mode: modeSel.value,
          });
        });
      }

      container.appendChild(el);
    }
  }

  _openEditor(schedule, isDuplicate = false) {
    const isNew = !schedule || isDuplicate;
    const useDefaults = !schedule;
    const name = (schedule && !isDuplicate) ? (schedule.name || '') : '';
    const hour = useDefaults ? 8 : (schedule.hour != null ? schedule.hour : 8);
    const minutes = useDefaults ? 0 : (schedule.minutes != null ? schedule.minutes : 0);
    const mode = useDefaults ? 3 : (schedule.mode || 3);
    const spC = schedule && schedule.setpoint != null ? schedule.setpoint : null;
    const spHeatC = schedule && schedule.setpoint_heat != null ? schedule.setpoint_heat : null;
    const spCoolC = schedule && schedule.setpoint_cool != null ? schedule.setpoint_cool : null;
    const temp = spC != null ? this._toDisplay(spC) : null;
    const tempHeat = spHeatC != null ? this._toDisplay(spHeatC) : null;
    const tempCool = spCoolC != null ? this._toDisplay(spCoolC) : null;
    const days = useDefaults ? [1,2,3,4,5] : (schedule.days || []);
    const pspeed = useDefaults ? 'auto' : (schedule.pspeed || 'auto');
    const deviceIds = useDefaults ? [] : (schedule.device_ids || []);
    const edSeason = schedule && schedule.season ? schedule.season : '';
    const edAway = !!(schedule && schedule.away);
    const edEnabled = isDuplicate ? true : (schedule ? schedule.enabled !== false : true);

    let selectedMode = mode;
    let selectedDays = [...days];
    let tempVal = temp;
    let tempCelsius = spC; // raw Celsius; avoids lossy display round-trip
    let tempTouched = false;
    let tempValHeat = tempHeat;        // auto/heat_cool: heat (low) -> setpoint_heat
    let tempHeatCelsius = spHeatC;
    let tempHeatTouched = false;
    let tempValCool = tempCool;        // auto/heat_cool: cool (high) -> setpoint_cool
    let tempCoolCelsius = spCoolC;
    let tempCoolTouched = false;

    const overlay = document.createElement('dialog');
    overlay.className = 'az-editor-overlay';
    overlay.innerHTML = `
      <div class="az-editor">
        <div class="az-editor-header">
          <h3 style="display:flex; align-items:center; gap:6px;">${isDuplicate ? '<ha-icon icon="mdi:content-copy"></ha-icon> Duplicate Schedule' : isNew ? '<ha-icon icon="mdi:calendar-plus"></ha-icon> New Schedule' : '<ha-icon icon="mdi:pencil"></ha-icon> Edit Schedule'}</h3>
          <button class="az-btn az-btn-outline az-btn-icon az-btn-sm az-close" title="Close"><ha-icon icon="mdi:close" style="--mdc-icon-size:18px;"></ha-icon></button>
        </div>
        <div class="az-editor-body">
          <div class="az-field">
            <label>Schedule Name</label>
            <input type="text" id="ed-name" value="${name}" placeholder="e.g. Winter Night"/>
          </div>
          <div class="az-field">
            <label>Enabled</label>
            <label style="display:flex; align-items:center; gap:12px; cursor:pointer; font-weight:500; text-transform:none; font-size:1em; color:var(--az-text); padding:8px;">
              <input type="checkbox" id="ed-enabled" ${edEnabled ? 'checked' : ''} style="width:20px; height:20px; accent-color:var(--az-primary); cursor:pointer;">
              Schedule is active
            </label>
          </div>
          <div class="az-field">
            <label>Time</label>
            <div class="az-time-row">
              <input type="number" id="ed-hour" min="0" max="23" value="${hour}" />
              <span>:</span>
              <input type="number" id="ed-min" min="0" max="59" value="${pad(minutes)}" />
            </div>
          </div>
          <div class="az-field">
            <label>Days</label>
            <div class="az-days-editor" id="ed-days">
              ${DAY_LABELS.map((d, i) => '<button class="az-day-btn ' + (selectedDays.includes(i) ? 'active' : '') + '" data-day="' + i + '">' + d + '</button>').join('')}
            </div>
          </div>
          <div class="az-field">
            <label>Mode</label>
            <div class="az-modes-editor" id="ed-modes">
              ${Object.entries(MODES).map(([v, m]) => '<button class="az-mode-btn ' + (parseInt(v) === selectedMode ? 'active' : '') + '" data-mode="' + v + '">' + m.icon + ' ' + m.label + '</button>').join('')}
            </div>
          </div>
          <div class="az-field" id="ed-temp-single" style="display:${selectedMode === 1 ? 'none' : ''}">
            <label>Temperature</label>
            <div class="az-temp-row">
              <button class="az-temp-btn" id="ed-temp-down" title="Decrease Temperature"><ha-icon icon="mdi:minus"></ha-icon></button>
              <div class="az-temp-val"><span id="ed-temp-display">${tempVal != null ? tempVal : '—'}</span><span class="az-temp-unit">${this._unitLabel()}</span></div>
              <button class="az-temp-btn" id="ed-temp-up" title="Increase Temperature"><ha-icon icon="mdi:plus"></ha-icon></button>
            </div>
          </div>
          <div class="az-field" id="ed-temp-dual" style="display:${selectedMode === 1 ? '' : 'none'}">
            <label>Heat Setpoint (Low)</label>
            <div class="az-temp-row">
              <button class="az-temp-btn" id="ed-heat-down" title="Decrease Heat Setpoint"><ha-icon icon="mdi:minus"></ha-icon></button>
              <div class="az-temp-val"><span id="ed-heat-display" style="color:#e74c3c">${tempValHeat != null ? tempValHeat : '—'}</span><span class="az-temp-unit">${this._unitLabel()}</span></div>
              <button class="az-temp-btn" id="ed-heat-up" title="Increase Heat Setpoint"><ha-icon icon="mdi:plus"></ha-icon></button>
            </div>
            <label style="margin-top:20px;">Cool Setpoint (High)</label>
            <div class="az-temp-row">
              <button class="az-temp-btn" id="ed-cool-down" title="Decrease Cool Setpoint"><ha-icon icon="mdi:minus"></ha-icon></button>
              <div class="az-temp-val"><span id="ed-cool-display" style="color:#3498db">${tempValCool != null ? tempValCool : '—'}</span><span class="az-temp-unit">${this._unitLabel()}</span></div>
              <button class="az-temp-btn" id="ed-cool-up" title="Increase Cool Setpoint"><ha-icon icon="mdi:plus"></ha-icon></button>
            </div>
          </div>
          <div class="az-field">
            <label>Fan Speed</label>
            <select id="ed-pspeed">
              <option value="auto" ${pspeed === 'auto' ? 'selected' : ''}>Auto</option>
              <option value="1" ${pspeed === '1' || pspeed === 1 ? 'selected' : ''}>Low</option>
              <option value="2" ${pspeed === '2' || pspeed === 2 ? 'selected' : ''}>Medium</option>
              <option value="3" ${pspeed === '3' || pspeed === 3 ? 'selected' : ''}>High</option>
            </select>
          </div>
          <div class="az-field">
            <label>Devices</label>
            <div class="az-devices-editor" id="ed-devices-list" style="display:flex; flex-direction:column; gap:8px; max-height: 200px; overflow-y: auto; padding: 4px; border: 1px solid var(--az-border); border-radius: 12px; background: var(--primary-background-color, var(--az-surface));">
              ${(this._availableDevices || []).map(d => `
                <label style="display:flex; align-items:center; gap:12px; cursor:pointer; font-weight:500; text-transform:none; font-size:1em; color:var(--az-text); padding: 8px;">
                  <input type="checkbox" class="ed-device-checkbox" value="${d.id}" ${(deviceIds.includes(d.id)) ? 'checked' : ''} style="width:20px; height:20px; accent-color:var(--az-primary); cursor:pointer;">
                  ${d.name}
                </label>
              `).join('')}
              ${(!this._availableDevices || this._availableDevices.length === 0) ? '<span style="color:var(--az-text2); padding: 12px;">No Airzone devices found.</span>' : ''}
            </div>
          </div>
          <div class="az-field">
            <label>Season</label>
            <select id="ed-season">
              <option value="" ${!edSeason ? 'selected' : ''}>None</option>
              <option value="winter" ${edSeason === 'winter' ? 'selected' : ''}>Winter</option>
              <option value="summer" ${edSeason === 'summer' ? 'selected' : ''}>Summer</option>
            </select>
          </div>
          <div class="az-field" style="margin-top: 8px; padding-top: 20px; border-top: 1px solid var(--az-border);">
            <label>Away Schedule</label>
            <label style="display:flex; align-items:center; gap:12px; cursor:pointer; font-weight:500; text-transform:none; font-size:1em; color:var(--az-text); padding:8px;">
              <input type="checkbox" id="ed-away" ${edAway ? 'checked' : ''} style="width:20px; height:20px; accent-color:var(--az-primary); cursor:pointer;">
              This is an away/vacation schedule
            </label>
          </div>
        </div>
        <div class="az-editor-footer">
          <button class="az-btn az-btn-outline az-close">Cancel</button>
          <button class="az-btn az-btn-primary" id="ed-save">${isNew ? 'Create' : 'Save'}</button>
        </div>
      </div>
    `;
    this.querySelector('ha-card').appendChild(overlay);
    overlay.showModal();

    // Day buttons
    overlay.querySelectorAll('.az-day-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const day = parseInt(btn.dataset.day);
        if (selectedDays.includes(day)) { selectedDays = selectedDays.filter(d => d !== day); btn.classList.remove('active'); }
        else { selectedDays.push(day); btn.classList.add('active'); }
      });
    });
    // Mode buttons
    const syncTempFields = () => {
      const single = overlay.querySelector('#ed-temp-single');
      const dual = overlay.querySelector('#ed-temp-dual');
      single.style.display = selectedMode === 1 ? 'none' : '';
      dual.style.display = selectedMode === 1 ? '' : 'none';
    };
    overlay.querySelectorAll('.az-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.az-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMode = parseInt(btn.dataset.mode);
        syncTempFields();
        // Sensible defaults when first switching to auto
        if (selectedMode === 1) {
          if (tempValHeat == null) { tempValHeat = this._useFah ? 66 : 19; overlay.querySelector('#ed-heat-display').textContent = tempValHeat; }
          if (tempValCool == null) { tempValCool = this._useFah ? 75 : 24; overlay.querySelector('#ed-cool-display').textContent = tempValCool; }
        }
      });
    });
    // Step 0.5°C / 1°F. Ranges follow the device: single 15-30°C,
    // heat/low 17-28.5°C (63-83°F), cool/high 19.5-30.5°C (67-87°F).
    const step = this._useFah ? 1 : 0.5;
    const minT = this._toDisplay(15);
    const maxT = this._toDisplay(30);
    const minHeatT = this._toDisplay(17);
    const maxHeatT = this._toDisplay(28.5);
    const minCoolT = this._toDisplay(19.5);
    const maxCoolT = this._toDisplay(30.5);
    const tempDisplay = overlay.querySelector('#ed-temp-display');
    overlay.querySelector('#ed-temp-down').addEventListener('click', () => { if (tempVal == null) tempVal = this._useFah ? 70 : 21; tempVal = Math.max(minT, tempVal - step); tempDisplay.textContent = tempVal; tempTouched = true; });
    overlay.querySelector('#ed-temp-up').addEventListener('click', () => { if (tempVal == null) tempVal = this._useFah ? 70 : 21; tempVal = Math.min(maxT, tempVal + step); tempDisplay.textContent = tempVal; tempTouched = true; });
    const heatDisplay = overlay.querySelector('#ed-heat-display');
    overlay.querySelector('#ed-heat-down').addEventListener('click', () => { if (tempValHeat == null) tempValHeat = this._useFah ? 66 : 19; tempValHeat = Math.max(minHeatT, tempValHeat - step); heatDisplay.textContent = tempValHeat; tempHeatTouched = true; });
    overlay.querySelector('#ed-heat-up').addEventListener('click', () => { if (tempValHeat == null) tempValHeat = this._useFah ? 66 : 19; tempValHeat = Math.min(maxHeatT, tempValHeat + step); heatDisplay.textContent = tempValHeat; tempHeatTouched = true; });
    const coolDisplay = overlay.querySelector('#ed-cool-display');
    overlay.querySelector('#ed-cool-down').addEventListener('click', () => { if (tempValCool == null) tempValCool = this._useFah ? 75 : 24; tempValCool = Math.max(minCoolT, tempValCool - step); coolDisplay.textContent = tempValCool; tempCoolTouched = true; });
    overlay.querySelector('#ed-cool-up').addEventListener('click', () => { if (tempValCool == null) tempValCool = this._useFah ? 75 : 24; tempValCool = Math.min(maxCoolT, tempValCool + step); coolDisplay.textContent = tempValCool; tempCoolTouched = true; });
    // Close
    const closeOverlay = () => { overlay.close(); overlay.remove(); };
    overlay.querySelectorAll('.az-close').forEach(btn => btn.addEventListener('click', closeOverlay));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });

    // Save
    overlay.querySelector('#ed-save').addEventListener('click', async () => {
      const edName = overlay.querySelector('#ed-name').value.trim() || 'Schedule';
      const edHour = parseInt(overlay.querySelector('#ed-hour').value) || 0;
      const edMin = parseInt(overlay.querySelector('#ed-min').value) || 0;
      const edSpeed = overlay.querySelector('#ed-pspeed').value;
      const devIds = Array.from(overlay.querySelectorAll('.ed-device-checkbox:checked')).map(cb => cb.value);
      const edProgEnabled = overlay.querySelector('#ed-enabled').checked;

      const seasonVal = overlay.querySelector('#ed-season').value || null;
      const awayVal = overlay.querySelector('#ed-away').checked;

      const obj = {
        name: edName,
        enabled: edProgEnabled,
        mode: selectedMode,
        pspeed: edSpeed === 'auto' ? 'auto' : parseInt(edSpeed),
        days: selectedDays.sort((a, b) => a - b),
        hour: edHour,
        minutes: edMin,
        device_ids: devIds,
        season: seasonVal,
        away: awayVal,
        setpoint: null,
        setpoint_heat: null,
        setpoint_cool: null,
      };

      if (selectedMode === 1) {
        // Use whatever value is shown (default-filled or user-adjusted); only
        // fall back to the raw Celsius when no display value exists. (Don't
        // gate on the +/- "touched" flag — the shown default is a real value.)
        const heatC = tempValHeat != null ? this._toCelsius(tempValHeat) : tempHeatCelsius;
        const coolC = tempValCool != null ? this._toCelsius(tempValCool) : tempCoolCelsius;
        if (heatC == null || heatC < 17 || heatC > 28.5) {
          this._toast('Heat setpoint must be ' + this._toDisplay(17) + '–' + this._toDisplay(28.5) + this._unitLabel(), true);
          return;
        }
        if (coolC == null || coolC < 19.5 || coolC > 30.5) {
          this._toast('Cool setpoint must be ' + this._toDisplay(19.5) + '–' + this._toDisplay(30.5) + this._unitLabel(), true);
          return;
        }
        if (heatC >= coolC) {
          this._toast('Heat setpoint must be below cool setpoint', true);
          return;
        }
        obj.setpoint_heat = heatC;
        obj.setpoint_cool = coolC;
      } else {
        const spCelsius = tempVal != null ? this._toCelsius(tempVal) : tempCelsius;
        obj.setpoint = spCelsius;
      }

      try {
        if (isNew) {
          await this._hass.callWS({
            type: 'call_service', domain: 'airzone_cloud', service: 'ha_schedule_add',
            service_data: { schedule: obj }, return_response: true
          });
          this._toast(isDuplicate ? 'Schedule duplicated!' : 'Schedule created!');
        } else {
          await this._hass.callWS({
            type: 'call_service', domain: 'airzone_cloud', service: 'ha_schedule_update',
            service_data: { id: schedule.id, changes: obj }, return_response: true
          });
          this._toast('Schedule updated!');
        }

        closeOverlay();
        this._loadData();
      } catch (err) {
        this._toast('Error: ' + (err.message || 'Unknown'), true);
      }
    });
  }

  // NOTE: schedule execution (firing schedules, applying mode + dual/single
  // setpoints, missed-transition catch-up) is owned entirely by the integration's
  // AirzoneScheduler (server-side). The card only does CRUD on the HA store.

  async _toggleSchedule(schedule, active) {
    const schedId = schedule.id;
    if (!schedId) {
      this._toast('Error: Schedule ID missing', true);
      return;
    }
    try {
      await this._hass.callWS({
        type: 'call_service', domain: 'airzone_cloud', service: 'ha_schedule_update',
        service_data: { id: schedId, changes: { enabled: !!active } }, return_response: true
      });
      this._toast(active ? 'Schedule enabled' : 'Schedule disabled');
      await this._loadSchedules();
    } catch (err) {
      this._toast('Error: ' + (err.message || 'Check console'), true);
      this._loadSchedules();
    }
  }

  // Generic partial-update of a schedule (inline mode / fan-speed selectors).
  async _updateSchedule(id, changes, msg) {
    if (!id) { this._toast('Error: Schedule ID missing', true); return; }
    try {
      await this._hass.callWS({
        type: 'call_service', domain: 'airzone_cloud', service: 'ha_schedule_update',
        service_data: { id, changes }, return_response: true
      });
      this._toast(msg || 'Schedule updated');
      await this._loadSchedules();
    } catch (err) {
      this._toast('Error: ' + (err.message || 'Check console'), true);
      this._loadSchedules();
    }
  }

  // Inline schedule-card setpoint stepper. Steps the displayed value (1°F /
  // 0.5°C, like the editor), converts back to the Celsius-stored setpoint,
  // clamps to the same device ranges the editor enforces (single 15–30,
  // heat 17–28.5, cool 19.5–30.5, heat<cool deadband), updates the shown
  // value optimistically, and debounces one ha_schedule_update.
  async _bumpScheduleSetpoint(schedule, kind, dir, el) {
    const sid = schedule.id;
    if (!sid) { this._toast('Error: Schedule ID missing', true); return; }
    this._schedSpPending = this._schedSpPending || {};
    this._schedSpTimers = this._schedSpTimers || {};
    const p = this._schedSpPending[sid] || {
      setpoint: schedule.setpoint,
      setpoint_heat: schedule.setpoint_heat,
      setpoint_cool: schedule.setpoint_cool,
    };
    const dkey = kind === 'heat' ? 'setpoint_heat' : kind === 'cool' ? 'setpoint_cool' : 'setpoint';
    const defC = kind === 'heat' ? 19 : kind === 'cool' ? 24 : 21;
    const curC = p[dkey] != null ? p[dkey] : defC;
    const disp = this._toDisplay(curC) + (dir === 'up' ? 1 : -1) * (this._useFah ? 1 : 0.5);
    let newC = Math.round(this._toCelsius(disp) * 2) / 2;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    if (kind === 'heat') {
      const coolC = p.setpoint_cool != null ? p.setpoint_cool : 30.5;
      newC = clamp(newC, 17, Math.min(28.5, coolC - 0.5));
    } else if (kind === 'cool') {
      const heatC = p.setpoint_heat != null ? p.setpoint_heat : 17;
      newC = clamp(newC, Math.max(19.5, heatC + 0.5), 30.5);
    } else {
      newC = clamp(newC, 15, 30);
    }
    p[dkey] = newC;
    this._schedSpPending[sid] = p;
    const valEl = el.querySelector('.az-sched-sp-val[data-kind="' + kind + '"]');
    if (valEl) valEl.textContent = this._displayTemp(newC);

    clearTimeout(this._schedSpTimers[sid]);
    this._schedSpTimers[sid] = setTimeout(async () => {
      const pend = this._schedSpPending[sid];
      delete this._schedSpPending[sid];
      delete this._schedSpTimers[sid];
      if (!pend) return;
      const changes = (kind === 'single')
        ? { setpoint: pend.setpoint }
        : { setpoint_heat: pend.setpoint_heat, setpoint_cool: pend.setpoint_cool };
      try {
        await this._hass.callWS({
          type: 'call_service', domain: 'airzone_cloud', service: 'ha_schedule_update',
          service_data: { id: sid, changes }, return_response: true
        });
        this._toast('Setpoint updated');
        await this._loadSchedules();
      } catch (err) {
        this._toast('Error: ' + (err.message || 'Check console'), true);
        this._loadSchedules();
      }
    }, 700);
  }

  async _deleteSchedule(id) {
    if (!confirm('Delete this schedule? This cannot be undone.')) return;
    try {
      await this._hass.callWS({
        type: 'call_service', domain: 'airzone_cloud', service: 'ha_schedule_delete',
        service_data: { id }, return_response: true
      });
      this._toast('Schedule deleted');
      this._loadSchedules();
    } catch (err) {
      this._toast('Error: ' + (err.message || ''), true);
    }
  }

  _toast(msg, error = false) {
    const t = document.createElement('div');
    t.className = 'az-toast';
    t.style.background = error ? '#e74c3c' : '#27ae60';
    t.textContent = msg;
    // The editor uses <dialog>.showModal(), which renders in the browser
    // "top layer" above ALL normal DOM (z-index can't beat it). Use the
    // Popover API so the toast also enters the top layer and shows above
    // the modal + its backdrop. Fall back to attaching inside the open
    // dialog (its subtree is already in the top layer) when unsupported.
    const supportsPopover =
      Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover');
    if (supportsPopover) {
      t.popover = 'manual';
      // Own the placement so default UA popover styles can't shift it.
      t.style.cssText += ';position:fixed;inset:auto;bottom:32px;left:50%;transform:translateX(-50%);margin:0;border:none;';
      this.appendChild(t);
      try { t.showPopover(); } catch (e) { /* ignore */ }
    } else {
      const dlg = this.querySelector('dialog.az-editor-overlay[open]');
      (dlg || this).appendChild(t);
    }
    const remove = () => {
      try { if (t.matches && t.matches(':popover-open')) t.hidePopover(); } catch (e) { /* ignore */ }
      t.remove();
    };
    t.style.cursor = 'pointer';
    t.title = 'Click to dismiss';
    t.addEventListener('click', remove);
    // Errors linger so they can actually be read; success is brief.
    setTimeout(remove, error ? 9000 : 3000);
  }

  static getStubConfig() {
    return { type: "custom:airzone-schedules-card" };
  }

  getCardSize() { return 4; }
}

customElements.define('airzone-schedules-card', AirzoneSchedulesCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "airzone-schedules-card",
  name: "Airzone Schedules",
  preview: true,
  description: "Manage schedules and zones for your Airzone Cloud installation"
});
