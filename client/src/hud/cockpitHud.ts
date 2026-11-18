import { WORLD_SIZE, type WingmanState } from '@patrol/shared';
import type { FlightSim } from '../sim/flightSim.js';
import type { TerrainMapData } from '../terrain/terrainLoader.js';

export class CockpitHud {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private radarSweep = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
  }

  public render(
    dt: number,
    internalW: number,
    internalH: number,
    sim: FlightSim,
    terrain: TerrainMapData | null,
    wingmen: WingmanState[],
    activeRing: { x: number; z: number } | null
  ): void {
    if (sim.cameraMode !== 'cockpit') {
      this.canvas.style.display = 'none';
      return;
    }
    this.canvas.style.display = 'block';

    if (this.canvas.width !== internalW || this.canvas.height !== internalH) {
      this.canvas.width = internalW;
      this.canvas.height = internalH;
      this.ctx.imageSmoothingEnabled = false;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, internalW, internalH);

    this.radarSweep = (this.radarSweep + dt * 2.2) % (Math.PI * 2);

    const scale = internalH / 340;
    const w = internalW / scale;
    const h = 340;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h * 0.36);

    ctx.save();
    ctx.scale(scale, scale);

    // 1. Canopy frame struts
    ctx.strokeStyle = '#1b1628';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.62);
    ctx.lineTo(w * 0.14, 0);
    ctx.moveTo(w, h * 0.62);
    ctx.lineTo(w * 0.86, 0);
    ctx.stroke();

    // 2. Collimated Pixel HUD (emerald-amber retro phosphor)
    const hudCol = '#72f29c';
    const warnCol = '#ff6b4a';
    ctx.save();
    ctx.strokeStyle = hudCol;
    ctx.fillStyle = hudCol;
    ctx.font = 'bold 8px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'middle';

    // Top Heading Tape
    const hdgDeg = (((-sim.yaw * 180) / Math.PI) % 360 + 360) % 360;
    const tapeW = 140;
    const tapeY = 18;
    ctx.strokeRect(cx - tapeW / 2, tapeY - 6, tapeW, 12);
    for (let degOff = -30; degOff <= 30; degOff += 10) {
      const tickX = cx + (degOff / 30) * (tapeW / 2 - 8);
      ctx.fillRect(Math.round(tickX), tapeY + 2, 1, 4);
      const val = Math.round(((hdgDeg + degOff + 360) % 360) / 10) * 10;
      if (degOff % 20 === 0) {
        ctx.textAlign = 'center';
        ctx.fillText(String(val % 360).padStart(3, '0'), tickX, tapeY - 1);
      }
    }
    ctx.textAlign = 'center';
    ctx.fillText(`HDG ${String(Math.round(hdgDeg)).padStart(3, '0')}`, cx, tapeY + 13);

    // Collimated Pitch Ladder aligned with real 3D horizon
    // Vertical pixels per radian based on cockpit FOV (1.02 rad)
    const pxPerRad = (h * 0.5) / Math.tan(1.02 * 0.5);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - 88, 28, 176, h * 0.54);
    ctx.clip();

    ctx.translate(cx, cy);
    ctx.rotate(-sim.roll);
    const pitchPx = sim.pitch * pxPerRad;
    ctx.translate(0, pitchPx);

    // Horizon line
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-72, 0);
    ctx.lineTo(-14, 0);
    ctx.moveTo(14, 0);
    ctx.lineTo(72, 0);
    ctx.stroke();

    // Pitch rungs every 10 deg
    for (let deg = -30; deg <= 30; deg += 10) {
      if (deg === 0) continue;
      const yOff = -(deg * Math.PI) / 180 * pxPerRad;
      ctx.beginPath();
      ctx.moveTo(-30, yOff);
      ctx.lineTo(-12, yOff);
      ctx.moveTo(12, yOff);
      ctx.lineTo(30, yOff);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(String(deg), -33, yOff);
      ctx.textAlign = 'left';
      ctx.fillText(String(deg), 33, yOff);
    }
    ctx.restore();

    // Waterline / boresight cross
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy);
    ctx.lineTo(cx - 3, cy);
    ctx.moveTo(cx + 3, cy);
    ctx.lineTo(cx + 8, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();

    // Left Airspeed & Right Altitude tapes/readouts
    const kts = Math.round(sim.speed * 4.8);
    const altFt = Math.round(sim.y * 32);
    const radAltFt = Math.round(sim.agl * 32);
    ctx.textAlign = 'left';
    ctx.fillText(`IAS ${kts}`, cx - 125, cy - 10);
    ctx.fillText(`G   ${sim.gLoad.toFixed(1)}`, cx - 125, cy + 4);
    ctx.fillText(`MSL ${sim.getReadyMissileCount()}/4`, cx - 125, cy + 18);

    ctx.textAlign = 'right';
    ctx.fillText(`ALT ${altFt}`, cx + 125, cy - 10);
    ctx.fillText(`RAD ${radAltFt}`, cx + 125, cy + 4);
    ctx.fillText(sim.afterburner ? 'AB ON' : 'MIL', cx + 125, cy + 18);

    // Dynamic HUD Warnings
    if (sim.agl < 14) {
      ctx.fillStyle = warnCol;
      ctx.textAlign = 'center';
      ctx.fillText('! LOW ALTITUDE - PULL UP !', cx, cy - 42);
    } else if (sim.gLoad > 4.5) {
      ctx.fillStyle = warnCol;
      ctx.textAlign = 'center';
      ctx.fillText('! HIGH G !', cx, cy - 42);
    }
    ctx.restore();

    // 3. Hand-Plotted Pixel Instrument Panel (bottom 38% of screen)
    const panelTop = Math.floor(h * 0.62);
    const panelH = h - panelTop;

    // Panel backdrop & glare shield
    ctx.fillStyle = '#1b1726';
    ctx.fillRect(0, panelTop, w, panelH);
    ctx.fillStyle = '#2d263d';
    ctx.fillRect(0, panelTop, w, 3);
    ctx.fillStyle = '#0f0c18';
    ctx.fillRect(0, panelTop + 3, w, 2);

    // Animated physical throttle lever on left console
    const thX = Math.max(10, cx - 220);
    const thY = panelTop + 16;
    ctx.fillStyle = '#100d18';
    ctx.fillRect(thX, thY, 18, 76);
    ctx.strokeStyle = '#5c4a78';
    ctx.strokeRect(thX, thY, 18, 76);
    const knobY = thY + 64 - sim.throttle * 54;
    ctx.fillStyle = sim.afterburner ? '#e05347' : '#d49a56';
    ctx.fillRect(thX - 3, Math.round(knobY), 24, 10);

    // Gauges layout centered around cx
    const rDial = 23;
    const row1Y = panelTop + 34;
    const row2Y = panelTop + 88;

    // 1) Airspeed Dial
    this.drawDial(ctx, cx - 150, row1Y, rDial, 'IAS', `${kts}`, (kts / 600) * Math.PI * 1.6 - Math.PI * 0.8);

    // 2) Artificial Horizon
    this.drawArtificialHorizon(ctx, cx - 88, row1Y, rDial, sim.pitch, sim.roll);

    // 3) Altimeter
    this.drawDial(
      ctx,
      cx - 26,
      row1Y,
      rDial,
      'ALT',
      `${altFt}`,
      ((altFt % 2000) / 2000) * Math.PI * 2 - Math.PI * 0.5
    );

    // 4) Turn & Slip Coordinator
    this.drawTurnSlip(ctx, cx - 150, row2Y, 20, sim.roll);

    // 5) Compass Heading Indicator
    this.drawCompass(ctx, cx - 88, row2Y, 20, hdgDeg);

    // 6) VSI
    const vsiNorm = Math.max(-1, Math.min(1, sim.vsi / 35));
    this.drawDial(ctx, cx - 26, row2Y, 20, 'VSI', `${Math.round(sim.vsi * 10)}`, vsiNorm * 1.3);

    // 7) Amber Ground-Mapping Radar (center-right)
    this.drawRadar(
      ctx,
      cx + 46,
      panelTop + 60,
      44,
      sim,
      terrain,
      wingmen,
      activeRing
    );

    // 8) Dual Engine RPM / EGT Gauges
    const rpmPct = Math.round(72 + sim.throttle * 28);
    const egtC = Math.round(520 + sim.throttle * 340);
    this.drawBarGauge(ctx, cx + 112, panelTop + 16, 26, 44, 'RPM', `${rpmPct}%`, sim.throttle);
    this.drawBarGauge(ctx, cx + 144, panelTop + 16, 26, 44, 'EGT', `${egtC}`, sim.afterburner ? 0.95 : 0.62);

    // 9) Cockpit Clock (player's real local time)
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);
    ctx.fillStyle = '#0e0b16';
    ctx.fillRect(cx + 112, panelTop + 68, 58, 18);
    ctx.strokeStyle = '#5c4a78';
    ctx.strokeRect(cx + 112, panelTop + 68, 58, 18);
    ctx.fillStyle = '#f4ae5c';
    ctx.font = 'bold 8px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, cx + 141, panelTop + 77);

    // 10) Illuminated Warning Lamps
    const lamps = [
      { label: 'LOW ALT', active: sim.agl < 14, col: '#e05347' },
      { label: 'HIGH G', active: sim.gLoad > 4.2, col: '#f4ae5c' },
      { label: 'RE-ARM', active: sim.getReadyMissileCount() < 4, col: '#4bc4b0' },
    ];
    lamps.forEach((lamp, i) => {
      const lx = cx + 112 + i * 20;
      const ly = panelTop + 92;
      ctx.fillStyle = lamp.active ? lamp.col : '#241e33';
      ctx.fillRect(lx, ly, 18, 14);
      ctx.strokeStyle = '#5c4a78';
      ctx.strokeRect(lx, ly, 18, 14);
      ctx.fillStyle = lamp.active ? '#120e1a' : '#71618c';
      ctx.font = 'bold 6px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(lamp.label.slice(0, 3), lx + 9, ly + 7);
    });
    ctx.restore();
  }

  private drawDial(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    label: string,
    value: string,
    angle: number
  ): void {
    ctx.fillStyle = '#0d0a16';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6e5c8a';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Ticks
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.fillStyle = '#a493bd';
      ctx.fillRect(Math.round(cx + Math.cos(a) * (r - 3)), Math.round(cy + Math.sin(a) * (r - 3)), 1, 1);
    }

    // Needle
    ctx.strokeStyle = '#f4ae5c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * (r - 5), cy + Math.sin(angle) * (r - 5));
    ctx.stroke();

    ctx.fillStyle = '#e7d8c5';
    ctx.font = 'bold 7px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy - 7);
    ctx.fillStyle = '#f4ae5c';
    ctx.fillText(value, cx, cy + 9);
  }

  private drawArtificialHorizon(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    pitch: number,
    roll: number
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    ctx.translate(cx, cy);
    ctx.rotate(-roll);
    const pOff = pitch * 26;
    ctx.fillStyle = '#3a5c8a';
    ctx.fillRect(-r * 2, -r * 2 + pOff, r * 4, r * 2);
    ctx.fillStyle = '#734a2e';
    ctx.fillRect(-r * 2, pOff, r * 4, r * 2);
    ctx.fillStyle = '#f7ead9';
    ctx.fillRect(-r, pOff, r * 2, 1);
    ctx.restore();

    ctx.strokeStyle = '#6e5c8a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Fixed aircraft symbol
    ctx.strokeStyle = '#f4ae5c';
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy);
    ctx.lineTo(cx + 8, cy);
    ctx.stroke();
  }

  private drawTurnSlip(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    roll: number
  ): void {
    ctx.fillStyle = '#0d0a16';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6e5c8a';
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy - 2);
    ctx.rotate(-roll * 0.6);
    ctx.strokeStyle = '#f7ead9';
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(10, 0);
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -4);
    ctx.stroke();
    ctx.restore();

    // Slip ball
    ctx.fillStyle = '#251e33';
    ctx.fillRect(cx - 10, cy + 7, 20, 4);
    const ballX = cx + Math.max(-7, Math.min(7, roll * 7));
    ctx.fillStyle = '#f4ae5c';
    ctx.fillRect(Math.round(ballX - 2), cy + 7, 4, 4);
  }

  private drawCompass(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    hdgDeg: number
  ): void {
    ctx.fillStyle = '#0d0a16';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6e5c8a';
    ctx.stroke();

    const rad = (-hdgDeg * Math.PI) / 180 - Math.PI * 0.5;
    ctx.strokeStyle = '#e05347';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * (r - 5), cy + Math.sin(rad) * (r - 5));
    ctx.stroke();

    ctx.fillStyle = '#f4ae5c';
    ctx.font = 'bold 7px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - r + 6);
    ctx.fillText(String(Math.round(hdgDeg)).padStart(3, '0'), cx, cy + 6);
  }

  private drawRadar(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    sim: FlightSim,
    terrain: TerrainMapData | null,
    wingmen: WingmanState[],
    activeRing: { x: number; z: number } | null
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#140c06';
    ctx.fill();
    ctx.clip();

    // Terrain contour dots in amber
    if (terrain) {
      const range = 360;
      const step = 4;
      const cosY = Math.cos(sim.yaw);
      const sinY = Math.sin(sim.yaw);
      for (let py = -r; py <= r; py += step) {
        for (let px = -r; px <= r; px += step) {
          if (px * px + py * py > r * r) continue;
          const dx = (px / r) * range;
          const dz = (py / r) * range;
          const wx = sim.x + dx * cosY - dz * sinY;
          const wz = sim.z + dx * sinY + dz * cosY;
          const u = (((wx / WORLD_SIZE) % 1) + 1) % 1;
          const v = (((wz / WORLD_SIZE) % 1) + 1) % 1;
          const tx = Math.floor(u * terrain.size);
          const ty = Math.floor(v * terrain.size);
          const hVal = terrain.rgba[(ty * terrain.size + tx) * 4] / 255;
          if (hVal > 0.25) {
            ctx.fillStyle = hVal > 0.56 ? '#f4ae5c' : '#6e4219';
            ctx.fillRect(cx + px, cy + py, 2, 2);
          }
        }
      }
    }

    // Rotating sweep beam
    ctx.strokeStyle = 'rgba(244, 174, 92, 0.7)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(this.radarSweep) * r, cy + Math.sin(this.radarSweep) * r);
    ctx.stroke();

    // Wingmen blips
    const cosY = Math.cos(-sim.yaw);
    const sinY = Math.sin(-sim.yaw);
    for (const w of wingmen) {
      let dx = w.x - sim.x;
      let dz = w.z - sim.z;
      if (dx > WORLD_SIZE / 2) dx -= WORLD_SIZE;
      if (dx < -WORLD_SIZE / 2) dx += WORLD_SIZE;
      if (dz > WORLD_SIZE / 2) dz -= WORLD_SIZE;
      if (dz < -WORLD_SIZE / 2) dz += WORLD_SIZE;

      const rx = (dx * cosY - dz * sinY) / 360 * r;
      const ry = (dx * sinY + dz * cosY) / 360 * r;
      if (rx * rx + ry * ry <= r * r) {
        ctx.fillStyle = '#4bc4b0';
        ctx.fillRect(Math.round(cx + rx - 1), Math.round(cy + ry - 1), 3, 3);
      }
    }

    // Sortie ring blip
    if (activeRing) {
      let dx = activeRing.x - sim.x;
      let dz = activeRing.z - sim.z;
      if (dx > WORLD_SIZE / 2) dx -= WORLD_SIZE;
      if (dx < -WORLD_SIZE / 2) dx += WORLD_SIZE;
      if (dz > WORLD_SIZE / 2) dz -= WORLD_SIZE;
      if (dz < -WORLD_SIZE / 2) dz += WORLD_SIZE;
      const rx = Math.max(-r + 3, Math.min(r - 3, (dx * cosY - dz * sinY) / 360 * r));
      const ry = Math.max(-r + 3, Math.min(r - 3, (dx * sinY + dz * cosY) / 360 * r));
      ctx.strokeStyle = '#fff2dc';
      ctx.strokeRect(Math.round(cx + rx - 2), Math.round(cy + ry - 2), 4, 4);
    }

    // Center ownship cross
    ctx.fillStyle = '#fff2dc';
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
    ctx.restore();

    ctx.strokeStyle = '#9c6b30';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawBarGauge(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    valText: string,
    norm: number
  ): void {
    ctx.fillStyle = '#0d0a16';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#5c4a78';
    ctx.strokeRect(x, y, w, h);

    const fillH = Math.round((h - 14) * Math.max(0, Math.min(1, norm)));
    ctx.fillStyle = norm > 0.85 ? '#e05347' : '#f4ae5c';
    ctx.fillRect(x + 4, y + h - 10 - fillH, w - 8, fillH);

    ctx.fillStyle = '#e7d8c5';
    ctx.font = 'bold 6px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, x + w / 2, y + 2);
    ctx.fillStyle = '#f4ae5c';
    ctx.fillText(valText, x + w / 2, y + h - 8);
  }
}
