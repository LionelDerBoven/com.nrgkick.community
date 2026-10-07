'use strict';

const Homey = require('homey');
const { NrgkickClient } = require('../../lib/NrgkickClient');
const describeError = require('../../lib/describeError');
const m = require('../../lib/mappings');

const INFO_REFRESH_MS = 10 * 60 * 1000; // firmware, attachment and network change rarely
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const AFTER_WRITE_MS = 2000; // /control lags a moment behind a write; re-read shortly after
const FAILURES_BEFORE_UNAVAILABLE = 2; // ride out a single dropped poll
const RELOCATE_INTERVAL_MS = 5 * 60 * 1000; // at most one address search per 5 minutes
const CONNECTION_KEYS = ['host', 'username', 'password'];
// Only SIM models report these; they are added when /info shows a SIM model and removed otherwise.
const SIM_CAPABILITIES = [
  'nrgkick_cellular_mode', 'nrgkick_cellular_signal', 'nrgkick_cellular_operator',
  'nrgkick_latitude', 'nrgkick_longitude', 'nrgkick_gps_accuracy',
];
const LOCATION_TRIGGER_METERS = 100; // above normal GPS jitter, well below a trip

const round = (value, decimals) => {
  if (value === null || value === undefined) return value;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};
const kwh = (wh) => (wh === null ? null : round(wh / 1000, 3));
const minutes = (s) => (s === null ? null : Math.round(s / 60));

class NrgkickDevice extends Homey.Device {

  async onInit() {
    this.info = null; // trimmed /info: only the fields the limits need
    this.infoAt = 0;
    this.control = null; // last /control values
    this.statusId = null;
    this.faultId = undefined; // undefined: not read yet, so the first read never triggers a Flow
    this.warningId = undefined;
    this.location = null; // last position that was reported to Flows
    this.failures = 0;
    this.pollTimer = null;
    this.polling = false;
    this.pollSoon = false;
    this.stopped = false;

    await this.ensureCapabilities();

    const { host, username, password } = this.getSettings();
    this.client = new NrgkickClient({
      host: host || '0.0.0.0', username, password, sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
    });

    this.registerCapabilityListener('nrgkick_current_set', (value) => this.writeControl('current_set', value));
    this.registerCapabilityListener('nrgkick_energy_limit', (value) => this.writeControl('energy_limit', Math.round(value * 1000)));
    this.registerCapabilityListener('nrgkick_phase_count', (value) => this.writeControl('phase_count', Number(value)));
    // Homey sets these together (e.g. the "Set target power" card), so handle them as one change.
    this.registerMultipleCapabilityListener(
      ['evcharger_charging', 'target_power', 'target_power_mode'],
      (changed) => this.onChargingControl(changed),
      500,
    );

    const address = this.driver.findAddress(this.getData().id);
    if (address) await this.updateHost(address);
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

  /** Adds capabilities that a newer app version introduced, and drops ones it removed (SIM ones are managed in applySim). */
  async ensureCapabilities() {
    const wanted = this.driver.manifest.capabilities;
    for (const cap of wanted) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    for (const cap of this.getCapabilities()) {
      if (!wanted.includes(cap) && !SIM_CAPABILITIES.includes(cap)) await this.removeCapability(cap).catch(this.error);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some((key) => CONNECTION_KEYS.includes(key))) {
      const test = new NrgkickClient({
        host: newSettings.host,
        username: newSettings.username,
        password: newSettings.password,
        sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
      });
      let info;
      try {
        info = await test.getInfo();
      } catch (err) {
        throw new Error(describeError(this.homey, err));
      } finally {
        test.destroy();
      }
      const serial = m.pick(info.general, 'serial_number');
      if (serial && String(serial) !== String(this.getData().id)) throw new Error(this.homey.__('errors.other_device'));
      this.client.configure(newSettings);
      this.info = null;
    }
    if (changedKeys.some((key) => CONNECTION_KEYS.includes(key) || key === 'poll_interval')) this.refreshSoon(1000);
  }

  /** Called with an address found through mDNS for this device. */
  async updateHost(address) {
    if (!address || this.stopped || this.getSetting('host') === address) return;
    this.log('NRGkick found at a new address');
    await this.setSettings({ host: address });
    this.client.configure({ ...this.getSettings(), host: address });
    if (!this.getAvailable()) this.refreshSoon(0);
  }

  /**
   * Looks for this NRGkick at the other addresses mDNS knows, by asking each one for its serial number.
   * Used when the device stopped answering and mDNS did not say which address is ours.
   */
  async relocate() {
    if (this.stopped || this.relocating || Date.now() - (this.relocatedAt || 0) < RELOCATE_INTERVAL_MS) return false;
    this.relocating = true;
    this.relocatedAt = Date.now();
    const { host, username, password } = this.getSettings();
    try {
      for (const address of this.driver.discoveredAddresses()) {
        if (address === host || this.stopped) continue;
        const probe = new NrgkickClient({
          host: address, username, password, timeout: 5000, sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
        });
        try {
          const info = await probe.getInfo();
          if (String(m.pick(info.general, 'serial_number')) === String(this.getData().id)) {
            await this.updateHost(address);
            return true;
          }
        } catch (err) {
          // Not reachable or not ours: try the next address.
        } finally {
          probe.destroy();
        }
      }
      return false;
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

  /** Re-reads the device soon, e.g. after a write; waits for a poll that is running. */
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
      const permanent = err.code === 'auth' || err.code === 'api_disabled';
      if (permanent || this.failures >= FAILURES_BEFORE_UNAVAILABLE) {
        await this.setUnavailable(describeError(this.homey, err)).catch(this.error);
      }
      if (!permanent && this.failures >= FAILURES_BEFORE_UNAVAILABLE) this.relocate().catch(this.error);
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
    if (!this.info || Date.now() - this.infoAt > INFO_REFRESH_MS) {
      const info = await this.client.getInfo();
      this.infoAt = Date.now();
      await this.applyInfo(info);
    }
    await this.applyControl(await this.client.getControl());
    await this.applyValues(await this.client.getValues());
  }

  async set(capability, value) {
    if (value === undefined || !this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch((err) => this.error(capability, err.message));
  }

  // ---- Applying device data ----

  async applyInfo(info) {
    const {
      general = {}, connector = {}, grid = {}, network = {}, versions = {},
    } = info;
    this.info = {
      general: { rated_current: m.num(general, 'rated_current') },
      connector: { phase_count: m.num(connector, 'phase_count'), max_current: m.num(connector, 'max_current') },
      grid: { voltage: m.num(grid, 'voltage'), phases: m.pick(grid, 'phases') },
    };
    await this.updateLimits();

    const text = (value) => (value === undefined || value === null ? '' : String(value));
    const fw = (sw, hw) => [text(m.pick(versions, sw)), text(m.pick(versions, hw))].filter(Boolean).join(' / ');
    const connectorType = this.homey.__(`connector.${m.codeToId(m.CONNECTOR_TYPES, m.pick(connector, 'type'))}`);
    const phases = this.info.connector.phase_count;
    const maxCurrent = this.info.connector.max_current;
    await this.updateLabels({
      info_model: text(m.pick(general, 'model_type')),
      info_serial: text(m.pick(general, 'serial_number')),
      info_rated_current: this.info.general.rated_current ? `${this.info.general.rated_current} A` : '',
      info_attachment: [connectorType, phases && maxCurrent ? `${phases} × ${maxCurrent} A` : ''].filter(Boolean).join(', '),
      info_grid: [
        this.info.grid.voltage ? `${this.info.grid.voltage} V` : '',
        m.num(grid, 'frequency') ? `${m.num(grid, 'frequency')} Hz` : '',
        m.gridPhasesText(this.info.grid.phases),
      ].filter(Boolean).join(', '),
      info_network: [text(m.pick(network, 'ssid')), text(m.pick(network, 'ip_address'))].filter(Boolean).join(', '),
      info_mac: text(m.pick(network, 'mac_address')),
      info_fw_smartmodule: fw('sw_sm', 'hw_sm'),
      info_fw_main: fw('sw_ma', 'hw_ma'),
      info_fw_touch: fw('sw_to', 'hw_to'),
      info_fw_star: fw('sw_st', 'hw_st'),
      info_fw_cellular: text(m.pick(versions, 'sw_cm')),
    });
    await this.set('measure_signal_strength', m.num(network, 'rssi'));
    await this.applySim(m.isSimModel(m.pick(general, 'model_type')), info.cellular, info.gps);
  }

  /**
   * Cellular and GPS data of SIM models. Built from the API documentation and tested against a simulated
   * device only: no SIM model was available while writing it.
   */
  async applySim(isSim, cellular, gps) {
    for (const cap of SIM_CAPABILITIES) {
      if (isSim && !this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
      if (!isSim && this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
    }
    if (!isSim) return;

    if (cellular) {
      const mode = m.pick(cellular, 'mode');
      if (mode !== undefined) await this.set('nrgkick_cellular_mode', m.codeToId(m.CELLULAR_MODES, mode));
      await this.set('nrgkick_cellular_signal', m.num(cellular, 'rssi'));
      const operator = m.pick(cellular, 'operator');
      if (operator !== undefined) await this.set('nrgkick_cellular_operator', String(operator || ''));
    }

    const fix = m.gpsFix(gps);
    if (!fix) return;
    await this.set('nrgkick_latitude', round(fix.latitude, 6));
    await this.set('nrgkick_longitude', round(fix.longitude, 6));
    await this.set('nrgkick_gps_accuracy', fix.accuracy === null ? null : round(fix.accuracy, 0));

    const previous = this.location;
    if (!previous) {
      this.location = fix; // the first fix after a start never triggers
      return;
    }
    const distance = m.distanceMeters(previous, fix);
    if (distance <= Math.max(LOCATION_TRIGGER_METERS, fix.accuracy || 0)) return;
    this.location = fix;
    await this.driver.triggers.locationChanged.trigger(this, {
      latitude: round(fix.latitude, 6), longitude: round(fix.longitude, 6), distance: Math.round(distance),
    }).catch(this.error);
  }

  /** Writes only labels that changed: every settings write is a flash write. */
  async updateLabels(labels) {
    const current = this.getSettings();
    const changed = Object.fromEntries(Object.entries(labels).filter(([key, value]) => current[key] !== value));
    if (Object.keys(changed).length) await this.setSettings(changed).catch(this.error);
  }

  /** Slider and Homey Energy ranges follow the unit, attachment and grid. setCapabilityOptions is costly: only on change. */
  async updateLimits() {
    const maxCurrent = m.maxCurrent(this.info);
    const targetPower = m.targetPowerOptions(this.info);
    const key = JSON.stringify([maxCurrent, targetPower]);
    if (this.getStoreValue('limits') === key) return;
    await this.setCapabilityOptions('nrgkick_current_set', {
      min: m.MIN_CURRENT, max: maxCurrent, step: 0.1, decimals: 1,
    });
    await this.setCapabilityOptions('target_power', targetPower);
    await this.setStoreValue('limits', key);
  }

  async applyControl(control) {
    const phaseCount = m.num(control, 'phase_count');
    const previous = this.control || {};
    this.control = {
      current_set: m.num(control, 'current_set'),
      charge_pause: m.num(control, 'charge_pause'),
      energy_limit: m.num(control, 'energy_limit'),
      // The device reports 0 for a moment while it switches phases; keep the last real value.
      phase_count: phaseCount >= 1 ? phaseCount : (previous.phase_count || null),
    };
    const c = this.control;
    if (c.current_set !== null) await this.set('nrgkick_current_set', round(c.current_set, 1));
    if (c.charge_pause !== null) await this.set('evcharger_charging', c.charge_pause === 0);
    if (c.energy_limit !== null) await this.set('nrgkick_energy_limit', kwh(c.energy_limit));
    if (c.phase_count) await this.set('nrgkick_phase_count', String(c.phase_count));
  }

  async applyValues(values) {
    const {
      energy, powerflow = {}, general, temperatures,
    } = values;
    const {
      l1, l2, l3, n,
    } = powerflow;

    await this.set('meter_power', kwh(m.num(energy, 'total_charged_energy')));
    await this.set('meter_power.session', kwh(m.num(energy, 'charged_energy')));

    await this.set('measure_power', round(m.num(powerflow, 'total_active_power'), 0));
    await this.set('measure_power.peak', round(m.num(powerflow, 'peak_power'), 0));
    await this.set('measure_voltage', round(m.num(powerflow, 'charging_voltage'), 1));
    await this.set('measure_current.offered', round(m.num(powerflow, 'charging_current'), 1));
    await this.set('measure_frequency', round(m.num(powerflow, 'grid_frequency'), 2));
    await this.set('nrgkick_power_factor', round(m.num(powerflow, 'total_power_factor'), 2));
    for (const [phase, data] of [['l1', l1], ['l2', l2], ['l3', l3]]) {
      await this.set(`measure_power.${phase}`, round(m.num(data, 'active_power'), 0));
      await this.set(`measure_current.${phase}`, round(m.num(data, 'current'), 2));
      await this.set(`measure_voltage.${phase}`, round(m.num(data, 'voltage'), 1));
    }
    await this.set('measure_current.n', round(m.num(n, 'current'), 2));

    await this.set('measure_temperature', round(m.num(temperatures, 'housing'), 1));
    await this.set('measure_temperature.connector_l1', round(m.num(temperatures, 'connector_l1'), 1));
    await this.set('measure_temperature.connector_l2', round(m.num(temperatures, 'connector_l2'), 1));
    await this.set('measure_temperature.connector_l3', round(m.num(temperatures, 'connector_l3'), 1));
    await this.set('measure_temperature.plug_1', round(m.num(temperatures, 'domestic_plug_1'), 1));
    await this.set('measure_temperature.plug_2', round(m.num(temperatures, 'domestic_plug_2'), 1));

    if (!general) return;
    await this.set('nrgkick_charging_rate', round(m.num(general, 'charging_rate'), 1));
    await this.set('nrgkick_charge_time', minutes(m.num(general, 'vehicle_charging_time')));
    await this.set('nrgkick_connect_time', minutes(m.num(general, 'vehicle_connect_time')));
    const permitted = m.num(general, 'charge_permitted');
    if (permitted !== null) await this.set('nrgkick_charge_permitted', permitted === 1);
    const chargeCount = m.num(general, 'charge_count');
    if (chargeCount !== null) await this.updateLabels({ info_charge_count: String(chargeCount) });

    await this.applyStatus(general);
    await this.applyFault(general);
    await this.applyWarning(general, m.num(energy, 'charged_energy'));
  }

  async applyStatus(general) {
    const raw = m.pick(general, 'status');
    if (raw === undefined) return;
    const statusId = m.codeToId(m.STATUS, raw);
    const paused = this.control ? this.control.charge_pause === 1 : false;
    await this.set('nrgkick_status', statusId);
    const state = m.chargingState(statusId, paused);
    if (state) await this.set('evcharger_charging_state', state);

    const previous = this.statusId;
    this.statusId = statusId;
    if (previous !== null && previous !== statusId) {
      await this.driver.triggers.statusChanged.trigger(this, {
        status: this.homey.__(`status.${statusId}`),
        previous_status: this.homey.__(`status.${previous}`),
      }).catch(this.error);
    }
  }

  /** An error code wins over a residual current trip; both raise the Fault alarm. */
  async applyFault(general) {
    const errorRaw = m.pick(general, 'error_code');
    const rcdRaw = m.pick(general, 'rcd_trigger');
    if (errorRaw === undefined && rcdRaw === undefined) return;
    const errorId = errorRaw === undefined ? 'no_error' : m.codeToId(m.ERROR_CODES, errorRaw);
    const rcdId = rcdRaw === undefined ? 'no_fault' : m.codeToId(m.RCD_TRIGGERS, rcdRaw);
    let faultId = null;
    let code = 0;
    if (errorId !== 'no_error') {
      faultId = errorId;
      code = Number(errorRaw) || 0;
    } else if (rcdId !== 'no_fault') {
      faultId = rcdId === 'unknown' ? 'unknown' : rcdId;
    }

    await this.set('nrgkick_error', faultId ? this.homey.__(`fault.${faultId}`) : this.homey.__('none'));
    await this.set('alarm_generic', faultId !== null);

    const previous = this.faultId;
    this.faultId = faultId;
    if (previous !== undefined && faultId && faultId !== previous) {
      await this.driver.triggers.faultOccurred.trigger(this, { fault: this.homey.__(`fault.${faultId}`), code })
        .catch(this.error);
    }
  }

  async applyWarning(general, sessionWh) {
    const raw = m.pick(general, 'warning_code');
    if (raw === undefined) return;
    const id = m.codeToId(m.WARNING_CODES, raw);
    const warningId = id === 'no_warning' ? null : id;
    await this.set('nrgkick_warning', warningId ? this.homey.__(`warning.${warningId}`) : this.homey.__('none'));

    const previous = this.warningId;
    this.warningId = warningId;
    if (previous === undefined || !warningId || warningId === previous) return;
    await this.driver.triggers.warningOccurred.trigger(this, {
      warning: this.homey.__(`warning.${warningId}`), code: Number(raw) || 0,
    }).catch(this.error);
    if (warningId === 'energy_limit_reached') {
      await this.driver.triggers.energyLimitReached.trigger(this, { energy: kwh(sessionWh) || 0 }).catch(this.error);
    }
  }

  // ---- Control ----

  /** Writes one control value, shows the value the device confirmed and re-reads shortly after. */
  async writeControl(key, value) {
    let echoed;
    try {
      echoed = await this.client.setControl(key, value);
    } catch (err) {
      throw new Error(describeError(this.homey, err));
    }
    await this.applyControl({ ...this.control, [key]: echoed });
    this.refreshSoon();
    return echoed;
  }

  async setPaused(paused) {
    const wanted = paused ? 1 : 0;
    if (this.control && this.control.charge_pause === wanted) return;
    await this.writeControl('charge_pause', wanted);
  }

  /**
   * evcharger_charging pauses or resumes. In Homey mode, target_power sets the charging current; in device mode
   * (the default) the NRGkick follows its own settings and target_power is ignored.
   */
  async onChargingControl({ evcharger_charging: charging, target_power: power, target_power_mode: mode }) {
    if (mode === 'device') await this.leaveHomeyMode();
    if (mode === 'homey') await this.enterHomeyMode();

    const homeyMode = (mode || this.getCapabilityValue('target_power_mode')) === 'homey';
    if (!homeyMode) {
      if (charging !== undefined) await this.setPaused(!charging);
      return;
    }

    const target = power !== undefined ? power : (this.getCapabilityValue('target_power') || 0);
    const enabled = charging !== undefined ? charging : this.getCapabilityValue('evcharger_charging') !== false;
    if (!enabled || target <= 0) {
      await this.setPaused(true);
      return;
    }
    const amps = m.wattsToCurrent(target, {
      voltage: m.nominalVoltage(this.info),
      phases: m.activePhases(this.info, this.control),
      max: m.maxCurrent(this.info),
    });
    const current = this.control && this.control.current_set;
    if (current === null || current === undefined || Math.abs(current - amps) >= 0.05) {
      await this.writeControl('current_set', amps);
    }
    await this.setPaused(false);
  }

  /** Remembers the user's own current and pause state, to restore them when Homey hands control back. */
  async enterHomeyMode() {
    if (this.getStoreValue('beforeHomey')) return;
    if (!this.control) await this.applyControl(await this.client.getControl());
    await this.setStoreValue('beforeHomey', {
      current_set: this.control.current_set, charge_pause: this.control.charge_pause,
    });
  }

  async leaveHomeyMode() {
    const before = this.getStoreValue('beforeHomey');
    if (!before) return;
    await this.unsetStoreValue('beforeHomey');
    if (Number.isFinite(before.current_set) && this.control && before.current_set !== this.control.current_set) {
      await this.writeControl('current_set', before.current_set);
    }
    if (before.charge_pause === 0 || before.charge_pause === 1) await this.setPaused(before.charge_pause === 1);
  }

}

module.exports = NrgkickDevice;
