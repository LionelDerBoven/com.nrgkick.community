'use strict';

const Homey = require('homey');
const { looksLikeNrgkick } = require('../../lib/gen1Ble');

/**
 * First-generation NRGkick over Bluetooth (experimental, read-only): built from evcc's protocol description,
 * not tested on a real unit yet.
 */
class NrgkickBleDriver extends Homey.Driver {

  async onPair(session) {
    session.setHandler('list_devices', async () => {
      const advertisements = await this.homey.ble.discover();
      const added = new Set(this.getDevices().map((d) => d.getData().id));
      const found = advertisements
        .filter((a) => looksLikeNrgkick(a) && !added.has(a.uuid))
        .slice(0, 10)
        .map((a) => ({
          name: a.localName || 'NRGkick',
          data: { id: a.uuid },
          store: { address: a.address || '' },
        }));
      this.log(`Bluetooth scan: ${advertisements.length} device(s), ${found.length} NRGkick(s)`);
      if (!found.length) throw new Error(this.homey.__('errors.no_ble_devices'));
      return found;
    });
  }

}

module.exports = NrgkickBleDriver;
