'use strict';

const KNOWN = new Set(['auth', 'api_disabled', 'rejected', 'timeout', 'connection', 'invalid_response', 'offline']);

/** A translated, user-facing message for an NrgkickError (falls back to the error's own message). */
module.exports = function describeError(homey, err) {
  if (err && KNOWN.has(err.code)) return homey.__(`errors.${err.code}`, { reason: err.reason || '' });
  return (err && err.message) || String(err);
};
