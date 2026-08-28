import test from 'node:test';
import assert from 'node:assert/strict';
import period from '../period-utils.js';

test('quinzenas de julho usam 15 e 16 dias', () => {
  assert.deepEqual(period.bounds('2026-07', '1'), {month: '2026-07', part: '1', start: 1, end: 15, days: 15});
  assert.deepEqual(period.bounds('2026-07', '2'), {month: '2026-07', part: '2', start: 16, end: 31, days: 16});
});

test('período mensal usa todos os dias do mês e preserva os 26 dias planejados FF', () => {
  assert.deepEqual(period.bounds('2026-07', 'monthly'), {month: '2026-07', part: 'monthly', start: 1, end: 31, days: 31});
  assert.equal(period.contains('2026-07-01', '2026-07', 'monthly'), true);
  assert.equal(period.contains('2026-07-31', '2026-07', 'monthly'), true);
  assert.equal(period.contains('2026-08-01', '2026-07', 'monthly'), false);
  assert.equal(period.fixedFleetPlannedDays(26, 'monthly'), 26);
});

test('segunda quinzena respeita o último dia de cada mês', () => {
  assert.equal(period.bounds('2026-02', '2').days, 13);
  assert.equal(period.bounds('2026-04', '2').days, 15);
  assert.equal(period.contains('2026-07-15', '2026-07', '1'), true);
  assert.equal(period.contains('2026-07-16', '2026-07', '1'), false);
  assert.equal(period.contains('2026-07-16', '2026-07', '2'), true);
  assert.equal(period.contains('2026-08-01', '2026-07', '2'), false);
});

test('utilização FF usa os dias da quinzena selecionada', () => {
  assert.equal(period.fixedFleetPlannedDays(26, '1'), 13);
  assert.equal(period.fixedFleetPlannedDays(26, '2'), 13);
  assert.equal(period.utilization(101, 7, 13), 101 / 91);
  assert.equal(period.utilization(101, 7, 26), 101 / 182);
  assert.equal(period.utilization(0, 0, 15), null);
});

test('detalhes financeiros aparecem somente no período mensal', () => {
  assert.equal(period.showsFinancialDetails('monthly'), true);
  assert.equal(period.showsFinancialDetails('1'), false);
  assert.equal(period.showsFinancialDetails('2'), false);
  assert.equal(period.showsFinancialDetails(undefined), false);
});

test('camada quinzenal reconhece todas as colunas e status financeiros', () => {
  assert.equal(period.isFinancialColumnLabel('FAIXA'), true);
  assert.equal(period.isFinancialColumnLabel('BÔNUS*'), true);
  assert.equal(period.isFinancialColumnLabel('Bônus anterior → atual'), true);
  assert.equal(period.isFinancialColumnLabel('VALOR'), true);
  assert.equal(period.isFinancialColumnLabel('DS MÉDIO'), false);
  assert.equal(period.isFinancialStatusLabel('Faixa atingida'), true);
  assert.equal(period.isFinancialStatusLabel('Faixa não atingida'), true);
  assert.equal(period.isFinancialStatusLabel('DS elegível'), false);
});
