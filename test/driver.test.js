'use strict';

// Runs the pairing handlers of driver.js against a fake NRGkick, with a stubbed Homey SDK.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Module = require('module');
const path = require('path');

const stubPath = path.join(__dirname, 'homey-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'homey') return stubPath;
  return originalResolve.call(this, request, ...rest);
};
require.cache[stubPath] = {
  id: 'homey', filename: 'homey', loaded: true, exports: { Driver: class {}, Device: class {}, App: class {} },
};
const NrgkickDriver = require('../drivers/nrgkick/driver');

/** A fake NRGkick: `mode` is 'open', 'auth' (user/secret) or 'disabled'. */
async function fakeNrgkick(mode) {
  const server = http.createServer((req, res) => {
    const expected = `Basic ${Buffer.from('user:secret').toString('base64')}`;
    let status = 200;
    let body = { general: { serial_number: 'SERIAL1', device_name: 'Garage' } };
    if (mode === 'disabled') body = { Response: 'API must be enabled within the NRGkick App' };
    if (mode === 'auth' && req.headers.authorization !== expected) {
      status = 401;
      body = { Response: '401 Unauthorized' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

function makeDriver({ devices = [], results = {} } = {}) {
  const driver = new NrgkickDriver();
  driver.homey = {
    __: (key) => key,
    setTimeout: (fn) => setTimeout(fn, 0),
    discovery: { getStrategy: () => ({ getDiscoveryResults: () => results, on() {} }) },
  };
  driver.discovery = driver.homey.discovery.getStrategy();
  driver.getDevices = () => devices;
  driver.log = () => {};
  return driver;
}

async function pair(driver) {
  const handlers = {};
  await driver.onPair({ setHandler: (name, fn) => { handlers[name] = fn; } });
  return handlers;
}

test('discover lists announced NRGkicks that are not added, with or without a serial', async () => {
  const driver = makeDriver({
    devices: [{ getSetting: () => '192.0.2.9', getData: () => ({ id: 'OTHER' }) }],
    results: {
      a: { address: '192.0.2.10', txt: { model_type: 'NRGkick Gen2', json_api_enabled: '1' } },
      b: { address: '192.0.2.11', txt: { device_name: 'Garage', json_api_enabled: '0' } },
      c: { address: '192.0.2.9', txt: {} },
    },
  });
  const h = await pair(driver);
  assert.deepStrictEqual(await h.discover(), [
    { host: '192.0.2.10', name: 'NRGkick Gen2', apiEnabled: true },
    { host: '192.0.2.11', name: 'Garage', apiEnabled: false },
  ]);
});

test('an open NRGkick is added without asking for a login', async () => {
  const dev = await fakeNrgkick('open');
  try {
    const h = await pair(makeDriver());
    assert.deepStrictEqual(await h.probe({ host: dev.host }), { status: 'ok' });
    assert.deepStrictEqual(await h.pending_device(), {
      name: 'Garage', data: { id: 'SERIAL1' }, settings: { host: dev.host, username: '', password: '' },
    });
  } finally {
    await dev.close();
  }
});

test('a protected NRGkick asks for a login; wrong ones fail, right ones are kept', async () => {
  const dev = await fakeNrgkick('auth');
  try {
    const h = await pair(makeDriver());
    assert.deepStrictEqual(await h.probe({ host: dev.host }), { status: 'auth' });
    assert.strictEqual(await h.login({ username: 'user', password: 'wrong' }), false);
    assert.strictEqual(await h.login({ username: ' user ', password: 'secret' }), true);
    const device = await h.pending_device();
    assert.deepStrictEqual(device.settings, { host: dev.host, username: 'user', password: 'secret' });
  } finally {
    await dev.close();
  }
});

test('API off leads to the instructions; retry reuses the address', async () => {
  const dev = await fakeNrgkick('disabled');
  try {
    const h = await pair(makeDriver());
    assert.deepStrictEqual(await h.probe({ host: dev.host }), { status: 'api_disabled' });
    assert.deepStrictEqual(await h.probe({}), { status: 'api_disabled' });
  } finally {
    await dev.close();
  }
});

test('errors are translated: no address, unreachable, already added', async () => {
  const h = await pair(makeDriver());
  await assert.rejects(h.probe({ host: ' ' }), { message: 'errors.no_host' });
  await assert.rejects(h.pending_device(), { message: 'errors.no_host' });
  await assert.rejects(h.probe({ host: '127.0.0.1:1' }), { message: 'errors.connection' });

  const dev = await fakeNrgkick('open');
  try {
    const added = await pair(makeDriver({ devices: [{ getSetting: () => '', getData: () => ({ id: 'serial1' }) }] }));
    await assert.rejects(added.probe({ host: dev.host }), { message: 'errors.already_added' });
  } finally {
    await dev.close();
  }
});
