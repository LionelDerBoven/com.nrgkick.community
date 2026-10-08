'use strict';

// NRGkick first generation over Bluetooth Low Energy.
//
// The characteristic UUIDs and the byte layout come from evcc (MIT licence, charger/nrg/ble, credits in the
// README). No first-generation unit was available while writing this: it is read-only and experimental, and the
// device logs the raw bytes when "debug logging" is on, so testers can send them in to verify the layout.
// Values are big-endian, as in evcc.

const CHARACTERISTICS = {
  info: '8f75bba0c90311e49fe80002a5d6b15d',
  energy: '0379e580ad1b11e48bdd0002a5d6b15d',
  power: 'fd005380b06511e49ce20002a5d6b15d',
  voltageCurrent: '171bad00b06611e4aeda0002a5d6b15d',
  settings: '14b3afc0ad1b11e4baab0002a5d6b15d',
};

// The energy limit reads this value when no limit is set (evcc writes it to turn the limit off).
const NO_ENERGY_LIMIT = 19997;

// Control pilot signal: the IEC 61851 state of the car.
const CP_STATUS = { 4: 'standby', 3: 'connected', 2: 'charging' };

const BLE_ERROR = 'ble';

/** Lower case without dashes, the form Homey uses for UUIDs. */
function normalizeUuid(uuid) {
  return String(uuid || '').replace(/-/g, '').toLowerCase();
}

function need(buffer, length, name) {
  if (!Buffer.isBuffer(buffer) || buffer.length < length) {
    const got = Buffer.isBuffer(buffer) ? buffer.length : 0;
    const err = new Error(`${name}: expected ${length} bytes, got ${got}`);
    err.code = 'invalid_response';
    throw err;
  }
}

/** Settings and state: current, pause flag, maximum current, error code. */
function decodeInfo(b) {
  need(b, 11, 'info');
  return {
    current: b.readUInt8(0),
    errorCode: b.readUInt8(4),
    chargingActive: b.readUInt8(6) === 1,
    paused: b.readUInt8(7) === 1,
    maxCurrent: b.readUInt8(8),
  };
}

/** Energy in Wh; the limit in kWh, or null when no limit is set. */
function decodeEnergy(b) {
  need(b, 18, 'energy');
  const limit = b.readUInt16BE(16);
  return {
    totalWh: b.readUInt32BE(0),
    lastChargeWh: b.readUInt32BE(4),
    limitKwh: limit === NO_ENERGY_LIMIT || limit === 0 ? null : limit / 100,
  };
}

/** Power in W (sent in 10 W steps), frequency in Hz, housing temperature in °C and the car's state. */
function decodePower(b) {
  need(b, 19, 'power');
  const cp = b.readInt8(18);
  return {
    totalW: b.readUInt16BE(0) * 10,
    l1W: b.readUInt16BE(2) * 10,
    l2W: b.readUInt16BE(4) * 10,
    l3W: b.readUInt16BE(6) * 10,
    peakW: b.readUInt16BE(8) * 10,
    frequency: b.readUInt16BE(10) / 100,
    temperature: b.readInt16BE(12),
    cpSignal: cp,
    status: CP_STATUS[cp] || 'unknown',
  };
}

/** Voltage (V) and current (A) per phase. */
function decodeVoltageCurrent(b) {
  need(b, 12, 'voltage/current');
  return {
    voltage: [b.readUInt16BE(0) / 10, b.readUInt16BE(2) / 10, b.readUInt16BE(4) / 10],
    current: [b.readUInt16BE(6) / 100, b.readUInt16BE(8) / 100, b.readUInt16BE(10) / 100],
  };
}

/** True for an advertisement that looks like a first-generation NRGkick. */
function looksLikeNrgkick(advertisement) {
  const name = String((advertisement && advertisement.localName) || '');
  const address = String((advertisement && advertisement.address) || '').toLowerCase();
  if (name) return /nrgkick/i.test(name);
  // Without a name, fall back to the address range of the units in the vendor documentation (00:1e:c0, the
  // Bluetooth module's maker). Other products with that module and no name could show up too; the list only
  // offers them, the user picks.
  return address.startsWith('00:1e:c0');
}

/**
 * Reads all four characteristics in one Bluetooth connection and disconnects again, so the NRGkick stays
 * free for the phone app between reads. The service of each characteristic is looked up once and remembered.
 */
class Gen1BleReader {

  /**
   * @param {object} options
   * @param {object} options.ble `homey.ble`
   * @param {string} options.peripheralUuid
   * @param {Object<string,string>} [options.services] characteristic UUID → service UUID, from an earlier read
   */
  constructor({ ble, peripheralUuid, services = null }) {
    this.ble = ble;
    this.peripheralUuid = peripheralUuid;
    this.services = services;
  }

  /** Returns `{ info, energy, power, voltageCurrent, raw }`; `raw` holds the bytes as hex for debugging. */
  async read() {
    const advertisement = await this.ble.find(this.peripheralUuid);
    const peripheral = await advertisement.connect();
    try {
      if (!this.services) this.services = await this.mapServices(peripheral);
      const raw = {};
      for (const [name, uuid] of Object.entries(CHARACTERISTICS)) {
        if (name === 'settings') continue;
        const service = this.services[uuid];
        if (!service) {
          const err = new Error(`Characteristic ${name} not found on this device`);
          err.code = BLE_ERROR;
          throw err;
        }
        raw[name] = await peripheral.read(service, uuid);
      }
      return {
        info: decodeInfo(raw.info),
        energy: decodeEnergy(raw.energy),
        power: decodePower(raw.power),
        voltageCurrent: decodeVoltageCurrent(raw.voltageCurrent),
        raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.toString('hex')])),
      };
    } finally {
      await peripheral.disconnect().catch(() => {});
    }
  }

  async mapServices(peripheral) {
    const wanted = new Set(Object.values(CHARACTERISTICS));
    const map = {};
    for (const service of await peripheral.discoverAllServicesAndCharacteristics()) {
      for (const characteristic of service.characteristics || []) {
        const uuid = normalizeUuid(characteristic.uuid);
        if (wanted.has(uuid)) map[uuid] = service.uuid;
      }
    }
    return map;
  }

}

module.exports = {
  CHARACTERISTICS,
  NO_ENERGY_LIMIT,
  normalizeUuid,
  decodeInfo,
  decodeEnergy,
  decodePower,
  decodeVoltageCurrent,
  looksLikeNrgkick,
  Gen1BleReader,
};
