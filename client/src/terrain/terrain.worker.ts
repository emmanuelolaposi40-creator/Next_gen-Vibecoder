import {
  WATER_LEVEL,
  WEATHER_PRESETS,
  createPrng,
  hashSeedCode,
  sampleTerrainHeightNormalized,
  type WeatherPreset,
} from '@patrol/shared';

interface WorkerRequest {
  seedCode: string;
  preset: WeatherPreset;
  size?: number;
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { seedCode, preset, size = 512 } = ev.data;
  const heights = new Float32Array(size * size);
  const forestNoise = new Float32Array(size * size);
  const detailNoise = new Float32Array(size * size);
  const rng = createPrng(`BIOME:${seedCode}`);
  const phaseX = rng() * 100;
  const phaseY = rng() * 100;
  const seedNum = hashSeedCode(seedCode);

  // 1. Heightfield + biome noise (0..65% progress)
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      heights[idx] = sampleTerrainHeightNormalized(u, v, seedCode);

      // Periodic trigonometric + hash-warped forest/meadow patch mask
      const tau = Math.PI * 2;
      const f1 = Math.sin((u * 6 + phaseX) * tau) * Math.cos((v * 6 + phaseY) * tau);
      const f2 = Math.sin((u * 13 - v * 9 + phaseY) * tau) * 0.5;
      const f3 = Math.cos((u * 23 + v * 19 + seedNum * 0.001) * tau) * 0.25;
      forestNoise[idx] = Math.max(0, Math.min(1, 0.5 + (f1 + f2 + f3) * 0.35));

      const d =
        Math.sin((u * 31 + v * 27) * tau) * 0.5 +
        Math.cos((u * 47 - v * 41) * tau) * 0.5;
      detailNoise[idx] = Math.max(0, Math.min(1, 0.5 + d * 0.4));
    }

    if (y % 32 === 0) {
      self.postMessage({
        type: 'progress',
        percent: Math.round((y / size) * 65),
        stage: 'SCULPTING LAKE BASINS',
      });
    }
  }

  // 2. Bake long directional shadows from sun direction (65..95% progress)
  const cfg = WEATHER_PRESETS[preset] ?? WEATHER_PRESETS['last-light'];
  const azRad = (cfg.sunAzimuthDeg * Math.PI) / 180;
  const elRad = (cfg.sunElevationDeg * Math.PI) / 180;
  const sunDirX = Math.cos(azRad);
  const sunDirY = Math.sin(azRad);
  const sunSlope = Math.tan(elRad) * 2.4; // scaled to normalized height domain

  const rgba = new Uint8Array(size * size * 4);
  const maxSteps = 44;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const h0 = Math.max(heights[idx], WATER_LEVEL);
      let shadow = 1.0;

      // March toward sun
      for (let s = 1; s <= maxSteps; s++) {
        const distNorm = (s * 1.4) / size;
        const sx = (((Math.round(x + sunDirX * s * 1.4) % size) + size) % size);
        const sy = (((Math.round(y + sunDirY * s * 1.4) % size) + size) % size);
        const hs = heights[sy * size + sx];
        const rayH = h0 + distNorm * sunSlope;
        if (hs > rayH) {
          shadow = 0.0;
          break;
        }
      }

      const o = idx * 4;
      rgba[o] = Math.round(heights[idx] * 255);
      rgba[o + 1] = Math.round(shadow * 255);
      rgba[o + 2] = Math.round(forestNoise[idx] * 255);
      rgba[o + 3] = Math.round(detailNoise[idx] * 255);
    }

    if (y % 32 === 0) {
      self.postMessage({
        type: 'progress',
        percent: 65 + Math.round((y / size) * 30),
        stage: 'BAKING AUTUMN SHADOWS',
      });
    }
  }

  self.postMessage(
    {
      type: 'done',
      size,
      rgba: rgba.buffer,
    },
    [rgba.buffer]
  );
};
