import {
  HEIGHT_SCALE,
  WATER_LEVEL,
  WORLD_SIZE,
  type CameraMode,
  type TailAccentColor,
} from '@patrol/shared';
import type { Vec3 } from '../math/mat4.js';
import type {
  RenderImpact,
  RenderMissile,
  RenderParticle,
} from '../render/renderer.js';
import { sampleTerrainCpu, type TerrainMapData } from '../terrain/terrainLoader.js';

export interface ActiveMissile extends RenderMissile {
  vx: number;
  vy: number;
  vz: number;
  life: number;
  isRemote: boolean;
}

interface SimParticle extends RenderParticle {
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  grow: number;
}

interface SimImpact extends RenderImpact {
  life: number;
  maxLife: number;
}

export interface FlightInput {
  /** Normalized cursor [-1..1] from screen center */
  cursorX: number;
  cursorY: number;
  hasMouseMoved: boolean;
  afterburner: boolean;
  invertY: boolean;
  sensitivity: number;
}

export class FlightSim {
  // Position & attitude
  public x = WORLD_SIZE * 0.5;
  public y = 96;
  public z = WORLD_SIZE * 0.5;
  public yaw = 0.6; // radians, 0 = -Z (North)
  public pitch = 0;
  public roll = 0;
  public speed = 64;
  public throttle = 0.65;
  public afterburner = false;
  public gLoad = 1.0;
  public vsi = 0; // vertical speed
  public agl = 50; // radar altitude above ground/water
  public overWater = false;

  public tailColor: TailAccentColor = 'red';

  // Camera state
  public cameraMode: CameraMode = 'chase';
  private prevCamPos: Vec3 = [0, 100, 0];
  private prevCamTarget: Vec3 = [0, 96, 0];
  private prevCamUp: Vec3 = [0, 1, 0];
  private camBlend = 1.0;

  // Barrel roll state
  private barrelRollTimer = 0;
  private barrelRollDir = 1;

  // 4 missile rails: 0 = ready, >0 = re-arming countdown in seconds
  public railCooldowns: [number, number, number, number] = [0, 0, 0, 0];
  private nextRailIdx = 0;

  public missiles: ActiveMissile[] = [];
  public particles: SimParticle[] = [];
  public impacts: SimImpact[] = [];

  private trailTimer = 0;
  private time = 0;

  // Event callbacks for audio/network
  public onMissileImpact?: (isWater: boolean, distFromJet: number) => void;

  public resetPosition(): void {
    this.x = WORLD_SIZE * 0.5;
    this.y = 98;
    this.z = WORLD_SIZE * 0.5;
    this.yaw = 0.6;
    this.pitch = 0;
    this.roll = 0;
    this.speed = 64;
    this.missiles = [];
    this.particles = [];
    this.impacts = [];
    this.railCooldowns = [0, 0, 0, 0];
  }

  public cycleCamera(): CameraMode {
    const order: CameraMode[] = ['topdown', 'chase', 'cockpit'];
    const next = order[(order.indexOf(this.cameraMode) + 1) % order.length];
    const cur = this.computeRawCamera(this.cameraMode);
    this.prevCamPos = cur.pos;
    this.prevCamTarget = cur.target;
    this.prevCamUp = cur.up;
    this.cameraMode = next;
    this.camBlend = 0.0;
    return next;
  }

  public triggerBarrelRoll(): void {
    if (this.barrelRollTimer <= 0) {
      this.barrelRollTimer = 0.48;
      this.barrelRollDir = this.roll >= 0 ? 1 : -1;
    }
  }

  public fireMissile(isRemote = false, override?: Partial<ActiveMissile>): boolean {
    if (!isRemote) {
      // Find a ready rail
      let found = -1;
      for (let i = 0; i < 4; i++) {
        const idx = (this.nextRailIdx + i) % 4;
        if (this.railCooldowns[idx] <= 0) {
          found = idx;
          break;
        }
      }
      if (found === -1) return false;
      this.railCooldowns[found] = 4.2;
      this.nextRailIdx = (found + 1) % 4;

      // Forward vector from yaw/pitch
      const cp = Math.cos(this.pitch);
      const fx = -Math.sin(this.yaw) * cp;
      const fy = Math.sin(this.pitch);
      const fz = -Math.cos(this.yaw) * cp;

      // When flying level, angle slightly downward toward terrain/water ahead
      const downBias = this.pitch > -0.06 ? -0.14 : 0;
      const mSpeed = this.speed + 125;
      const rx = Math.cos(this.yaw) * (found % 2 === 0 ? -1.4 : 1.4);
      const rz = -Math.sin(this.yaw) * (found % 2 === 0 ? -1.4 : 1.4);

      this.missiles.push({
        x: this.x + rx,
        y: this.y - 0.3,
        z: this.z + rz,
        vx: fx * mSpeed,
        vy: (fy + downBias) * mSpeed,
        vz: fz * mSpeed,
        yaw: this.yaw,
        pitch: this.pitch + downBias,
        roll: 0,
        life: 5.5,
        isRemote: false,
      });
      return true;
    } else if (override && override.x !== undefined) {
      this.missiles.push({
        x: override.x,
        y: override.y ?? 90,
        z: override.z ?? 0,
        vx: override.vx ?? 0,
        vy: override.vy ?? -10,
        vz: override.vz ?? -120,
        yaw: Math.atan2(-(override.vx ?? 0), -(override.vz ?? -1)),
        pitch: 0,
        roll: 0,
        life: 5.0,
        isRemote: true,
      });
      return true;
    }
    return false;
  }

  public getReadyMissileCount(): number {
    let c = 0;
    for (let i = 0; i < 4; i++) if (this.railCooldowns[i] <= 0) c++;
    return c;
  }

  public step(dt: number, input: FlightInput, terrain: TerrainMapData | null): void {
    const safeDt = Math.min(dt, 0.05);
    this.time += safeDt;

    // Re-arm missile rails
    for (let i = 0; i < 4; i++) {
      if (this.railCooldowns[i] > 0) {
        this.railCooldowns[i] = Math.max(0, this.railCooldowns[i] - safeDt);
      }
    }

    // Smooth camera blend (~1s)
    if (this.camBlend < 1.0) {
      this.camBlend = Math.min(1.0, this.camBlend + safeDt * 1.05);
    }

    // Speed & throttle
    this.afterburner = input.afterburner;
    const targetThrottle = input.afterburner ? 1.0 : 0.65;
    this.throttle += (targetThrottle - this.throttle) * Math.min(1, safeDt * 5);
    const targetSpeed = input.afterburner ? 114 : 68;
    this.speed += (targetSpeed - this.speed) * Math.min(1, safeDt * 2.4);

    // Steering: autopilot lazy S-turns until first mouse move
    let targetRoll = 0;
    let targetPitch = 0;
    let turnRate = 0;

    if (!input.hasMouseMoved) {
      const sTurn = Math.sin(this.time * 0.35);
      targetRoll = sTurn * 0.42;
      turnRate = -sTurn * 0.28;
      targetPitch = Math.sin(this.time * 0.22) * 0.06;
    } else if (this.cameraMode === 'topdown') {
      // North-up tactical: bank toward cursor direction
      const desiredYaw = Math.atan2(-input.cursorX, input.cursorY);
      let diff = desiredYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const mag = Math.min(1, Math.hypot(input.cursorX, input.cursorY) * 1.3);
      turnRate = Math.max(-1.8, Math.min(1.8, diff * 2.2)) * mag;
      targetRoll = Math.max(-0.95, Math.min(0.95, -turnRate * 0.65));
      targetPitch = (98 - this.y) * 0.012;
    } else {
      // Chase & Cockpit: cursor offset controls roll/turn & pitch
      const sx = Math.max(-1, Math.min(1, input.cursorX * input.sensitivity));
      const sy = Math.max(-1, Math.min(1, input.cursorY * input.sensitivity)) * (input.invertY ? -1 : 1);
      targetRoll = -sx * 1.05;
      turnRate = -sx * 1.35;
      targetPitch = -sy * 0.65;
    }

    // Terrain avoidance: smooth automatic pull-up before impact (cannot crash)
    const groundInfo = terrain
      ? sampleTerrainCpu(terrain, this.x, this.z)
      : { groundY: WATER_LEVEL * HEIGHT_SCALE, rawNorm: WATER_LEVEL, isWater: true };
    const lookAheadX = this.x - Math.sin(this.yaw) * 38;
    const lookAheadZ = this.z - Math.cos(this.yaw) * 38;
    const aheadInfo = terrain ? sampleTerrainCpu(terrain, lookAheadX, lookAheadZ) : groundInfo;
    const minSafeY = Math.max(groundInfo.groundY, aheadInfo.groundY) + 9.0;

    if (this.y < minSafeY + 14) {
      const urgency = Math.max(0, Math.min(1, (minSafeY + 14 - this.y) / 18));
      targetPitch = Math.max(targetPitch, 0.35 + urgency * 0.55);
    }
    if (this.y > 220) {
      targetPitch = Math.min(targetPitch, -0.25);
    }

    const prevY = this.y;
    const prevYaw = this.yaw;
    const prevPitch = this.pitch;

    this.yaw += turnRate * safeDt;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, safeDt * 4.2);
    this.pitch = Math.max(-0.78, Math.min(0.78, this.pitch));

    let visualRoll = this.roll;
    if (this.barrelRollTimer > 0) {
      this.barrelRollTimer = Math.max(0, this.barrelRollTimer - safeDt);
      const t = 1 - this.barrelRollTimer / 0.48;
      visualRoll = targetRoll + this.barrelRollDir * t * Math.PI * 2;
      this.roll = visualRoll;
    } else {
      this.roll += (targetRoll - this.roll) * Math.min(1, safeDt * 5.0);
    }

    // Integrate velocity
    const cp = Math.cos(this.pitch);
    const vx = -Math.sin(this.yaw) * cp * this.speed;
    const vy = Math.sin(this.pitch) * this.speed;
    const vz = -Math.cos(this.yaw) * cp * this.speed;

    this.x = (this.x + vx * safeDt + WORLD_SIZE) % WORLD_SIZE;
    this.y = Math.max(groundInfo.groundY + 3.2, this.y + vy * safeDt);
    this.z = (this.z + vz * safeDt + WORLD_SIZE) % WORLD_SIZE;

    this.agl = Math.max(0, this.y - groundInfo.groundY);
    this.overWater = groundInfo.isWater;
    this.vsi = (this.y - prevY) / safeDt;

    const dYaw = (this.yaw - prevYaw) / safeDt;
    const dPitch = (this.pitch - prevPitch) / safeDt;
    const rawG = 1.0 + Math.hypot(dYaw, dPitch) * (this.speed / 42);
    this.gLoad += (rawG - this.gLoad) * Math.min(1, safeDt * 6);

    // Wingtip vapour trails & low-altitude water spray/wake
    this.trailTimer += safeDt;
    if (this.trailTimer >= 0.032) {
      this.trailTimer = 0;
      if (Math.abs(this.roll) > 0.35 || this.afterburner) {
        const rx = Math.cos(this.yaw) * 2.3;
        const rz = -Math.sin(this.yaw) * 2.3;
        for (const s of [-1, 1]) {
          this.particles.push({
            x: this.x + rx * s,
            y: this.y,
            z: this.z + rz * s,
            vx: 0,
            vy: 0,
            vz: 0,
            sx: 0.22,
            sy: 0.16,
            sz: 1.4,
            yaw: this.yaw,
            pitch: this.pitch,
            roll: 0,
            kind: 'white',
            unlit: true,
            life: 0.55,
            maxLife: 0.55,
            grow: -0.2,
          });
        }
      }

      // Water spray & trailing surface wake when skimming low over lakes
      if (this.overWater && this.agl < 13.5) {
        const waterY = WATER_LEVEL * HEIGHT_SCALE;
        for (let k = 0; k < 2; k++) {
          const spread = (Math.random() - 0.5) * 2.4;
          this.particles.push({
            x: this.x + spread,
            y: waterY + 0.4,
            z: this.z + (Math.random() - 0.5) * 2.4,
            vx: (Math.random() - 0.5) * 4,
            vy: 4 + Math.random() * 6,
            vz: (Math.random() - 0.5) * 4,
            sx: 0.7,
            sy: 0.7,
            sz: 0.7,
            yaw: 0,
            pitch: 0,
            roll: 0,
            kind: 'spray',
            unlit: false,
            life: 0.65,
            maxLife: 0.65,
            grow: 1.4,
          });
        }
      }
    }

    // Step missiles
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.life -= safeDt;
      m.x = (m.x + m.vx * safeDt + WORLD_SIZE) % WORLD_SIZE;
      m.y += m.vy * safeDt;
      m.z = (m.z + m.vz * safeDt + WORLD_SIZE) % WORLD_SIZE;

      // Missile flame & smoke trail
      this.particles.push({
        x: m.x,
        y: m.y,
        z: m.z,
        vx: 0,
        vy: 0.8,
        vz: 0,
        sx: 0.55,
        sy: 0.55,
        sz: 0.55,
        yaw: 0,
        pitch: 0,
        roll: 0,
        kind: Math.random() > 0.35 ? 'smoke' : 'flame',
        unlit: false,
        life: 0.85,
        maxLife: 0.85,
        grow: 1.6,
      });

      const hitInfo = terrain
        ? sampleTerrainCpu(terrain, m.x, m.z)
        : { groundY: WATER_LEVEL * HEIGHT_SCALE, rawNorm: WATER_LEVEL, isWater: true };

      if (m.y <= hitInfo.groundY || m.life <= 0) {
        if (m.y <= hitInfo.groundY) {
          this.spawnImpact(m.x, hitInfo.groundY, m.z, hitInfo.isWater);
        }
        this.missiles.splice(i, 1);
      }
    }

    // Step particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= safeDt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * safeDt;
      p.y += p.vy * safeDt;
      p.z += p.vz * safeDt;
      const g = p.grow * safeDt;
      p.sx = Math.max(0.05, p.sx + g);
      p.sy = Math.max(0.05, p.sy + g);
      p.sz = Math.max(0.05, p.sz + g);
    }

    // Step impacts
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const imp = this.impacts[i];
      imp.life -= safeDt;
      imp.age = Math.max(0, imp.life / imp.maxLife);
      if (imp.life <= 0) {
        this.impacts.splice(i, 1);
      }
    }
  }

  private spawnImpact(x: number, y: number, z: number, isWater: boolean): void {
    const dist = Math.hypot(x - this.x, z - this.z);
    this.onMissileImpact?.(isWater, dist);

    this.impacts.unshift({
      x,
      z,
      radius: isWater ? 14 : 11,
      age: 1.0,
      life: isWater ? 4.5 : 8.0,
      maxLife: isWater ? 4.5 : 8.0,
    });
    if (this.impacts.length > 8) this.impacts.pop();

    if (isWater) {
      // Tall column of white spray + foam burst
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 4;
        this.particles.push({
          x: x + Math.cos(a) * r,
          y: y + Math.random() * 4,
          z: z + Math.sin(a) * r,
          vx: Math.cos(a) * (3 + Math.random() * 6),
          vy: 14 + Math.random() * 22,
          vz: Math.sin(a) * (3 + Math.random() * 6),
          sx: 1.4,
          sy: 2.2,
          sz: 1.4,
          yaw: 0,
          pitch: 0,
          roll: 0,
          kind: 'spray',
          unlit: true,
          life: 1.2 + Math.random() * 0.5,
          maxLife: 1.7,
          grow: 1.8,
        });
      }
    } else {
      // Bright flash + expanding fireball + lingering dark smoke column + shock ring
      this.particles.push({
        x,
        y: y + 1.5,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        sx: 5.5,
        sy: 5.5,
        sz: 5.5,
        yaw: 0,
        pitch: 0,
        roll: 0,
        kind: 'white',
        unlit: true,
        life: 0.16,
        maxLife: 0.16,
        grow: 18,
      });

      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 4 + Math.random() * 10;
        this.particles.push({
          x,
          y: y + 1.0,
          z,
          vx: Math.cos(a) * sp,
          vy: 6 + Math.random() * 14,
          vz: Math.sin(a) * sp,
          sx: 2.2,
          sy: 2.2,
          sz: 2.2,
          yaw: 0,
          pitch: 0,
          roll: 0,
          kind: i < 8 ? 'flame' : 'smoke',
          unlit: i < 8,
          life: i < 8 ? 0.55 : 2.6 + Math.random() * 1.2,
          maxLife: 3.8,
          grow: i < 8 ? 3.5 : 2.2,
        });
      }

      // Outward shock ring
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        this.particles.push({
          x,
          y: y + 0.8,
          z,
          vx: Math.cos(a) * 26,
          vy: 0.5,
          vz: Math.sin(a) * 26,
          sx: 1.5,
          sy: 0.7,
          sz: 1.5,
          yaw: a,
          pitch: 0,
          roll: 0,
          kind: 'ember',
          unlit: true,
          life: 0.45,
          maxLife: 0.45,
          grow: 2.0,
        });
      }
    }
  }

  private computeRawCamera(mode: CameraMode): { pos: Vec3; target: Vec3; up: Vec3; fov: number } {
    const fx = -Math.sin(this.yaw) * Math.cos(this.pitch);
    const fy = Math.sin(this.pitch);
    const fz = -Math.cos(this.yaw) * Math.cos(this.pitch);

    if (mode === 'topdown') {
      return {
        pos: [this.x, this.y + 84, this.z + 8],
        target: [this.x, this.y, this.z],
        up: [0, 0, -1],
        fov: 0.82,
      };
    }
    if (mode === 'cockpit') {
      return {
        pos: [this.x + fx * 1.2, this.y + 0.72 + fy * 1.2, this.z + fz * 1.2],
        target: [this.x + fx * 60, this.y + 0.72 + fy * 60, this.z + fz * 60],
        up: [-Math.sin(this.roll) * Math.cos(this.yaw), Math.cos(this.roll), Math.sin(this.roll) * Math.sin(this.yaw)],
        fov: 1.02,
      };
    }
    // Chase view
    const dist = 14.5;
    const height = 4.2;
    return {
      pos: [this.x - fx * dist, this.y - fy * dist + height, this.z - fz * dist],
      target: [this.x + fx * 18, this.y + fy * 18 + 0.8, this.z + fz * 18],
      up: [0, 1, 0],
      fov: 0.92,
    };
  }

  public getCamera(): { pos: Vec3; target: Vec3; up: Vec3; fov: number } {
    const raw = this.computeRawCamera(this.cameraMode);
    if (this.camBlend >= 1.0) return raw;

    const t = this.camBlend * this.camBlend * (3 - 2 * this.camBlend);
    const lerp3 = (a: Vec3, b: Vec3): Vec3 => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
    return {
      pos: lerp3(this.prevCamPos, raw.pos),
      target: lerp3(this.prevCamTarget, raw.target),
      up: lerp3(this.prevCamUp, raw.up),
      fov: raw.fov,
    };
  }
}
