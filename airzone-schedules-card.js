class AirzoneSchedulesCard extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    if (!this.content) {
      this.innerHTML = `
        <ha-card header="Airzone Schedules">
          <div class="card-content">
            <style>
              .schedule-container {
                display: flex;
                flex-direction: column;
                gap: 16px;
              }
              .schedule-item {
                border: 1px solid var(--divider-color);
                border-radius: 4px;
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
              }
              .schedule-header {
                font-weight: bold;
                display: flex;
                justify-content: space-between;
              }
              .schedule-actions {
                display: flex;
                gap: 8px;
                margin-top: 8px;
              }
              .editor-section {
                margin-top: 16px;
                border-top: 1px solid var(--divider-color);
                padding-top: 16px;
                display: flex;
                flex-direction: column;
                gap: 8px;
              }
              textarea {
                width: 100%;
                height: 150px;
                font-family: monospace;
                resize: vertical;
                background: var(--input-background-color, #fff);
                color: var(--primary-text-color, #000);
                border: 1px solid var(--divider-color, #ccc);
                padding: 8px;
              }
              mwc-button {
                --mdc-theme-primary: var(--primary-color);
              }
              #error-msg {
                color: var(--error-color, red);
              }
            </style>
            <div class="schedule-container" id="schedules-list">
              <em>Loading schedules...</em>
            </div>
            
            <div class="editor-section">
              <span id="error-msg"></span>
              <h4>Edit / Create Schedule</h4>
              <p>Schedule ID (leave blank to create a new one):</p>
              <input type="text" id="schedule-id-input" placeholder="e.g. 5f4e..." style="width:100%; padding: 4px;" />
              
              <p>Schedule Data JSON:</p>
              <textarea id="schedule-data-input" placeholder='{\n  "name": "New Schedule",\n  "active": true\n}'></textarea>
              <div class="schedule-actions">
                <mwc-button raised id="btn-save">Save (POST/PATCH)</mwc-button>
                <mwc-button id="btn-refresh">Refresh</mwc-button>
                <mwc-button id="btn-delete" style="--mdc-theme-primary: var(--error-color, red);">Delete by ID</mwc-button>
              </div>
            </div>
            
            <div class="editor-section">
              <h4>Global Controls</h4>
              <mwc-button raised id="btn-enable-all">Enable All Schedules</mwc-button>
              <mwc-button raised id="btn-disable-all" style="--mdc-theme-primary: var(--error-color, red);">Disable All</mwc-button>
            </div>
          </div>
        </ha-card>
      `;
      this.content = this.querySelector('.card-content');
      
      this.querySelector('#btn-refresh').addEventListener('click', () => this.loadSchedules());
      this.querySelector('#btn-save').addEventListener('click', () => this.saveSchedule());
      this.querySelector('#btn-delete').addEventListener('click', () => this.deleteSchedule());
      this.querySelector('#btn-enable-all').addEventListener('click', () => this.toggleAll(true));
      this.querySelector('#btn-disable-all').addEventListener('click', () => this.toggleAll(false));
      
      this.loadSchedules();
    }
  }

  setConfig(config) {
    if (!config.config_entry) {
      throw new Error('You need to define a config_entry ID in this cards configuration.');
    }
    this.config = config;
  }

  async loadSchedules() {
    this.showError("");
    const listEl = this.querySelector('#schedules-list');
    listEl.innerHTML = '<em>Loading...</em>';
    try {
      const response = await this._hass.callWS({
        type: 'call_service',
        domain: 'airzone_cloud',
        service: 'get_installation_schedules',
        service_data: { config_entry: this.config.config_entry },
        return_response: true
      });
      
      listEl.innerHTML = '';
      const schedulesMap = response.response.schedules;
      
      if (!schedulesMap || Object.keys(schedulesMap).length === 0) {
        listEl.innerHTML = '<em>No schedules found or could not be loaded.</em>';
        return;
      }

      // Render dictionary
      for (const [key, value] of Object.entries(schedulesMap)) {
        const item = document.createElement('div');
        item.className = 'schedule-item';
        
        let headerText = value.name ? value.name : \`Schedule ID: \${key}\`;
        
        item.innerHTML = \`
          <div class="schedule-header">
            <span>\${headerText}</span>
            <span>\${value.activated === false ? '⏸ Disabled' : '▶ Active'}</span>
          </div>
          <div style="font-size: 0.9em; color: var(--secondary-text-color);">
            <pre style="margin:0; overflow-x: auto;">\${JSON.stringify(value, null, 2)}</pre>
          </div>
          <div class="schedule-actions">
            <mwc-button outlined class="btn-edit" data-id="\${key}">Edit</mwc-button>
          </div>
        \`;
        
        item.querySelector('.btn-edit').addEventListener('click', (e) => {
          this.querySelector('#schedule-id-input').value = e.target.getAttribute('data-id');
          this.querySelector('#schedule-data-input').value = JSON.stringify(value, null, 2);
        });
        
        listEl.appendChild(item);
      }
    } catch (err) {
      listEl.innerHTML = \`<em>Error loading schedules: \${err.message || JSON.stringify(err)}</em>\`;
    }
  }

  async saveSchedule() {
    this.showError("");
    const id = this.querySelector('#schedule-id-input').value.trim();
    const dataStr = this.querySelector('#schedule-data-input').value.trim();
    
    let parsedData;
    try {
      parsedData = JSON.parse(dataStr);
    } catch (e) {
      this.showError("Invalid JSON in schedule data.");
      return;
    }

    try {
      if (id) {
        // PATCH
        await this._hass.callService('airzone_cloud', 'patch_installation_schedule', {
          config_entry: this.config.config_entry,
          schedule_id: id,
          schedule_data: parsedData
        });
      } else {
        // POST
        await this._hass.callService('airzone_cloud', 'post_installation_schedule', {
          config_entry: this.config.config_entry,
          schedule_data: parsedData
        });
      }
      this.loadSchedules();
      this.showError("Saved successfully!", "green");
    } catch (err) {
      this.showError("Failed to save: " + (err.message || JSON.stringify(err)));
    }
  }

  async deleteSchedule() {
    this.showError("");
    const id = this.querySelector('#schedule-id-input').value.trim();
    if (!id) {
      this.showError("Please specify a Schedule ID to delete.");
      return;
    }
    
    if (!confirm("Are you sure you want to delete schedule ID: " + id + "?")) return;
    
    try {
      await this._hass.callService('airzone_cloud', 'delete_installation_schedule', {
        config_entry: this.config.config_entry,
        schedule_id: id
      });
      this.querySelector('#schedule-id-input').value = "";
      this.querySelector('#schedule-data-input').value = "";
      this.loadSchedules();
      this.showError("Deleted successfully!", "green");
    } catch (err) {
      this.showError("Failed to delete: " + (err.message || JSON.stringify(err)));
    }
  }

  async toggleAll(active) {
    this.showError("");
    try {
      await this._hass.callService('airzone_cloud', 'patch_installation_schedules_activate', {
        config_entry: this.config.config_entry,
        active: active
      });
      this.loadSchedules();
    } catch (err) {
      this.showError("Failed to toggle schedules: " + (err.message || JSON.stringify(err)));
    }
  }

  showError(msg, color = "var(--error-color, red)") {
    const el = this.querySelector('#error-msg');
    el.style.color = color;
    el.innerText = msg;
  }

  getCardSize() {
    return 6;
  }
}

customElements.define('airzone-schedules-card', AirzoneSchedulesCard);
