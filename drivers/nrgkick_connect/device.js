'use strict';

const Homey = require('homey');
const { ConnectClient } = require('../../lib/ConnectClient');
const { parseConnect, connectChargingState } = require('../../lib/connectMappings');
const describeError = require('../../lib/describeError');

const describe = (homey, err) => describeError(homey, err, { connect: true });
const m = require('../../lib/mappings');

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const AFTER_WRITE_MS = 3000;
const WRITE_GAP_MS = 1500; // the module drops a request that follows another too closely (seen by evcc)
const FAILURES_BEFORE_UNAVAILABLE = 2;
const RELOCATE_INTERVAL_MS = 5 * 60 * 1000; // at most one network search per 5 minutes
const VOLTAGE = 230; // the Connect API reports no nominal voltage

const round = (value, decimals) => {
  if (value === null || value === undefined) return value;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/**
 * A first-generation NRGkick behind an NRGkick Connect module. Experimental: written from DiniTech's Connect API
 * documentation and tested against a simulated module only.
 */
class NrgkickConnectDevice extends Homey.Device {

  async onInit() {
    this.state = null; // last parsed answer
    this.failures = 0;
    this.pollTimer = null;
    this.polling = false;
    this.pollSoon = false;
    this.stopped = false;
    this.writeQueue = Promise.resolve();
    this.targetPower = null;
    this.targetPaused = false;

    await this.ensureCapabilities();
    this.client = new ConnectClient({
      host: this.getSetting('host') || '0.0.0.0', sleep: (ms) => this.wait(ms),
    });

    this.registerCapabilityListener('nrgkick_current_set', (value) => this.write({ current: this.clampCurrent(value) }));
    this.registerCapabilityListener('nrgkick_energy_limit', (value) => this.write({ energyLimit: value > 0 ? value : null }));
    this.registerMultipleCapabilityListener(
      ['evcharger_charging', 'target_power', 'target_power_mode'],
      (changed) => this.onChargingControl(changed),
      500,
    );
    this.schedulePoll(0);
  }

  async onUninit() {
    this.stop();
  }

  async onDeleted() {
    this.stop();
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) this.homey.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.client) this.client.destroy();
  }

  wait(ms) {
    return new Promise((resolve) => this.homey.setTimeout(resolve, ms));
  }

  async ensureCapabilities() {
    const wanted = this.driver.manifest.capabilities;
    for (const cap of wanted) if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    for (const cap of this.getCapabilities()) if (!wanted.includes(cap)) await this.removeCapability(cap).catch(this.error);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('host')) {
      if (!String(newSettings.host || '').trim()) throw new Error(this.homey.__('errors.no_connect_host'));
      let test = null;
      try {
        test = new ConnectClient({ host: newSettings.host, sleep: (ms) => this.wait(ms) });
        await test.getSettings(this.getData().id);
      } catch (err) {
        throw new Error(describe(this.homey, err));
      } finally {
        if (test) test.destroy();
      }
      this.client.configure({ host: newSettings.host });
    }
    if (changedKeys.some((key) => ['host', 'poll_interval', 'password'].includes(key))) this.refreshSoon(1000);
  }

  /**
   * The module may have a new address (DHCP): ask the network for Connect modules and take the one that reports
   * this NRGkick. Its discovery answer names the NRGkick it is connected to (NRGMAC).
   */
  async relocate() {
    if (this.stopped || this.relocating || Date.now() - (this.relocatedAt || 0) < RELOCATE_INTERVAL_MS) return false;
    this.relocating = true;
    this.relocatedAt = Date.now();
    try {
      const mac = String(this.getData().id).toUpperCase();
      const found = (await this.driver.discoverModules()).find((mod) => String(mod.nrgMac).toUpperCase() === mac);
      if (!found || this.stopped || found.ip === this.getSetting('host')) return false;
      this.log('Connect module found at a new address');
      await this.setSettings({ host: found.ip });
      this.client.configure({ host: found.ip });
      this.refreshSoon(0);
      return true;
    } finally {
      this.relocating = false;
    }
  }

  // ---- Polling ----

  interval() {
    const seconds = Number(this.getSetting('poll_interval')) || 30;
    return Math.min(300, Math.max(10, seconds)) * 1000;
  }

  schedulePoll(delay) {
    if (this.stopped) return;
    if (this.pollTimer) this.homey.clearTimeout(this.pollTimer);
    this.pollTimer = this.homey.setTimeout(() => {
      this.pollTimer = null;
      this.poll().catch(this.error);
    }, delay);
  }

  refreshSoon(delay = AFTER_WRITE_MS) {
    if (this.polling) this.pollSoon = true;
    else this.schedulePoll(delay);
  }

  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    let next = this.interval();
    try {
      await this.refresh();
      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.failures++;
      next = Math.min(next * 2 ** Math.min(this.failures - 1, 4), MAX_BACKOFF_MS);
      this.log(`Poll failed (${this.failures}): ${err.code || ''} ${err.message}`);
      if (err.code === 'offline' || this.failures >= FAILURES_BEFORE_UNAVAILABLE) {
        await this.setUnavailable(describe(this.homey, err)).catch(this.error);
      }
      const unreachable = err.code === 'timeout' || err.code === 'connection';
      if (unreachable && this.failures >= FAILURES_BEFORE_UNAVAILABLE) this.relocate().catch(this.error);
    } finally {
      this.polling = false;
      if (this.pollSoon) {
        this.pollSoon = false;
        next = AFTER_WRITE_MS;
      }
      this.schedulePoll(next);
    }
  }

  async refresh() {
    const mac = this.getData().id;
    const settings = await this.client.getSettings(mac);
    const measurements = await this.client.getMeasurements(mac);
    if (this.getSetting('debug_logging')) {
      this.log('settings', JSON.stringify(settings));
      this.log('measurements', JSON.stringify(measurements));
    }
    const state = parseConnect(settings, measurements);
    if (!state.online) {
      const err = new Error('The NRGkick is not connected to the Connect module');
      err.code = 'offline';
      throw err;
    }
    await this.apply(state);
  }

  async set(capability, value) {
    if (value === undefined || value === null || !this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch((err) => this.error(capability, err.message));
  }

  async apply(state) {
    this.state = state;
    await this.updateLimits(state); // cheap when nothing changed: compares a stored key

    if (state.enabled !== null) await this.set('evcharger_charging', state.enabled);
    await this.set('evcharger_charging_state', connectChargingState(state));
    if (state.current !== null) await this.set('nrgkick_current_set', round(state.current, 1));
    await this.set('nrgkick_energy_limit', state.energyLimitKwh === null ? 0 : round(state.energyLimitKwh, 1));

    const live = (value) => (state.charging || value === null ? value : 0); // idle noise shows as 0
    await this.set('measure_power', live(state.powerW));
    await this.set('meter_power', round(state.totalKwh, 3));
    await this.set('meter_power.session', round(state.sessionKwh, 3));
    await this.set('measure_frequency', round(state.frequency, 2));
    await this.set('measure_temperature', round(state.temperature, 1));
    for (const [i, phase] of ['l1', 'l2', 'l3'].entries()) {
      const p = state.phases[i];
      await this.set(`measure_power.${phase}`, live(p.powerW));
      await this.set(`measure_current.${phase}`, live(round(p.current, 2)));
      await this.set(`measure_voltage.${phase}`, round(p.voltage, 1));
    }

    if (state.passwordMatch === false && this.getSetting('password')) {
      if (!this.pinWarning) await this.setWarning(this.homey.__('errors.connect_pin_wrong')).catch(this.error);
      this.pinWarning = true;
    } else if (this.pinWarning) {
      await this.unsetWarning().catch(this.error);
      this.pinWarning = false;
    }

    const fault = state.errors.length > 0;
    await this.set('alarm_generic', fault);
    await this.set('nrgkick_error', fault
      ? this.homey.__('gen1.error_codes', { codes: state.errors.join(', ') })
      : this.homey.__('none'));

    if (this.getCapabilityValue('target_power_mode') === null) await this.set('target_power_mode', 'device');
    if (this.getCapabilityValue('target_power') === null && state.current !== null) {
      await this.set('target_power', m.currentToWatts(state.current, { voltage: VOLTAGE, phases: state.activePhases }));
    }

    const labels = { info_mac: String(this.getData().id), info_firmware: state.firmware };
    const current = this.getSettings();
    const changed = Object.fromEntries(Object.entries(labels).filter(([key, value]) => current[key] !== value));
    if (Object.keys(changed).length) await this.setSettings(changed).catch(this.error);
  }

  maxCurrent() {
    const max = this.state && this.state.maxCurrent;
    return Number.isFinite(max) && max >= m.MIN_CURRENT ? max : 16;
  }

  /** Whole amperes between 6 A and the maximum: the Connect API takes the current as an integer. */
  clampCurrent(value) {
    return Math.min(this.maxCurrent(), Math.max(m.MIN_CURRENT, Math.floor(value)));
  }

  /** Slider and Homey Energy ranges follow what the module reports. setCapabilityOptions is costly: only on change. */
  async updateLimits(state) {
    const max = this.maxCurrent();
    const phases = state.activePhases;
    const key = JSON.stringify([max, phases]);
    if (this.getStoreValue('limits') === key) return;
    try {
      await this.setCapabilityOptions('nrgkick_current_set', {
        min: m.MIN_CURRENT, max, step: 1, decimals: 0,
      });
      await this.setCapabilityOptions('target_power', {
        min: 0, max: Math.round(max * VOLTAGE * phases), step: VOLTAGE, excludeMin: 0, excludeMax: Math.round(m.MIN_CURRENT * VOLTAGE * phases),
      });
    } catch (err) {
      this.error('Could not update the limits', err.message); // tried again on the next change
      return;
    }
    await this.setStoreValue('limits', key);
  }

  // ---- Control ----

  /** Sends one change, one at a time and spaced out, then re-reads the module. */
  write(change) {
    const run = this.writeQueue.then(async () => {
      const password = this.getSetting('password');
      if (!password) throw new Error(this.homey.__('errors.connect_pin_needed'));
      try {
        await this.client.putSettings(this.getData().id, password, change);
      } catch (err) {
        throw new Error(describe(this.homey, err));
      } finally {
        await this.wait(WRITE_GAP_MS);
      }
      this.refreshSoon();
    });
    this.writeQueue = run.catch(() => {});
    return run;
  }

  /**
   * Same rules as the second-generation driver, simplified: the last command wins, a target power becomes a
   * charging current, and below 6 A charging pauses until the target rises again.
   */
  async onChargingControl({ evcharger_charging: charging, target_power: power, target_power_mode: mode }) {
    if (power !== undefined) this.targetPower = power;
    let target = power;
    if (target === undefined && mode === 'homey') target = this.targetPower !== null ? this.targetPower : (this.getCapabilityValue('target_power') || 0);
    if (target === undefined) {
      if (charging === undefined) return;
      this.targetPaused = false;
      await this.write({ charging });
      return;
    }

    const enabled = charging !== undefined ? charging : (this.targetPaused || this.getCapabilityValue('evcharger_charging') !== false);
    const amps = m.wattsToCurrent(target, {
      voltage: VOLTAGE, phases: this.state ? this.state.activePhases : 1, max: this.maxCurrent(),
    });
    if (amps <= 0) {
      this.targetPaused = enabled;
      await this.write({ charging: false });
      return;
    }
    this.targetPaused = false;
    await this.write({ charging: enabled, current: this.clampCurrent(amps) });
  }

}

module.exports = NrgkickConnectDevice;
