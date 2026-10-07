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
    this.discovery = this.homey.discovery.getStrategy('nrgkick');
    this.discovery.on('result', (result) => this.onDiscoveryResult(result));
  }

  /** The current mDNS address of the NRGkick with this serial number, or null. */
  findAddress(serial) {
    const wanted = String(serial).toLowerCase();
    const result = Object.values(this.discovery.getDiscoveryResults())
      .find((r) => String((r.txt && r.txt.serial_number) || '').toLowerCase() === wanted);
    return result ? result.address : null;
  }

  onDiscoveryResult(result) {
    const serial = String((result.txt && result.txt.serial_number) || '').toLowerCase();
    if (!serial || !result.address) return;
    const device = this.getDevices().find((d) => String(d.getData().id).toLowerCase() === serial);
    if (device && device.client) device.updateHost(result.address).catch(this.error);
  }

  async onPair(session) {
    session.setHandler('discover', async () => {
      const added = new Set(this.getDevices().map((d) => String(d.getData().id).toLowerCase()));
      return Object.values(this.discovery.getDiscoveryResults())
        .filter((r) => r.txt && r.txt.serial_number && !added.has(String(r.txt.serial_number).toLowerCase()))
        .map((r) => ({
          host: r.address,
          name: r.txt.device_name || 'NRGkick',
          model: r.txt.model_type || '',
          apiEnabled: r.txt.json_api_enabled !== '0',
        }));
    });

    session.setHandler('connect', async ({ host, username, password }) => {
      const address = String(host || '').trim();
      if (!address) throw new Error(this.homey.__('errors.no_host'));
      const user = String(username || '').trim();
      const client = new NrgkickClient({
        host: address, username: user, password, sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
      });
      let info;
      try {
        info = await client.getInfo();
      } catch (err) {
        if (err.code === 'auth' && !user) throw new Error(this.homey.__('errors.auth_required'));
        throw new Error(describeError(this.homey, err));
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
        settings: { host: address, username: user, password: password || '' },
      };
    });
  }

}

module.exports = NrgkickDriver;
