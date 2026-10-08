'use strict';

const PollingDevice = require('../../lib/PollingDevice');
const { Gen1BleReader } = require('../../lib/gen1Ble');
const m = require('../../lib/mappings');

const MAX_BACKOFF_MS = 10 * 60 * 1000;
// Bluetooth drops a read now and then (distance, the phone app holding the connection); ride out a few.
const FAILURES_BEFORE_UNAVAILABLE = 3;

const { round } = m;

/**
 * A first-generation NRGkick read over Bluetooth. Experimental and read-only: the byte layout comes from evcc and
 * still has to be confirmed on a real unit, so "debug logging" writes the raw bytes to the app log.
 */
class NrgkickBleDevice extends PollingDevice {

  async onInit() {
    this.initPolling({
      interval: { value: 60, min: 30, max: 600 }, maxBackoffMs: MAX_BACKOFF_MS, backoffSteps: 3, keepOnNull: true,
    });

    await this.ensureCapabilities();
    this.reader = new Gen1BleReader({
      ble: this.homey.ble, peripheralUuid: this.getData().id, services: this.getStoreValue('services') || null,
    });
    // Control over Bluetooth follows once testers confirmed the readings.
    const readOnly = async () => {
      throw new Error(this.homey.__('errors.ble_read_only'));
    };
    this.registerCapabilityListener('evcharger_charging', readOnly);
    this.schedulePoll(0);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) this.schedulePoll(1000);
  }

  async refresh() {
    const data = await this.reader.read();
    if (this.getSetting('debug_logging')) this.log('raw', JSON.stringify(data.raw));
    if (!this.getStoreValue('services') && this.reader.services) await this.setStoreValue('services', this.reader.services);
    await this.apply(data);
  }

  async onPollError(err) {
    // A characteristic that is missing may mean the services changed: look them up again next time.
    if (err.code === 'ble') {
      this.reader.services = null;
      await this.unsetStoreValue('services').catch(this.error);
    }
    if (this.failures >= FAILURES_BEFORE_UNAVAILABLE) {
      await this.setUnavailable(this.homey.__('errors.ble_unreachable')).catch(this.error);
    }
  }

  async apply({
    info, energy, power, voltageCurrent,
  }) {
    const { status } = power;
    const charging = status === 'charging';
    const live = (value) => (charging || value === null ? value : 0);

    await this.set('nrgkick_status', status);
    const state = m.chargingState(status, info.paused);
    if (state) await this.set('evcharger_charging_state', state);
    // As in evcc: the NRGkick briefly reports "paused" right after a connection while it keeps charging.
    await this.set('evcharger_charging', !info.paused || info.chargingActive);
    await this.set('nrgkick_current_set', info.current >= m.MIN_CURRENT ? info.current : null);
    await this.set('nrgkick_energy_limit', energy.limitKwh === null ? 0 : round(energy.limitKwh, 1));

    await this.set('measure_power', live(power.totalW));
    await this.set('measure_power.peak', power.peakW);
    await this.set('measure_frequency', round(power.frequency, 2));
    await this.set('measure_temperature', power.temperature);
    await this.set('meter_power', round(energy.totalWh / 1000, 3));
    await this.set('meter_power.session', round(energy.lastChargeWh / 1000, 3));
    for (const [i, phase] of ['l1', 'l2', 'l3'].entries()) {
      await this.set(`measure_power.${phase}`, live([power.l1W, power.l2W, power.l3W][i]));
      await this.set(`measure_current.${phase}`, live(round(voltageCurrent.current[i], 2)));
      await this.set(`measure_voltage.${phase}`, round(voltageCurrent.voltage[i], 1));
    }

    const fault = info.errorCode !== 0;
    await this.set('alarm_generic', fault);
    await this.set('nrgkick_error', fault ? this.homey.__('gen1.error_codes', { codes: String(info.errorCode) }) : this.homey.__('none'));

    await this.updateLabels({
      info_mac: String(this.getStoreValue('address') || ''),
      info_max_current: info.maxCurrent ? `${info.maxCurrent} A` : '',
    });
  }

}

module.exports = NrgkickBleDevice;
