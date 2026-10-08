'use strict';

const Homey = require('homey');
const { ConnectClient } = require('../../lib/ConnectClient');
const { discoverConnectModules } = require('../../lib/connectDiscovery');
const describeError = require('../../lib/describeError');

/**
 * First-generation NRGkick through the NRGkick Connect module (experimental: built from DiniTech's Connect API
 * documentation, not tested on a real module yet).
 */
class NrgkickConnectDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('connect_set_current')
      .registerRunListener(({ device, current }) => device.triggerCapabilityListener('nrgkick_current_set', current));
    this.homey.flow.getActionCard('connect_set_energy_limit')
      .registerRunListener(({ device, limit }) => device.triggerCapabilityListener('nrgkick_energy_limit', Math.max(0, limit)));
  }

  /** Connect modules that answer the discovery question within 3 seconds. */
  async discoverModules() {
    let localIp = '';
    try {
      localIp = String(await this.homey.cloud.getLocalAddress()).split(':')[0];
    } catch (err) {
      // only used inside the question; the module answers the sender anyway
    }
    const modules = await discoverConnectModules({ timer: (fn, ms) => this.homey.setTimeout(fn, ms), localIp });
    this.log(`Connect discovery: ${modules.length} module(s) found`);
    return modules;
  }

  /** The NRGkicks a Connect module knows, as Homey devices that are not added yet. */
  async readDevices(host, password) {
    const client = new ConnectClient({ host, sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)) });
    const added = new Set(this.getDevices().map((d) => String(d.getData().id).toUpperCase()));
    const result = [];
    try {
      const devices = (await client.getDevices())
        .filter((d) => !added.has(String(d.MacAddress).toUpperCase()))
        .slice(0, 10);
      for (const d of devices) {
        const mac = String(d.MacAddress).toUpperCase();
        // The name set in the NRGkick app, when the module can reach the NRGkick right now.
        const settings = await client.getSettings(mac).catch(() => null);
        const name = settings && settings.Values && settings.Values.DeviceMetadata && settings.Values.DeviceMetadata.Name;
        result.push({
          name: String(name || `NRGkick ${mac.slice(-5)}`),
          data: { id: mac },
          settings: { host, password: password || '' },
        });
      }
    } finally {
      client.destroy();
    }
    return result;
  }

  async onPair(session) {
    let found = [];

    session.setHandler('discover', async () => {
      const modules = await this.discoverModules();
      return modules.map((mod) => ({ host: mod.ip, name: mod.nrgName || 'NRGkick Connect' }));
    });

    session.setHandler('connect', async ({ host, password } = {}) => {
      const address = String(host || '').trim();
      if (!address) throw new Error(this.homey.__('errors.no_connect_host'));
      try {
        found = await this.readDevices(address, String(password || '').trim());
      } catch (err) {
        throw err.code ? new Error(describeError(this.homey, err)) : err;
      }
      if (!found.length) throw new Error(this.homey.__('errors.no_connect_devices'));
      return found.length;
    });

    session.setHandler('list_devices', async () => found);
  }

}

module.exports = NrgkickConnectDriver;
