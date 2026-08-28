import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const referencePath = new URL('../outputs/thread-01/dispatcher_bases.json', import.meta.url);

test('bases da antiga coordenação permanecem sem coordenadora e preservam dispatchers', async () => {
  const reference = JSON.parse(await readFile(referencePath, 'utf8'));
  const affectedBases = [
    'BARRETOS SSP31',
    'BAURU SSP14',
    'GOIANIA SGO1',
    'HIDROLANDIA SGO3',
    'JALES SSP28',
    'MARILIA SSP13',
    'RIBEIRAO PRETO SSP57',
    'SAO CARLOS SSP22',
    'SAO JOSE DO RIO PRETO SSP12',
  ];

  for (const base of affectedBases) {
    assert.equal(reference.bases[base].coordinator, '', `${base} deve permanecer sem coordenadora`);
    assert.ok(reference.bases[base].dispatchers.length > 0, `${base} deve preservar seus dispatchers`);
  }

  const formerCoordinator = Object.values(reference.bases).filter(base => /VIVIANE\s+PAN?SANI/i.test(base.coordinator || ''));
  assert.equal(formerCoordinator.length, 0);
});
