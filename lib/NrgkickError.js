'use strict';

/**
 * Error raised by NrgkickClient. `code` is one of:
 * - `auth`: HTTP 401/403, credentials missing or wrong
 * - `api_disabled`: the JSON API is turned off in the NRGkick app
 * - `rejected`: the device refused a command; `reason` holds its own text
 * - `timeout`, `connection`: the device could not be reached
 * - `invalid_response`: the device answered something that is not the expected JSON
 */
class NrgkickError extends Error {

  constructor(code, message, { status = null, reason = null } = {}) {
    super(message);
    this.name = 'NrgkickError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }

}

module.exports = NrgkickError;
