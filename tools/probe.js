'use strict';

// Development tool: reads /info, /control and /values from a real NRGkick with the app's own client and prints
// them with identifiers masked. Settings come from .env (see .env.example). Read-only: it never writes.
//
//   node tools/probe.js            all three endpoints
//   node tools/probe.js values     one endpoint

const fs = require('fs');
const path = require('path');
const { NrgkickClient } = require('../lib/NrgkickClient');

const MASKED = new Set(['serial_number', 'serial', 'device_name', 'ip_address', 'mac_address', 'ssid', 'imei', 'imsi',
  'latitude', 'longitude']);

function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) throw new Error('Create .env first (see .env.example)');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function mask(value) {
  if (Array.isArray(value)) return value.map(mask);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, MASKED.has(k.replace(/:$/, '')) ? '***' : mask(v)]));
}

async function main() {
  const env = loadEnv();
  const client = new NrgkickClient({
    host: env.NRGKICK_HOST, username: env.NRGKICK_USERNAME, password: env.NRGKICK_PASSWORD,
  });
  const wanted = process.argv[2];
  const calls = { info: () => client.getInfo(), control: () => client.getControl(), values: () => client.getValues() };
  try {
    for (const [name, call] of Object.entries(calls)) {
      if (wanted && wanted !== name) continue;
      const started = Date.now();
      try {
        const body = await call();
        console.log(`== ${name} (${Date.now() - started} ms)`);
        console.log(JSON.stringify(mask(body), null, 2));
      } catch (err) {
        console.log(`== ${name} FAILED: ${err.code} ${err.message}`);
      }
    }
  } finally {
    client.destroy();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
