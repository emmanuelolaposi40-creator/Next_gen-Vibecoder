import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPrng,
  generateSortieRings,
  normalizeSeedCode,
  sampleTerrainHeightNormalized,
} from './prng.js';

test('normalizeSeedCode sanitizes and uppercases seed strings', () => {
  assert.equal(normalizeSeedCode('  lake-4821! '), 'LAKE-4821');
  assert.equal(normalizeSeedCode(''), 'LAKE-4821');
});

test('createPrng is deterministic for identical seeds', () => {
  const a = createPrng('LAKE-4821');
  const b = createPrng('lake-4821');
  for (let i = 0; i < 10; i++) {
    assert.equal(a(), b());
  }
});

test('sampleTerrainHeightNormalized tiles seamlessly across [0, 1)', () => {
  const h0 = sampleTerrainHeightNormalized(0.0, 0.37, 'PINE-1234');
  const h1 = sampleTerrainHeightNormalized(1.0, 0.37, 'PINE-1234');
  assert.ok(Math.abs(h0 - h1) < 1e-6);
});

test('generateSortieRings produces deterministic ring positions above terrain', () => {
  const r1 = generateSortieRings('HAWK-9001', 8);
  const r2 = generateSortieRings('HAWK-9001', 8);
  assert.equal(r1.length, 8);
  assert.deepEqual(r1, r2);
  for (const ring of r1) {
    assert.ok(ring.y > 40);
  }
});
