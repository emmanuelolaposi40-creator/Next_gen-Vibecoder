import { HEIGHT_SCALE, WATER_LEVEL, WORLD_SIZE, type WeatherPreset } from '@patrol/shared';

export interface TerrainMapData {
  size: number;
  rgba: Uint8Array;
}

export function generateTerrainInWorker(
  seedCode: string,
  preset: WeatherPreset,
  onProgress: (percent: number, stage: string) => void
): Promise<TerrainMapData> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        onProgress(msg.percent, msg.stage);
      } else if (msg.type === 'done') {
        onProgress(100, 'SECTOR READY');
        const rgba = new Uint8Array(msg.rgba);
        worker.terminate();
        resolve({ size: msg.size, rgba });
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };

    worker.postMessage({ seedCode, preset, size: 512 });
  });
}

export function sampleTerrainCpu(
  terrain: TerrainMapData,
  worldX: number,
  worldZ: number
): { groundY: number; rawNorm: number; isWater: boolean } {
  const { size, rgba } = terrain;
  const u = (((worldX / WORLD_SIZE) % 1) + 1) % 1;
  const v = (((worldZ / WORLD_SIZE) % 1) + 1) % 1;

  const fx = u * size;
  const fy = v * size;
  const x0 = Math.floor(fx) % size;
  const y0 = Math.floor(fy) % size;
  const x1 = (x0 + 1) % size;
  const y1 = (y0 + 1) % size;
  const tx = fx - Math.floor(fx);
  const ty = fy - Math.floor(fy);

  const h00 = rgba[(y0 * size + x0) * 4] / 255;
  const h10 = rgba[(y0 * size + x1) * 4] / 255;
  const h01 = rgba[(y1 * size + x0) * 4] / 255;
  const h11 = rgba[(y1 * size + x1) * 4] / 255;

  const h0 = h00 + (h10 - h00) * tx;
  const h1 = h01 + (h11 - h01) * tx;
  const rawNorm = h0 + (h1 - h0) * ty;
  const isWater = rawNorm <= WATER_LEVEL;
  const groundY = Math.max(rawNorm, WATER_LEVEL) * HEIGHT_SCALE;

  return { groundY, rawNorm, isWater };
}
