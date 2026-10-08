'use strict';

// NRGkick Connect support: the client and the discovery against simulated modules, and the data mapping.
// The answers follow the examples in DiniTech's "NRGkick Connect – JSON WEB API" documentation (version 0.2).

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const dgram = require('dgram');
const { ConnectClient } = require('../lib/ConnectClient');
const { parseConnect, connectChargingState } = require('../lib/connectMappings');
const { parseDeviceMessage, discoverConnectModules } = require('../lib/connectDiscovery');

const MAC = '00:1E:C0:59:30:A0';

const SETTINGS = {
  Info: { ErrorCodes: ['0'], Connected: true },
  Values: {
    ChargingStatus: { Charging: true },
    ChargingEnergy: {
      Value: 199.95, Limited: false, Min: 0.5, Max: 200.0,
    },
    ChargingCurrent: { Value: 16.0, Min: 6.0, Max: 32.0 },
    DeviceMetadata: { Name: 'NRGkick_eGolf_30A0', PasswordMatch: true },
  },
  ProductType: 'NRGkick',
  HardwareVersion: '1',
  FirmwareVersion: '1',
  MacAddress: MAC,
  Online: true,
  Timestamp: 1550219055,
};

const MEASUREMENTS = {
  MacAddress: MAC,
  ChargingCurrentPhase: [15.97, 0, 0],
  ChargingEnergy: 2.154,
  ChargingEnergyOverAll: 862.448,
  ChargingPower: 3.68,
  ChargingPowerPhase: [3.68, 0, 0],
  Frequency: 49.98,
  TemperatureMainUnit: 24.0,
  VoltagePhase: [231.2, 0, 0],
  Online: true,
  Timestamp: 1550217927,
};

/** A simulated Connect module. `state.offline` makes it answer 204, `state.rejectPin` a 500 with a message. */
async function fakeModule(state = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      if (state.offline && req.url !== '/api/devices') return send(204);
      if (req.url === '/api/devices') return send(200, [{ MacAddress: MAC, Online: true }, { MacAddress: 'bogus' }]);
      if (req.url === `/api/settings/${MAC}` && req.method === 'GET') return send(200, state.settings || SETTINGS);
      if (req.url === `/api/measurements/${MAC}`) return send(200, state.measurements || MEASUREMENTS);
      if (req.url === `/api/settings/${MAC}` && req.method === 'PUT') {
        if (state.rejectPin) return send(500, { Message: 'Error (6): Password not in request' });
        return send(202);
      }
      return send(404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

const quick = (host) => new ConnectClient({ host, sleep: async () => {}, timeout: 2000 });

test('lists the NRGkicks of a module and skips entries without a valid address', async () => {
  const mod = await fakeModule();
  const client = quick(mod.host);
  try {
    assert.deepStrictEqual((await client.getDevices()).map((d) => d.MacAddress), [MAC]);
    assert.strictEqual((await client.getSettings(MAC.toLowerCase())).Values.ChargingCurrent.Value, 16);
    assert.strictEqual((await client.getMeasurements(MAC)).ChargingPower, 3.68);
  } finally {
    client.destroy();
    await mod.close();
  }
});

test('a change is one PUT with the PIN, the documented field names and the energy limit', async () => {
  const mod = await fakeModule();
  const client = quick(mod.host);
  try {
    await client.putSettings(MAC, '1234', { charging: false, current: 10.4, energyLimit: 12.5 });
    await client.putSettings(MAC, '1234', { energyLimit: null });
    const puts = mod.requests.filter((r) => r.method === 'PUT');
    assert.deepStrictEqual(puts[0].body, {
      Values: {
        DeviceMetadata: { Password: '1234' },
        ChargingStatus: { Charging: false },
        ChargingCurrent: { Value: 10 },
        ChargingEnergy: { Value: 12.5, Limited: true },
      },
    });
    assert.deepStrictEqual(puts[1].body.Values.ChargingEnergy, { Limited: false });
  } finally {
    client.destroy();
    await mod.close();
  }
});

test('the module\'s own error text is passed on, and a change is not repeated', async () => {
  const mod = await fakeModule({ rejectPin: true });
  const client = quick(mod.host);
  try {
    await assert.rejects(client.putSettings(MAC, '', { charging: true }), (err) => err.code === 'rejected' && /Password/.test(err.reason));
    assert.strictEqual(mod.requests.filter((r) => r.method === 'PUT').length, 1);
  } finally {
    client.destroy();
    await mod.close();
  }
});

test('204 means the NRGkick is not connected to the module', async () => {
  const mod = await fakeModule({ offline: true });
  const client = quick(mod.host);
  try {
    await assert.rejects(client.getSettings(MAC), (err) => err.code === 'offline');
  } finally {
    client.destroy();
    await mod.close();
  }
});

test('an invalid MAC address is refused before anything is sent', () => {
  const client = quick('127.0.0.1:1');
  try {
    assert.throws(() => client.getSettings('../../x'), TypeError);
  } finally {
    client.destroy();
  }
});

test('maps the documented answers to values', () => {
  const s = parseConnect(SETTINGS, MEASUREMENTS);
  assert.strictEqual(s.online, true);
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.current, 16);
  assert.strictEqual(s.maxCurrent, 32);
  assert.strictEqual(s.energyLimitKwh, null, 'not limited');
  assert.strictEqual(s.powerW, 3680);
  assert.strictEqual(s.charging, true);
  assert.strictEqual(s.totalKwh, 862.448);
  assert.strictEqual(s.sessionKwh, 2.154);
  assert.deepStrictEqual(s.phases[0], { powerW: 3680, current: 15.97, voltage: 231.2 });
  assert.strictEqual(s.activePhases, 1);
  assert.deepStrictEqual(s.errors, []);
  assert.strictEqual(s.firmware, '1 / 1');

  const limited = parseConnect({
    ...SETTINGS,
    Info: { ErrorCodes: ['0', '17'], Connected: true },
    Values: { ...SETTINGS.Values, ChargingEnergy: { Value: 20, Limited: true } },
  }, { ...MEASUREMENTS, VoltagePhase: [231, 230, 229], ChargingPower: 0.01 });
  assert.strictEqual(limited.energyLimitKwh, 20);
  assert.deepStrictEqual(limited.errors, [17]);
  assert.strictEqual(limited.activePhases, 3);
  assert.strictEqual(limited.charging, false, 'idle noise is not charging');

  assert.strictEqual(parseConnect({ ...SETTINGS, Info: { Connected: false } }, MEASUREMENTS).online, false);
  assert.strictEqual(parseConnect({}, {}).powerW, null);
});

test('charging state: the Connect API cannot see an unplugged car', () => {
  assert.strictEqual(connectChargingState({ charging: true, enabled: true }), 'plugged_in_charging');
  assert.strictEqual(connectChargingState({ charging: false, enabled: false }), 'plugged_in_paused');
  assert.strictEqual(connectChargingState({ charging: false, enabled: true }), 'plugged_in');
});

test('parses the documented DEVICE discovery answer', () => {
  const text = '** DEVICE **\r\nDEVICE: NRGkick Gateway\r\nVERSION: 1.0\r\nMAC: B8:27:EB:EB:E9:EF\r\n'
    + 'IP: 192.0.2.84\r\nNRGNAME: NRGkick_eGolf_30A0\r\nNRGMAC: 00:1E:C0:59:30:A0\r\nPID: B827EBEBE9EF-921352\r\nNRGOFFLINE: true\r\n';
  assert.deepStrictEqual(parseDeviceMessage(text), {
    ip: '192.0.2.84', mac: 'B8:27:EB:EB:E9:EF', nrgName: 'NRGkick_eGolf_30A0', nrgMac: '00:1E:C0:59:30:A0', online: true,
  });
  assert.strictEqual(parseDeviceMessage('** WHERE IS **\r\nIP: 192.0.2.4\r\n'), null);
  assert.strictEqual(parseDeviceMessage('** DEVICE **\r\nMAC: x\r\n'), null, 'no IP');
});

test('discovery asks, collects the answers (sent three times) once, and closes', async () => {
  const responder = dgram.createSocket('udp4');
  const questions = [];
  responder.on('message', (message, remote) => {
    questions.push(message.toString());
    const answer = Buffer.from('** DEVICE **\r\nDEVICE: NRGkick Gateway\r\nMAC: B8:27:EB:EB:E9:EF\r\nIP: 192.0.2.84\r\nNRGNAME: Garage\r\n');
    for (let i = 0; i < 3; i++) responder.send(answer, remote.port, remote.address);
  });
  await new Promise((resolve) => responder.bind(0, '127.0.0.1', resolve));
  try {
    const modules = await discoverConnectModules({
      timer: (fn, ms) => setTimeout(fn, Math.min(ms, 300)), group: '127.0.0.1', port: responder.address().port, timeoutMs: 300,
    });
    assert.deepStrictEqual(modules.map((mod) => [mod.ip, mod.nrgName]), [['192.0.2.84', 'Garage']]);
    assert.ok(questions.length >= 1 && questions[0].startsWith('** WHERE IS **\r\n'));
  } finally {
    responder.close();
  }
});
