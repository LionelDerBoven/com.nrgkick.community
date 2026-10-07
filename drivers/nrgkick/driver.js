'use strict';

const Homey = require('homey');
const { NrgkickClient } = require('../../lib/NrgkickClient');
const describeError = require('../../lib/describeError');
const m = require('../../lib/mappings');

class NrgkickDriver extends Homey.Driver {

  async onInit() {
    const { flow } = this.homey;
    this.triggers = {
      statusChanged: flow.getDeviceTriggerCard('status_changed'),
      faultOccurred: flow.getDeviceTriggerCard('fault_occurred'),
      warningOccurred: flow.getDeviceTriggerCard('warning_occurred'),
      energyLimitReached: flow.getDeviceTriggerCard('energy_limit_reached'),
      locationChanged: flow.getDeviceTriggerCard('location_changed'),
    };

    flow.getConditionCard('status_is')
      .registerRunListener(({ device, status }) => device.getCapabilityValue('nrgkick_status') === status);
    flow.getConditionCard('fault_active')
      .registerRunListener(({ device }) => device.getCapabilityValue('alarm_generic') === true);

    flow.getActionCard('set_current').registerRunListener(({ device, current }) => {
      const max = m.maxCurrent(device.info);
      return device.triggerCapabilityListener('nrgkick_current_set', Math.min(max, Math.max(m.MIN_CURRENT, current)));
    });
    flow.getActionCard('set_energy_limit')
      .registerRunListener(({ device, limit }) => device.triggerCapabilityListener('nrgkick_energy_limit', Math.max(0, limit)));
    flow.getActionCard('set_phase_count')
      .registerRunListener(({ device, phases }) => device.triggerCapabilityListener('nrgkick_phase_count', phases));

    // mDNS keeps the address current when DHCP hands out a new one. Devices also work without it (a manual
    // address, or a NRGkick on another subnet), so the strategy is not linked to the driver's availability.
    // Homey does not always pass on every TXT record (the serial number can be missing, seen across VLANs
    // through an mDNS proxy), so a result is matched by its serial when present and otherwise by asking
    // the NRGkick at that address (see Device#relocate).
    this.discovery = this.homey.discovery.getStrategy('nrgkick');
    this.discovery.on('result', (result) => this.onDiscoveryResult(result));
    this.log(`mDNS: ${Object.keys(this.discovery.getDiscoveryResults()).length} NRGkick(s) known at start`);
  }

  /** Addresses of the NRGkicks mDNS currently knows (at most 5: a home has one or two). */
  discoveredAddresses() {
    const addresses = Object.values(this.discovery.getDiscoveryResults()).map((r) => r.address).filter(Boolean);
    return [...new Set(addresses)].slice(0, 5);
  }

  /** The current mDNS address of the NRGkick with this serial number, when its TXT record carries one. */
  findAddress(serial) {
    const wanted = String(serial).toLowerCase();
    const result = Object.values(this.discovery.getDiscoveryResults())
      .find((r) => String((r.txt && r.txt.serial_number) || '').toLowerCase() === wanted);
    return result ? result.address : null;
  }

  onDiscoveryResult(result) {
    if (!result.address) return;
    const serial = String((result.txt && result.txt.serial_number) || '').toLowerCase();
    for (const device of this.getDevices()) {
      if (!device.client) continue;
      if (serial && String(device.getData().id).toLowerCase() === serial) device.updateHost(result.address).catch(this.error);
      else if (!serial && !device.getAvailable()) device.relocate().catch(this.error);
    }
  }

  /** NRGkicks announced over mDNS that are not added yet (at most 5). */
  discoveredForPairing() {
    const usedHosts = new Set(this.getDevices().map((d) => d.getSetting('host')));
    return Object.values(this.discovery.getDiscoveryResults())
      .filter((r) => r.address && !usedHosts.has(r.address))
      .slice(0, 5)
      .map((r) => {
        const txt = r.txt || {};
        return {
          host: r.address,
          name: txt.device_name || txt.model_type || 'NRGkick',
          apiEnabled: txt.json_api_enabled !== '0',
        };
      });
  }

  /**
   * Reads /info at `host` and returns the device to create. Throws an NrgkickError for auth, API disabled or
   * connection problems, and a translated Error when the device has no serial or is already added.
   */
  async readDevice(host, username, password) {
    const client = new NrgkickClient({
      host, username, password, sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
    });
    let info;
    try {
      info = await client.getInfo();
    } finally {
      client.destroy();
    }
    const serial = m.pick(info.general, 'serial_number');
    if (!serial) throw new Error(this.homey.__('errors.no_serial'));
    if (this.getDevices().some((d) => String(d.getData().id).toLowerCase() === String(serial).toLowerCase())) {
      throw new Error(this.homey.__('errors.already_added'));
    }
    return {
      name: m.pick(info.general, 'device_name') || 'NRGkick',
      data: { id: String(serial) },
      settings: { host, username, password },
    };
  }

  /**
   * Pairing: pick a found NRGkick or enter an address (select / manual), the app tries it without login, and
   * only asks for a username and password (login_credentials) when the NRGkick answers 401. The finish view
   * creates the device.
   */
  async onPair(session) {
    const pending = { host: '', device: null };

    session.setHandler('discover', async () => this.discoveredForPairing());

    // Tries an address without credentials. Returns { status: 'ok' | 'auth' | 'api_disabled' }.
    session.setHandler('probe', async ({ host } = {}) => {
      const address = String(host || pending.host || '').trim();
      if (!address) throw new Error(this.homey.__('errors.no_host'));
      pending.host = address;
      pending.device = null;
      try {
        pending.device = await this.readDevice(address, '', '');
        return { status: 'ok' };
      } catch (err) {
        if (err.code === 'auth') return { status: 'auth' };
        if (err.code === 'api_disabled') return { status: 'api_disabled' };
        throw err.code ? new Error(describeError(this.homey, err)) : err;
      }
    });

    session.setHandler('login', async ({ username, password }) => {
      try {
        pending.device = await this.readDevice(pending.host, String(username || '').trim(), password || '');
        return true;
      } catch (err) {
        if (err.code === 'auth') return false;
        throw err.code ? new Error(describeError(this.homey, err)) : err;
      }
    });

    session.setHandler('pending_device', async () => {
      if (!pending.device) throw new Error(this.homey.__('errors.no_host'));
      return pending.device;
    });
  }
}

module.exports = NrgkickDriver;
