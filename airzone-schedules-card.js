const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MODES = [
  { value: 1, label: 'Heating', icon: '🔥', color: '#e74c3c' },
  { value: 2, label: 'Cooling', icon: '❄️', color: '#3498db' },
  { value: 3, label: 'Ventilation', icon: '💨', color: '#2ecc71' },
  { value: 4, label: 'Dry', icon: '💧', color: '#f39c12' },
  { value: 5, label: 'Auto', icon: '🔄', color: '#9b59b6' },
];

// Helper to extract a value from a schedule, trying multiple possible field names
function _val(s, ...keys) {
  for (const k of keys) {
    if (s[k] !== undefined && s[k] !== null) return s[k];
  }
  return undefined;
}

function _getScheduleName(s) {
  return _val(s, 'name', 'title', 'label') || 'Unnamed Schedule';
}
function _getScheduleActive(s) {
  const v = _val(s, 'enabled', 'activated', 'active');
  return v !== false && v !== 0;
}
function _getScheduleMode(s) {
  // Could be in events, actions, or top-level
  if (s.events && Array.isArray(s.events) && s.events.length > 0) {
    return _val(s.events[0], 'mode') || 0;
  }
  return _val(s, 'mode') || 0;
}
function _getScheduleSetpoint(s) {
  if (s.events && Array.isArray(s.events) && s.events.length > 0) {
    return _val(s.events[0], 'setpoint', 'setpoint_temperature', 'temperature');
  }
  return _val(s, 'setpoint', 'setpoint_temperature', 'temperature');
}
function _getScheduleTime(s) {
  if (s.events && Array.isArray(s.events) && s.events.length > 0) {
    return _val(s.events[0], 'time', 'start_time', 'hour');
  }
  return _val(s, 'time', 'start_time', 'hour');
}
function _getScheduleDays(s) {
  if (s.events && Array.isArray(s.events) && s.events.length > 0) {
    return _val(s.events[0], 'days', 'daysOfWeek', 'week_days') || [];
  }
  return _val(s, 'days', 'daysOfWeek', 'week_days') || [];
}
function _getSchedulePower(s) {
  if (s.events && Array.isArray(s.events) && s.events.length > 0) {
    const v = _val(s.events[0], 'power', 'power_state');
    return v !== false && v !== 0;
  }
  const v = _val(s, 'power', 'power_state');
  return v !== false && v !== 0;
}

class AirzoneSchedulesCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._schedules = [];
    this._rawData = null;
    this._initialized = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._render();
      this._loadSchedules();
    }
  }

  setConfig(config) {
    if (!config.config_entry) {
      throw new Error('You need to define a config_entry in the card configuration.');
    }
    this.config = config;
  }

  _render() {
    this.innerHTML = '';
    const card = document.createElement('ha-card');
    card.innerHTML = `
      <style>
        :host { --az-primary: #4a90d9; --az-danger: #e74c3c; --az-success: #27ae60; --az-bg: var(--card-background-color, #1c1c1c); --az-surface: var(--primary-background-color, #252525); --az-text: var(--primary-text-color, #e0e0e0); --az-text2: var(--secondary-text-color, #999); --az-border: var(--divider-color, #333); }
        .az-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px 12px; }
        .az-header h2 { margin:0; font-size:1.2em; font-weight:600; color:var(--az-text); display:flex; align-items:center; gap:8px; }
        .az-header-actions { display:flex; gap:8px; }
        .az-btn { border:none; border-radius:8px; padding:8px 16px; font-size:0.85em; font-weight:500; cursor:pointer; transition:all 0.2s; display:inline-flex; align-items:center; gap:6px; }
        .az-btn-primary { background:var(--az-primary); color:#fff; }
        .az-btn-primary:hover { filter:brightness(1.15); }
        .az-btn-outline { background:transparent; border:1px solid var(--az-border); color:var(--az-text); }
        .az-btn-outline:hover { background:var(--az-surface); }
        .az-btn-danger { background:transparent; border:1px solid var(--az-danger); color:var(--az-danger); }
        .az-btn-danger:hover { background:rgba(231,76,60,0.1); }
        .az-btn-sm { padding:6px 12px; font-size:0.8em; }
        .az-btn-icon { padding:6px; min-width:32px; justify-content:center; }
        .az-list { padding:0 16px 16px; display:flex; flex-direction:column; gap:10px; }
        .az-empty { text-align:center; padding:32px 16px; color:var(--az-text2); }
        .az-empty-icon { font-size:2.5em; margin-bottom:8px; }
        .az-schedule { background:var(--az-surface); border-radius:12px; overflow:hidden; border:1px solid var(--az-border); transition:border-color 0.2s; }
        .az-schedule:hover { border-color: var(--az-primary); }
        .az-schedule-top { display:flex; align-items:center; padding:14px 16px; gap:12px; }
        .az-schedule-icon { width:40px; height:40px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:1.3em; flex-shrink:0; }
        .az-schedule-info { flex:1; min-width:0; }
        .az-schedule-name { font-weight:600; font-size:0.95em; color:var(--az-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .az-schedule-meta { font-size:0.8em; color:var(--az-text2); margin-top:2px; display:flex; gap:12px; flex-wrap:wrap; }
        .az-schedule-toggle { position:relative; width:44px; height:24px; flex-shrink:0; }
        .az-schedule-toggle input { opacity:0; width:0; height:0; }
        .az-toggle-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:#555; border-radius:24px; transition:0.3s; }
        .az-toggle-slider:before { position:absolute; content:""; height:18px; width:18px; left:3px; bottom:3px; background:white; border-radius:50%; transition:0.3s; }
        .az-schedule-toggle input:checked + .az-toggle-slider { background:var(--az-success); }
        .az-schedule-toggle input:checked + .az-toggle-slider:before { transform:translateX(20px); }
        .az-schedule-actions { display:flex; gap:6px; flex-shrink:0; }
        .az-days { display:flex; gap:4px; padding:0 16px 14px; }
        .az-day { width:32px; height:24px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:0.7em; font-weight:600; }
        .az-day-on { background:var(--az-primary); color:white; }
        .az-day-off { background:var(--az-border); color:var(--az-text2); }
        .az-loading { text-align:center; padding:32px; color:var(--az-text2); }
        .az-spinner { display:inline-block; width:24px; height:24px; border:3px solid var(--az-border); border-top-color:var(--az-primary); border-radius:50%; animation:az-spin 0.8s linear infinite; }
        @keyframes az-spin { to { transform:rotate(360deg); } }
        .az-raw { padding:0 16px 14px; }
        .az-raw-toggle { font-size:0.75em; color:var(--az-primary); cursor:pointer; text-decoration:underline; }
        .az-raw-data { font-family:monospace; font-size:0.7em; background:var(--az-surface); border:1px solid var(--az-border); border-radius:8px; padding:8px; margin-top:6px; white-space:pre-wrap; word-break:break-all; max-height:200px; overflow-y:auto; color:var(--az-text2); display:none; }

        /* Editor overlay */
        .az-editor-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.6); z-index:999; display:flex; align-items:center; justify-content:center; }
        .az-editor { background:var(--az-bg); border-radius:16px; width:90%; max-width:480px; max-height:85vh; overflow-y:auto; border:1px solid var(--az-border); box-shadow:0 20px 60px rgba(0,0,0,0.5); }
        .az-editor-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--az-border); }
        .az-editor-header h3 { margin:0; font-size:1.05em; color:var(--az-text); }
        .az-editor-body { padding:20px; display:flex; flex-direction:column; gap:18px; }
        .az-field label { display:block; font-size:0.8em; font-weight:500; color:var(--az-text2); margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; }
        .az-json-area { width:100%; min-height:200px; padding:10px; font-family:monospace; font-size:0.8em; border:1px solid var(--az-border); border-radius:8px; background:var(--az-surface); color:var(--az-text); box-sizing:border-box; resize:vertical; }
        .az-editor-footer { display:flex; justify-content:flex-end; gap:8px; padding:16px 20px; border-top:1px solid var(--az-border); }
        .az-editor-hint { font-size:0.75em; color:var(--az-text2); line-height:1.4; }
        .az-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); padding:10px 20px; border-radius:8px; color:white; font-size:0.85em; z-index:1000; animation:az-fade-in 0.3s; }
        @keyframes az-fade-in { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
      </style>
      <div class="az-header">
        <h2>📅 Airzone Schedules</h2>
        <div class="az-header-actions">
          <button class="az-btn az-btn-outline az-btn-sm" id="az-refresh">↻ Refresh</button>
          <button class="az-btn az-btn-primary az-btn-sm" id="az-add">+ New</button>
        </div>
      </div>
      <div class="az-list" id="az-list">
        <div class="az-loading"><div class="az-spinner"></div><br/>Loading schedules…</div>
      </div>
    `;
    this.appendChild(card);
    card.querySelector('#az-refresh').addEventListener('click', () => this._loadSchedules());
    card.querySelector('#az-add').addEventListener('click', () => this._openEditor(null));
  }

  async _loadSchedules() {
    const list = this.querySelector('#az-list');
    list.innerHTML = '<div class="az-loading"><div class="az-spinner"></div><br/>Loading schedules…</div>';
    try {
      const resp = await this._hass.callWS({
        type: 'call_service', domain: 'airzone_cloud', service: 'get_installation_schedules',
        service_data: { config_entry: this.config.config_entry }, return_response: true
      });
      this._rawData = resp.response || resp;
      const data = (this._rawData && this._rawData.schedules) ? this._rawData.schedules : this._rawData || {};

      // Schedules could be an object keyed by ID, an array, or nested
      if (Array.isArray(data)) {
        this._schedules = data.map((s, i) => ({ _id: s._id || s.id || String(i), ...s }));
      } else if (typeof data === 'object') {
        this._schedules = Object.entries(data).map(([id, s]) => {
          if (typeof s === 'object' && s !== null) return { _id: id, ...s };
          return { _id: id, value: s };
        });
      } else {
        this._schedules = [];
      }
      this._renderList();
    } catch (err) {
      list.innerHTML = '<div class="az-empty"><div class="az-empty-icon">⚠️</div>Error loading schedules<br/><small>' + (err.message || '') + '</small></div>';
    }
  }

  _renderList() {
    const list = this.querySelector('#az-list');
    if (!this._schedules.length) {
      list.innerHTML = '<div class="az-empty"><div class="az-empty-icon">📭</div>No schedules configured<br/><small>Click "+ New" to create one</small></div>';
      return;
    }
    list.innerHTML = '';
    for (const s of this._schedules) {
      const modeVal = _getScheduleMode(s);
      const mode = MODES.find(m => m.value === modeVal) || { icon: '📋', color: '#888', label: 'Unknown' };
      const isActive = _getScheduleActive(s);
      const days = _getScheduleDays(s);
      const time = _getScheduleTime(s) || '—';
      const temp = _getScheduleSetpoint(s);
      const tempStr = temp != null ? temp + '°C' : '—';
      const name = _getScheduleName(s);

      const el = document.createElement('div');
      el.className = 'az-schedule';
      el.innerHTML = `
        <div class="az-schedule-top">
          <div class="az-schedule-icon" style="background:${mode.color}22; color:${mode.color}">${mode.icon}</div>
          <div class="az-schedule-info">
            <div class="az-schedule-name">${name}</div>
            <div class="az-schedule-meta">
              <span>⏰ ${time}</span>
              <span>🌡️ ${tempStr}</span>
              <span>${mode.label}</span>
            </div>
          </div>
          <label class="az-schedule-toggle">
            <input type="checkbox" ${isActive ? 'checked' : ''} data-id="${s._id}"/>
            <span class="az-toggle-slider"></span>
          </label>
          <div class="az-schedule-actions">
            <button class="az-btn az-btn-outline az-btn-icon az-btn-sm az-edit" data-id="${s._id}">✏️</button>
            <button class="az-btn az-btn-danger az-btn-icon az-btn-sm az-del" data-id="${s._id}">🗑️</button>
          </div>
        </div>
        ${days.length ? '<div class="az-days">' + DAYS.map((d, i) => '<span class="az-day ' + (days.includes(i + 1) ? 'az-day-on' : 'az-day-off') + '">' + d + '</span>').join('') + '</div>' : ''}
        <div class="az-raw">
          <span class="az-raw-toggle">▶ View raw data</span>
          <div class="az-raw-data">${JSON.stringify(s, null, 2)}</div>
        </div>
      `;

      el.querySelector('.az-edit').addEventListener('click', () => this._openEditor(s));
      el.querySelector('.az-del').addEventListener('click', () => this._deleteSchedule(s._id));
      el.querySelector('input[type=checkbox]').addEventListener('change', (e) => this._toggleSchedule(s, e.target.checked));
      const rawToggle = el.querySelector('.az-raw-toggle');
      const rawData = el.querySelector('.az-raw-data');
      rawToggle.addEventListener('click', () => {
        const open = rawData.style.display === 'block';
        rawData.style.display = open ? 'none' : 'block';
        rawToggle.textContent = open ? '▶ View raw data' : '▼ Hide raw data';
      });

      list.appendChild(el);
    }
  }

  _openEditor(schedule) {
    const isNew = !schedule;
    const overlay = document.createElement('div');
    overlay.className = 'az-editor-overlay';

    // For editing, show the full schedule JSON so the user can modify any field.
    // For new, show a template.
    const template = isNew ? {
      name: "New Schedule",
      events: [{
        days: [1,2,3,4,5],
        time: "08:00",
        mode: 1,
        setpoint: 22,
        power: true
      }],
      enabled: true
    } : (() => {
      const copy = Object.assign({}, schedule);
      delete copy._id;
      return copy;
    })();

    overlay.innerHTML = `
      <div class="az-editor">
        <div class="az-editor-header">
          <h3>${isNew ? '✨ New Schedule' : '✏️ Edit Schedule'}</h3>
          <button class="az-btn az-btn-outline az-btn-icon az-btn-sm az-close">✕</button>
        </div>
        <div class="az-editor-body">
          <div class="az-field">
            <label>Schedule Data (JSON)</label>
            <textarea class="az-json-area" id="ed-json">${JSON.stringify(template, null, 2)}</textarea>
          </div>
          <div class="az-editor-hint">
            Edit the JSON above to modify the schedule. The exact fields depend on the Airzone API.
            Common fields: <b>name</b>, <b>enabled</b>, <b>events</b> (array with <b>days</b>, <b>time</b>, <b>mode</b>, <b>setpoint</b>, <b>power</b>).
          </div>
        </div>
        <div class="az-editor-footer">
          <button class="az-btn az-btn-outline az-close">Cancel</button>
          <button class="az-btn az-btn-primary" id="ed-save">${isNew ? 'Create Schedule' : 'Save Changes'}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelectorAll('.az-close').forEach(btn => btn.addEventListener('click', () => overlay.remove()));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#ed-save').addEventListener('click', async () => {
      let payload;
      try { payload = JSON.parse(overlay.querySelector('#ed-json').value); }
      catch (e) { this._toast('Invalid JSON: ' + e.message, true); return; }

      try {
        if (isNew) {
          await this._hass.callService('airzone_cloud', 'post_installation_schedule', {
            config_entry: this.config.config_entry, schedule_data: payload
          });
          this._toast('Schedule created!');
        } else {
          await this._hass.callService('airzone_cloud', 'patch_installation_schedule', {
            config_entry: this.config.config_entry, schedule_id: schedule._id, schedule_data: payload
          });
          this._toast('Schedule updated!');
        }
        overlay.remove();
        this._loadSchedules();
      } catch (err) {
        this._toast('Error: ' + (err.message || 'Unknown error'), true);
      }
    });
  }

  async _toggleSchedule(schedule, active) {
    // Try the global activate/deactivate endpoint via patch_installation_schedule
    // Use the field names found in the original schedule data
    const payload = {};
    if ('enabled' in schedule) payload.enabled = active;
    else if ('activated' in schedule) payload.activated = active;
    else payload.enabled = active; // default guess

    try {
      await this._hass.callService('airzone_cloud', 'patch_installation_schedule', {
        config_entry: this.config.config_entry, schedule_id: schedule._id,
        schedule_data: payload
      });
      this._toast(active ? 'Schedule enabled' : 'Schedule disabled');
      this._loadSchedules();
    } catch (err) {
      this._toast('Error: ' + (err.message || ''), true);
      this._loadSchedules();
    }
  }

  async _deleteSchedule(id) {
    if (!confirm('Delete this schedule? This cannot be undone.')) return;
    try {
      await this._hass.callService('airzone_cloud', 'delete_installation_schedule', {
        config_entry: this.config.config_entry, schedule_id: id
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
    this.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  getCardSize() { return 4; }
}

customElements.define('airzone-schedules-card', AirzoneSchedulesCard);
