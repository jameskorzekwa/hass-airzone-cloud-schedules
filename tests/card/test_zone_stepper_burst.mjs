// Adapted from the candidate burst regression: real card methods/renderer,
// deterministic clock and deferred services (no sleeps or live HA required).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = readFileSync(new URL('../../custom_components/airzone_cloud/airzone-schedules-card.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeCard() {
  let now = 0, sequence = 0;
  const timers = new Map();
  const tick = async ms => {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await settle();
    }
    now = end;
    await settle();
  };
  // A small DOM surface: render actual markup and wire actual click handlers.
  class Element {
    constructor() { this.style = {}; this.dataset = {}; this.children = []; this.nodes = {}; this.isConnected = true; }
    set innerHTML(value) { this.html = value; this.nodes = {}; }
    get innerHTML() { return this.html || ''; }
    appendChild(child) { this.children.push(child); }
    setAttribute() {}
    addEventListener(event, fn) { this[event] = fn; }
    querySelector(selector) {
      if (selector === '.az-zone') return null; // exercise full renderer each time
      const node = this.nodes[selector] ||= new Element();
      if (selector === '.az-zone-temp-up' || selector === '.az-zone-temp-down') {
        node.dataset = { max: '86', min: '59' };
        node.closest = () => this;
      }
      return node;
    }
    querySelectorAll(selector) {
      if (selector === '.az-zone-sp-btn') {
        return this.buttons ||= ['heat', 'cool'].flatMap(kind => ['down', 'up'].map(dir => {
          const btn = new Element();
          btn.dataset = { entity: this.dataset.entity, kind, dir };
          btn.closest = () => this;
          return btn;
        }));
      }
      return [];
    }
  }
  const sandbox = {
    HTMLElement: Element, customElements: { get() {}, define() {} },
    document: { addEventListener() {}, createElement: () => new Element() },
    localStorage: { getItem: () => null }, console,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source + '\n;globalThis.Card = AirzoneSchedulesCard;', sandbox);
  const card = new sandbox.Card();
  const writes = [], refreshes = [], errors = [];
  card._activeTab = 'zones';
  card._toast = message => errors.push(message);
  card._availableDevices = [{ entity_id: 'climate.z1' }, { entity_id: 'climate.z2' }];
  card._hass = {
    config: { unit_system: { temperature: '°F' } },
    states: Object.fromEntries(['climate.z1', 'climate.z2'].map(eid => [eid, {
      state: 'heat', attributes: { friendly_name: eid, temperature: 64, min_temp: 59, max_temp: 86 },
    }])),
    callService(domain, service, data) {
      const call = { ...deferred(), data: plain(data) };
      (domain === 'climate' ? writes : refreshes).push(call);
      return call.promise;
    },
  };
  card._initialized = true;
  card.hass = card._hass; // initial render and hash via the real HA setter
  const zoneElement = () => card._zoneGrids.zonesOn.children.find(el => el.dataset.entity === 'climate.z1');
  const reconnect = () => {
    card.isConnected = true;
    // Emulate browser attachment; an absent callback is a no-op, as in a browser.
    card.connectedCallback?.();
    card.hass = card._hass; // unchanged state must not be needed to force a render
  };
  const set = (value, eid = 'climate.z1') => card._zoneSetTemp(eid, { temperature: value }, { temperature: value });
  const render = () => {
    card._renderZones();
    return card._zoneGrids.zonesOn.children.find(el => el.dataset.entity === 'climate.z1');
  };
  return { card, writes, refreshes, errors, tick, set, render, timers, reconnect, zoneElement };
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok -', name); }
  catch (err) { failures++; console.error('FAIL -', name, err); }
}

await check('rapid clicks debounce to the last value, with immediate optimistic display', async () => {
  const h = makeCard();
  h.render().querySelector('.az-zone-temp-up').click();
  await h.tick(300);
  h.render().querySelector('.az-zone-temp-up').click();
  h.render().querySelector('.az-zone-temp-up').click();
  assert.match(h.render().innerHTML, /az-zone-num">67</);
  await h.tick(599); assert.equal(h.writes.length, 0);
  await h.tick(1); assert.deepEqual(h.writes.map(w => w.data), [{ entity_id: 'climate.z1', temperature: 67 }]);
});

for (const fail of [false, true]) {
  await check(`overlapping bursts serialize; obsolete ${fail ? 'failure' : 'success'} cannot clear latest intent`, async () => {
    const h = makeCard();
    h.set(65); await h.tick(600);
    h.set(66); await h.tick(600); h.set(67); await h.tick(600);
    assert.equal(h.writes.length, 1);
    if (fail) h.writes[0].reject(new Error('obsolete')); else h.writes[0].resolve();
    await settle();
    assert.deepEqual(h.writes.map(w => w.data.temperature), [65, 67]);
    assert.match(h.render().innerHTML, /az-zone-num">67</);
    assert.equal(h.errors.length, 0);
    await h.tick(5000); assert.equal(h.refreshes.length, 0);
  });
}

await check('slow writes retain pins beyond 15 seconds, even on matching HA state', async () => {
  const h = makeCard(); h.set(65); await h.tick(600);
  await h.tick(20000);
  assert.match(h.render().innerHTML, /az-zone-num">65</);
  h.card._hass.states['climate.z1'].attributes.temperature = 65;
  h.render(); assert.equal(h.card._zoneOpt['climate.z1'].temperature, 65);
  h.card._hass.states['climate.z1'].attributes.temperature = 64;
  assert.match(h.render().innerHTML, /az-zone-num">65</);
});

await check('return to starting value remains queued behind older in-flight write', async () => {
  const h = makeCard(); h.set(65); await h.tick(600); h.set(64);
  h.render(); assert.equal(h.card._zoneOpt['climate.z1'].temperature, 64);
  await h.tick(600); assert.equal(h.writes.length, 1);
  h.card._hass.states['climate.z1'].attributes.temperature = 65;
  h.writes[0].resolve(); await settle();
  assert.deepEqual(h.writes.map(w => w.data.temperature), [65, 64]);
  assert.match(h.render().innerHTML, /az-zone-num">64</);
});

await check('latest failure rerenders current authoritative HA state, not captured DOM', async () => {
  const h = makeCard(); h.set(65); h.set(67); await h.tick(600);
  h.render(); h.card._hass.states['climate.z1'].attributes.temperature = 62;
  h.writes[0].reject(new Error('latest failed')); await settle();
  assert.equal(h.card._zoneOpt['climate.z1'], undefined);
  assert.match(h.card._zoneGrids.zonesOn.children[0].innerHTML, /az-zone-num">62</);
  assert.deepEqual(h.errors, ['Error: latest failed']);
  h.set(63); await h.tick(600); assert.equal(h.writes.length, 2);
});

await check('dual-band real click handlers coalesce both edges and serialize return to initial band', async () => {
  const h = makeCard();
  const zone = h.card._hass.states['climate.z1'];
  zone.state = 'heat_cool'; Object.assign(zone.attributes, { target_temp_low: 64, target_temp_high: 66 });
  let el = h.render();
  el.buttons.find(b => b.dataset.kind === 'heat' && b.dataset.dir === 'up').click();
  el = h.render();
  el.buttons.find(b => b.dataset.kind === 'cool' && b.dataset.dir === 'up').click();
  await h.tick(600);
  assert.deepEqual(h.writes[0].data, { entity_id: 'climate.z1', target_temp_low: 65, target_temp_high: 68 });
  const band = { target_temp_low: 64, target_temp_high: 66 };
  h.card._zoneSetTemp('climate.z1', band, band); h.render();
  assert.equal(h.card._zoneOpt['climate.z1'].target_temp_low, 64);
  await h.tick(600); assert.equal(h.writes.length, 1);
  h.writes[0].resolve(); await settle();
  assert.deepEqual(h.writes[1].data, { entity_id: 'climate.z1', ...band });
});

await check('different zones run independently', async () => {
  const h = makeCard(); h.set(65); h.set(70, 'climate.z2'); await h.tick(600);
  assert.equal(h.writes.length, 2);
  h.set(71, 'climate.z2'); await h.tick(600); h.writes[1].resolve(); await settle();
  assert.deepEqual(h.writes[2].data, { entity_id: 'climate.z2', temperature: 71 });
});

await check('disconnect flushes pending work without overlapping an active write', async () => {
  const h = makeCard(); h.set(65); h.card.isConnected = false; h.card.disconnectedCallback();
  assert.equal(h.writes.length, 1);
  h.set(66); h.set(67); h.card.disconnectedCallback();
  assert.equal(h.writes.length, 1);
  h.writes[0].resolve(); await settle();
  assert.deepEqual(h.writes.map(w => w.data.temperature), [65, 67]);
  await h.tick(600); assert.equal(h.writes.length, 2);
  h.writes[1].resolve(); await settle(); await h.tick(20000);
  assert.equal(h.refreshes.length, 0);
  assert.equal(h.timers.size, 0);
  h.reconnect();
  assert.match(h.zoneElement().innerHTML, /az-zone-num">64</);
});

for (const outcome of ['expiry', 'failure']) {
  await check(`reconnect reconciles detached ${outcome} with unchanged HA hash before the next click`, async () => {
    const h = makeCard(); h.set(67); h.render(); await h.tick(600);
    const hash = h.card._lastZoneHash;
    const displayed = () => Number(h.zoneElement().innerHTML.match(/az-zone-num">([^<]+)</)[1]);
    assert.equal(displayed(), 67);
    h.card.isConnected = false; h.card.disconnectedCallback();
    if (outcome === 'failure') h.writes[0].reject(new Error('detached failure'));
    else h.writes[0].resolve();
    await settle(); await h.tick(15000);
    assert.equal(h.card._zoneOpt['climate.z1'], undefined);
    assert.equal(displayed(), 67, 'detached DOM was not rendered');
    assert.equal(h.card._getZoneHash(), hash, 'HA state did not change');
    h.reconnect(); // no manual renderer call after attachment
    assert.equal(displayed(), 64, 'attachment must reconcile the stale DOM');
    assert.equal(h.card._lastZoneHash, hash);
    const el = h.zoneElement();
    el.querySelector('.az-zone-temp-up').click();
    assert.equal(el.querySelector('.az-zone-num').textContent, 65);
    await h.tick(600);
    assert.equal(h.writes[1].data.temperature, 65, 'next click steps from the displayed authoritative value');
  });
}

for (const finishDetached of [false, true]) {
  await check(`reconciliation remains bounded across disconnect/reconnect (finish detached: ${finishDetached})`, async () => {
    const h = makeCard(); h.set(65); await h.tick(600);
    if (!finishDetached) { h.writes[0].resolve(); await settle(); }
    h.card.isConnected = false; h.card.disconnectedCallback();
    if (finishDetached) { h.writes[0].resolve(); await settle(); }
    await h.tick(1000); h.reconnect();
    assert.match(h.zoneElement().innerHTML, /az-zone-num">65</);
    await h.tick(14000);
    assert.equal(h.card._zoneOpt['climate.z1'], undefined);
    assert.match(h.card._zoneGrids.zonesOn.children[0].innerHTML, /az-zone-num">64</);
  });
}

await check('completion before the next debounce deadline does not send the new burst early', async () => {
  const h = makeCard(); h.set(65); await h.tick(600); h.set(66);
  await h.tick(100); h.writes[0].resolve(); await settle();
  assert.equal(h.writes.length, 1);
  await h.tick(499); assert.equal(h.writes.length, 1);
  await h.tick(1); assert.equal(h.writes[1].data.temperature, 66);
});

await check('synchronous service exceptions release the queue and show authoritative state', async () => {
  const h = makeCard(); const original = h.card._hass.callService;
  h.card._hass.callService = () => { throw new Error('disconnected'); };
  h.set(65); await h.tick(600);
  assert.equal(h.card._zoneOpt['climate.z1'], undefined);
  assert.deepEqual(h.errors, ['Error: disconnected']);
  assert.match(h.card._zoneGrids.zonesOn.children[0].innerHTML, /az-zone-num">64</);
  h.card._hass.callService = original;
  h.set(66); await h.tick(600); assert.equal(h.writes.length, 1);
});

await check('latest completion reconciles on match or bounded expiry without another HA event', async () => {
  const h = makeCard(); h.set(65); await h.tick(600); h.writes[0].resolve(); await settle();
  await h.tick(14999); assert.match(h.render().innerHTML, /az-zone-num">65</);
  await h.tick(1);
  assert.equal(h.card._zoneOpt['climate.z1'], undefined);
  assert.match(h.card._zoneGrids.zonesOn.children[0].innerHTML, /az-zone-num">64</);
  h.set(66); await h.tick(600); h.writes[1].resolve(); await settle();
  h.card._hass.states['climate.z1'].attributes.temperature = 66;
  h.render(); assert.equal(h.card._zoneOpt['climate.z1'], undefined);
});

await check('old refresh/expiry callbacks cannot affect a new generation; refresh rejection is handled', async () => {
  const h = makeCard(); h.set(65); await h.tick(600); h.writes[0].resolve(); await settle();
  await h.tick(1500); assert.equal(h.refreshes.length, 1);
  h.set(66); h.refreshes[0].reject(new Error('stale refresh')); await settle();
  await h.tick(20000);
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.errors.length, 0);
  assert.match(h.render().innerHTML, /az-zone-num">66</);
  h.writes[1].resolve(); await settle(); await h.tick(1500);
  h.refreshes[1].reject(new Error('refresh offline')); await settle();
  assert.ok(h.errors.some(e => e.includes('refresh offline')));
  await new Promise(resolve => setImmediate(resolve)); // surface unhandled rejections
});

if (failures) process.exitCode = 1;
