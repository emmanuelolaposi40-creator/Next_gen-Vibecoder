import {
  HEIGHT_SCALE,
  WATER_LEVEL,
  WEATHER_PRESETS,
  WORLD_SIZE,
  type TailAccentColor,
  type WeatherPreset,
} from '@patrol/shared';
import {
  composeTransformMat4,
  createMat4,
  invertMat4,
  lookAtMat4,
  multiplyMat4,
  perspectiveMat4,
  type Mat4,
  type Vec3,
} from '../math/mat4.js';
import type { TerrainMapData } from '../terrain/terrainLoader.js';
import {
  buildColoredBoxMesh,
  buildJetMesh,
  buildMissileMesh,
  buildRingMesh,
  type MeshBuffers,
} from './meshes.js';
import { BLIT_FRAG, FULLSCREEN_VERT, MESH_FRAG, MESH_VERT, WORLD_FRAG } from './shaders.js';

export interface RenderParticle {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  pitch: number;
  roll: number;
  kind: 'smoke' | 'flame' | 'white' | 'spray' | 'ember';
  unlit: boolean;
}

export interface RenderMissile {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface RenderJet {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  tailColor: TailAccentColor;
  afterburner: boolean;
  /** Rail availability for 4 wing-mounted missiles */
  railReady?: [boolean, boolean, boolean, boolean];
}

export interface RenderRing {
  x: number;
  y: number;
  z: number;
  yaw: number;
  radius: number;
  active: boolean;
}

export interface RenderImpact {
  x: number;
  z: number;
  radius: number;
  age: number; // 1 -> 0
}

export interface RenderSceneInput {
  time: number;
  preset: WeatherPreset;
  camPos: Vec3;
  camTarget: Vec3;
  camUp: Vec3;
  fovRad: number;
  showPlayerJet: boolean;
  playerJet: RenderJet;
  wingmen: RenderJet[];
  missiles: RenderMissile[];
  particles: RenderParticle[];
  rings: RenderRing[];
  impacts: RenderImpact[];
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    throw new Error(`Shader compile error: ${log}`);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

export class PatrolRenderer {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;

  private worldProg: WebGLProgram;
  private meshProg: WebGLProgram;
  private blitProg: WebGLProgram;
  private emptyVao: WebGLVertexArrayObject;

  private terrainTex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private fboColorTex: WebGLTexture;
  private fboDepthTex: WebGLTexture;

  public internalWidth = 604;
  public internalHeight = 340;
  private baseTargetHeight = 340;
  private frameTimeAvgMs = 16.6;

  private jetMeshes = new Map<TailAccentColor, MeshBuffers>();
  private missileMesh: MeshBuffers;
  private boxMeshes: Record<RenderParticle['kind'], MeshBuffers>;
  private ringActiveMesh: MeshBuffers;
  private ringDoneMesh: MeshBuffers;

  private projMat = createMat4();
  private viewMat = createMat4();
  private viewProjMat = createMat4();
  private invViewProjMat = createMat4();
  private modelMat = createMat4();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('WebGL2 is required but not supported in this browser.');
    }
    this.gl = gl;

    this.worldProg = linkProgram(gl, FULLSCREEN_VERT, WORLD_FRAG);
    this.meshProg = linkProgram(gl, MESH_VERT, MESH_FRAG);
    this.blitProg = linkProgram(gl, FULLSCREEN_VERT, BLIT_FRAG);
    this.emptyVao = gl.createVertexArray()!;

    // Terrain texture
    this.terrainTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.terrainTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Offscreen low-res FBO
    this.fbo = gl.createFramebuffer()!;
    this.fboColorTex = gl.createTexture()!;
    this.fboDepthTex = gl.createTexture()!;
    this.resizeFbo(604, 340);

    // Prebuild meshes
    for (const c of ['red', 'amber', 'teal', 'violet'] as TailAccentColor[]) {
      this.jetMeshes.set(c, buildJetMesh(gl, c));
    }
    this.missileMesh = buildMissileMesh(gl);
    this.boxMeshes = {
      smoke: buildColoredBoxMesh(gl, [0.28, 0.24, 0.32]),
      flame: buildColoredBoxMesh(gl, [1.0, 0.56, 0.16]),
      white: buildColoredBoxMesh(gl, [0.98, 0.96, 0.90]),
      spray: buildColoredBoxMesh(gl, [0.88, 0.92, 0.94]),
      ember: buildColoredBoxMesh(gl, [0.98, 0.34, 0.14]),
    };
    this.ringActiveMesh = buildRingMesh(gl, [0.98, 0.72, 0.24]);
    this.ringDoneMesh = buildRingMesh(gl, [0.34, 0.72, 0.65]);
  }

  public uploadTerrain(data: TerrainMapData): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.terrainTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      data.size,
      data.size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data.rgba
    );
  }

  public updateResolution(dtMs: number): void {
    // Dynamic internal resolution scaling on frame-time spikes
    this.frameTimeAvgMs = this.frameTimeAvgMs * 0.85 + dtMs * 0.15;
    if (this.frameTimeAvgMs > 25.0 && this.baseTargetHeight > 180) {
      this.baseTargetHeight = Math.max(180, this.baseTargetHeight - 40);
    } else if (this.frameTimeAvgMs < 15.0 && this.baseTargetHeight < 340) {
      this.baseTargetHeight = Math.min(340, this.baseTargetHeight + 20);
    }

    const rect = this.canvas.getBoundingClientRect();
    const aspect = Math.max(0.5, (rect.width || 1280) / (rect.height || 720));
    const targetH = this.baseTargetHeight;
    const targetW = Math.max(160, Math.round(targetH * aspect));

    if (targetW !== this.internalWidth || targetH !== this.internalHeight) {
      this.resizeFbo(targetW, targetH);
    }
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
  }

  private resizeFbo(w: number, h: number): void {
    const gl = this.gl;
    this.internalWidth = w;
    this.internalHeight = h;

    gl.bindTexture(gl.TEXTURE_2D, this.fboColorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, this.fboDepthTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.DEPTH_COMPONENT24,
      w,
      h,
      0,
      gl.DEPTH_COMPONENT,
      gl.UNSIGNED_INT,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboColorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.fboDepthTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  public getViewProjMatrix(): Mat4 {
    return this.viewProjMat;
  }

  public render(scene: RenderSceneInput): void {
    const gl = this.gl;
    const cfg = WEATHER_PRESETS[scene.preset] ?? WEATHER_PRESETS['last-light'];
    const aspect = this.internalWidth / this.internalHeight;

    perspectiveMat4(this.projMat, scene.fovRad, aspect, 0.4, 2400.0);
    lookAtMat4(this.viewMat, scene.camPos, scene.camTarget, scene.camUp);
    multiplyMat4(this.viewProjMat, this.projMat, this.viewMat);
    invertMat4(this.invViewProjMat, this.viewProjMat);

    const azRad = (cfg.sunAzimuthDeg * Math.PI) / 180;
    const elRad = (cfg.sunElevationDeg * Math.PI) / 180;
    const sunDir: Vec3 = [
      Math.cos(elRad) * Math.cos(azRad),
      Math.sin(elRad),
      Math.cos(elRad) * Math.sin(azRad),
    ];

    // 1. Render World Ray-Marcher into low-res FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.internalWidth, this.internalHeight);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.depthMask(true);

    gl.useProgram(this.worldProg);
    gl.bindVertexArray(this.emptyVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.terrainTex);
    gl.uniform1i(gl.getUniformLocation(this.worldProg, 'uTerrainTex'), 0);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.worldProg, 'uInvViewProj'), false, this.invViewProjMat);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.worldProg, 'uViewProj'), false, this.viewProjMat);
    gl.uniform3fv(gl.getUniformLocation(this.worldProg, 'uCamPos'), scene.camPos);
    gl.uniform1f(gl.getUniformLocation(this.worldProg, 'uTime'), scene.time);
    gl.uniform1f(gl.getUniformLocation(this.worldProg, 'uWorldSize'), WORLD_SIZE);
    gl.uniform1f(gl.getUniformLocation(this.worldProg, 'uHeightScale'), HEIGHT_SCALE);
    gl.uniform1f(gl.getUniformLocation(this.worldProg, 'uWaterLevel'), WATER_LEVEL);

    gl.uniform3fv(gl.getUniformLocation(this.worldProg, 'uSunDir'), sunDir);
    gl.uniform3f(
      gl.getUniformLocation(this.worldProg, 'uSunDiscColor'),
      cfg.sunDiscRgb[0] / 255,
      cfg.sunDiscRgb[1] / 255,
      cfg.sunDiscRgb[2] / 255
    );
    gl.uniform3f(
      gl.getUniformLocation(this.worldProg, 'uSkyZenith'),
      cfg.skyZenithRgb[0] / 255,
      cfg.skyZenithRgb[1] / 255,
      cfg.skyZenithRgb[2] / 255
    );
    gl.uniform3f(
      gl.getUniformLocation(this.worldProg, 'uSkyHorizon'),
      cfg.skyHorizonRgb[0] / 255,
      cfg.skyHorizonRgb[1] / 255,
      cfg.skyHorizonRgb[2] / 255
    );
    gl.uniform3f(
      gl.getUniformLocation(this.worldProg, 'uHazeWarm'),
      cfg.hazeWarmRgb[0] / 255,
      cfg.hazeWarmRgb[1] / 255,
      cfg.hazeWarmRgb[2] / 255
    );
    gl.uniform3f(
      gl.getUniformLocation(this.worldProg, 'uHazeCool'),
      cfg.hazeCoolRgb[0] / 255,
      cfg.hazeCoolRgb[1] / 255,
      cfg.hazeCoolRgb[2] / 255
    );
    gl.uniform1f(gl.getUniformLocation(this.worldProg, 'uCloudDensity'), cfg.cloudDensity);
    gl.uniform1f(gl.getUniformLocation(this.worldProg, 'uSnowLine'), cfg.snowLine);
    gl.uniform3f(
      gl.getUniformLocation(this.worldProg, 'uJetPos'),
      scene.playerJet.x,
      scene.playerJet.y,
      scene.playerJet.z
    );

    const impFlat = new Float32Array(8 * 4);
    for (let i = 0; i < Math.min(8, scene.impacts.length); i++) {
      const imp = scene.impacts[i];
      impFlat[i * 4] = imp.x;
      impFlat[i * 4 + 1] = imp.z;
      impFlat[i * 4 + 2] = imp.radius;
      impFlat[i * 4 + 3] = imp.age;
    }
    gl.uniform4fv(gl.getUniformLocation(this.worldProg, 'uImpacts'), impFlat);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. Render 3D Meshes into same low-res FBO with depth test
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.meshProg);
    const uModelLoc = gl.getUniformLocation(this.meshProg, 'uModel');
    const uVpLoc = gl.getUniformLocation(this.meshProg, 'uViewProj');
    const uSunLoc = gl.getUniformLocation(this.meshProg, 'uSunDir');
    const uUnlitLoc = gl.getUniformLocation(this.meshProg, 'uUnlit');
    gl.uniformMatrix4fv(uVpLoc, false, this.viewProjMat);
    gl.uniform3fv(uSunLoc, sunDir);

    // Player jet + mounted missiles
    if (scene.showPlayerJet) {
      this.drawJet(gl, scene.playerJet, uModelLoc, uUnlitLoc, scene.time);
    }

    // Remote wingmen
    for (const w of scene.wingmen) {
      this.drawJet(gl, w, uModelLoc, uUnlitLoc, scene.time);
    }

    // Active missiles in flight
    gl.uniform1f(uUnlitLoc, 0.0);
    gl.bindVertexArray(this.missileMesh.vao);
    for (const m of scene.missiles) {
      composeTransformMat4(this.modelMat, m.x, m.y, m.z, m.yaw, m.pitch, m.roll, 1.3, 1.3, 1.3);
      gl.uniformMatrix4fv(uModelLoc, false, this.modelMat);
      gl.drawArrays(gl.TRIANGLES, 0, this.missileMesh.vertexCount);
    }

    // Sortie rings
    for (const r of scene.rings) {
      const mesh = r.active ? this.ringActiveMesh : this.ringDoneMesh;
      gl.bindVertexArray(mesh.vao);
      gl.uniform1f(uUnlitLoc, r.active ? 1.0 : 0.0);
      composeTransformMat4(
        this.modelMat,
        r.x,
        r.y,
        r.z,
        r.yaw,
        0,
        0,
        r.radius,
        r.radius,
        r.radius
      );
      gl.uniformMatrix4fv(uModelLoc, false, this.modelMat);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
    }

    // Particles (smoke, flames, vapour trails, water spray, fireballs)
    for (const p of scene.particles) {
      const mesh = this.boxMeshes[p.kind];
      gl.bindVertexArray(mesh.vao);
      gl.uniform1f(uUnlitLoc, p.unlit ? 1.0 : 0.0);
      composeTransformMat4(this.modelMat, p.x, p.y, p.z, p.yaw, p.pitch, p.roll, p.sx, p.sy, p.sz);
      gl.uniformMatrix4fv(uModelLoc, false, this.modelMat);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
    }

    // 3. Blit + 1px outline + 4x4 Bayer dithering to screen canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.internalWidth, this.internalHeight);
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(this.blitProg);
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboColorTex);
    gl.uniform1i(gl.getUniformLocation(this.blitProg, 'uColorTex'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fboDepthTex);
    gl.uniform1i(gl.getUniformLocation(this.blitProg, 'uDepthTex'), 1);

    gl.uniform2f(
      gl.getUniformLocation(this.blitProg, 'uResolution'),
      this.internalWidth,
      this.internalHeight
    );
    gl.uniform1f(
      gl.getUniformLocation(this.blitProg, 'uOutlineStrength'),
      scene.showPlayerJet ? 1.0 : 0.0
    );

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawJet(
    gl: WebGL2RenderingContext,
    jet: RenderJet,
    uModelLoc: WebGLUniformLocation | null,
    uUnlitLoc: WebGLUniformLocation | null,
    time: number
  ): void {
    const mesh = this.jetMeshes.get(jet.tailColor) ?? this.jetMeshes.get('red')!;
    gl.uniform1f(uUnlitLoc, 0.0);
    gl.bindVertexArray(mesh.vao);
    composeTransformMat4(this.modelMat, jet.x, jet.y, jet.z, jet.yaw, jet.pitch, jet.roll);
    gl.uniformMatrix4fv(uModelLoc, false, this.modelMat);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);

    // Wing-mounted missiles on rails
    if (jet.railReady) {
      const railOffsets: Vec3[] = [
        [-1.15, -0.14, 0.4],
        [1.15, -0.14, 0.4],
        [-1.72, -0.14, 0.72],
        [1.72, -0.14, 0.72],
      ];
      gl.bindVertexArray(this.missileMesh.vao);
      const jetMat = new Float32Array(this.modelMat);
      for (let i = 0; i < 4; i++) {
        if (!jet.railReady[i]) continue;
        const [lx, ly, lz] = railOffsets[i];
        const wx = jetMat[0] * lx + jetMat[4] * ly + jetMat[8] * lz + jetMat[12];
        const wy = jetMat[1] * lx + jetMat[5] * ly + jetMat[9] * lz + jetMat[13];
        const wz = jetMat[2] * lx + jetMat[6] * ly + jetMat[10] * lz + jetMat[14];
        composeTransformMat4(this.modelMat, wx, wy, wz, jet.yaw, jet.pitch, jet.roll, 0.9, 0.9, 0.9);
        gl.uniformMatrix4fv(uModelLoc, false, this.modelMat);
        gl.drawArrays(gl.TRIANGLES, 0, this.missileMesh.vertexCount);
      }
    }

    // Twin afterburner plumes with bright white cores
    if (jet.afterburner) {
      const jetMat = composeTransformMat4(
        createMat4(),
        jet.x,
        jet.y,
        jet.z,
        jet.yaw,
        jet.pitch,
        jet.roll
      );
      const flicker = 0.85 + Math.sin(time * 48.0 + jet.x) * 0.25;
      gl.uniform1f(uUnlitLoc, 1.0);
      for (const side of [-0.28, 0.28]) {
        // Outer orange plume
        const lz = 3.15 + flicker * 0.4;
        const wx = jetMat[0] * side + jetMat[8] * lz + jetMat[12];
        const wy = jetMat[1] * side + jetMat[9] * lz + jetMat[13];
        const wz = jetMat[2] * side + jetMat[10] * lz + jetMat[14];
        gl.bindVertexArray(this.boxMeshes.flame.vao);
        composeTransformMat4(
          this.modelMat,
          wx,
          wy,
          wz,
          jet.yaw,
          jet.pitch,
          jet.roll,
          0.32,
          0.32,
          1.4 * flicker
        );
        gl.uniformMatrix4fv(uModelLoc, false, this.modelMat);
        gl.drawArrays(gl.TRIANGLES, 0, this.boxMeshes.flame.vertexCount);

        // Bright white core
        const cz = 2.85 + flicker * 0.2;
        const cx = jetMat[0] * side + jetMat[8] * cz + jetMat[12];
        const cy = jetMat[1] * side + jetMat[9] * cz + jetMat[13];
        const czz = jetMat[2] * side + jetMat[10] * cz + jetMat[14];
        gl.bindVertexArray(this.boxMeshes.white.vao);
        composeTransformMat4(
          this.modelMat,
          cx,
          cy,
          czz,
          jet.yaw,
          jet.pitch,
          jet.roll,
          0.18,
          0.18,
          0.85 * flicker
        );
        gl.uniformMatrix4fv(uModelLoc, false, this.modelMat);
        gl.drawArrays(gl.TRIANGLES, 0, this.boxMeshes.white.vertexCount);
      }
    }
  }

  public capturePostcardDataUrl(): string {
    return this.canvas.toDataURL('image/png');
  }
}
