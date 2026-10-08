'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ble = require('../lib/gen1Ble');

// Buffers built with the layout from evcc (big-endian), with values a charging unit would report.
function infoBuffer({
  current = 16, errorCode = 0, active = 1, paused = 0, max = 32,
} = {}) {
  const b = Buffer.alloc(13);
  b.writeUInt8(current, 0);
  b.writeUInt16BE(155, 1); // kWh per 100 km × 10
  b.writeUInt8(19, 3);
  b.writeUInt8(errorCode, 4);
  b.writeUInt8(95, 5);
  b.writeUInt8(active, 6);
  b.writeUInt8(paused, 7);
  b.writeUInt8(max, 8);
  b.writeInt8(4, 9);
  return b;
}

function energyBuffer({ total = 862448, last = 2154, limit = ble.NO_ENERGY_LIMIT } = {}) {
  const b = Buffer.alloc(19);
  b.writeUInt32BE(total, 0);
  b.writeUInt32BE(last, 4);
  b.writeUInt16BE(limit, 16);
  return b;
}

function powerBuffer({ total = 368, cp = 2, temperature = 24 } = {}) {
  const b = Buffer.alloc(19);
  b.writeUInt16BE(total, 0);
  b.writeUInt16BE(total, 2);
  b.writeUInt16BE(0, 4);
  b.writeUInt16BE(0, 6);
  b.writeUInt16BE(370, 8);
  b.writeUInt16BE(4998, 10);
  b.writeInt16BE(temperature, 12);
  b.writeInt8(cp, 18);
  return b;
}

function voltageCurrentBuffer() {
  const b = Buffer.alloc(14);
  b.writeUInt16BE(2312, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(0, 4);
  b.writeUInt16BE(1597, 6);
  return b;
}

test('decodes the info characteristic', () => {
  assert.deepStrictEqual(ble.decodeInfo(infoBuffer({ paused: 1, errorCode: 3 })), {
    current: 16, errorCode: 3, chargingActive: true, paused: true, maxCurrent: 32,
  });
});

test('decodes energy, with the "no limit" value as null', () => {
  assert.deepStrictEqual(ble.decodeEnergy(energyBuffer()), { totalWh: 862448, lastChargeWh: 2154, limitKwh: null });
  assert.strictEqual(ble.decodeEnergy(energyBuffer({ limit: 1050 })).limitKwh, 10.5);
});

test('decodes power in 10 W steps and the car state from the CP signal', () => {
  const p = ble.decodePower(powerBuffer());
  assert.strictEqual(p.totalW, 3680);
  assert.strictEqual(p.peakW, 3700);
  assert.strictEqual(p.frequency, 49.98);
  assert.strictEqual(p.temperature, 24);
  assert.strictEqual(p.status, 'charging');
  assert.strictEqual(ble.decodePower(powerBuffer({ cp: 3 })).status, 'connected');
  assert.strictEqual(ble.decodePower(powerBuffer({ cp: 4 })).status, 'standby');
  assert.strictEqual(ble.decodePower(powerBuffer({ cp: 9 })).status, 'unknown');
  assert.strictEqual(ble.decodePower(powerBuffer({ temperature: -5 })).temperature, -5);
});

test('decodes voltage and current per phase', () => {
  assert.deepStrictEqual(ble.decodeVoltageCurrent(voltageCurrentBuffer()), {
    voltage: [231.2, 0, 0], current: [15.97, 0, 0],
  });
});

test('a short answer is reported, not misread', () => {
  assert.throws(() => ble.decodePower(Buffer.alloc(5)), (err) => err.code === 'invalid_response' && /power/.test(err.message));
  assert.throws(() => ble.decodeInfo(null), (err) => err.code === 'invalid_response');
});

test('recognises NRGkick advertisements by name or address', () => {
  assert.ok(ble.looksLikeNrgkick({ localName: 'NRGkick_eGolf_30A0', address: 'aa:bb:cc:dd:ee:ff' }));
  assert.ok(ble.looksLikeNrgkick({ localName: '', address: '00:1e:c0:59:30:a0' }));
  assert.ok(!ble.looksLikeNrgkick({ localName: 'Speaker', address: '11:22:33:44:55:66' }));
  assert.ok(!ble.looksLikeNrgkick({ localName: 'Other product', address: '00:1e:c0:11:22:33' }), 'a named device is judged by its name');
  assert.ok(!ble.looksLikeNrgkick(null));
});

// ---- Reader against a fake Homey Bluetooth stack ----
function fakeBle({ missing = null, failOn = null } = {}) {
  const calls = {
    connects: 0, disconnects: 0, discovers: 0, reads: [],
  };
  const values = {
    [ble.CHARACTERISTICS.info]: infoBuffer(),
    [ble.CHARACTERISTICS.energy]: energyBuffer(),
    [ble.CHARACTERISTICS.power]: powerBuffer(),
    [ble.CHARACTERISTICS.voltageCurrent]: voltageCurrentBuffer(),
  };
  const dashed = (u) => `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`.toUpperCase();
  const peripheral = {
    async discoverAllServicesAndCharacteristics() {
      calls.discovers++;
      return [
        { uuid: 'svc-a', characteristics: [{ uuid: dashed(ble.CHARACTERISTICS.info) }, { uuid: ble.CHARACTERISTICS.settings }] },
        {
          uuid: 'svc-b',
          characteristics: Object.values(ble.CHARACTERISTICS)
            .filter((u) => u !== ble.CHARACTERISTICS.info && u !== missing)
            .map((uuid) => ({ uuid })),
        },
      ];
    },
    async read(service, uuid) {
      calls.reads.push([service, uuid]);
      if (uuid === failOn) throw new Error('GATT read failed');
      return values[uuid];
    },
    async disconnect() {
      calls.disconnects++;
    },
  };
  return {
    calls,
    api: {
      async find(uuid) {
        assert.strictEqual(uuid, 'peripheral-1');
        return {
          async connect() {
            calls.connects++;
            return peripheral;
          },
        };
      },
    },
  };
}

test('reads all values in one connection and disconnects', async () => {
  const fake = fakeBle();
  const reader = new ble.Gen1BleReader({ ble: fake.api, peripheralUuid: 'peripheral-1' });
  const data = await reader.read();
  assert.strictEqual(data.power.totalW, 3680);
  assert.strictEqual(data.energy.totalWh, 862448);
  assert.strictEqual(data.raw.info, infoBuffer().toString('hex'));
  assert.strictEqual(fake.calls.connects, 1);
  assert.strictEqual(fake.calls.disconnects, 1);
  assert.strictEqual(reader.services[ble.CHARACTERISTICS.info], 'svc-a', 'dashed upper-case UUIDs are matched');
  assert.ok(!fake.calls.reads.some(([, uuid]) => uuid === ble.CHARACTERISTICS.settings), 'settings are never read');

  await reader.read();
  assert.strictEqual(fake.calls.discovers, 1, 'services are looked up once');
});

test('disconnects also when a read fails, and reports a missing characteristic', async () => {
  const failing = fakeBle({ failOn: ble.CHARACTERISTICS.power });
  await assert.rejects(new ble.Gen1BleReader({ ble: failing.api, peripheralUuid: 'peripheral-1' }).read(), /GATT/);
  assert.strictEqual(failing.calls.disconnects, 1);

  const missing = fakeBle({ missing: ble.CHARACTERISTICS.energy });
  await assert.rejects(
    new ble.Gen1BleReader({ ble: missing.api, peripheralUuid: 'peripheral-1' }).read(),
    (err) => err.code === 'ble' && /energy/.test(err.message),
  );
  assert.strictEqual(missing.calls.disconnects, 1);
});
