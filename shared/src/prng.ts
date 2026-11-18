import type { RingTarget, TailAccentColor, WeatherPreset, WeatherPresetConfig } from './types.js';

export const WORLD_SIZE = 2048; // Seamless tiling domain in world units
export const WATER_LEVEL = 0.24; // Normalized height [0..1] where water meets shore
export const HEIGHT_SCALE = 170; // World units max terrain height

export const WEATHER_PRESETS: Record<WeatherPreset, WeatherPresetConfig> = {
  'last-light': {
    id: 'last-light',
    label: 'Last Light',
    description: 'Autumn lake country under a low golden sun and deep violet shadows.',
    sunElevationDeg: 11.5,
    sunAzimuthDeg: 232,
    cloudDensity: 0.48,
    snowLine: 0.78,
    hazeWarmRgb: [242, 168, 108],
    hazeCoolRgb: [134, 114, 164],
    skyZenithRgb: [46, 48, 92],
    skyHorizonRgb: [244, 174, 118],
    sunDiscRgb: [255, 236, 178],
  },
  'crimson-dusk': {
    id: 'crimson-dusk',
    label: 'Crimson Dusk',
    description: 'Smoldering ember horizon with copper clouds and indigo lakes.',
    sunElevationDeg: 7.5,
    sunAzimuthDeg: 248,
    cloudDensity: 0.56,
    snowLine: 0.84,
    hazeWarmRgb: [232, 112, 92],
    hazeCoolRgb: [86, 68, 128],
    skyZenithRgb: [32, 26, 68],
    skyHorizonRgb: [236, 124, 96],
    sunDiscRgb: [255, 198, 134],
  },
  'high-alpine': {
    id: 'high-alpine',
    label: 'High Alpine',
    description: 'Crisp late-afternoon clarity, lower snowline, and cool lilac ridges.',
    sunElevationDeg: 16.0,
    sunAzimuthDeg: 215,
    cloudDensity: 0.36,
    snowLine: 0.64,
    hazeWarmRgb: [246, 204, 152],
    hazeCoolRgb: [122, 144, 192],
    skyZenithRgb: [48, 72, 126],
    skyHorizonRgb: [238, 206, 168],
    sunDiscRgb: [255, 246, 208],
  },
};

export const TAIL_ACCENT_COLORS: Record<TailAccentColor, { label: string; hex: string; rgb: [number, number, number] }> = {
  red: { label: 'Crimson', hex: '#d9443b', rgb: [217, 68, 59] },
  amber: { label: 'Amber', hex: '#e89b32', rgb: [232, 155, 50] },
  teal: { label: 'Teal', hex: '#38b5a6', rgb: [56, 181, 166] },
  violet: { label: 'Violet', hex: '#9a68d9', rgb: [154, 104, 217] },
};

const SEED_PREFIXES = ['LAKE', 'PINE', 'DUSK', 'HAWK', 'MIST', 'VALE', 'CRAG', 'WING'];

export function hashSeedCode(seedCode: string): number {
  const clean = normalizeSeedCode(seedCode);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < clean.length; i++) {
    h ^= clean.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function normalizeSeedCode(seedCode: string): string {
  return seedCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 16) || 'LAKE-4821';
}

export function generateSeedCode(): string {
  const prefix = SEED_PREFIXES[Math.floor(Math.random() * SEED_PREFIXES.length)];
  const num = 1000 + Math.floor(Math.random() * 9000);
  return `${prefix}-${num}`;
}

export function createPrng(seed: number | string): () => number {
  let a = typeof seed === 'string' ? hashSeedCode(seed) : seed >>> 0;
  if (a === 0) a = 0x6d2b79f5;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2DPeriodic(ix: number, iy: number, period: number, seed: number): number {
  const px = ((ix % period) + period) % period;
  const py = ((iy % period) + period) % period;
  let h = (px * 374761393 + py * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function periodicValueNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);

  const a = hash2DPeriodic(ix, iy, period, seed);
  const b = hash2DPeriodic(ix + 1, iy, period, seed);
  const c = hash2DPeriodic(ix, iy + 1, period, seed);
  const d = hash2DPeriodic(ix + 1, iy + 1, period, seed);

  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/**
 * Evaluates deterministic seamlessly-tiling terrain height [0..1] at normalized UV [0..1).
 * Matches the Web Worker generator so server/client sortie rings align with actual terrain.
 */
export function sampleTerrainHeightNormalized(u: number, v: number, seedCode: string): number {
  const seed = hashSeedCode(seedCode);
  // Base continental & lake basin shapes
  let h = 0;
  let amp = 0.5;
  let period = 4;
  for (let oct = 0; oct < 6; oct++) {
    const n = periodicValueNoise(u, v, period, seed + oct * 1013);
    h += n * amp;
    amp *= 0.5;
    period *= 2;
  }
  // Ridged mountain octave
  const ridgeRaw = periodicValueNoise(u, v, 8, seed + 9001);
  const ridge = 1.0 - Math.abs(ridgeRaw * 2.0 - 1.0);
  const ridgeDetail = 1.0 - Math.abs(periodicValueNoise(u, v, 16, seed + 12007) * 2.0 - 1.0);
  const mountainMask = Math.max(0, (h - 0.42) * 1.8);
  h = h * 0.78 + (ridge * 0.65 + ridgeDetail * 0.35) * mountainMask * 0.42;

  // Carve winding lake basins
  const basin = periodicValueNoise(u, v, 3, seed + 4049);
  if (basin < 0.42) {
    const t = (0.42 - basin) / 0.42;
    h -= t * t * 0.28;
  }

  return Math.max(0, Math.min(1, h));
}

export function sampleTerrainWorldY(worldX: number, worldZ: number, seedCode: string): number {
  const u = (((worldX / WORLD_SIZE) % 1) + 1) % 1;
  const v = (((worldZ / WORLD_SIZE) % 1) + 1) % 1;
  const norm = sampleTerrainHeightNormalized(u, v, seedCode);
  return Math.max(norm, WATER_LEVEL) * HEIGHT_SCALE;
}

export function generateSortieRings(seedCode: string, count = 8): RingTarget[] {
  const rng = createPrng(`SORTIE:${normalizeSeedCode(seedCode)}`);
  const rings: RingTarget[] = [];
  let angle = rng() * Math.PI * 2;
  let cx = WORLD_SIZE * 0.5;
  let cz = WORLD_SIZE * 0.5;

  for (let i = 0; i < count; i++) {
    const step = 220 + rng() * 140;
    angle += (rng() - 0.5) * 0.95;
    cx = (cx + Math.cos(angle) * step + WORLD_SIZE) % WORLD_SIZE;
    cz = (cz + Math.sin(angle) * step + WORLD_SIZE) % WORLD_SIZE;

    const groundY = sampleTerrainWorldY(cx, cz, seedCode);
    const altitudeOffset = 34 + rng() * 44;
    rings.push({
      index: i,
      x: cx,
      y: groundY + altitudeOffset,
      z: cz,
      yaw: angle,
      radius: 18,
    });
  }
  return rings;
}
