import { THREE } from './materials.js';

const cache = new Map();
/** sRGB hex → linear [r,g,b]. */
export function lin(hex) {
  let v = cache.get(hex);
  if (!v) { const c = new THREE.Color(hex); v = [c.r, c.g, c.b]; cache.set(hex, v); }
  return v;
}
export const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

function normal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Accumulates flat-shaded voxel geometry with the custom attributes the world shader reads. */
export class Builder {
  constructor() { this.P = []; this.N = []; this.C = []; this.S = []; this.B = []; this.F = []; this.E = []; }

  vert(p, n, c, f, s, b, e) {
    this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]); this.C.push(c[0], c[1], c[2]);
    this.F.push(f[0], f[1], f[2], f[3]); this.S.push(s); this.B.push(b); this.E.push(e);
  }

  /** q: 4 corners, counter-clockwise seen from the front. fw/fh: face size in world units (0 = no edge highlight). */
  quad(q, n, cols, fw = 0, fh = 0, sw = null, born = 0, emit = 0) {
    n = n || normal(q[0], q[1], q[2]);
    const uv = [[0, 0], [fw, 0], [fw, fh], [0, fh]];
    for (const i of [0, 1, 2, 0, 2, 3]) this.vert(q[i], n, cols[i] || cols[0], [uv[i][0], uv[i][1], fw, fh], sw ? sw[i] : 0, born, emit);
  }

  tri(a, b, c, col, born = 0) {
    const n = normal(a, b, c);
    for (const p of [a, b, c]) this.vert(p, n, col, [0, 0, 0, 0], 0, born, 0);
  }

  /** Box centred on x/z, standing on y. o: rot (Y), ao (ground y), sway, swayBase, born, emit, bottom, edges. */
  box(x, y, z, w, h, d, hex, o = {}) {
    const col = Array.isArray(hex) ? hex : lin(hex);
    const hx = w / 2, hz = d / 2, y0 = y, y1 = y + h;
    const cr = Math.cos(o.rot || 0), sr = Math.sin(o.rot || 0);
    const T = (p) => [x + p[0] * cr + p[2] * sr, p[1], z - p[0] * sr + p[2] * cr];
    const R = (n) => [n[0] * cr + n[2] * sr, n[1], -n[0] * sr + n[2] * cr];
    const faces = [
      [[0, 1, 0], [[-hx, y1, hz], [hx, y1, hz], [hx, y1, -hz], [-hx, y1, -hz]], w, d],
      [[0, 0, 1], [[-hx, y0, hz], [hx, y0, hz], [hx, y1, hz], [-hx, y1, hz]], w, h],
      [[0, 0, -1], [[hx, y0, -hz], [-hx, y0, -hz], [-hx, y1, -hz], [hx, y1, -hz]], w, h],
      [[1, 0, 0], [[hx, y0, hz], [hx, y0, -hz], [hx, y1, -hz], [hx, y1, hz]], d, h],
      [[-1, 0, 0], [[-hx, y0, -hz], [-hx, y0, hz], [-hx, y1, hz], [-hx, y1, -hz]], d, h],
    ];
    if (o.bottom) faces.push([[0, -1, 0], [[-hx, y0, -hz], [hx, y0, -hz], [hx, y0, hz], [-hx, y0, hz]], w, d]);
    const edges = o.edges !== false;
    for (const [n, q, fw, fh] of faces) {
      const cols = q.map((p) => {
        if (o.ao === undefined) return col;
        const k = 0.62 + 0.38 * Math.min(1, Math.max(0, (p[1] - o.ao) / 0.8));
        return [col[0] * k, col[1] * k, col[2] * k];
      });
      const sw = o.sway ? q.map((p) => Math.max(0, p[1] - (o.swayBase ?? y0)) * o.sway) : null;
      this.quad(q.map(T), R(n), cols, edges ? fw : 0, edges ? fh : 0, sw, o.born || 0, o.emit || 0);
    }
  }

  /** Box placed in a rotated local frame (ox, oz, rot). */
  lbox(ox, oz, rot, lx, ly, lz, w, h, d, hex, o = {}) {
    const c = Math.cos(rot), s = Math.sin(rot);
    this.box(ox + lx * c + lz * s, ly, oz - lx * s + lz * c, w, h, d, hex, { ...o, rot });
  }

  /** Gable roof, ridge along local x. */
  gable(ox, y, oz, w, d, rh, roofHex, wallHex, rot, born = 0) {
    const roof = lin(roofHex), wall = lin(wallHex), under = mul(roof, 0.55);
    const hx = w / 2, hz = d / 2, c = Math.cos(rot), s = Math.sin(rot);
    const T = (lx, ly, lz) => [ox + lx * c + lz * s, ly, oz - lx * s + lz * c];
    const sl = Math.hypot(hz, rh);
    this.quad([T(-hx, y, hz), T(hx, y, hz), T(hx, y + rh, 0), T(-hx, y + rh, 0)], null, [roof], w, sl, null, born);
    this.quad([T(hx, y, -hz), T(-hx, y, -hz), T(-hx, y + rh, 0), T(hx, y + rh, 0)], null, [roof], w, sl, null, born);
    this.tri(T(hx, y, hz), T(hx, y, -hz), T(hx, y + rh, 0), wall, born);
    this.tri(T(-hx, y, -hz), T(-hx, y, hz), T(-hx, y + rh, 0), wall, born);
    this.quad([T(-hx, y, -hz), T(hx, y, -hz), T(hx, y, hz), T(-hx, y, hz)], null, [under], 0, 0, null, born);
  }

  /** Four-sided pyramid (thatch or hide), apex at y + h. */
  pyramid(ox, y, oz, w, d, h, hex, rot, born = 0, underHex) {
    const col = lin(hex), under = lin(underHex ?? hex), hx = w / 2, hz = d / 2, c = Math.cos(rot), s = Math.sin(rot);
    const T = (lx, ly, lz) => [ox + lx * c + lz * s, ly, oz - lx * s + lz * c];
    const A = T(0, y + h, 0), p = [T(-hx, y, hz), T(hx, y, hz), T(hx, y, -hz), T(-hx, y, -hz)];
    for (let i = 0; i < 4; i++) this.tri(p[i], p[(i + 1) % 4], A, col, born);
    this.quad([T(-hx, y, -hz), T(hx, y, -hz), T(hx, y, hz), T(-hx, y, hz)], null, [mul(under, 0.6)], 0, 0, null, born);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.S, 1));
    g.setAttribute('aBorn', new THREE.Float32BufferAttribute(this.B, 1));
    g.setAttribute('aFace', new THREE.Float32BufferAttribute(this.F, 4));
    g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.E, 1));
    g.computeBoundingSphere();
    return g;
  }
}
