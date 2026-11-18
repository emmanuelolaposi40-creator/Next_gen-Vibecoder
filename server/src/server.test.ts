import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';

test('REST API endpoints persist and query seeds, profiles, postcards, and sorties', async () => {
  const app = buildApp({ dbPath: ':memory:' });

  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);

  // Profile
  const profRes = await app.inject({
    method: 'POST',
    url: '/api/profile',
    payload: { token: 'test-tok-1', callsign: 'MAVERICK', tailColor: 'amber', invertY: true, sensitivity: 1.4 },
  });
  assert.equal(profRes.statusCode, 200);
  assert.equal(profRes.json().profile.callsign, 'MAVERICK');
  assert.equal(profRes.json().profile.tailColor, 'amber');

  // Seeds
  const seedCreate = await app.inject({
    method: 'POST',
    url: '/api/seeds',
    payload: { code: 'VALE-9911', name: 'Amber Valley', preset: 'crimson-dusk', creatorCallsign: 'MAVERICK' },
  });
  assert.equal(seedCreate.statusCode, 201);

  const upvote = await app.inject({ method: 'POST', url: '/api/seeds/VALE-9911/upvote' });
  assert.equal(upvote.statusCode, 200);
  assert.equal(upvote.json().seed.upvotes, 2);

  // Postcard
  const pcRes = await app.inject({
    method: 'POST',
    url: '/api/postcards',
    payload: {
      seedCode: 'VALE-9911',
      preset: 'crimson-dusk',
      callsign: 'MAVERICK',
      imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      altitude: 3100,
      speed: 420,
      gLoad: 2.3,
      heading: 180,
    },
  });
  assert.equal(pcRes.statusCode, 201);

  const pcList = await app.inject({ method: 'GET', url: '/api/postcards?seedCode=VALE-9911' });
  assert.equal(pcList.json().postcards.length, 1);

  // Sorties
  const sortRes = await app.inject({
    method: 'POST',
    url: '/api/sorties',
    payload: { seedCode: 'VALE-9911', callsign: 'MAVERICK', clearTimeMs: 42150, ringsCount: 8 },
  });
  assert.equal(sortRes.statusCode, 201);

  const sortList = await app.inject({ method: 'GET', url: '/api/sorties?seedCode=VALE-9911' });
  assert.equal(sortList.json().sorties.length, 1);
  assert.equal(sortList.json().sorties[0].clearTimeMs, 42150);

  await app.close();
});
