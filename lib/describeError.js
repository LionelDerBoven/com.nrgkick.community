'use strict';

const KNOWN = new Set(['auth', 'api_disabled', 'rejected', 'timeout', 'connection', 'invalid_response', 'offline']);
// Through a Connect module, the module is what did not answer, so these get their own text.
const CONNECT_OWN = new Set(['timeout', 'connection', 'invalid_response']);

/**
 * A translated, user-facing message for an NrgkickError (falls back to the error's own message).
 * @param {object} homey
 * @param {Error} err
 * @param {{connect?: boolean}} [options] connect: the error came from an NRGkick Connect module
 */
module.exports = function describeError(homey, err, { connect = false } = {}) {
  if (err && connect && CONNECT_OWN.has(err.code)) return homey.__(`errors.connect_${err.code}`);
  if (err && KNOWN.has(err.code)) return homey.__(`errors.${err.code}`, { reason: err.reason || '' });
  return (err && err.message) || String(err);
};
