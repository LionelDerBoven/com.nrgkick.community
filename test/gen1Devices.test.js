'use strict';

// Runs the first-generation devices (Connect module and Bluetooth) against simulated hardware, with a stubbed
// Homey SDK.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Module = require('module');
const path = require('path');
const ble = require('../lib/gen1Ble');

class FakeDevice {

  constructor({
    settings = {}, store = {}, capabilities, id, homey = {},
  }) {
    this.settings = { ...settings };
    this.store = { ...store };
    this.caps = new Map(capabilities.map((c) => [c, null]));
    this.options = {};
    this.listeners = {};
    this.available = true;
    this.unavailableReason = null;
    this.warning = null;
    this.logs = [];
    this.id = id;
    this.driver = { manifest: { capabilities } };
    this.homey = {
      setTimeout: (fn, ms) => {
        if (ms <= 1500) return setTimeout(fn, 0);
        return { fn, ms }; // polls are run by the test
      },
      clearTimeout: () => {},
      __: (key, tokens) => (tokens ? `${key}:${Object.values(tokens).join(',')}` : key),
      ...homey,
    };
  }

  getData() { return { id: this.id }; }

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

  async triggerCapabilityListener(cap, value) {
    await this.listeners[cap](value);
    this.caps.set(cap, value);
  }

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

  async setWarning(text) { this.warning = text; }

  async unsetWarning() { this.warning = null; }

  log(...args) { this.logs.push(args.join(' ')); }

  error() {}

}

const stubPath = path.join(__dirname, 'homey-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'homey') return stubPath;
  return originalResolve.call(this, request, ...rest);
};
require.cache[stubPath] = {
  id: 'homey', filename: 'homey', loaded: true, exports: { Device: FakeDevice, Driver: class {}, App: class {} },
};
const ConnectDevice = require('../drivers/nrgkick_connect/device');
const BleDevice = require('../drivers/nrgkick_ble/device');
const connectManifest = require('../drivers/nrgkick_connect/driver.compose.json');
const bleManifest = require('../drivers/nrgkick_ble/driver.compose.json');

// ---- Connect ----

const MAC = '00:1E:C0:59:30:A0';

async function fakeModule() {
  const state = {
    charging: true, current: 16, limit: null, power: 3.68, offline: false, pinMatch: true, puts: [],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      if (state.offline) return send(204);
      if (req.method === 'PUT') {
        const { Values } = JSON.parse(body);
        state.puts.push(Values);
        if (Values.ChargingStatus) state.charging = Values.ChargingStatus.Charging;
        if (Values.ChargingCurrent) state.current = Values.ChargingCurrent.Value;
        return send(202);
      }
      if (req.url === `/api/settings/${MAC}`) {
        return send(200, {
          Info: { ErrorCodes: ['0'], Connected: true },
          Values: {
            ChargingStatus: { Charging: state.charging },
            ChargingEnergy: { Value: state.limit || 200, Limited: state.limit !== null },
            ChargingCurrent: { Value: state.current, Min: 6, Max: 16 },
            DeviceMetadata: { Name: 'Garage', PasswordMatch: state.pinMatch },
          },
          FirmwareVersion: '2',
          HardwareVersion: '1',
          Online: true,
        });
      }
      return send(200, {
        ChargingCurrentPhase: [16, 0, 0],
        ChargingEnergy: 2.154,
        ChargingEnergyOverAll: 862.448,
        ChargingPower: state.power,
        ChargingPowerPhase: [state.power, 0, 0],
        Frequency: 50,
        TemperatureMainUnit: 24,
        VoltagePhase: [230, 0, 0],
        Online: true,
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    host: `127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

async function connectDevice(mod, settings = {}, modules = []) {
  const device = new ConnectDevice({
    id: MAC,
    capabilities: connectManifest.capabilities,
    settings: {
      host: mod.host, password: '1234', poll_interval: 30, ...settings,
    },
  });
  device.driver.discoverModules = async () => modules;
  await device.onInit();
  await device.poll();
  return device;
}

test('Connect: reads the module into capabilities', async () => {
  const mod = await fakeModule();
  const device = await connectDevice(mod);
  try {
    assert.strictEqual(device.getCapabilityValue('measure_power'), 3680);
    assert.strictEqual(device.getCapabilityValue('meter_power'), 862.448);
    assert.strictEqual(device.getCapabilityValue('nrgkick_current_set'), 16);
    assert.strictEqual(device.getCapabilityValue('evcharger_charging'), true);
    assert.strictEqual(device.getCapabilityValue('evcharger_charging_state'), 'plugged_in_charging');
    assert.strictEqual(device.getCapabilityValue('nrgkick_energy_limit'), 0);
    assert.strictEqual(device.getCapabilityValue('alarm_generic'), false);
    assert.strictEqual(device.getCapabilityValue('target_power_mode'), 'device');
    assert.strictEqual(device.getCapabilityValue('target_power'), 3680);
    assert.strictEqual(device.options.nrgkick_current_set.max, 16);
    assert.strictEqual(device.options.target_power.max, 3680);
    assert.strictEqual(device.settings.info_firmware, '2 / 1');
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: the current is sent as whole amperes within the module\'s limits', async () => {
  const mod = await fakeModule();
  const device = await connectDevice(mod);
  try {
    await device.triggerCapabilityListener('nrgkick_current_set', 25.7);
    assert.deepStrictEqual(mod.state.puts.pop(), { DeviceMetadata: { Password: '1234' }, ChargingCurrent: { Value: 16 } });
    await device.triggerCapabilityListener('nrgkick_energy_limit', 0);
    assert.deepStrictEqual(mod.state.puts.pop().ChargingEnergy, { Limited: false });
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: a change without a PIN explains what is missing', async () => {
  const mod = await fakeModule();
  const device = await connectDevice(mod, { password: '' });
  try {
    await assert.rejects(device.triggerCapabilityListener('nrgkick_current_set', 10), /errors\.connect_pin_needed/);
    assert.strictEqual(mod.state.puts.length, 0);
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: a target power becomes a current, and too little power pauses', async () => {
  const mod = await fakeModule();
  const device = await connectDevice(mod);
  try {
    await device.listeners.multi({ target_power: 2300 });
    assert.deepStrictEqual(mod.state.puts.pop(), {
      DeviceMetadata: { Password: '1234' }, ChargingStatus: { Charging: true }, ChargingCurrent: { Value: 10 },
    });
    await device.listeners.multi({ target_power: 1000 });
    assert.deepStrictEqual(mod.state.puts.pop().ChargingStatus, { Charging: false });
    await device.listeners.multi({ evcharger_charging: true });
    assert.deepStrictEqual(mod.state.puts.pop().ChargingStatus, { Charging: true });
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: handing back from Homey Energy restores the user\'s own current and charging state', async () => {
  const mod = await fakeModule();
  const device = await connectDevice(mod);
  try {
    await device.listeners.multi({ target_power_mode: 'homey', target_power: 1000 });
    assert.strictEqual(mod.state.charging, false, 'paused: too little power');
    await device.poll();
    await device.listeners.multi({ target_power_mode: 'device' });
    assert.deepStrictEqual(mod.state.puts.pop(), {
      DeviceMetadata: { Password: '1234' }, ChargingStatus: { Charging: true }, ChargingCurrent: { Value: 16 },
    });
    assert.strictEqual(device.store.beforeHomey, undefined);
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: a new module address is accepted while the NRGkick is away', async () => {
  const mod = await fakeModule();
  const device = await connectDevice(mod);
  try {
    mod.state.offline = true;
    await device.onSettings({ newSettings: { host: mod.host }, changedKeys: ['host'] });
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: an NRGkick that left the module makes the device unavailable at once', async () => {
  const mod = await fakeModule();
  const device = await connectDevice(mod);
  try {
    mod.state.offline = true;
    await device.poll();
    assert.strictEqual(device.available, false);
    assert.strictEqual(device.unavailableReason, 'errors.offline:');
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: a module with a new address is found again through discovery', async () => {
  const mod = await fakeModule();
  const [hostname, port] = mod.host.split(':');
  const device = await connectDevice(mod, { host: '127.0.0.1:1' }, [
    { ip: '192.0.2.9', nrgMac: '11:22:33:44:55:66' },
    { ip: `${hostname}:${port}`, nrgMac: MAC.toLowerCase() },
  ]);
  try {
    await device.poll(); // second failure: unavailable, and a search
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(device.settings.host, mod.host);
    await device.poll();
    assert.strictEqual(device.available, true);
    assert.strictEqual(device.getCapabilityValue('measure_power'), 3680);
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: a wrong PIN shows a warning until it is fixed', async () => {
  const mod = await fakeModule();
  mod.state.pinMatch = false;
  const device = await connectDevice(mod);
  try {
    assert.strictEqual(device.warning, 'errors.connect_pin_wrong');
    mod.state.pinMatch = true;
    await device.poll();
    assert.strictEqual(device.warning, null);
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: an empty or unreachable address is refused with a translated text', async () => {
  const mod = await fakeModule();
  const device = await connectDevice(mod);
  try {
    await assert.rejects(device.onSettings({ newSettings: { host: '' }, changedKeys: ['host'] }), /errors\.no_connect_host/);
    await assert.rejects(
      device.onSettings({ newSettings: { host: '127.0.0.1:1' }, changedKeys: ['host'] }),
      /errors\.connect_connection/,
    );
  } finally {
    device.stop();
    await mod.close();
  }
});

test('Connect: limits that failed to apply are tried again on the next read', async () => {
  const mod = await fakeModule();
  const device = new ConnectDevice({
    id: MAC, capabilities: connectManifest.capabilities, settings: { host: mod.host, password: '1234' },
  });
  device.driver.discoverModules = async () => [];
  let fail = true;
  const original = device.setCapabilityOptions.bind(device);
  device.setCapabilityOptions = async (cap, options) => {
    if (fail) throw new Error('busy');
    return original(cap, options);
  };
  try {
    await device.onInit();
    await device.poll();
    assert.strictEqual(device.store.limits, undefined);
    fail = false;
    await device.poll();
    assert.strictEqual(device.options.nrgkick_current_set.max, 16);
    assert.ok(device.store.limits);
  } finally {
    device.stop();
    await mod.close();
  }
});

// ---- Bluetooth ----

function blePeripheral({ fail = false } = {}) {
  const info = Buffer.alloc(13);
  info.writeUInt8(16, 0);
  info.writeUInt8(1, 6); // charging active
  info.writeUInt8(32, 8);
  const energy = Buffer.alloc(19);
  energy.writeUInt32BE(862448, 0);
  energy.writeUInt32BE(2154, 4);
  energy.writeUInt16BE(ble.NO_ENERGY_LIMIT, 16);
  const power = Buffer.alloc(19);
  power.writeUInt16BE(368, 0);
  power.writeUInt16BE(368, 2);
  power.writeUInt16BE(5000, 10);
  power.writeInt16BE(24, 12);
  power.writeInt8(2, 18);
  const vc = Buffer.alloc(14);
  vc.writeUInt16BE(2300, 0);
  vc.writeUInt16BE(1600, 6);
  const values = {
    [ble.CHARACTERISTICS.info]: info,
    [ble.CHARACTERISTICS.energy]: energy,
    [ble.CHARACTERISTICS.power]: power,
    [ble.CHARACTERISTICS.voltageCurrent]: vc,
  };
  return {
    async find() {
      if (fail) throw new Error('Peripheral not found');
      return {
        async connect() {
          return {
            discoverAllServicesAndCharacteristics: async () => [
              { uuid: 'svc', characteristics: Object.values(ble.CHARACTERISTICS).map((uuid) => ({ uuid })) },
            ],
            read: async (service, uuid) => values[uuid],
            disconnect: async () => {},
          };
        },
      };
    },
  };
}

async function bleDevice(api, settings = {}) {
  const device = new BleDevice({
    id: 'peripheral-1',
    capabilities: bleManifest.capabilities,
    store: { address: '00:1e:c0:59:30:a0' },
    settings: { poll_interval: 60, debug_logging: false, ...settings },
    homey: { ble: api },
  });
  await device.onInit();
  return device;
}

test('Bluetooth: reads the NRGkick into capabilities and remembers its services', async () => {
  const device = await bleDevice(blePeripheral(), { debug_logging: true });
  try {
    await device.poll();
    assert.strictEqual(device.getCapabilityValue('measure_power'), 3680);
    assert.strictEqual(device.getCapabilityValue('nrgkick_status'), 'charging');
    assert.strictEqual(device.getCapabilityValue('evcharger_charging_state'), 'plugged_in_charging');
    assert.strictEqual(device.getCapabilityValue('evcharger_charging'), true);
    assert.strictEqual(device.getCapabilityValue('meter_power'), 862.448);
    assert.strictEqual(device.getCapabilityValue('measure_voltage.l1'), 230);
    assert.strictEqual(device.getCapabilityValue('measure_current.l1'), 16);
    assert.strictEqual(device.getCapabilityValue('nrgkick_energy_limit'), 0);
    assert.strictEqual(device.settings.info_max_current, '32 A');
    assert.strictEqual(device.settings.info_mac, '00:1e:c0:59:30:a0');
    assert.ok(device.store.services, 'services are stored');
    assert.ok(device.logs.some((line) => line.startsWith('raw ')), 'debug logging writes the raw bytes');
  } finally {
    device.stop();
  }
});

test('Bluetooth: controlling is refused for now', async () => {
  const device = await bleDevice(blePeripheral());
  try {
    await assert.rejects(device.listeners.evcharger_charging(false), /errors\.ble_read_only/);
  } finally {
    device.stop();
  }
});

test('Bluetooth: unavailable only after three failed reads', async () => {
  const device = await bleDevice(blePeripheral({ fail: true }));
  try {
    await device.poll();
    await device.poll();
    assert.strictEqual(device.available, true);
    await device.poll();
    assert.strictEqual(device.available, false);
    assert.strictEqual(device.unavailableReason, 'errors.ble_unreachable');
  } finally {
    device.stop();
  }
});
