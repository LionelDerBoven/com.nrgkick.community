'use strict';

const http = require('http');
const NrgkickError = require('./NrgkickError');
const { parseHost } = require('./NrgkickClient');

// Client for the NRGkick Connect module: the WiFi bridge sold for first-generation NRGkicks. It follows DiniTech's
// "NRGkick Connect – JSON WEB API" (version 0.2, 2019): GET /api/devices, GET /api/measurements/<mac>,
// GET and PUT /api/settings/<mac>, where <mac> is the NRGkick's Bluetooth address. No authentication; a change
// must carry the NRGkick's Bluetooth PIN as DeviceMetadata.Password.

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

function toNrgkickError(err) {
  if (err instanceof NrgkickError) return err;
  return new NrgkickError('connection', err.message || 'Connection failed');
}

/** Turns a status code and body into data, or throws the matching NrgkickError. */
function interpretConnect(status, text) {
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    body = null;
  }
  const message = body && typeof body === 'object' && !Array.isArray(body) && typeof body.Message === 'string' ? body.Message : null;
  if (status === 204) throw new NrgkickError('offline', 'The NRGkick is not connected to the Connect module', { status });
  if (message && status >= 400) throw new NrgkickError('rejected', message, { status, reason: message });
  if (status >= 400) throw new NrgkickError('http', `HTTP ${status}`, { status });
  if (status === 202) return body || {};
  if (!body || typeof body !== 'object') {
    throw new NrgkickError('invalid_response', 'The Connect module did not answer with JSON', { status });
  }
  return body;
}

class ConnectClient {

  /**
   * @param {object} options
   * @param {string} options.host address of the Connect module
   * @param {(ms: number) => Promise<void>} [options.sleep] waits between retries; the app passes a Homey timer
   * @param {number} [options.timeout] per-attempt timeout in ms
   */
  constructor({ host, sleep, timeout = REQUEST_TIMEOUT_MS }) {
    this.agent = new http.Agent({
      keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 30000,
    });
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))); // eslint-disable-line homey-app/global-timers
    this.timeout = timeout;
    this.configure({ host });
  }

  configure({ host }) {
    const { hostname, port } = parseHost(host);
    this.hostname = hostname;
    this.port = port;
  }

  destroy() {
    this.agent.destroy();
  }

  /** NRGkicks the Connect module knows: `[{ MacAddress, Online, Timestamp }]`. */
  async getDevices() {
    const body = await this._request('GET', '/api/devices');
    if (!Array.isArray(body)) throw new NrgkickError('invalid_response', 'Expected a list of devices');
    return body.filter((d) => d && MAC.test(String(d.MacAddress || '')));
  }

  getMeasurements(mac) {
    return this._request('GET', `/api/measurements/${ConnectClient.mac(mac)}`);
  }

  getSettings(mac) {
    return this._request('GET', `/api/settings/${ConnectClient.mac(mac)}`);
  }

  /**
   * Changes settings in one request: the module drops requests that arrive back to back (seen by evcc).
   * @param {string} mac
   * @param {string} password the NRGkick's Bluetooth PIN
   * @param {{charging?: boolean, current?: number, energyLimit?: number|null}} change energyLimit in kWh, null for none
   */
  putSettings(mac, password, { charging, current, energyLimit }) {
    const values = { DeviceMetadata: { Password: String(password || '') } };
    if (charging !== undefined) values.ChargingStatus = { Charging: Boolean(charging) };
    if (current !== undefined) values.ChargingCurrent = { Value: Math.round(current) };
    if (energyLimit !== undefined) {
      values.ChargingEnergy = energyLimit === null ? { Limited: false } : { Value: energyLimit, Limited: true };
    }
    return this._request('PUT', `/api/settings/${ConnectClient.mac(mac)}`, { Values: values });
  }

  static mac(mac) {
    const value = String(mac || '').toUpperCase();
    if (!MAC.test(value)) throw new TypeError('Invalid MAC address');
    return value;
  }

  async _request(method, path, body) {
    let lastError;
    // A change is sent once: repeating it could apply it twice after a lost answer.
    const attempts = method === 'GET' ? MAX_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this._attempt(method, path, body);
      } catch (err) {
        lastError = err;
        const retryable = err.code === 'timeout' || err.code === 'connection';
        if (!retryable || attempt === attempts - 1) break;
        await this.sleep(1000 * 1.5 ** attempt);
      }
    }
    if (lastError.code === 'http') {
      throw new NrgkickError('connection', `HTTP ${lastError.status}`, { status: lastError.status });
    }
    throw lastError;
  }

  _attempt(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = { Accept: 'application/json' };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      const req = http.request({
        method, hostname: this.hostname, port: this.port, path, headers, agent: this.agent, timeout: this.timeout,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new NrgkickError('invalid_response', 'Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (err) => reject(toNrgkickError(err)));
        res.on('end', () => {
          try {
            resolve(interpretConnect(res.statusCode, Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('timeout', () => req.destroy(new NrgkickError('timeout', 'The Connect module did not answer in time')));
      req.on('error', (err) => reject(toNrgkickError(err)));
      req.end(payload || undefined);
    });
  }

}

module.exports = { ConnectClient, interpretConnect };
