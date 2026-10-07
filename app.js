'use strict';

const Homey = require('homey');

class NrgkickApp extends Homey.App {

  async onInit() {
    this.log('NRGkick app started');
  }

}

module.exports = NrgkickApp;
