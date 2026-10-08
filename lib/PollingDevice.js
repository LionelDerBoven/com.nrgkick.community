'use strict';

const Homey = require('homey');

/**
 * What the three NRGkick devices share: polling with a back-off on errors, capability and label writes that only
 * happen on a change, and keeping the capability list in step with the driver manifest.
 *
 * A subclass calls initPolling() in onInit, implements refresh() (read the device and apply it) and may override
 * onPollError(err) to decide when the device turns unavailable.
 */
class PollingDevice extends Homey.Device {

  /**
   * @param {object} options
   * @param {{value: number, min: number, max: number}} options.interval poll interval setting in seconds
   * @param {number} options.maxBackoffMs longest wait after repeated errors
   * @param {number} [options.backoffSteps] doublings of the interval before the cap applies
   * @param {number} [options.afterWriteMs] re-read this soon after a write
   * @param {number} [options.followUpMs] and, when asked, once more after this
   * @param {boolean} [options.keepOnNull] a null value leaves a capability as it is instead of clearing it
   */
  initPolling({
    interval, maxBackoffMs, backoffSteps = 4, afterWriteMs = 2000, followUpMs = 8000, keepOnNull = false,
  }) {
    this.pollOptions = {
      interval, maxBackoffMs, backoffSteps, afterWriteMs, followUpMs,
    };
    this.keepOnNull = keepOnNull;
    this.failures = 0;
    this.pollTimer = null;
    this.polling = false;
    this.pollSoon = false;
    this.followUp = false;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) this.homey.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  async onUninit() {
    this.stop();
  }

  async onDeleted() {
    this.stop();
  }

  /** A promise that resolves after `ms`, on a Homey timer. */
  wait(ms) {
    return new Promise((resolve) => this.homey.setTimeout(resolve, ms));
  }

  /**
   * Adds capabilities that a newer app version introduced and drops ones it removed.
   * @param {{skipAdd?: string[], keep?: string[]}} [options] skipAdd: added later by the device itself;
   *   keep: managed by the device itself, never removed here
   */
  async ensureCapabilities({ skipAdd = [], keep = [] } = {}) {
    const wanted = this.driver.manifest.capabilities;
    for (const cap of wanted) {
      if (!skipAdd.includes(cap) && !this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    for (const cap of this.getCapabilities()) {
      if (!wanted.includes(cap) && !keep.includes(cap)) await this.removeCapability(cap).catch(this.error);
    }
  }

  /** Sets a capability only when it exists and the value changed. */
  async set(capability, value) {
    if (value === undefined || (value === null && this.keepOnNull) || !this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch((err) => this.error(capability, err.message));
  }

  /** Writes only labels that changed: every settings write is a flash write. */
  async updateLabels(labels) {
    const current = this.getSettings();
    const changed = Object.fromEntries(Object.entries(labels).filter(([key, value]) => current[key] !== value));
    if (Object.keys(changed).length) await this.setSettings(changed).catch(this.error);
  }

  // ---- Polling ----

  interval() {
    const { value, min, max } = this.pollOptions.interval;
    const seconds = Number(this.getSetting('poll_interval')) || value;
    return Math.min(max, Math.max(min, seconds)) * 1000;
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
  refreshSoon(delay = this.pollOptions.afterWriteMs) {
    if (this.polling) this.pollSoon = true;
    else this.schedulePoll(delay);
  }

  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    const {
      maxBackoffMs, backoffSteps, afterWriteMs, followUpMs,
    } = this.pollOptions;
    let next = this.interval();
    try {
      await this.refresh();
      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.failures++;
      next = Math.min(next * 2 ** Math.min(this.failures - 1, backoffSteps), maxBackoffMs);
      this.log(`Poll failed (${this.failures}): ${err.code || ''} ${err.message}`);
      await this.onPollError(err).catch(this.error);
    } finally {
      this.polling = false;
      if (this.pollSoon) {
        this.pollSoon = false;
        next = afterWriteMs;
      } else if (this.followUp) {
        this.followUp = false;
        next = followUpMs;
      }
      this.schedulePoll(next);
    }
  }

  /** Reads the device and applies what it reports. */
  async refresh() {
    throw new Error('refresh() is not implemented');
  }

  /** Called after a failed poll, with this.failures already counted. The default keeps the device available. */
  async onPollError() {
    return undefined;
  }

}

module.exports = PollingDevice;
