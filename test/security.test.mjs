import test from 'node:test';
import assert from 'node:assert/strict';
import { bonusCents, decodeBase64, normalizeRow, publicPath, recordKey, safeFileName } from '../server.mjs';

test('public file allowlist blocks backend and source files', () => {
  assert.match(publicPath('/index.html'), /index\.html$/);
  assert.equal(publicPath('/server.mjs'), null);
  assert.equal(publicPath('/package.json'), null);
  assert.equal(publicPath('/outputs/thread-01/Rotas%201%20a%2031%20Julho%20DDS%20preenchida.xlsx'), null);
  assert.equal(publicPath('/outputs/thread-01/../server.mjs'), null);
});

test('filename and base64 validation reject unsafe upload inputs', () => {
  assert.equal(safeFileName('C:\\temp\\dados.xlsx', 'fallback.xlsx'), 'dados.xlsx');
  assert.throws(() => safeFileName('.env', 'fallback.xlsx'), /file-name-invalid/);
  assert.deepEqual(decodeBase64(Buffer.from('ok').toString('base64'), 10), Buffer.from('ok'));
  assert.throws(() => decodeBase64('not base64!', 10), /file-invalid/);
  assert.throws(() => decodeBase64(Buffer.from('too long').toString('base64'), 2), /file-too-large/);
});

test('rows are flat, bounded and safe to persist', () => {
  assert.deepEqual(normalizeRow({ Base: 'A', total: 3 }), { Base: 'A', total: 3 });
  assert.throws(() => normalizeRow({ nested: { value: 'x' } }), /row-nested-value/);
  assert.throws(() => normalizeRow({ value: 'x'.repeat(10001) }), /row-value-invalid/);
});

test('record keys are deterministic and bonus amounts are policy constrained', () => {
  const row = { rota: '123', data: '2026-07-01', placa: 'ABC-1234' };
  assert.equal(recordKey(row, 1), recordKey(row, 999));
  assert.equal(bonusCents(1000, 'ff'), 100000);
  assert.equal(bonusCents(333.33, 'spot'), 33333);
  assert.equal(bonusCents(300, 'spot'), 30000);
  assert.throws(() => bonusCents(9999, 'ff'), /bonus-amount-not-in-policy/);
  assert.throws(() => bonusCents(10.005, 'spot'), /bonus-amount-invalid/);
});
