'use strict';

// Turns the NRGkick Connect module's /api/settings and /api/measurements answers into plain values.
// Field names follow DiniTech's Connect API documentation (version 0.2); powers are in kW there.

// Below this the cable is not charging: the meter reads a little noise even when idle.
const CHARGING_THRESHOLD_KW = 0.1;

const finite = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);
const at = (list, i) => (Array.isArray(list) ? finite(list[i]) : null);

/** Error codes other than "0", as numbers. */
function errorCodes(settings) {
  const codes = settings && settings.Info && Array.isArray(settings.Info.ErrorCodes) ? settings.Info.ErrorCodes : [];
  return codes.map(Number).filter((code) => Number.isFinite(code) && code !== 0);
}

/**
 * @returns {{ online: boolean, enabled: boolean|null, current: number|null, minCurrent: number|null,
 *   maxCurrent: number|null, energyLimitKwh: number|null, passwordMatch: boolean|null, errors: number[],
 *   powerW: number|null, phases: {powerW, current, voltage}[], totalKwh: number|null, sessionKwh: number|null,
 *   frequency: number|null, temperature: number|null, charging: boolean, activePhases: number, firmware: string }}
 */
function parseConnect(settings = {}, measurements = {}) {
  const values = settings.Values || {};
  const charging = values.ChargingStatus || {};
  const current = values.ChargingCurrent || {};
  const energy = values.ChargingEnergy || {};
  const metadata = values.DeviceMetadata || {};
  const powerKw = finite(measurements.ChargingPower);

  const phases = [0, 1, 2].map((i) => ({
    powerW: at(measurements.ChargingPowerPhase, i) === null ? null : Math.round(at(measurements.ChargingPowerPhase, i) * 1000),
    current: at(measurements.ChargingCurrentPhase, i),
    voltage: at(measurements.VoltagePhase, i),
  }));
  const withVoltage = phases.filter((p) => p.voltage !== null && p.voltage > 150).length;

  const online = settings.Online !== false && measurements.Online !== false
    && !(settings.Info && settings.Info.Connected === false);

  return {
    online,
    enabled: typeof charging.Charging === 'boolean' ? charging.Charging : null,
    current: finite(current.Value),
    minCurrent: finite(current.Min),
    maxCurrent: finite(current.Max),
    energyLimitKwh: energy.Limited === true ? finite(energy.Value) : null,
    passwordMatch: typeof metadata.PasswordMatch === 'boolean' ? metadata.PasswordMatch : null,
    errors: errorCodes(settings),
    powerW: powerKw === null ? null : Math.round(powerKw * 1000),
    phases,
    totalKwh: finite(measurements.ChargingEnergyOverAll),
    sessionKwh: finite(measurements.ChargingEnergy),
    frequency: finite(measurements.Frequency),
    temperature: finite(measurements.TemperatureMainUnit),
    charging: powerKw !== null && powerKw >= CHARGING_THRESHOLD_KW,
    activePhases: withVoltage || 1,
    firmware: [settings.FirmwareVersion, settings.HardwareVersion].filter((v) => v !== undefined && v !== null && v !== '').join(' / '),
  };
}

/**
 * Homey's evcharger_charging_state. The Connect API cannot tell whether a car is plugged in (also noted by
 * evcc), so without charging power the state is "plugged in", or "paused" when charging is switched off.
 */
function connectChargingState({ charging, enabled }) {
  if (charging) return 'plugged_in_charging';
  return enabled === false ? 'plugged_in_paused' : 'plugged_in';
}

module.exports = { parseConnect, connectChargingState, CHARGING_THRESHOLD_KW };
