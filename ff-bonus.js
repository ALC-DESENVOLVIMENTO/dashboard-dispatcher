(function exposeFixedFleetBonus(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BonusFF = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createFixedFleetBonus() {
  'use strict';

  const bands = Object.freeze([
    Object.freeze({label: 'Acima de 100%', min: 1, strict: true, payout: 1300}),
    Object.freeze({label: '100%', min: 1, strict: false, payout: 1000}),
    Object.freeze({label: '95%', min: .95, strict: false, payout: 700}),
    Object.freeze({label: '90%', min: .9, strict: false, payout: 350})
  ]);

  function bandForUtilization(value) {
    const utilization = Number(value);
    if (!Number.isFinite(utilization) || utilization < 0) return null;
    return bands.find(band => band.strict ? utilization > band.min : utilization >= band.min) || null;
  }

  function payoutForUtilization(value) {
    return bandForUtilization(value)?.payout || 0;
  }

  return Object.freeze({bands, bandForUtilization, payoutForUtilization});
});
