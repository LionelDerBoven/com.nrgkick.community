'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { NrgkickClient, NrgkickError, parseHost } = require('../lib/NrgkickClient');

/** Starts a fake NRGkick. `handler(req, url)` returns `{ status, body }` (body as object or raw string). */
async function fakeDevice(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const { status = 200, body = {} } = handler(req, url, requests.length) || {};
    if (body === null) {
      req.socket.destroy();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    host: `127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

const noSleep = () => Promise.resolve();

test('parseHost accepts the usual spellings', () => {
  assert.deepStrictEqual(parseHost('192.0.2.5'), { hostname: '192.0.2.5', port: 80 });
  assert.deepStrictEqual(parseHost(' http://192.0.2.5:8080/info '), { hostname: '192.0.2.5', port: 8080 });
  assert.deepStrictEqual(parseHost('charger.example'), { hostname: 'charger.example', port: 80 });
  assert.deepStrictEqual(parseHost('[fe80::1]:81'), { hostname: 'fe80::1', port: 81 });
  assert.throws(() => parseHost(''), NrgkickError);
});

test('reads use raw mode and send basic auth when configured', async () => {
  const dev = await fakeDevice(() => ({ body: { general: { status: 1 } } }));
  const client = new NrgkickClient({
    host: dev.host, username: 'user', password: 'secret', sleep: noSleep,
  });
  try {
    const values = await client.getValues();
    assert.deepStrictEqual(values, { general: { status: 1 } });
    assert.strictEqual(dev.requests[0].path, '/values');
    assert.deepStrictEqual(dev.requests[0].query, { raw: '1' });
    assert.strictEqual(dev.requests[0].auth, `Basic ${Buffer.from('user:secret').toString('base64')}`);
    await client.getControl();
    assert.deepStrictEqual(dev.requests[1].query, {});
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('no auth header without credentials', async () => {
  const dev = await fakeDevice(() => ({ body: {} }));
  const client = new NrgkickClient({ host: dev.host, username: 'user', sleep: noSleep });
  try {
    await client.getInfo();
    assert.strictEqual(dev.requests[0].auth, undefined);
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('401 is an auth error and is not retried', async () => {
  const dev = await fakeDevice(() => ({ status: 401, body: { Response: '401 Unauthorized' } }));
  const client = new NrgkickClient({ host: dev.host, sleep: noSleep });
  try {
    await assert.rejects(client.getInfo(), (err) => err.code === 'auth' && err.status === 401);
    assert.strictEqual(dev.requests.length, 1);
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('disabled JSON API is reported as api_disabled', async () => {
  const dev = await fakeDevice(() => ({ body: { Response: 'API must be enabled within the NRGkick App' } }));
  const client = new NrgkickClient({ host: dev.host, sleep: noSleep });
  try {
    await assert.rejects(client.getValues(), (err) => err.code === 'api_disabled');
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('a refused command carries the device reason, on 200 and on 406', async () => {
  const reason = 'Charging pause is blocked by solar-charging';
  let status = 200;
  const dev = await fakeDevice(() => ({ status, body: { Response: reason } }));
  const client = new NrgkickClient({ host: dev.host, sleep: noSleep });
  try {
    await assert.rejects(client.setControl('charge_pause', 1), (err) => err.code === 'rejected' && err.reason === reason);
    status = 406;
    await assert.rejects(client.setControl('phase_count', 1), (err) => err.code === 'rejected' && err.status === 406);
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('setControl formats the value and returns the echo', async () => {
  const dev = await fakeDevice((req, url) => {
    const [key, value] = [...url.searchParams.entries()][0];
    return { body: { [key]: key === 'current_set' ? Math.min(Number(value), 16) : Number(value) } };
  });
  const client = new NrgkickClient({ host: dev.host, sleep: noSleep });
  try {
    assert.strictEqual(await client.setControl('current_set', 10.04), 10);
    assert.deepStrictEqual(dev.requests[0].query, { current_set: '10' });
    assert.strictEqual(await client.setControl('current_set', 20), 16, 'returns the clamped echo');
    assert.strictEqual(await client.setControl('energy_limit', 5000.4), 5000);
    assert.deepStrictEqual(dev.requests[2].query, { energy_limit: '5000' });
    assert.strictEqual(await client.setControl('charge_pause', 1), 1);
    await assert.rejects(client.setControl('unknown_key', 1), TypeError);
    await assert.rejects(client.setControl('phase_count', NaN), TypeError);
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('a missing echo is an invalid response', async () => {
  const dev = await fakeDevice(() => ({ body: { other: 1 } }));
  const client = new NrgkickClient({ host: dev.host, sleep: noSleep });
  try {
    await assert.rejects(client.setControl('current_set', 8), (err) => err.code === 'invalid_response');
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('5xx and dropped connections are retried, then succeed', async () => {
  const dev = await fakeDevice((req, url, n) => {
    if (n === 1) return { status: 503, body: 'busy' };
    if (n === 2) return { body: null }; // connection dropped
    return { body: { ok: 1 } };
  });
  const waits = [];
  const sleep = (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
  const client = new NrgkickClient({ host: dev.host, sleep });
  try {
    assert.deepStrictEqual(await client.getInfo(), { ok: 1 });
    assert.strictEqual(dev.requests.length, 3);
    assert.deepStrictEqual(waits, [1000, 1500]);
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('gives up after three attempts', async () => {
  const dev = await fakeDevice(() => ({ status: 500, body: 'oops' }));
  const client = new NrgkickClient({ host: dev.host, sleep: noSleep });
  try {
    await assert.rejects(client.getInfo(), (err) => err.code === 'connection' && err.status === 500);
    assert.strictEqual(dev.requests.length, 3);
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('non-JSON and oversized bodies are rejected', async () => {
  let body = '<html>not json</html>';
  const dev = await fakeDevice(() => ({ body }));
  const client = new NrgkickClient({ host: dev.host, sleep: noSleep });
  try {
    await assert.rejects(client.getInfo(), (err) => err.code === 'invalid_response');
    body = JSON.stringify({ big: 'x'.repeat(100 * 1024) });
    await assert.rejects(client.getInfo(), (err) => err.code === 'invalid_response');
  } finally {
    client.destroy();
    await dev.close();
  }
});

test('an unreachable host is a connection error', async () => {
  const client = new NrgkickClient({ host: '127.0.0.1:1', sleep: noSleep, timeout: 500 });
  try {
    await assert.rejects(client.getInfo(), (err) => err.code === 'connection');
  } finally {
    client.destroy();
  }
});

test('a silent host times out', async () => {
  const server = http.createServer(() => {}); // never answers
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new NrgkickClient({ host: `127.0.0.1:${server.address().port}`, sleep: noSleep, timeout: 200 });
  try {
    await assert.rejects(client.getInfo(), (err) => err.code === 'timeout');
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
