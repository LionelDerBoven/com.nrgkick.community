'use strict';

// Code tables of the NRGkick Gen2 local JSON API (raw mode). Ids are the documented names in lower case and
// double as locale keys (`status.<id>`, `error.<id>` …). Unknown codes map to 'unknown'.

const STATUS = {
  0: 'unknown', 1: 'standby', 2: 'connected', 3: 'charging', 6: 'error', 7: 'wakeup',
};

const CONNECTOR_TYPES = {
  0: 'unknown', 1: 'cee', 2: 'domestic', 3: 'type2', 4: 'wall', 5: 'aus',
};

const RCD_TRIGGERS = {
  0: 'no_fault',
  1: 'ac_30ma_fault',
  2: 'ac_60ma_fault',
  3: 'ac_150ma_fault',
  4: 'dc_positive_6ma_fault',
  5: 'dc_negative_6ma_fault',
};

const WARNING_CODES = {
  0: 'no_warning',
  1: 'no_pe',
  2: 'blackout_protection',
  3: 'energy_limit_reached',
  4: 'ev_does_not_comply_standard',
  5: 'unsupported_charging_mode',
  6: 'no_attachment_detected',
  7: 'no_comm_with_type2_attachment',
  16: 'increased_temperature',
  17: 'increased_housing_temperature',
  18: 'increased_attachment_temperature',
  19: 'increased_domestic_plug_temperature',
};

const ERROR_CODES = {
  0: 'no_error',
  1: 'general_error',
  2: '32a_attachment_on_16a_unit',
  3: 'voltage_drop_detected',
  4: 'unplug_detection_triggered',
  5: 'type2_not_authorized',
  16: 'residual_current_detected',
  32: 'cp_signal_voltage_error',
  33: 'cp_signal_impermissible',
  34: 'ev_diode_fault',
  48: 'pe_self_test_failed',
  49: 'rcd_self_test_failed',
  50: 'relay_self_test_failed',
  51: 'pe_and_rcd_self_test_failed',
  52: 'pe_and_relay_self_test_failed',
  53: 'rcd_and_relay_self_test_failed',
  54: 'pe_and_rcd_and_relay_self_test_failed',
  64: 'supply_voltage_error',
  65: 'phase_shift_error',
  66: 'overvoltage_detected',
  67: 'undervoltage_detected',
  68: 'overvoltage_without_pe_detected',
  69: 'undervoltage_without_pe_detected',
  70: 'underfrequency_detected',
  71: 'overfrequency_detected',
  72: 'unknown_frequency_type',
  73: 'unknown_grid_type',
  80: 'general_overtemperature',
  81: 'housing_overtemperature',
  82: 'attachment_overtemperature',
  83: 'domestic_plug_overtemperature',
};

const CELLULAR_MODES = {
  0: 'unknown', 1: 'no_service', 2: 'gsm', 3: 'lte_cat_m1', 4: 'lte_nb_iot',
};

const MIN_CURRENT = 6;
const NOMINAL_VOLTAGE = 230;

/**
 * Reads a key from an API section. Some firmware versions added a trailing colon to a few keys
 * (`voltage:`, `max_current:`), so that spelling is accepted too.
 */
function pick(section, key) {
  if (!section || typeof section !== 'object') return undefined;
  return section[key] !== undefined ? section[key] : section[`${key}:`];
}

/** A finite number from an API section, or null. */
function num(section, key) {
  const value = pick(section, key);
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Maps a raw code (or, on firmware that ignores raw mode, its name) to an id of `table`. */
function codeToId(table, value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    const id = value.trim().toLowerCase();
    return Object.values(table).includes(id) ? id : 'unknown';
  }
  const id = table[Number(value)];
  return id || 'unknown';
}

/** Number of set bits in the grid phase mask (bit 0 = L1, 1 = L2, 2 = L3). */
function phaseCountFromMask(mask) {
  const n = Number(mask);
  if (!Number.isInteger(n) || n <= 0) return 0;
  return (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1);
}

/** Readable list of the grid phases, e.g. "L1, L3". */
function gridPhasesText(mask) {
  const n = Number(mask);
  if (!Number.isInteger(n) || n <= 0) return '';
  return ['L1', 'L2', 'L3'].filter((_, i) => (n >> i) & 1).join(', ');
}

/**
 * Homey's evcharger_charging_state from the NRGkick status and the pause flag.
 * Returns null when the status is unknown, so the last known state is kept.
 */
function chargingState(statusId, paused) {
  switch (statusId) {
    case 'standby':
      return 'plugged_out';
    case 'charging':
      return 'plugged_in_charging';
    case 'connected':
    case 'wakeup':
    case 'error':
      return paused ? 'plugged_in_paused' : 'plugged_in';
    default:
      return null;
  }
}

/** Car is connected for these statuses (standby means nothing is plugged in). */
function isPluggedIn(statusId) {
  return ['connected', 'charging', 'wakeup', 'error'].includes(statusId);
}

/** Highest current the charger accepts: the unit's rating, lowered by the attachment's limit when known. */
function maxCurrent(info) {
  const rated = num(info && info.general, 'rated_current');
  const connector = num(info && info.connector, 'max_current');
  const candidates = [rated, connector].filter((v) => v !== null && v >= MIN_CURRENT);
  return candidates.length ? Math.min(...candidates) : 16;
}

/**
 * Phases the charger can use with the current attachment and grid: the lowest known of the attachment's
 * phase count and the connected grid phases. The user's phase limit is applied separately (activePhases).
 */
function availablePhases(info) {
  const connector = num(info && info.connector, 'phase_count');
  const grid = phaseCountFromMask(pick(info && info.grid, 'phases'));
  const candidates = [connector, grid].filter((v) => v !== null && v >= 1 && v <= 3);
  return candidates.length ? Math.min(...candidates) : 1;
}

/** Phases actually used for charging: available phases, limited by the user's phase_count setting. */
function activePhases(info, control) {
  const available = availablePhases(info);
  const user = num(control, 'phase_count');
  return user !== null && user >= 1 ? Math.min(available, user) : available;
}

/** Nominal phase voltage reported by the device (230 in Europe); falls back to 230. */
function nominalVoltage(info) {
  const v = num(info && info.grid, 'voltage');
  return v !== null && v >= 100 && v <= 260 ? v : NOMINAL_VOLTAGE;
}

/**
 * Options for target_power: from 0 to the highest power with the current attachment (or the lower `max`
 * current the user set), with the 6 A minimum as exclude zone (values inside it become 0, i.e. pause).
 */
function targetPowerOptions(info, max = maxCurrent(info)) {
  const voltage = nominalVoltage(info);
  const phases = availablePhases(info);
  return {
    min: 0,
    max: Math.round(max * voltage * phases),
    step: voltage,
    excludeMin: 0,
    excludeMax: Math.round(MIN_CURRENT * voltage * phases),
  };
}

/**
 * Converts a target power in W to a charging current in A (0.1 A steps). Returns 0 for "do not charge".
 * A request between 0 and the 6 A minimum is raised to 6 A; Homey's exclude zone normally prevents that.
 */
function wattsToCurrent(watts, { voltage, phases, max }) {
  if (!Number.isFinite(watts) || watts <= 0) return 0;
  const amps = Math.floor((watts / (voltage * phases)) * 10) / 10;
  return Math.min(max, Math.max(MIN_CURRENT, amps));
}

/** Converts a charging current to the power it allows, in W. */
function currentToWatts(amps, { voltage, phases }) {
  return Math.round(amps * voltage * phases);
}

/** SIM models (model type e.g. "NRGkick Gen2 SIM") also report cellular and GPS data. */
function isSimModel(modelType) {
  return /\bsim\b/i.test(String(modelType || ''));
}

/**
 * A GPS fix from the /info gps section, or null without a usable fix (missing, or 0/0).
 * Accuracy is only valid on newer cellular modules, so it may be null.
 */
function gpsFix(gps) {
  const latitude = num(gps, 'latitude');
  const longitude = num(gps, 'longitude');
  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  const accuracy = num(gps, 'accuracy');
  return { latitude, longitude, accuracy: accuracy !== null && accuracy > 0 ? accuracy : null };
}

/** Great-circle distance in metres between two { latitude, longitude } points. */
function distanceMeters(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = {
  STATUS,
  CONNECTOR_TYPES,
  CELLULAR_MODES,
  isSimModel,
  gpsFix,
  distanceMeters,
  RCD_TRIGGERS,
  WARNING_CODES,
  ERROR_CODES,
  MIN_CURRENT,
  isPluggedIn,
  pick,
  num,
  codeToId,
  phaseCountFromMask,
  gridPhasesText,
  chargingState,
  maxCurrent,
  availablePhases,
  activePhases,
  nominalVoltage,
  targetPowerOptions,
  wattsToCurrent,
  currentToWatts,
};
