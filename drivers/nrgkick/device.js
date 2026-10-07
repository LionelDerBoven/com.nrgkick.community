'use strict';

const Homey = require('homey');
const { NrgkickClient } = require('../../lib/NrgkickClient');
const describeError = require('../../lib/describeError');
const m = require('../../lib/mappings');

const INFO_REFRESH_MS = 10 * 60 * 1000; // firmware, attachment and network change rarely
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const AFTER_WRITE_MS = 2000; // /control lags a moment behind a write; re-read shortly after
const FOLLOW_UP_MS = 8000; // and once more: a car takes 5-10 s to start or stop drawing power (measured)
const FAILURES_BEFORE_UNAVAILABLE = 2; // ride out a single dropped poll
const RELOCATE_INTERVAL_MS = 5 * 60 * 1000; // at most one address search per 5 minutes
const CONNECTION_KEYS = ['host', 'username', 'password'];
// Only SIM models report these; they are added when /info shows a SIM model and removed otherwise.
const SIM_CAPABILITIES = [
  'nrgkick_cellular_mode', 'nrgkick_cellular_signal', 'nrgkick_cellular_operator',
  'nrgkick_latitude', 'nrgkick_longitude', 'nrgkick_gps_accuracy',
];
// Shown only when the attachment and the grid have more than one phase; with one phase it can do nothing.
const PHASE_CAPABILITY = 'nrgkick_phase_count';
const LOCATION_TRIGGER_METERS = 100; // above normal GPS jitter, well below a trip
const SESSION_SAVE_MS = 5 * 60 * 1000; // persist the running session cost at most every 5 minutes (flash writes)

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
    this.followUp = false;
    this.stopped = false;
    this.controlQueue = Promise.resolve(); // charging control batches run one after another
    this.mode = null; // target_power_mode as last requested; Homey stores it only after the listener returns
    this.targetPower = null;
    this.targetPaused = false; // paused because the target power was too low, not by the user
    this.pluggedIn = null; // null: not read yet, so the first read never triggers a Flow
    this.sessionDone = false; // "charging session ended" fires once per plug-in
    this.price = null; // price per kWh from the Flow action; falls back to the price_per_kwh setting
    const session = this.getStoreValue('session') || {};
    this.sessionWh = Number.isFinite(session.wh) ? session.wh : null;
    this.sessionCost = Number.isFinite(session.cost) ? session.cost : 0;
    this.sessionSavedAt = 0;

    await this.ensureCapabilities();

    const { host, username, password } = this.getSettings();
    this.client = new NrgkickClient({
      host: host || '0.0.0.0', username, password, sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
    });

    this.registerCapabilityListener('nrgkick_current_set', (value) => this.writeControl('current_set', Math.min(value, this.maxCurrent())));
    this.registerCapabilityListener('nrgkick_energy_limit', (value) => this.writeControl('energy_limit', Math.round(value * 1000)));
    this.registerPhaseListener();
    this.registerCapabilityListener('nrgkick_homey_control', async (on) => {
      const mode = on ? 'homey' : 'device';
      this.setCapabilityValue('target_power_mode', mode).catch(this.error);
      await this.queueChargingControl({ target_power_mode: mode });
    });
    // Homey sets these together (e.g. the "Set target power" card), so handle them as one change.
    this.registerMultipleCapabilityListener(
      ['evcharger_charging', 'target_power', 'target_power_mode'],
      (changed) => this.queueChargingControl(changed),
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
      if (cap !== PHASE_CAPABILITY && !this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
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
    if (changedKeys.includes('max_current')) {
      await this.updateLimits(newSettings);
      await this.enforceMaxCurrent(newSettings).catch(this.error);
    }
    if (changedKeys.some((key) => CONNECTION_KEYS.includes(key) || key === 'poll_interval')) this.refreshSoon(1000);
  }

  /** The phase picker comes and goes with the attachment, so its listener is registered once it exists. */
  registerPhaseListener() {
    if (this.phaseListener || !this.hasCapability(PHASE_CAPABILITY)) return;
    this.registerCapabilityListener(PHASE_CAPABILITY, (value) => this.setPhaseCount(value));
    this.phaseListener = true;
  }

  async updatePhaseCapability() {
    const useful = m.availablePhases(this.info) > 1;
    if (useful && !this.hasCapability(PHASE_CAPABILITY)) {
      await this.addCapability(PHASE_CAPABILITY).catch(this.error);
      this.registerPhaseListener();
      if (this.control && this.control.phase_count) await this.set(PHASE_CAPABILITY, String(this.control.phase_count));
    }
    if (!useful && this.hasCapability(PHASE_CAPABILITY)) await this.removeCapability(PHASE_CAPABILITY).catch(this.error);
  }

  /** From the Flow card; works whether or not the phase picker is shown. */
  async setPhaseCount(phases) {
    await this.writeControl('phase_count', Number(phases));
  }

  /** Highest current allowed: the charger and attachment maximum, lowered by the user's max_current setting. */
  maxCurrent(settings = this.getSettings()) {
    const hardware = m.maxCurrent(this.info);
    const limit = Number(settings.max_current);
    return limit >= m.MIN_CURRENT ? Math.min(hardware, limit) : hardware;
  }

  /** A current set above the user's limit (e.g. in the NRGkick app) is brought back down. */
  async enforceMaxCurrent(settings = this.getSettings()) {
    const max = this.maxCurrent(settings);
    const current = this.control && this.control.current_set;
    if (this.enforcing || current === null || current === undefined || current <= max + 0.05) return;
    this.enforcing = true;
    try {
      this.log(`Charging current above the limit, lowering it to ${max} A`);
      await this.writeControl('current_set', max);
    } finally {
      this.enforcing = false;
    }
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
      } else if (this.followUp) {
        this.followUp = false;
        next = FOLLOW_UP_MS;
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
    await this.updatePhaseCapability();

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
  async updateLimits(settings = this.getSettings()) {
    const maxCurrent = this.maxCurrent(settings);
    const targetPower = m.targetPowerOptions(this.info, maxCurrent);
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
    // Homey Energy needs a starting point: device mode, and the power the current setting allows.
    if (this.getCapabilityValue('target_power_mode') === null) await this.set('target_power_mode', 'device');
    await this.set('nrgkick_homey_control', (this.mode || this.getCapabilityValue('target_power_mode')) === 'homey');
    if (this.getCapabilityValue('target_power') === null && c.current_set !== null) {
      const voltage = m.nominalVoltage(this.info);
      const phases = m.activePhases(this.info, c);
      await this.set('target_power', m.currentToWatts(c.current_set, { voltage, phases }));
    }
    if (!this.enforcing) await this.enforceMaxCurrent().catch(this.error);
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

    // Outside a charge the meter still reads a watt or so of noise (also seen in HA). Show 0 then, so the status
    // indicator and Homey Energy only show power while the car is really charging.
    const statusRaw = m.pick(general, 'status');
    const charging = statusRaw === undefined || m.codeToId(m.STATUS, statusRaw) === 'charging';
    const live = (value) => (charging || value === null ? value : 0);

    await this.set('measure_power', live(round(m.num(powerflow, 'total_active_power'), 0)));
    await this.set('measure_power.peak', round(m.num(powerflow, 'peak_power'), 0));
    await this.set('measure_voltage', round(m.num(powerflow, 'charging_voltage'), 1));
    await this.set('measure_current.offered', round(m.num(powerflow, 'charging_current'), 1));
    await this.set('measure_frequency', round(m.num(powerflow, 'grid_frequency'), 2));
    await this.set('nrgkick_power_factor', round(m.num(powerflow, 'total_power_factor'), 2));
    for (const [phase, data] of [['l1', l1], ['l2', l2], ['l3', l3]]) {
      await this.set(`measure_power.${phase}`, live(round(m.num(data, 'active_power'), 0)));
      await this.set(`measure_current.${phase}`, live(round(m.num(data, 'current'), 2)));
      await this.set(`measure_voltage.${phase}`, round(m.num(data, 'voltage'), 1));
    }
    await this.set('measure_current.n', live(round(m.num(n, 'current'), 2)));

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

    const previousStatus = this.statusId;
    await this.applyStatus(general);
    await this.applySession(previousStatus, energy, general);
    await this.applyFault(general);
    await this.applyWarning(general, m.num(energy, 'charged_energy'));
  }

  /** Price per kWh for the session cost: the latest from a Flow, else the fixed price in the settings. */
  currentPrice() {
    if (Number.isFinite(this.price)) return this.price;
    const fixed = Number(this.getSetting('price_per_kwh'));
    return Number.isFinite(fixed) && fixed > 0 ? fixed : 0;
  }

  /** Set from the "Set the electricity price" Flow card, e.g. fed by Homey Energy's price trigger. */
  setPrice(price) {
    this.price = Number.isFinite(price) && price >= 0 ? price : null;
  }

  /**
   * Plug-in and unplug triggers, and the session that runs in between. The cost adds up each kWh at the
   * price of that moment, so a price change during a charge counts correctly. "Charging session ended" fires
   * once per plug-in: when the charge stops on its own (car full or energy limit) or at the latest on unplug.
   */
  async applySession(previousStatus, energy, general) {
    const { statusId } = this;
    if (statusId === null || statusId === 'unknown') return;
    const wh = m.num(energy, 'charged_energy');
    if (wh !== null) {
      if (this.sessionWh !== null && wh >= this.sessionWh) this.sessionCost += ((wh - this.sessionWh) / 1000) * this.currentPrice();
      else if (this.sessionWh !== null) this.sessionCost = 0; // the NRGkick started a new session
      this.sessionWh = wh;
    }

    const plugged = m.isPluggedIn(statusId);
    const was = this.pluggedIn;
    this.pluggedIn = plugged;
    if (was === null) {
      this.sessionDone = !plugged;
    } else if (plugged && !was) {
      this.sessionDone = false;
      this.sessionCost = 0;
      await this.driver.triggers.carPluggedIn.trigger(this, {}).catch(this.error);
    } else if (!plugged && was) {
      await this.finishSession(general);
      await this.driver.triggers.carUnplugged.trigger(this, {}).catch(this.error);
    } else if (plugged && previousStatus === 'charging' && statusId === 'connected'
      && this.control && this.control.charge_pause === 0) {
      await this.finishSession(general); // stopped on its own: car full or energy limit reached
    }

    if (Date.now() - this.sessionSavedAt > SESSION_SAVE_MS) await this.saveSession();
  }

  async finishSession(general) {
    if (this.sessionDone) return;
    this.sessionDone = true;
    await this.saveSession();
    if (!this.sessionWh) return; // plugged in and out without charging
    await this.driver.triggers.sessionEnded.trigger(this, {
      energy: kwh(this.sessionWh),
      charge_time: minutes(m.num(general, 'vehicle_charging_time')) || 0,
      connected_time: minutes(m.num(general, 'vehicle_connect_time')) || 0,
      cost: round(this.sessionCost, 2),
    }).catch(this.error);
  }

  async saveSession() {
    this.sessionSavedAt = Date.now();
    await this.setStoreValue('session', { wh: this.sessionWh, cost: round(this.sessionCost, 4) }).catch(this.error);
  }

  /** "Charge … kWh and then stop": the limit counts from what this session already charged. */
  async chargeEnergy(kwhToAdd) {
    const already = this.sessionWh && m.isPluggedIn(this.statusId) ? this.sessionWh : 0;
    await this.writeControl('energy_limit', Math.round(already + kwhToAdd * 1000));
    await this.setPaused(false);
  }

  /** Raises or lowers the charging current by `delta` A, within 6 A and the maximum. */
  async changeCurrent(delta) {
    const current = this.control && this.control.current_set !== null ? this.control.current_set : this.getCapabilityValue('nrgkick_current_set');
    const target = Math.round(Math.min(this.maxCurrent(), Math.max(m.MIN_CURRENT, (current || m.MIN_CURRENT) + delta)) * 10) / 10;
    if (target !== current) await this.triggerCapabilityListener('nrgkick_current_set', target);
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
    this.followUp = true;
    this.refreshSoon();
    return echoed;
  }

  async setPaused(paused) {
    const wanted = paused ? 1 : 0;
    if (this.control && this.control.charge_pause === wanted) return;
    await this.writeControl('charge_pause', wanted);
  }

  /**
   * Homey can deliver a mode change and a target power as two batches in quick succession, and it stores a
   * value only after its listener returns. So the requested mode and target are remembered at once, and the
   * batches run one after another; otherwise the second batch could still see the old mode and be ignored.
   */
  queueChargingControl(changed) {
    // Setting a target power by hand only makes sense in Homey mode, so it switches to it.
    const currentMode = this.mode || this.getCapabilityValue('target_power_mode');
    if (changed.target_power !== undefined && changed.target_power_mode === undefined && currentMode !== 'homey') {
      changed = { ...changed, target_power_mode: 'homey' };
      this.setCapabilityValue('target_power_mode', 'homey').catch(this.error);
    }
    if (changed.target_power_mode !== undefined) {
      this.mode = changed.target_power_mode;
      this.set('nrgkick_homey_control', this.mode === 'homey').catch(this.error);
    }
    if (changed.target_power !== undefined) this.targetPower = changed.target_power;
    const run = this.controlQueue.then(() => this.onChargingControl(changed));
    this.controlQueue = run.catch(() => {});
    return run;
  }

  /**
   * evcharger_charging pauses or resumes. In Homey mode, target_power sets the charging current; in device mode
   * (the default) the NRGkick follows its own settings and target_power is ignored.
   */
  async onChargingControl({ evcharger_charging: charging, target_power: power, target_power_mode: mode }) {
    if (mode === 'device') await this.leaveHomeyMode();
    if (mode === 'homey') await this.enterHomeyMode();

    const homeyMode = (mode || this.mode || this.getCapabilityValue('target_power_mode')) === 'homey';
    if (!homeyMode) {
      if (charging !== undefined) await this.setPaused(!charging);
      return;
    }

    let target = power;
    if (target === undefined) target = this.targetPower !== null ? this.targetPower : (this.getCapabilityValue('target_power') || 0);
    // A pause that only came from a too low target power must not block charging once the target rises again.
    const enabled = charging !== undefined ? charging : (this.targetPaused || this.getCapabilityValue('evcharger_charging') !== false);
    const amps = m.wattsToCurrent(target, {
      voltage: m.nominalVoltage(this.info),
      phases: m.activePhases(this.info, this.control),
      max: this.maxCurrent(),
    });
    if (!enabled || amps <= 0) {
      this.targetPaused = enabled;
      await this.setPaused(true);
      return;
    }
    this.targetPaused = false;
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
    this.targetPaused = false;
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
