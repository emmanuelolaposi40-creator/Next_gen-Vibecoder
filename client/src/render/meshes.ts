import { TAIL_ACCENT_COLORS, type TailAccentColor } from '@patrol/shared';
import type { Vec3 } from '../math/mat4.js';

export interface MeshBuffers {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  vertexCount: number;
}

class MeshBuilder {
  private data: number[] = [];

  tri(a: Vec3, b: Vec3, c: Vec3, col: [number, number, number]): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    this.push(a, [nx, ny, nz], col);
    this.push(b, [nx, ny, nz], col);
    this.push(c, [nx, ny, nz], col);
  }

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, col: [number, number, number]): void {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }

  private push(p: Vec3, n: Vec3, col: [number, number, number]): void {
    this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2]);
  }

  build(gl: WebGL2RenderingContext): MeshBuffers {
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.data), gl.STATIC_DRAW);

    const stride = 9 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 6 * 4);
    gl.bindVertexArray(null);

    return { vao, vbo, vertexCount: this.data.length / 9 };
  }
}

/**
 * Twin-engine, twin-tail fighter jet mesh.
 * Forward = -Z, Right = +X, Up = +Y. Wingspan ~ 4.4 units, Length ~ 6.2 units.
 */
export function buildJetMesh(gl: WebGL2RenderingContext, tailAccent: TailAccentColor = 'red'): MeshBuffers {
  const b = new MeshBuilder();
  const slateLight: [number, number, number] = [0.58, 0.62, 0.69];
  const slateMid: [number, number, number] = [0.43, 0.47, 0.55];
  const slateDark: [number, number, number] = [0.30, 0.34, 0.42];
  const radome: [number, number, number] = [0.14, 0.15, 0.20];
  const canopy: [number, number, number] = [0.92, 0.72, 0.26];
  const nozzle: [number, number, number] = [0.18, 0.18, 0.22];
  const glow: [number, number, number] = [1.0, 0.55, 0.18];
  const ac = TAIL_ACCENT_COLORS[tailAccent]?.rgb ?? [217, 68, 59];
  const finTip: [number, number, number] = [ac[0] / 255, ac[1] / 255, ac[2] / 255];

  // Nose radome (pointed dark cone)
  const noseTip: Vec3 = [0, 0.0, -3.3];
  const nT: Vec3 = [0, 0.28, -2.0];
  const nB: Vec3 = [0, -0.22, -2.0];
  const nL: Vec3 = [-0.32, 0.02, -2.0];
  const nR: Vec3 = [0.32, 0.02, -2.0];
  b.tri(noseTip, nR, nT, radome);
  b.tri(noseTip, nT, nL, radome);
  b.tri(noseTip, nL, nB, radome);
  b.tri(noseTip, nB, nR, radome);

  // Forward fuselage + intakes
  const fT: Vec3 = [0, 0.36, -0.4];
  const fB: Vec3 = [0, -0.28, -0.4];
  const fL: Vec3 = [-0.56, 0.04, -0.4];
  const fR: Vec3 = [0.56, 0.04, -0.4];
  b.quad(nT, nR, fR, fT, slateLight);
  b.quad(nL, nT, fT, fL, slateMid);
  b.quad(nR, nB, fB, fR, slateDark);
  b.quad(nB, nL, fL, fB, slateDark);

  // Gold-tinted bubble canopy
  const cF: Vec3 = [0, 0.36, -1.7];
  const cTopF: Vec3 = [0, 0.66, -1.1];
  const cTopB: Vec3 = [0, 0.62, -0.45];
  const cL: Vec3 = [-0.24, 0.36, -1.0];
  const cR: Vec3 = [0.24, 0.36, -1.0];
  const cB: Vec3 = [0, 0.38, -0.1];
  b.tri(cF, cR, cTopF, canopy);
  b.tri(cF, cTopF, cL, canopy);
  b.quad(cTopF, cR, cB, cTopB, canopy);
  b.quad(cL, cTopF, cTopB, cB, canopy);

  // Aft twin-engine fuselage
  const aT: Vec3 = [0, 0.34, 2.2];
  const aB: Vec3 = [0, -0.24, 2.2];
  const aL: Vec3 = [-0.62, 0.04, 2.2];
  const aR: Vec3 = [0.62, 0.04, 2.2];
  b.quad(fT, fR, aR, aT, slateMid);
  b.quad(fL, fT, aT, aL, slateLight);
  b.quad(fR, fB, aB, aR, slateDark);
  b.quad(fB, fL, aL, aB, slateDark);

  // Cropped delta wings (with splinter camo panels)
  const wRootF_R: Vec3 = [0.52, 0.04, -0.6];
  const wRootB_R: Vec3 = [0.58, 0.04, 1.75];
  const wTipF_R: Vec3 = [2.35, -0.04, 0.85];
  const wTipB_R: Vec3 = [2.35, -0.04, 1.55];
  b.quad(wRootF_R, wTipF_R, wTipB_R, wRootB_R, slateLight);
  b.quad(wRootB_R, wTipB_R, wTipF_R, wRootF_R, slateDark); // underside

  const wRootF_L: Vec3 = [-0.52, 0.04, -0.6];
  const wRootB_L: Vec3 = [-0.58, 0.04, 1.75];
  const wTipF_L: Vec3 = [-2.35, -0.04, 0.85];
  const wTipB_L: Vec3 = [-2.35, -0.04, 1.55];
  b.quad(wTipF_L, wRootF_L, wRootB_L, wTipB_L, slateMid);
  b.quad(wTipB_L, wRootB_L, wRootF_L, wTipF_L, slateDark);

  // Horizontal stabilators
  b.quad([0.55, 0.02, 1.85], [1.35, -0.02, 2.25], [1.35, -0.02, 2.65], [0.55, 0.02, 2.45], slateMid);
  b.quad([-1.35, -0.02, 2.25], [-0.55, 0.02, 1.85], [-0.55, 0.02, 2.45], [-1.35, -0.02, 2.65], slateLight);

  // Twin canted vertical fins with colored tips
  for (const side of [-1, 1]) {
    const xBase = side * 0.42;
    const xMid = side * 0.62;
    const xTop = side * 0.72;
    const f1: Vec3 = [xBase, 0.22, 1.25];
    const f2: Vec3 = [xBase, 0.20, 2.25];
    const m1: Vec3 = [xMid, 0.86, 1.72];
    const m2: Vec3 = [xMid, 0.86, 2.32];
    const t1: Vec3 = [xTop, 1.12, 1.92];
    const t2: Vec3 = [xTop, 1.12, 2.38];

    // Main fin body
    b.quad(f1, f2, m2, m1, slateMid);
    b.quad(f2, f1, m1, m2, slateDark);
    // Accent tip
    b.quad(m1, m2, t2, t1, finTip);
    b.quad(m2, m1, t1, t2, finTip);
  }

  // Twin exhaust nozzles + glowing inner cores
  for (const side of [-1, 1]) {
    const cx = side * 0.28;
    const cy = 0.02;
    const z0 = 2.2;
    const z1 = 2.65;
    const r = 0.20;
    const pts0: Vec3[] = [
      [cx - r, cy + r, z0],
      [cx + r, cy + r, z0],
      [cx + r, cy - r, z0],
      [cx - r, cy - r, z0],
    ];
    const pts1: Vec3[] = [
      [cx - r * 0.8, cy + r * 0.8, z1],
      [cx + r * 0.8, cy + r * 0.8, z1],
      [cx + r * 0.8, cy - r * 0.8, z1],
      [cx - r * 0.8, cy - r * 0.8, z1],
    ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      b.quad(pts0[i], pts0[j], pts1[j], pts1[i], nozzle);
    }
    b.quad(pts1[0], pts1[3], pts1[2], pts1[1], glow);
  }

  return b.build(gl);
}

export function buildMissileMesh(gl: WebGL2RenderingContext): MeshBuffers {
  const b = new MeshBuilder();
  const body: [number, number, number] = [0.92, 0.90, 0.86];
  const tip: [number, number, number] = [0.85, 0.26, 0.22];
  const fin: [number, number, number] = [0.30, 0.32, 0.38];

  const r = 0.07;
  const zF = -0.55;
  const zB = 0.55;
  const nose: Vec3 = [0, 0, -0.82];

  const f: Vec3[] = [
    [-r, r, zF],
    [r, r, zF],
    [r, -r, zF],
    [-r, -r, zF],
  ];
  const k: Vec3[] = [
    [-r, r, zB],
    [r, r, zB],
    [r, -r, zB],
    [-r, -r, zB],
  ];

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    b.tri(nose, f[j], f[i], tip);
    b.quad(f[i], f[j], k[j], k[i], body);
  }
  // Tail fins
  b.quad([-0.22, 0, 0.32], [0.22, 0, 0.32], [0.22, 0, 0.56], [-0.22, 0, 0.56], fin);
  b.quad([0, -0.22, 0.32], [0, 0.22, 0.32], [0, 0.22, 0.56], [0, -0.22, 0.56], fin);

  return b.build(gl);
}

export function buildColoredBoxMesh(
  gl: WebGL2RenderingContext,
  col: [number, number, number]
): MeshBuffers {
  const b = new MeshBuilder();
  const s = 0.5;
  const p: Vec3[] = [
    [-s, -s, -s],
    [s, -s, -s],
    [s, s, -s],
    [-s, s, -s],
    [-s, -s, s],
    [s, -s, s],
    [s, s, s],
    [-s, s, s],
  ];
  b.quad(p[0], p[1], p[2], p[3], col);
  b.quad(p[5], p[4], p[7], p[6], col);
  b.quad(p[4], p[0], p[3], p[7], col);
  b.quad(p[1], p[5], p[6], p[2], col);
  b.quad(p[3], p[2], p[6], p[7], col);
  b.quad(p[4], p[5], p[1], p[0], col);
  return b.build(gl);
}

export function buildRingMesh(gl: WebGL2RenderingContext, col: [number, number, number]): MeshBuffers {
  const b = new MeshBuilder();
  const segs = 12;
  const rIn = 0.85;
  const rOut = 1.05;
  const halfZ = 0.14;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    b.quad(
      [c0 * rIn, s0 * rIn, -halfZ],
      [c0 * rOut, s0 * rOut, -halfZ],
      [c1 * rOut, s1 * rOut, -halfZ],
      [c1 * rIn, s1 * rIn, -halfZ],
      col
    );
    b.quad(
      [c1 * rIn, s1 * rIn, halfZ],
      [c1 * rOut, s1 * rOut, halfZ],
      [c0 * rOut, s0 * rOut, halfZ],
      [c0 * rIn, s0 * rIn, halfZ],
      col
    );
    b.quad(
      [c0 * rOut, s0 * rOut, -halfZ],
      [c0 * rOut, s0 * rOut, halfZ],
      [c1 * rOut, s1 * rOut, halfZ],
      [c1 * rOut, s1 * rOut, -halfZ],
      col
    );
  }
  return b.build(gl);
}
