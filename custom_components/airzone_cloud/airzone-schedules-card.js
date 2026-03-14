const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MODES = {
  1: { label: 'Auto', icon: '🔄', color: '#9b59b6' },
  2: { label: 'Cooling', icon: '❄️', color: '#3498db' },
  3: { label: 'Heating', icon: '🔥', color: '#e74c3c' },
  4: { label: 'Ventilation', icon: '💨', color: '#2ecc71' },
  5: { label: 'Dry', icon: '💧', color: '#f39c12' },
  7: { label: 'Emergency Heat', icon: '🔥', color: '#c0392b' },
};
const DEFAULT_MODE = { label: 'Unknown', icon: '📋', color: '#888' };

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
      this._loadSchedules();
    }
  }

  setConfig(config) {
    this.config = config || {};
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
        .az-schedule:hover { border-color:var(--az-primary); }
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

        dialog.az-editor-overlay { border:none; background:transparent; padding:0; outline:none; margin:auto; max-width:100%; max-height:100%; overflow:visible; }
        dialog.az-editor-overlay::backdrop { background:rgba(0,0,0,0.6); }
        .az-editor { background:var(--az-bg); border-radius:16px; width:90%; max-width:420px; max-height:85vh; overflow-y:auto; border:1px solid var(--az-border); box-shadow:0 20px 60px rgba(0,0,0,0.5); }
        .az-editor-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--az-border); }
        .az-editor-header h3 { margin:0; font-size:1.05em; color:var(--az-text); }
        .az-editor-body { padding:20px; display:flex; flex-direction:column; gap:18px; }
        .az-field label { display:block; font-size:0.8em; font-weight:500; color:var(--az-text2); margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; }
        .az-field input[type=text], .az-field input[type=number], .az-field select { width:100%; padding:10px 12px; border:1px solid var(--az-border); border-radius:8px; background:var(--az-surface); color:var(--az-text); font-size:0.9em; box-sizing:border-box; outline:none; transition:border 0.2s; }
        .az-field input:focus, .az-field select:focus { border-color:var(--az-primary); }
        .az-time-row { display:flex; gap:8px; align-items:center; }
        .az-time-row input { width:70px; text-align:center; }
        .az-time-row span { color:var(--az-text); font-size:1.2em; font-weight:600; }
        .az-days-editor { display:flex; gap:6px; }
        .az-day-btn { width:40px; height:36px; border:1px solid var(--az-border); border-radius:8px; background:transparent; color:var(--az-text2); font-size:0.8em; font-weight:600; cursor:pointer; transition:all 0.2s; }
        .az-day-btn.active { background:var(--az-primary); color:white; border-color:var(--az-primary); }
        .az-modes-editor { display:flex; gap:6px; flex-wrap:wrap; }
        .az-mode-btn { padding:8px 14px; border:1px solid var(--az-border); border-radius:8px; background:transparent; color:var(--az-text); font-size:0.8em; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; gap:4px; }
        .az-mode-btn.active { border-color:var(--az-primary); background:rgba(74,144,217,0.15); }
        .az-temp-row { display:flex; align-items:center; gap:12px; }
        .az-temp-val { font-size:1.8em; font-weight:600; color:var(--az-text); min-width:70px; text-align:center; }
        .az-temp-unit { font-size:0.5em; color:var(--az-text2); }
        .az-temp-btn { width:36px; height:36px; border-radius:50%; border:1px solid var(--az-border); background:transparent; color:var(--az-text); font-size:1.2em; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; }
        .az-temp-btn:hover { background:var(--az-primary); color:white; border-color:var(--az-primary); }
        .az-editor-footer { display:flex; justify-content:flex-end; gap:8px; padding:16px 20px; border-top:1px solid var(--az-border); }
        .az-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); padding:10px 20px; border-radius:8px; color:white; font-size:0.85em; z-index:1000; animation:az-fade-in 0.3s; }
        @keyframes az-fade-in { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
        .az-devices { font-size:0.75em; color:var(--az-text2); padding:0 16px 12px; }
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
      const sc = s.start_conf || {};
      const modeInfo = MODES[sc.mode] || DEFAULT_MODE;
      const isActive = s.prog_enabled !== false;
      const days = sc.days || [];
      const time = (sc.hour != null) ? fmtTime(sc.hour, sc.minutes || 0) : '—';
      const temp = sc.setpoint ? sc.setpoint.celsius + '°C' : '—';
      const name = s.name || 'Unnamed Schedule';
      const deviceCount = (s.device_ids || []).length;

      const el = document.createElement('div');
      el.className = 'az-schedule';
      el.innerHTML = `
        <div class="az-schedule-top">
          <div class="az-schedule-icon" style="background:${modeInfo.color}22; color:${modeInfo.color}">${modeInfo.icon}</div>
          <div class="az-schedule-info">
            <div class="az-schedule-name">${name}</div>
            <div class="az-schedule-meta">
              <span>⏰ ${time}</span>
              <span>🌡️ ${temp}</span>
              <span>${modeInfo.label}</span>
              ${sc.pspeed ? '<span>💨 ' + sc.pspeed + '</span>' : ''}
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
        <div class="az-days">${DAY_LABELS.map((d, i) => '<span class="az-day ' + (days.includes(i) ? 'az-day-on' : 'az-day-off') + '">' + d + '</span>').join('')}</div>
        ${deviceCount ? '<div class="az-devices">📍 ' + deviceCount + ' zone' + (deviceCount > 1 ? 's' : '') + '</div>' : ''}
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
          <h3>${isNew ? '✨ New Schedule' : '✏️ Edit Schedule'}</h3>
          <button class="az-btn az-btn-outline az-btn-icon az-btn-sm az-close">✕</button>
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
              <button class="az-temp-btn" id="ed-temp-down">−</button>
              <div class="az-temp-val"><span id="ed-temp-display">${tempVal}</span><span class="az-temp-unit">°C</span></div>
              <button class="az-temp-btn" id="ed-temp-up">+</button>
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
          ${!isNew ? '<div class="az-field"><label>Device IDs</label><input type="text" id="ed-devices" value="' + deviceIds.join(', ') + '" placeholder="Comma-separated device IDs"/></div>' : ''}
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
      const devicesEl = overlay.querySelector('#ed-devices');
      const devIds = devicesEl ? devicesEl.value.split(',').map(s => s.trim()).filter(Boolean) : (schedule ? schedule.device_ids || [] : []);

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
    try {
      const svcData = { schedule_id: schedule._id, schedule_data: { prog_enabled: active } };
      if (this.config.config_entry) svcData.config_entry = this.config.config_entry;
      await this._hass.callService('airzone_cloud', 'patch_installation_schedule', svcData);
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
