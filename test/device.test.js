'use strict';

// Runs the real device.js against a fake NRGkick, with a stubbed Homey SDK.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Module = require('module');
const path = require('path');

// ---- Homey SDK stub ----
class FakeDevice {

  constructor({ settings, capabilities, driver }) {
    this.settings = { ...settings };
    this.caps = new Map(capabilities.map((c) => [c, null]));
    this.options = {};
    this.store = {};
    this.listeners = {};
    this.available = true;
    this.unavailableReason = null;
    this.timers = [];
    this.driver = driver;
    this.homey = {
      setTimeout: (fn, ms) => {
        if (ms <= 1500) return setTimeout(fn, 0); // client retry back-off: run at once
        const timer = { fn, ms };
        this.timers.push(timer);
        return timer;
      },
      clearTimeout: () => {},
      __: (key, tokens) => (tokens && tokens.reason ? `${key}:${tokens.reason}` : key),
    };
  }

  getData() { return { id: 'SERIAL1' }; }

  getSettings() { return { ...this.settings }; }

  getSetting(key) { return this.settings[key]; }

  async setSettings(values) { Object.assign(this.settings, values); }

  hasCapability(cap) { return this.caps.has(cap); }

  getCapabilities() { return [...this.caps.keys()]; }

  async addCapability(cap) { this.caps.set(cap, null); }

  async removeCapability(cap) { this.caps.delete(cap); }

  getCapabilityValue(cap) { return this.caps.get(cap); }

  async setCapabilityValue(cap, value) { this.caps.set(cap, value); }

  async setCapabilityOptions(cap, options) { this.options[cap] = options; }

  getStoreValue(key) { return this.store[key]; }

  async setStoreValue(key, value) { this.store[key] = value; }

  async unsetStoreValue(key) { delete this.store[key]; }

  registerCapabilityListener(cap, fn) { this.listeners[cap] = fn; }

  registerMultipleCapabilityListener(caps, fn) { this.listeners.multi = fn; }

  getAvailable() { return this.available; }

  async setAvailable() {
    this.available = true;
    this.unavailableReason = null;
  }

  async setUnavailable(reason) {
    this.available = false;
    this.unavailableReason = reason;
  }

  log() {}

  error() {}

}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'homey') return path.join(__dirname, 'homey-stub.js');
  return originalResolve.call(this, request, ...rest);
};
require.cache[path.join(__dirname, 'homey-stub.js')] = {
  id: 'homey', filename: 'homey', loaded: true, exports: { Device: FakeDevice, Driver: class {}, App: class {} },
};
const NrgkickDevice = require('../drivers/nrgkick/device');
const manifest = require('../drivers/nrgkick/driver.compose.json');

// ---- Fake NRGkick ----
function fakeNrgkick() {
  const state = {
    info: {
      general: {
        serial_number: 'SERIAL1', model_type: 'NRGkick Gen2', device_name: 'Garage', rated_current: 32,
      },
      connector: {
        phase_count: 1, max_current: 16, type: 2, serial: 'A1',
      },
      grid: { voltage: 230, frequency: 50, phases: 1 },
      network: {
        ip_address: '192.0.2.10', mac_address: '00:00:00:00:00:01', ssid: 'net', rssi: -61,
      },
      versions: { sw_sm: '4.0.0.100', hw_sm: '1.0' },
    },
    control: {
      current_set: 16, charge_pause: 0, energy_limit: 0, phase_count: 3,
    },
    values: {
      energy: { total_charged_energy: 1234567, charged_energy: 0 },
      powerflow: {
        charging_voltage: 231.2,
        charging_current: 16,
        grid_frequency: 50.01,
        peak_power: 0,
        total_active_power: 0,
        total_power_factor: 0.16,
        l1: { voltage: 231.2, current: 0, active_power: 0 },
        l2: { voltage: 0, current: 0, active_power: 0 },
        l3: { voltage: 0, current: 0, active_power: 0 },
        n: { current: 0 },
      },
      general: {
        charging_rate: 0,
        vehicle_connect_time: 0,
        vehicle_charging_time: 0,
        status: 1,
        charge_permitted: 0,
        charge_count: 42,
        rcd_trigger: 0,
        warning_code: 0,
        error_code: 0,
      },
      temperatures: { housing: 21.456, domestic_plug_1: 20 },
    },
    status: 200,
    writes: [],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body;
    if (state.status !== 200) body = { Response: 'nope' };
    else if (url.pathname === '/info') body = state.info;
    else if (url.pathname === '/values') body = state.values;
    else if (url.pathname === '/control') {
      const entries = [...url.searchParams.entries()];
      if (entries.length) {
        const [key, value] = entries[0];
        state.writes.push(`${key}=${value}`);
        state.control[key] = Number(value);
        body = { [key]: Number(value) };
      } else body = state.control;
    }
    res.writeHead(state.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state,
    host: `127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(r);
    }),
  })));
}

async function startDevice() {
  const dev = await fakeNrgkick();
  const triggered = [];
  const card = (name) => ({ trigger: async (device, tokens) => triggered.push({ name, tokens }) });
  const driver = {
    manifest,
    findAddress: () => null,
    discovered: [],
    discoveredAddresses() { return this.discovered; },
    triggers: {
      statusChanged: card('status_changed'),
      faultOccurred: card('fault_occurred'),
      warningOccurred: card('warning_occurred'),
      energyLimitReached: card('energy_limit_reached'),
      locationChanged: card('location_changed'),
    },
  };
  const device = new NrgkickDevice({
    settings: {
      host: dev.host, username: '', password: '', poll_interval: 30,
    },
    capabilities: ['onoff'], // a stale capability that ensureCapabilities must remove
    driver,
  });
  await device.onInit();
  return { dev, device, triggered };
}

test('first poll fills capabilities, labels and limits', async () => {
  const { dev, device, triggered } = await startDevice();
  try {
    assert.strictEqual(device.hasCapability('onoff'), false);
    assert.strictEqual(device.hasCapability('nrgkick_status'), true);
    await device.poll();
    const v = (cap) => device.getCapabilityValue(cap);
    assert.strictEqual(v('meter_power'), 1234.567);
    assert.strictEqual(v('nrgkick_status'), 'standby');
    assert.strictEqual(v('evcharger_charging_state'), 'plugged_out');
    assert.strictEqual(v('evcharger_charging'), true);
    assert.strictEqual(v('nrgkick_current_set'), 16);
    assert.strictEqual(v('nrgkick_phase_count'), '3');
    assert.strictEqual(v('nrgkick_energy_limit'), 0);
    assert.strictEqual(v('measure_temperature'), 21.5);
    assert.strictEqual(v('measure_signal_strength'), -61);
    assert.strictEqual(v('nrgkick_error'), 'none');
    assert.strictEqual(v('alarm_generic'), false);
    assert.deepStrictEqual(device.options.target_power, {
      min: 0, max: 3680, step: 230, excludeMin: 0, excludeMax: 1380,
    });
    assert.strictEqual(device.options.nrgkick_current_set.max, 16);
    assert.strictEqual(device.settings.info_attachment, 'connector.domestic, 1 × 16 A');
    assert.strictEqual(device.settings.info_grid, '230 V, 50 Hz, L1');
    assert.strictEqual(device.settings.info_fw_smartmodule, '4.0.0.100 / 1.0');
    assert.strictEqual(device.settings.info_charge_count, '42');
    assert.deepStrictEqual(triggered, [], 'the first read never triggers');
  } finally {
    device.stop();
    await dev.close();
  }
});

test('changes trigger Flows once', async () => {
  const { dev, device, triggered } = await startDevice();
  try {
    await device.poll();
    dev.state.values.general.status = 3;
    dev.state.values.powerflow.total_active_power = 3650.4;
    await device.poll();
    assert.strictEqual(device.getCapabilityValue('evcharger_charging_state'), 'plugged_in_charging');
    assert.strictEqual(device.getCapabilityValue('measure_power'), 3650);
    assert.deepStrictEqual(triggered.shift(), {
      name: 'status_changed', tokens: { status: 'status.charging', previous_status: 'status.standby' },
    });

    dev.state.values.general.error_code = 81;
    dev.state.values.general.warning_code = 3;
    dev.state.values.energy.charged_energy = 10000;
    await device.poll();
    assert.strictEqual(device.getCapabilityValue('alarm_generic'), true);
    assert.strictEqual(device.getCapabilityValue('nrgkick_error'), 'fault.housing_overtemperature');
    assert.deepStrictEqual(triggered.map((t) => t.name), ['fault_occurred', 'warning_occurred', 'energy_limit_reached']);
    assert.deepStrictEqual(triggered[0].tokens, { fault: 'fault.housing_overtemperature', code: 81 });
    assert.deepStrictEqual(triggered[2].tokens, { energy: 10 });

    triggered.length = 0;
    await device.poll();
    assert.deepStrictEqual(triggered, [], 'no repeat while nothing changes');
  } finally {
    device.stop();
    await dev.close();
  }
});

test('residual current trip raises the fault alarm', async () => {
  const { dev, device, triggered } = await startDevice();
  try {
    await device.poll();
    dev.state.values.general.rcd_trigger = 1;
    await device.poll();
    assert.strictEqual(device.getCapabilityValue('alarm_generic'), true);
    assert.strictEqual(device.getCapabilityValue('nrgkick_error'), 'fault.ac_30ma_fault');
    assert.strictEqual(triggered[0].name, 'fault_occurred');
  } finally {
    device.stop();
    await dev.close();
  }
});

test('a transient phase_count of 0 is ignored', async () => {
  const { dev, device } = await startDevice();
  try {
    await device.poll();
    dev.state.control.phase_count = 0;
    await device.poll();
    assert.strictEqual(device.getCapabilityValue('nrgkick_phase_count'), '3');
  } finally {
    device.stop();
    await dev.close();
  }
});

test('capability listeners write the device', async () => {
  const { dev, device } = await startDevice();
  try {
    await device.poll();
    await device.listeners.nrgkick_current_set(10.5);
    await device.listeners.nrgkick_energy_limit(7.5);
    await device.listeners.nrgkick_phase_count('1');
    await device.listeners.multi({ evcharger_charging: false });
    assert.deepStrictEqual(dev.state.writes, ['current_set=10.5', 'energy_limit=7500', 'phase_count=1', 'charge_pause=1']);
    assert.strictEqual(device.getCapabilityValue('nrgkick_energy_limit'), 7.5);
    assert.strictEqual(device.getCapabilityValue('evcharger_charging'), false);
    await device.listeners.multi({ target_power: 5000 });
    assert.strictEqual(dev.state.writes.length, 4, 'target power is ignored outside Homey mode');
  } finally {
    device.stop();
    await dev.close();
  }
});

test('Homey mode follows target power and hands control back', async () => {
  const { dev, device } = await startDevice();
  try {
    await device.poll();
    await device.listeners.multi({ target_power: 2300, target_power_mode: 'homey', evcharger_charging: true });
    assert.deepStrictEqual(dev.state.writes, ['current_set=10']);
    assert.deepStrictEqual(device.store.beforeHomey, { current_set: 16, charge_pause: 0 });

    await device.listeners.multi({ target_power: 0, evcharger_charging: false });
    assert.deepStrictEqual(dev.state.writes.slice(1), ['charge_pause=1']);

    await device.setCapabilityValue('target_power_mode', 'homey');
    await device.listeners.multi({ target_power: 3000, evcharger_charging: true });
    assert.deepStrictEqual(dev.state.writes.slice(2), ['current_set=13', 'charge_pause=0']);

    await device.listeners.multi({ target_power_mode: 'device' });
    assert.deepStrictEqual(dev.state.writes.slice(4), ['current_set=16']);
    assert.strictEqual(device.store.beforeHomey, undefined);
  } finally {
    device.stop();
    await dev.close();
  }
});

test('a refused write surfaces the device reason', async () => {
  const { dev, device } = await startDevice();
  try {
    await device.poll();
    dev.state.status = 406;
    await assert.rejects(device.listeners.nrgkick_phase_count('1'), { message: 'errors.rejected:nope' });
  } finally {
    device.stop();
    await dev.close();
  }
});

test('wrong credentials make the device unavailable at once; a later poll recovers', async () => {
  const { dev, device } = await startDevice();
  try {
    await device.poll();
    dev.state.status = 401;
    await device.poll();
    assert.strictEqual(device.available, false);
    assert.strictEqual(device.unavailableReason, 'errors.auth');
    const next = device.timers[device.timers.length - 1];
    assert.strictEqual(next.ms, 30000);
    dev.state.status = 200;
    await device.poll();
    assert.strictEqual(device.available, true);
  } finally {
    device.stop();
    await dev.close();
  }
});

test('SIM models get cellular and GPS data; moving more than 100 m triggers a Flow', async () => {
  const { dev, device, triggered } = await startDevice();
  const SIM = ['nrgkick_cellular_mode', 'nrgkick_cellular_signal', 'nrgkick_cellular_operator',
    'nrgkick_latitude', 'nrgkick_longitude', 'nrgkick_gps_accuracy'];
  try {
    await device.poll();
    assert.ok(SIM.every((cap) => !device.hasCapability(cap)), 'not on a model without SIM');

    Object.assign(dev.state.info, {
      general: { ...dev.state.info.general, model_type: 'NRGkick Gen2 SIM' },
      cellular: {
        imei: '0', imsi: '0', operator: 'Operator', rssi: -87, mode: 3,
      },
      gps: {
        latitude: 47.070714, longitude: 15.439504, altitude: 353, accuracy: 4.2,
      },
      versions: { ...dev.state.info.versions, sw_cm: 'B15' },
    });
    device.infoAt = 0; // force an /info read on the next poll
    await device.poll();
    const v = (cap) => device.getCapabilityValue(cap);
    assert.ok(SIM.every((cap) => device.hasCapability(cap)));
    assert.strictEqual(v('nrgkick_cellular_mode'), 'lte_cat_m1');
    assert.strictEqual(v('nrgkick_cellular_signal'), -87);
    assert.strictEqual(v('nrgkick_cellular_operator'), 'Operator');
    assert.strictEqual(v('nrgkick_latitude'), 47.070714);
    assert.strictEqual(v('nrgkick_gps_accuracy'), 4);
    assert.strictEqual(device.settings.info_fw_cellular, 'B15');
    assert.deepStrictEqual(triggered, [], 'the first fix never triggers');

    dev.state.info.gps = { latitude: 47.0709, longitude: 15.4397 }; // about 25 m
    device.infoAt = 0;
    await device.poll();
    assert.deepStrictEqual(triggered, []);

    dev.state.info.gps = { latitude: 47.0752, longitude: 15.4395 }; // about 500 m north
    device.infoAt = 0;
    await device.poll();
    assert.strictEqual(triggered.length, 1);
    assert.strictEqual(triggered[0].name, 'location_changed');
    assert.ok(triggered[0].tokens.distance > 450 && triggered[0].tokens.distance < 550, triggered[0].tokens.distance);
    assert.strictEqual(device.getCapabilityValue('nrgkick_gps_accuracy'), null);

    dev.state.info.gps = { latitude: 0, longitude: 0 }; // no fix: keep the last position
    device.infoAt = 0;
    await device.poll();
    assert.strictEqual(device.getCapabilityValue('nrgkick_latitude'), 47.0752);

    dev.state.info.general.model_type = 'NRGkick Gen2';
    device.infoAt = 0;
    await device.poll();
    assert.ok(SIM.every((cap) => !device.hasCapability(cap)), 'removed again without SIM');
  } finally {
    device.stop();
    await dev.close();
  }
});

test('ensureCapabilities keeps SIM capabilities that are present', async () => {
  const { dev, device } = await startDevice();
  try {
    await device.addCapability('nrgkick_latitude');
    await device.ensureCapabilities();
    assert.strictEqual(device.hasCapability('nrgkick_latitude'), true);
  } finally {
    device.stop();
    await dev.close();
  }
});

test('a device that stops answering is found again at a discovered address', async () => {
  const { dev, device } = await startDevice();
  try {
    await device.poll();
    device.driver.discovered = ['127.0.0.1:1', dev.host];
    device.client.configure({ host: '127.0.0.1:1' }); // simulate an address that changed
    await device.setSettings({ host: '127.0.0.1:1' });
    await device.poll();
    await device.poll();
    await new Promise((resolve) => setTimeout(resolve, 200)); // relocate runs in the background
    assert.strictEqual(device.getSetting('host'), dev.host);
    await device.poll();
    assert.strictEqual(device.available, true);
    assert.strictEqual(await device.relocate(), false, 'rate-limited');
  } finally {
    device.stop();
    await dev.close();
  }
});
