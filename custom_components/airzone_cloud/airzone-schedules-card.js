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
  // Returns the setpoint in Celsius from a schedule object, handling both top-level
  // plain number (current API format) and legacy start_conf.setpoint object format.
  _getSetpointC(schedule) {
    const top = schedule?.setpoint;
    if (top != null) return typeof top === 'object' ? top.celsius : top;
    const conf = schedule?.start_conf?.setpoint;
    if (conf != null) return typeof conf === 'object' ? conf.celsius : conf;
    return null;
  }

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
      .map(([eid, s]) => `${eid}:${s.state}:${s.attributes.current_temperature}:${s.attributes.temperature}:${s.attributes.hvac_action}:${s.attributes.current_humidity}:${s.attributes.fan_mode}`)
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
        .az-header { display:flex; align-items:center; justify-content:space-between; padding:24px 32px 16px; }
        ha-card.is-panel .az-header { padding: 16px 0 16px 0; }
        .az-header h2 { margin:0; font-size:1.8em; font-weight:600; color:var(--az-text); display:flex; align-items:center; gap:12px; }
        .az-header h2 ha-icon { --mdc-icon-size: 36px; color: var(--az-primary); }
        .az-header-actions { display:flex; gap:12px; align-items:center; }
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
        .az-schedule-group { display:grid; grid-template-columns: 1fr; gap:16px; }
        @media(min-width: 800px) { .az-schedule-group { grid-template-columns: repeat(2, 1fr); } }
        .az-schedule { background:var(--card-background-color, var(--az-surface)); border-radius:16px; overflow:hidden; border:1px solid var(--az-border); transition:all 0.2s; box-shadow: 0 4px 16px rgba(0,0,0,0.06); display: flex; flex-direction: column; }
        .az-schedule:hover { border-color:var(--az-primary); transform: translateY(-4px); box-shadow: 0 12px 24px rgba(0,0,0,0.1); }
        .az-schedule-top { display:flex; align-items:center; padding:24px; gap:20px; }
        .az-schedule-icon { width:64px; height:64px; border-radius:16px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .az-schedule-icon ha-icon { --mdc-icon-size: 32px; }
        .az-schedule-info { flex:1; min-width:0; }
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

        .az-zone { background:var(--card-background-color, var(--az-surface)); border-radius:16px; overflow:hidden; border:1px solid var(--az-border); transition:all 0.2s; box-shadow: 0 4px 16px rgba(0,0,0,0.06); display:flex; flex-direction:column; padding:24px; gap:16px; }
        .az-zone:hover { border-color:var(--az-primary); transform: translateY(-4px); box-shadow: 0 12px 24px rgba(0,0,0,0.1); }
        .az-zone-header { display:flex; align-items:center; gap:16px; }
        .az-zone-icon { width:52px; height:52px; border-radius:14px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .az-zone-icon ha-icon { --mdc-icon-size: 26px; }
        .az-zone-name { font-weight:600; font-size:1.2em; color:var(--az-text); flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .az-zone-action { font-size:0.8em; font-weight:600; padding:4px 10px; border-radius:8px; display:inline-flex; align-items:center; gap:4px; }
        .az-zone-temps { display:flex; align-items:center; justify-content:space-between; gap:16px; }
        .az-zone-current { display:flex; flex-direction:column; align-items:center; gap:2px; }
        .az-zone-current-val { font-size:2.4em; font-weight:300; color:var(--az-text); letter-spacing:-1px; }
        .az-zone-current-label { font-size:0.75em; color:var(--az-text2); text-transform:uppercase; font-weight:600; letter-spacing:0.5px; }
        .az-zone-target { display:flex; align-items:center; gap:12px; }
        .az-zone-target-val { font-size:1.8em; font-weight:500; color:var(--az-primary); min-width:70px; text-align:center; }
        .az-zone-temp-btn { width:40px; height:40px; border-radius:50%; border:none; background:var(--primary-background-color, var(--az-surface)); color:var(--az-text); font-size:1.4em; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .az-zone-temp-btn:hover { background:var(--az-primary); color:white; }
        .az-zone-stats { display:flex; gap:16px; flex-wrap:wrap; font-size:0.9em; color:var(--az-text2); font-weight:500; }
        .az-zone-stat { display:flex; align-items:center; gap:4px; }
        .az-zone-stat ha-icon { --mdc-icon-size: 16px; }

        @media(max-width: 600px) {
          .az-list { grid-template-columns: 1fr; padding: 0 16px 16px; }
          .az-schedule-top { padding: 16px; flex-wrap: wrap; }
          .az-schedule-actions { margin-left: 0; width: 100%; justify-content: flex-end; }
          .az-editor-body { padding: 20px; }
          .az-editor-header { padding: 20px; }
          .az-editor-footer { padding: 20px; }
          .az-temp-row { gap: 12px; justify-content: center; }
          .az-tabs { padding: 0 16px 12px; }
          .az-tab { padding: 10px 16px; font-size: 0.95em; }
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
    await this._loadTags();
    await this._loadSchedules();
  }

  async _loadTags() {
    try {
      const svcData = this.config.config_entry ? { config_entry: this.config.config_entry } : {};
      const resp = await this._hass.callWS({
        type: 'call_service', domain: 'airzone_cloud', service: 'get_schedule_tags',
        service_data: svcData, return_response: true
      });
      const raw = resp.response || resp;
      this._tags = raw.tags || {};
    } catch (err) {
      console.warn('Failed to load schedule tags', err);
      this._tags = {};
    }
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
      const svcData = this.config.config_entry ? { config_entry: this.config.config_entry } : {};
      const resp = await this._hass.callWS({
        type: 'call_service', domain: 'airzone_cloud', service: 'get_installation_schedules',
        service_data: svcData, return_response: true
      });
      const raw = resp.response || resp;
      const data = raw.schedules || raw;
      this._schedules = Array.isArray(data) ? data : Object.entries(data).map(([id, s]) => ({ _id: id, ...s }));
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
        const tags = this._tags[s._id] || {};
        if (this._filterSeason !== null && (tags.season || null) !== this._filterSeason) return false;
        if (this._filterAway !== null && !!tags.away !== this._filterAway) return false;
        return true;
      });
    }

    if (!sorted.length) {
      list.innerHTML = '<div class="az-empty"><div class="az-empty-icon"><ha-icon icon="mdi:filter-off-outline" style="--mdc-icon-size: 48px;"></ha-icon></div>No schedules match the current filters</div>';
      return;
    }

    const enabled = sorted.filter(s => s.prog_enabled !== false);
    const disabled = sorted.filter(s => s.prog_enabled === false);

    const buildCard = (s) => {
      const sc = s.start_conf || {};
      const modeInfo = MODES[sc.mode] || DEFAULT_MODE;
      const isActive = s.prog_enabled !== false;
      const days = sc.days || [];
      const time = (sc.hour != null) ? fmtTime(sc.hour, sc.minutes || 0) : '—';
      const spC = this._getSetpointC(s);
      const temp = spC != null ? this._displayTemp(spC) : '—';
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
              <span style="display:flex; align-items:center; gap:4px;"><ha-icon icon="mdi:thermometer" style="--mdc-icon-size: 16px;"></ha-icon> ${temp}</span>
              <span style="display:flex; align-items:center; gap:4px;">${modeInfo.label}</span>
              ${sc.pspeed ? '<span style="display:flex; align-items:center; gap:4px;"><ha-icon icon="mdi:fan" style="--mdc-icon-size: 16px;"></ha-icon> ' + sc.pspeed + '</span>' : ''}
            </div>
          </div>
          <label class="az-schedule-toggle">
            <input type="checkbox" ${isActive ? 'checked' : ''} data-id="${s._id}"/>
            <span class="az-toggle-slider"></span>
          </label>
          <div class="az-schedule-actions">
            <button class="az-btn az-btn-outline az-btn-icon az-btn-sm az-edit" data-id="${s._id}" title="Edit"><ha-icon icon="mdi:pencil" style="--mdc-icon-size: 18px;"></ha-icon></button>
            <button class="az-btn az-btn-outline az-btn-icon az-btn-sm az-dup" data-id="${s._id}" title="Duplicate"><ha-icon icon="mdi:content-copy" style="--mdc-icon-size: 18px;"></ha-icon></button>
            <button class="az-btn az-btn-danger az-btn-icon az-btn-sm az-del" data-id="${s._id}" title="Delete"><ha-icon icon="mdi:delete" style="--mdc-icon-size: 18px;"></ha-icon></button>
          </div>
        </div>
        <div class="az-days">${DAY_LABELS.map((d, i) => '<span class="az-day ' + (days.includes(i) ? 'az-day-on' : 'az-day-off') + '">' + d + '</span>').join('')}</div>
        ${(() => { const t = this._tags[s._id] || {}; const b = []; if (t.season === 'winter') b.push('<span style="display:inline-flex;align-items:center;gap:4px;background:#3498db22;color:#3498db;padding:4px 10px;border-radius:8px;font-size:0.8em;font-weight:600;"><ha-icon icon="mdi:snowflake" style="--mdc-icon-size:14px;"></ha-icon> Winter</span>'); if (t.season === 'summer') b.push('<span style="display:inline-flex;align-items:center;gap:4px;background:#e7743422;color:#e74c3c;padding:4px 10px;border-radius:8px;font-size:0.8em;font-weight:600;"><ha-icon icon="mdi:white-balance-sunny" style="--mdc-icon-size:14px;"></ha-icon> Summer</span>'); if (t.away) b.push('<span style="display:inline-flex;align-items:center;gap:4px;background:#f39c1222;color:#f39c12;padding:4px 10px;border-radius:8px;font-size:0.8em;font-weight:600;"><ha-icon icon="mdi:airplane" style="--mdc-icon-size:14px;"></ha-icon> Away</span>'); return b.length ? '<div style="display:flex;gap:8px;padding:0 24px 8px;flex-wrap:wrap;">' + b.join('') + '</div>' : ''; })()}
        ${deviceCount ? '<div class="az-devices" style="display:flex; align-items:center; gap:4px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="' + deviceNamesStr + '"><ha-icon icon="mdi:map-marker-outline" style="--mdc-icon-size: 16px; flex-shrink: 0;"></ha-icon> <span style="overflow: hidden; text-overflow: ellipsis;">' + deviceNamesStr + '</span></div>' : ''}
      `;

      el.querySelector('.az-edit').addEventListener('click', () => this._openEditor(s));
      el.querySelector('.az-dup').addEventListener('click', () => this._openEditor(s, true));
      el.querySelector('.az-del').addEventListener('click', () => this._deleteSchedule(s._id));
      el.querySelector('input[type=checkbox]').addEventListener('change', (e) => this._toggleSchedule(s, e.target.checked));
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
          <div class="az-zone-current">
            <div class="az-zone-current-val">${currentTemp != null ? currentTemp : '—'}<span style="font-size:0.4em; color:var(--az-text2);">${this._haUnitLabel()}</span></div>
            <div class="az-zone-current-label">Current</div>
          </div>
          ${!isOff && targetTemp != null ? `
          <div class="az-zone-target">
            <button class="az-zone-temp-btn az-zone-temp-down" data-entity="${zone.entity_id}" data-min="${minTemp}"><ha-icon icon="mdi:minus" style="--mdc-icon-size:18px;"></ha-icon></button>
            <div class="az-zone-target-val">${targetTemp != null ? targetTemp : '—'}<span style="font-size:0.5em; color:var(--az-text2);">${this._haUnitLabel()}</span></div>
            <button class="az-zone-temp-btn az-zone-temp-up" data-entity="${zone.entity_id}" data-max="${maxTemp}"><ha-icon icon="mdi:plus" style="--mdc-icon-size:18px;"></ha-icon></button>
          </div>
          ` : '<div></div>'}
        </div>
        <div class="az-zone-stats">
          ${humidity != null ? '<span class="az-zone-stat"><ha-icon icon="mdi:water-percent"></ha-icon> ' + humidity + '%</span>' : ''}
          ${fanMode ? '<span class="az-zone-stat"><ha-icon icon="mdi:fan"></ha-icon> ' + fanMode + '</span>' : ''}
          <span class="az-zone-stat"><ha-icon icon="mdi:${modeInfo.icon.replace('mdi:', '')}"></ha-icon> ${modeInfo.label}</span>
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

      container.appendChild(el);
    }
  }

  _openEditor(schedule, isDuplicate = false) {
    const isNew = !schedule || isDuplicate;
    const useDefaults = !schedule;
    const sc = schedule ? (schedule.start_conf || {}) : {};
    const name = (schedule && !isDuplicate) ? (schedule.name || '') : '';
    const hour = useDefaults ? 8 : (sc.hour != null ? sc.hour : 8);
    const minutes = useDefaults ? 0 : (sc.minutes != null ? sc.minutes : 0);
    const mode = useDefaults ? 3 : (sc.mode || 3);
    const spC = this._getSetpointC(schedule);
    const temp = spC != null ? this._toDisplay(spC) : null;
    const days = useDefaults ? [1,2,3,4,5] : (sc.days || []);
    const pspeed = useDefaults ? 'auto' : (sc.pspeed || 'auto');
    const deviceIds = useDefaults ? [] : (schedule.device_ids || []);
    const existingTags = schedule ? (this._tags[schedule._id] || {}) : {};
    const edSeason = existingTags.season || '';
    const edAway = !!existingTags.away;
    const edEnabled = isDuplicate ? true : (schedule ? schedule.prog_enabled !== false : true);

    let selectedMode = mode;
    let selectedDays = [...days];
    let tempVal = temp;
    let tempCelsius = spC; // raw Celsius value for the API; avoids lossy display round-trip
    let tempTouched = false; // true once user changes temp via +/- buttons

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
            <input type="text" id="ed-name" value="${name}" placeholder="e.g. Winter Night" maxlength="11"/>
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
          <div class="az-field">
            <label>Temperature</label>
            <div class="az-temp-row">
              <button class="az-temp-btn" id="ed-temp-down" title="Decrease Temperature"><ha-icon icon="mdi:minus"></ha-icon></button>
              <div class="az-temp-val"><span id="ed-temp-display">${tempVal != null ? tempVal : '—'}</span><span class="az-temp-unit">${this._unitLabel()}</span></div>
              <button class="az-temp-btn" id="ed-temp-up" title="Increase Temperature"><ha-icon icon="mdi:plus"></ha-icon></button>
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
    overlay.querySelectorAll('.az-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.az-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMode = parseInt(btn.dataset.mode);
      });
    });
    // Temp (step: 0.5°C or 1°F; limits: 15-30°C / 59-86°F)
    const tempDisplay = overlay.querySelector('#ed-temp-display');
    const step = this._useFah ? 1 : 0.5;
    const minT = this._toDisplay(15);
    const maxT = this._toDisplay(30);
    overlay.querySelector('#ed-temp-down').addEventListener('click', () => { if (tempVal == null) tempVal = this._useFah ? 70 : 21; tempVal = Math.max(minT, tempVal - step); tempDisplay.textContent = tempVal; tempTouched = true; });
    overlay.querySelector('#ed-temp-up').addEventListener('click', () => { if (tempVal == null) tempVal = this._useFah ? 70 : 21; tempVal = Math.min(maxT, tempVal + step); tempDisplay.textContent = tempVal; tempTouched = true; });
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

      const spCelsius = tempTouched ? (tempVal != null ? this._toCelsius(tempVal) : null) : tempCelsius;
      const spObj = spCelsius != null ? { celsius: spCelsius, fah: cToF(spCelsius) } : null;

      const payload = {
        name: edName,
        type: 'week',
        prog_enabled: edProgEnabled,
        setpoint: spCelsius,
        start_conf: {
          mode: selectedMode,
          pspeed: edSpeed === 'auto' ? 'auto' : parseInt(edSpeed),
          days: selectedDays.sort(),
          hour: edHour,
          minutes: edMin,
          setpoint: spObj,
        },
        device_ids: devIds,
      };

      const seasonVal = overlay.querySelector('#ed-season').value || null;
      const awayVal = overlay.querySelector('#ed-away').checked;

      try {
        const svcData = { schedule_data: payload };
        if (this.config.config_entry) svcData.config_entry = this.config.config_entry;

        let tagScheduleId = null;
        if (isNew) {
          const postResp = await this._hass.callWS({
            type: 'call_service', domain: 'airzone_cloud', service: 'post_installation_schedule',
            service_data: svcData, return_response: true
          });
          const created = postResp?.response?.response || postResp?.response || {};
          tagScheduleId = created._id || created.schedule?._id || null;
          this._toast(isDuplicate ? 'Schedule duplicated!' : 'Schedule created!');
        } else {
          svcData.schedule_id = schedule._id;
          await this._hass.callService('airzone_cloud', 'patch_installation_schedule', svcData);
          tagScheduleId = schedule._id;
          this._toast('Schedule updated!');
        }

        // Save tags
        if (tagScheduleId && (seasonVal || awayVal)) {
          try {
            const tagData = { schedule_id: tagScheduleId, season: seasonVal, away: awayVal };
            if (this.config.config_entry) tagData.config_entry = this.config.config_entry;
            await this._hass.callService('airzone_cloud', 'set_schedule_tags', tagData);
          } catch (tagErr) { console.warn('Failed to save tags', tagErr); }
        } else if (tagScheduleId && !seasonVal && !awayVal) {
          try {
            const tagData = { schedule_id: tagScheduleId, season: null, away: false };
            if (this.config.config_entry) tagData.config_entry = this.config.config_entry;
            await this._hass.callService('airzone_cloud', 'set_schedule_tags', tagData);
          } catch (tagErr) { console.warn('Failed to clear tags', tagErr); }
        }

        closeOverlay();
        this._loadData();
      } catch (err) {
        this._toast('Error: ' + (err.message || 'Unknown'), true);
      }
    });
  }

  // Returns a Date for when a schedule most recently would have fired, or null.
  _getLastFired(schedule, now) {
    const sc = schedule.start_conf || {};
    const days = sc.days || [];
    if (!days.length || sc.hour == null) return null;
    const schedMin = sc.minutes || 0;
    const today = now.getDay(); // 0=Sun matches schedule day indices
    for (let offset = 0; offset < 7; offset++) {
      const checkDay = (today - offset + 7) % 7;
      if (!days.includes(checkDay)) continue;
      if (offset === 0) {
        if (now.getHours() * 60 + now.getMinutes() >= sc.hour * 60 + schedMin) {
          return new Date(now.getFullYear(), now.getMonth(), now.getDate(), sc.hour, schedMin);
        }
      } else {
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, sc.hour, schedMin);
      }
    }
    return null;
  }

  // After a toggle, apply the mode & setpoint each zone should have based on active schedules.
  async _applyActiveSchedules() {
    await this._loadDevices();
    if (!this._availableDevices?.length) return;
    const now = new Date();
    const enabled = this._schedules.filter(s => s.prog_enabled !== false);
    if (!enabled.length) return;

    const actions = new Map();
    for (const dev of this._availableDevices) {
      const matching = enabled.filter(s => (s.device_ids || []).includes(dev.id));
      if (!matching.length) continue;
      let best = null, bestTime = null;
      for (const s of matching) {
        const t = this._getLastFired(s, now);
        if (t && (!bestTime || t > bestTime)) { bestTime = t; best = s; }
      }
      if (!best) continue;
      const sc = best.start_conf || {};
      actions.set(dev.entity_id, { mode: SCHEDULE_MODE_TO_HVAC[sc.mode], setpoint: this._getSetpointC(best) });
    }
    if (!actions.size) return;

    const haFah = this._haUnitLabel() === '°F';
    const promises = [];
    for (const [eid, a] of actions) {
      if (a.mode) {
        promises.push(this._hass.callService('climate', 'set_hvac_mode', { entity_id: eid, hvac_mode: a.mode }));
      }
      if (a.setpoint != null) {
        const temp = haFah ? cToF(a.setpoint) : a.setpoint;
        promises.push(this._hass.callService('climate', 'set_temperature', { entity_id: eid, temperature: temp }));
      }
    }
    try {
      await Promise.all(promises);
      this._toast(`Applied schedule settings to ${actions.size} zone(s)`);
    } catch (err) {
      this._toast('Error applying schedule settings: ' + (err.message || 'Check console'), true);
    }
  }

  async _toggleSchedule(schedule, active) {
    const schedId = schedule._id || schedule.id;
    if (!schedId) {
      this._toast('Error: Schedule ID missing', true);
      return;
    }

    try {
      const sc = schedule.start_conf || {};
      const spC = this._getSetpointC(schedule);
      const spObj = spC != null ? { celsius: spC, fah: cToF(spC) } : null;
      const payload = {
        name: schedule.name,
        type: schedule.type || 'week',
        prog_enabled: !!active,
        setpoint: spC,
        start_conf: {
          mode: sc.mode,
          pspeed: sc.pspeed,
          days: sc.days,
          hour: sc.hour,
          minutes: sc.minutes,
          setpoint: spObj,
        },
        device_ids: schedule.device_ids || [],
      };

      const svcData = {
        schedule_id: schedId,
        schedule_data: payload
      };
      if (this.config.config_entry) svcData.config_entry = this.config.config_entry;

      await this._hass.callService('airzone_cloud', 'patch_installation_schedule', svcData);
      this._toast(active ? 'Schedule enabled' : 'Schedule disabled');
      await this._loadSchedules();
      await this._applyActiveSchedules();
    } catch (err) {
      this._toast('Error: ' + (err.message || 'Check console'), true);
      this._loadSchedules();
    }
  }

  async _deleteSchedule(id) {
    if (!confirm('Delete this schedule? This cannot be undone.')) return;
    try {
      const svcData = { schedule_id: id };
      if (this.config.config_entry) svcData.config_entry = this.config.config_entry;
      await this._hass.callService('airzone_cloud', 'delete_installation_schedule', svcData);
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
    this.appendChild(t);
    setTimeout(() => t.remove(), 3000);
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
