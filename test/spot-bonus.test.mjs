import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const SpotBonus = require('../spot-bonus.js');

test('bônus total Spot permanece igual ao valor da faixa em qualquer divisão', () => {
  for (const band of SpotBonus.bands) {
    for (let dispatchers = 1; dispatchers <= 100; dispatchers += 1) {
      const result = SpotBonus.bonusForCars(band.cars, dispatchers);
      assert.equal(result.total, band.total);
      assert.equal(result.dispatcherCount, dispatchers);
      assert.equal(result.perDispatcherCents, Math.round((band.total * 100) / dispatchers));
    }
  }
});

test('Cuiabá mantém a faixa total de R$ 1.500 ao dividir entre seus seis dispatchers', async () => {
  const reference = JSON.parse(await readFile(new URL('../outputs/thread-01/dispatcher_bases.json', import.meta.url), 'utf8'));
  const dispatcherCount = reference.bases['CUIABA SMR1'].dispatchers.length;
  const result = SpotBonus.bonusForCars(23.2, dispatcherCount);
  assert.equal(dispatcherCount, 6);
  assert.equal(result.band.cars, 15);
  assert.equal(result.total, 1500);
  assert.equal(result.perDispatcher, 250);
});

test('limites das faixas não promovem volume abaixo do mínimo', () => {
  assert.equal(SpotBonus.bonusForCars(9.999, 2).total, 0);
  assert.equal(SpotBonus.bonusForCars(10, 2).total, 1000);
  assert.equal(SpotBonus.bonusForCars(14.999, 2).total, 1000);
  assert.equal(SpotBonus.bonusForCars(15, 2).total, 1500);
});
