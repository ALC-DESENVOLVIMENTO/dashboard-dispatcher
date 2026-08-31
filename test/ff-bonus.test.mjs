import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FixedFleetBonus = require('../ff-bonus.js');
const SpotBonus = require('../spot-bonus.js');

test('Frota Fixa paga R$ 1.300 somente acima de 100% de utilização', () => {
  assert.equal(FixedFleetBonus.payoutForUtilization(1.000001), 1300);
  assert.equal(FixedFleetBonus.payoutForUtilization(1.01), 1300);
  assert.equal(FixedFleetBonus.bandForUtilization(1.000001)?.label, 'Acima de 100%');
});

test('Frota Fixa mantém as faixas nos valores de fronteira', () => {
  assert.equal(FixedFleetBonus.payoutForUtilization(1), 1000);
  assert.equal(FixedFleetBonus.payoutForUtilization(.999999), 700);
  assert.equal(FixedFleetBonus.payoutForUtilization(.95), 700);
  assert.equal(FixedFleetBonus.payoutForUtilization(.949999), 350);
  assert.equal(FixedFleetBonus.payoutForUtilization(.9), 350);
  assert.equal(FixedFleetBonus.payoutForUtilization(.899999), 0);
});

test('a nova faixa de Frota Fixa não altera a regra Spot', () => {
  assert.equal(SpotBonus.bonusForCars(15).total, 1500);
  assert.equal(SpotBonus.bonusForCars(25).total, 2000);
});

test('Junho e Julho são recalculados pela mesma regra sem valor mensal em cache', () => {
  const periods = {
    '2026-06': [1.02, 1, .95],
    '2026-07': [1.08, 1.000001, .9]
  };
  const totals = Object.fromEntries(Object.entries(periods).map(([month, utilizations]) => [
    month,
    utilizations.reduce((sum, utilization) => sum + FixedFleetBonus.payoutForUtilization(utilization), 0)
  ]));
  assert.deepEqual(totals, {'2026-06': 3000, '2026-07': 2950});
});
