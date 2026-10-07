'use strict';

const http = require('http');
const NrgkickError = require('./NrgkickError');

// The largest response (/info or /values) is about 1.5 KB. 64 KB leaves room for firmware growth and still
// stops a misbehaving host from filling the heap.
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const API_DISABLED_TEXT = 'API must be enabled';

const CONTROL_KEYS = new Set(['current_set', 'charge_pause', 'energy_limit', 'phase_count']);

/**
 * Accepts `host`, `host:port`, `http://host[:port][/path]` or `[v6]:port` and returns `{ hostname, port }`.
 */
function parseHost(input) {
  let value = String(input || '').trim();
  value = value.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (!value) throw new NrgkickError('connection', 'No host given');

  const v6 = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { hostname: v6[1], port: v6[2] ? Number(v6[2]) : 80 };

  const parts = value.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return { hostname: parts[0], port: Number(parts[1]) };
  if (parts.length > 2) return { hostname: value, port: 80 }; // bare IPv6 without brackets
  return { hostname: value, port: 80 };
}

function toNrgkickError(err) {
  if (err instanceof NrgkickError) return err;
  return new NrgkickError('connection', err.message || 'Connection failed');
}

/** Turns a status code and body into data, or throws the matching NrgkickError. */
function interpret(status, text) {
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    body = null;
  }

  if (status === 401 || status === 403) {
    throw new NrgkickError('auth', 'Authentication failed', { status });
  }

  const reason = body && typeof body === 'object' && typeof body.Response === 'string' ? body.Response : null;
  if (reason !== null) {
    if (reason.includes(API_DISABLED_TEXT)) throw new NrgkickError('api_disabled', reason, { status, reason });
    throw new NrgkickError('rejected', reason, { status, reason });
  }

  if (status >= 400) throw new NrgkickError('http', `HTTP ${status}`, { status });
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new NrgkickError('invalid_response', 'The device did not answer with a JSON object', { status });
  }
  return body;
}

/**
 * Minimal client for the NRGkick Gen2 local JSON API (GET /info, /values, /control).
 * One client per device; it keeps at most one idle socket to its host.
 */
class NrgkickClient {

  /**
   * @param {object} options
   * @param {string} options.host
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {(ms: number) => Promise<void>} [options.sleep] waits between retries; the app passes a Homey timer
   * @param {number} [options.timeout] per-attempt timeout in ms
   */
  constructor({
    host, username, password, sleep, timeout = REQUEST_TIMEOUT_MS,
  }) {
    this.agent = new http.Agent({
      keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 30000,
    });
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))); // eslint-disable-line homey-app/global-timers
    this.timeout = timeout;
    this.configure({ host, username, password });
  }

  configure({ host, username, password }) {
    const { hostname, port } = parseHost(host);
    this.hostname = hostname;
    this.port = port;
    this.auth = username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : null;
  }

  destroy() {
    this.agent.destroy();
  }

  /** Static device info: general, connector, grid, network, versions (+ cellular/gps on SIM models). */
  getInfo() {
    return this._request('/info', { raw: 1 });
  }

  /** Live values: energy, powerflow, general, temperatures. */
  getValues() {
    return this._request('/values', { raw: 1 });
  }

  /** User settings: current_set, charge_pause, energy_limit, phase_count. */
  getControl() {
    return this._request('/control');
  }

  /**
   * Writes one control value and returns the value the device echoes back (it may clamp it).
   * @param {'current_set'|'charge_pause'|'energy_limit'|'phase_count'} key
   * @param {number} value
   */
  async setControl(key, value) {
    if (!CONTROL_KEYS.has(key)) throw new TypeError(`Unknown control key ${key}`);
    if (!Number.isFinite(value)) throw new TypeError(`Invalid value for ${key}`);
    const formatted = key === 'current_set' ? String(Math.round(value * 10) / 10) : String(Math.round(value));
    const body = await this._request('/control', { [key]: formatted });
    const echoed = Number(body[key]);
    if (!(key in body) || !Number.isFinite(echoed)) {
      throw new NrgkickError('invalid_response', `The device did not confirm ${key}`);
    }
    return echoed;
  }

  async _request(path, params = {}) {
    const query = new URLSearchParams(params).toString();
    const fullPath = query ? `${path}?${query}` : path;
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this._attempt(fullPath);
      } catch (err) {
        lastError = err;
        const retryable = err.code === 'timeout' || err.code === 'connection'
          || (err.code === 'http' && RETRY_STATUSES.has(err.status));
        if (!retryable || attempt === MAX_ATTEMPTS - 1) break;
        await this.sleep(1000 * 1.5 ** attempt);
      }
    }
    if (lastError.code === 'http') {
      throw new NrgkickError('connection', `HTTP ${lastError.status}`, { status: lastError.status });
    }
    throw lastError;
  }

  _attempt(path) {
    return new Promise((resolve, reject) => {
      const headers = { Accept: 'application/json' };
      if (this.auth) headers.Authorization = this.auth;

      const req = http.get({
        hostname: this.hostname, port: this.port, path, headers, agent: this.agent, timeout: this.timeout,
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
            resolve(interpret(res.statusCode, Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('timeout', () => req.destroy(new NrgkickError('timeout', 'The NRGkick did not answer in time')));
      req.on('error', (err) => reject(toNrgkickError(err)));
    });
  }

}

module.exports = {
  NrgkickClient, NrgkickError, parseHost, interpret,
};
