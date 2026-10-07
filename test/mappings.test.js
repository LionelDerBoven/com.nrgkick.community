'use strict';

const test = require('node:test');
const assert = require('node:assert');
const m = require('../lib/mappings');

const INFO_1P_32A = {
  general: { rated_current: 32 },
  connector: { phase_count: 1, max_current: 16, type: 2 },
  grid: { voltage: 230, frequency: 50, phases: 1 },
};
const INFO_3P_32A = {
  general: { rated_current: 32 },
  connector: { phase_count: 3, max_current: 32, type: 1 },
  grid: { voltage: 230, frequency: 50, phases: 7 },
};

test('codeToId maps raw codes, names and unknown values', () => {
  assert.strictEqual(m.codeToId(m.STATUS, 3), 'charging');
  assert.strictEqual(m.codeToId(m.STATUS, '2'), 'connected');
  assert.strictEqual(m.codeToId(m.STATUS, 'STANDBY'), 'standby');
  assert.strictEqual(m.codeToId(m.STATUS, 5), 'unknown');
  assert.strictEqual(m.codeToId(m.STATUS, 'SOMETHING'), 'unknown');
  assert.strictEqual(m.codeToId(m.STATUS, undefined), 'unknown');
  assert.strictEqual(m.codeToId(m.ERROR_CODES, 2), '32a_attachment_on_16a_unit');
  assert.strictEqual(m.codeToId(m.WARNING_CODES, 19), 'increased_domestic_plug_temperature');
});

test('pick and num accept the trailing-colon spelling of older firmware', () => {
  assert.strictEqual(m.num({ 'voltage:': '231.5' }, 'voltage'), 231.5);
  assert.strictEqual(m.num({ voltage: 230 }, 'voltage'), 230);
  assert.strictEqual(m.num({ voltage: null }, 'voltage'), null);
  assert.strictEqual(m.num(undefined, 'voltage'), null);
  assert.strictEqual(m.num({ voltage: 'abc' }, 'voltage'), null);
});

test('phase mask helpers', () => {
  assert.strictEqual(m.phaseCountFromMask(7), 3);
  assert.strictEqual(m.phaseCountFromMask(5), 2);
  assert.strictEqual(m.phaseCountFromMask(0), 0);
  assert.strictEqual(m.gridPhasesText(5), 'L1, L3');
  assert.strictEqual(m.gridPhasesText(0), '');
});

test('chargingState follows status and pause', () => {
  assert.strictEqual(m.chargingState('standby', false), 'plugged_out');
  assert.strictEqual(m.chargingState('charging', false), 'plugged_in_charging');
  assert.strictEqual(m.chargingState('connected', false), 'plugged_in');
  assert.strictEqual(m.chargingState('connected', true), 'plugged_in_paused');
  assert.strictEqual(m.chargingState('wakeup', true), 'plugged_in_paused');
  assert.strictEqual(m.chargingState('unknown', false), null);
});

test('limits come from the unit, the attachment and the grid', () => {
  assert.strictEqual(m.maxCurrent(INFO_1P_32A), 16);
  assert.strictEqual(m.maxCurrent(INFO_3P_32A), 32);
  assert.strictEqual(m.maxCurrent({}), 16);
  assert.strictEqual(m.availablePhases(INFO_1P_32A), 1);
  assert.strictEqual(m.availablePhases(INFO_3P_32A), 3);
  assert.strictEqual(m.activePhases(INFO_3P_32A, { phase_count: 1 }), 1);
  assert.strictEqual(m.activePhases(INFO_3P_32A, { phase_count: 0 }), 3);
  assert.strictEqual(m.activePhases(INFO_1P_32A, { phase_count: 3 }), 1);
});

test('targetPowerOptions spans 0 to the attachment maximum with a 6 A dead zone', () => {
  assert.deepStrictEqual(m.targetPowerOptions(INFO_1P_32A), {
    min: 0, max: 3680, step: 230, excludeMin: 0, excludeMax: 1380,
  });
  assert.deepStrictEqual(m.targetPowerOptions(INFO_3P_32A), {
    min: 0, max: 22080, step: 230, excludeMin: 0, excludeMax: 4140,
  });
});

test('wattsToCurrent and back', () => {
  const opts = { voltage: 230, phases: 1, max: 16 };
  assert.strictEqual(m.wattsToCurrent(0, opts), 0);
  assert.strictEqual(m.wattsToCurrent(-500, opts), 0);
  assert.strictEqual(m.wattsToCurrent(2300, opts), 10);
  assert.strictEqual(m.wattsToCurrent(2350, opts), 10.2);
  assert.strictEqual(m.wattsToCurrent(1000, opts), 6);
  assert.strictEqual(m.wattsToCurrent(9999, opts), 16);
  assert.strictEqual(m.wattsToCurrent(11040, { voltage: 230, phases: 3, max: 32 }), 16);
  assert.strictEqual(m.currentToWatts(16, { voltage: 230, phases: 3 }), 11040);
});
