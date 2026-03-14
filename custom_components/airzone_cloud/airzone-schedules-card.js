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

function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(h, m) { return pad(h) + ':' + pad(m); }

class AirzoneSchedulesCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._schedules = [];
    this._initialized = false;
  }

  set panel(panel) {
    this._panel = panel;
    if (panel && panel.config) {
      this.setConfig(panel.config);
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._render();
      this._loadData();
    }
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
          name: e.name || e.original_name || (this._hass.states[e.entity_id] && this._hass.states[e.entity_id].attributes.friendly_name) || e.entity_id
        }));
    } catch (err) {
      console.error('Failed to load entity registry', err);
      this._availableDevices = [];
    }
  }

  setConfig(config) {
    this.config = config || {};
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
        ha-card.is-panel .az-header { padding: 16px 0 32px 0; }
        .az-header h2 { margin:0; font-size:1.8em; font-weight:600; color:var(--az-text); display:flex; align-items:center; gap:12px; }
        .az-header h2 ha-icon { --mdc-icon-size: 36px; color: var(--az-primary); }
        .az-header-actions { display:flex; gap:12px; }
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
        .az-list { padding:0 32px 32px; display:grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap:20px; }
        ha-card.is-panel .az-list { padding: 0; }
        .az-empty { text-align:center; padding:64px 20px; color:var(--az-text2); grid-column: 1 / -1; font-size: 1.2em; }
        .az-empty-icon { margin-bottom:16px; color: var(--az-border); }
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
        .az-devices { font-size:0.85em; color:var(--az-text2); padding:0 24px 20px; margin-top: -8px; font-weight: 500; }
        @media(max-width: 600px) {
          .az-list { grid-template-columns: 1fr; padding: 0 16px 16px; }
          .az-schedule-top { padding: 16px; flex-wrap: wrap; }
          .az-schedule-actions { margin-left: 0; width: 100%; justify-content: flex-end; }
          .az-editor-body { padding: 20px; }
          .az-editor-header { padding: 20px; }
          .az-editor-footer { padding: 20px; }
          .az-temp-row { gap: 12px; justify-content: center; }
        }
      </style>
      <div class="az-header">
        <h2><ha-icon icon="mdi:calendar-clock"></ha-icon> Airzone Schedules</h2>
        <div class="az-header-actions">
          <button class="az-btn az-btn-outline az-btn-sm" id="az-refresh"><ha-icon icon="mdi:refresh" style="--mdc-icon-size: 16px;"></ha-icon> Refresh</button>
          <button class="az-btn az-btn-primary az-btn-sm" id="az-add"><ha-icon icon="mdi:plus" style="--mdc-icon-size: 16px;"></ha-icon> New</button>
        </div>
      </div>
      <div class="az-list" id="az-list">
        <div class="az-loading"><div class="az-spinner"></div><br/>Loading schedules…</div>
      </div>
    `;
    this.appendChild(card);
    card.querySelector('#az-refresh').addEventListener('click', () => this._loadData());
    card.querySelector('#az-add').addEventListener('click', () => this._openEditor(null));
  }

  async _loadSchedules() {
    const list = this.querySelector('#az-list');
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
    const list = this.querySelector('#az-list');
    if (!this._schedules.length) {
      list.innerHTML = '<div class="az-empty"><div class="az-empty-icon"><ha-icon icon="mdi:calendar-blank-outline" style="--mdc-icon-size: 48px;"></ha-icon></div>No schedules configured<br/><small>Click "New" to create one</small></div>';
      return;
    }
    list.innerHTML = '';
    for (const s of this._schedules) {
      const sc = s.start_conf || {};
      const modeInfo = MODES[sc.mode] || DEFAULT_MODE;
      const isActive = s.prog_enabled !== false;
      const days = sc.days || [];
      const time = (sc.hour != null) ? fmtTime(sc.hour, sc.minutes || 0) : '—';
      const temp = sc.setpoint ? sc.setpoint.celsius + '°C' : '—';
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
            <button class="az-btn az-btn-danger az-btn-icon az-btn-sm az-del" data-id="${s._id}" title="Delete"><ha-icon icon="mdi:delete" style="--mdc-icon-size: 18px;"></ha-icon></button>
          </div>
        </div>
        <div class="az-days">${DAY_LABELS.map((d, i) => '<span class="az-day ' + (days.includes(i) ? 'az-day-on' : 'az-day-off') + '">' + d + '</span>').join('')}</div>
        ${deviceCount ? '<div class="az-devices" style="display:flex; align-items:center; gap:4px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="' + deviceNamesStr + '"><ha-icon icon="mdi:map-marker-outline" style="--mdc-icon-size: 16px; flex-shrink: 0;"></ha-icon> <span style="overflow: hidden; text-overflow: ellipsis;">' + deviceNamesStr + '</span></div>' : ''}
      `;

      el.querySelector('.az-edit').addEventListener('click', () => this._openEditor(s));
      el.querySelector('.az-del').addEventListener('click', () => this._deleteSchedule(s._id));
      el.querySelector('input[type=checkbox]').addEventListener('change', (e) => this._toggleSchedule(s, e.target.checked));
      list.appendChild(el);
    }
  }

  _openEditor(schedule) {
    const isNew = !schedule;
    const sc = schedule ? (schedule.start_conf || {}) : {};
    const name = isNew ? '' : (schedule.name || '');
    const hour = isNew ? 8 : (sc.hour != null ? sc.hour : 8);
    const minutes = isNew ? 0 : (sc.minutes != null ? sc.minutes : 0);
    const mode = isNew ? 3 : (sc.mode || 3);
    const temp = isNew ? 21 : (sc.setpoint ? sc.setpoint.celsius : 21);
    const days = isNew ? [1,2,3,4,5] : (sc.days || []);
    const pspeed = isNew ? 'auto' : (sc.pspeed || 'auto');
    const deviceIds = isNew ? [] : (schedule.device_ids || []);

    let selectedMode = mode;
    let selectedDays = [...days];
    let tempVal = temp;

    const overlay = document.createElement('dialog');
    overlay.className = 'az-editor-overlay';
    overlay.innerHTML = `
      <div class="az-editor">
        <div class="az-editor-header">
          <h3 style="display:flex; align-items:center; gap:6px;">${isNew ? '<ha-icon icon="mdi:calendar-plus"></ha-icon> New Schedule' : '<ha-icon icon="mdi:pencil"></ha-icon> Edit Schedule'}</h3>
          <button class="az-btn az-btn-outline az-btn-icon az-btn-sm az-close" title="Close"><ha-icon icon="mdi:close" style="--mdc-icon-size:18px;"></ha-icon></button>
        </div>
        <div class="az-editor-body">
          <div class="az-field">
            <label>Schedule Name</label>
            <input type="text" id="ed-name" value="${name}" placeholder="e.g. Winter Night"/>
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
              <div class="az-temp-val"><span id="ed-temp-display">${tempVal}</span><span class="az-temp-unit">°C</span></div>
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
    // Temp
    const tempDisplay = overlay.querySelector('#ed-temp-display');
    overlay.querySelector('#ed-temp-down').addEventListener('click', () => { tempVal = Math.max(15, tempVal - 0.5); tempDisplay.textContent = tempVal; });
    overlay.querySelector('#ed-temp-up').addEventListener('click', () => { tempVal = Math.min(30, tempVal + 0.5); tempDisplay.textContent = tempVal; });
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

      const payload = {
        name: edName,
        type: 'week',
        prog_enabled: true,
        start_conf: {
          mode: selectedMode,
          pspeed: edSpeed === 'auto' ? 'auto' : parseInt(edSpeed),
          setpoint: { celsius: tempVal, fah: Math.round(tempVal * 9/5 + 32) },
          days: selectedDays.sort(),
          hour: edHour,
          minutes: edMin,
        },
        device_ids: devIds,
      };

      try {
        const svcData = { schedule_data: payload };
        if (this.config.config_entry) svcData.config_entry = this.config.config_entry;

        if (isNew) {
          await this._hass.callService('airzone_cloud', 'post_installation_schedule', svcData);
          this._toast('Schedule created!');
        } else {
          svcData.schedule_id = schedule._id;
          await this._hass.callService('airzone_cloud', 'patch_installation_schedule', svcData);
          this._toast('Schedule updated!');
        }
        closeOverlay();
        this._loadSchedules();
      } catch (err) {
        this._toast('Error: ' + (err.message || 'Unknown'), true);
      }
    });
  }

  async _toggleSchedule(schedule, active) {
    const schedId = schedule._id || schedule.id;
    if (!schedId) {
      this._toast('Error: Schedule ID missing', true);
      return;
    }

    console.log('Toggling schedule:', { id: schedId, active, schedule });

    try {
      const payload = {
        name: schedule.name,
        type: schedule.type || 'week',
        prog_enabled: !!active
      };

      if (schedule.start_conf) {
        payload.start_conf = JSON.parse(JSON.stringify(schedule.start_conf));
        delete payload.start_conf.id;
        delete payload.start_conf._id;
      }
      
      if (schedule.device_ids) {
        payload.device_ids = schedule.device_ids;
      }

      const svcData = {
        schedule_id: schedId,
        schedule_data: payload
      };
      if (this.config.config_entry) svcData.config_entry = this.config.config_entry;

      console.log('Service call data:', svcData);

      await this._hass.callService('airzone_cloud', 'patch_installation_schedule', svcData);
      this._toast(active ? 'Schedule enabled' : 'Schedule disabled');
      this._loadSchedules();
    } catch (err) {
      console.error('Toggle failed:', err);
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
  description: "Manage schedules for your Airzone Cloud installation"
});
