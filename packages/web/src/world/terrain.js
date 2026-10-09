import { THREE } from './materials.js';
import { Builder, lin, mul } from './builder.js';

export const WATER_Y = -0.35, SAND_Y = 0, GRASS_Y = 0.3, MESA_STEP = 1.1, BOTTOM_Y = -3.4;
export const VILLAGE_Y = GRASS_Y + 0.12, WALK_Y = VILLAGE_Y;
export const FIRE_RING = 1.7;
const SLOT_SPACING = 32, ISLAND_R = 25, CHUNK = 4, FALL = 1.9;

export const ACCENTS = [0x4c8dff, 0x33d1e0, 0xa77bff, 0x4fe0a0, 0xe58cff];
const PAL_STONE = {
  grass: 0xffd22e, grassSide: 0xf4aa0a, mesa: 0xffc62a, sand: 0xf3d9b8, sandSide: 0xddb590, path: 0xcf9a5e, ground1: 0xebc994, ground2: 0xe3bf88, groundSide: 0xc4925a,
  earth: 0xa9697a, earthDeep: 0x8a5163, waterSide: 0x4a8bd4, waterTop: 0x4f93dc,
  trunk: 0x5a372f, branch: 0x6e4339, tuft: [0xb7c61b, 0x9cb316], pebble: [0xcb8ea4, 0xd9a77f], rock: [0xaab9cb, 0x91a2b7],
  mud: 0xd9a066, mud2: 0xe3b07a, thatch: 0xe7b84a, thatch2: 0xd9a33c, hide: 0xcf9a62, wood: 0x8a5a3a, wood2: 0x6e4630, log: 0x7a4a30,
  stone: 0x9aa3ae, door: 0x4a3020, flame: 0xff9a2e, flame2: 0xffcf4a, pot: 0xb5653a, stake: 0x8a6a48, mesaMap: 0xf0b820, pathMap: 0xc08850,
};
const PAL_SUB = {
  grass: 0x7fb24c, grassSide: 0x5c8c38, mesa: 0x70a644, sand: 0xe6dcc0, sandSide: 0xc9bb98, path: 0x55595f, ground1: 0x8fbf58, ground2: 0x87b752, groundSide: 0x5c8c38,
  earth: 0x8a6a55, earthDeep: 0x6b5244, waterSide: 0x3a76bd, waterTop: 0x3d7ec6,
  trunk: 0x5a4636, branch: 0x6a5240, tuft: [0x5e9c33, 0x4e8a2b], pebble: [0xa9adb2, 0x8f9499], rock: [0xa3a8ae, 0x8b9199],
  stone: 0xd6d1c7, plaza: 0xd3ccbf, plaza2: 0xc5beb0, kerb: 0xa9abaf, hedge: [0x3b7733, 0x447f36, 0x356c2e], mesaMap: 0x6aa63c, pathMap: 0x55595f,
};
const PAL_JP = {
  grass: 0x93c25c, grassSide: 0x6f9a42, mesa: 0x86b553, sand: 0xd6d0c1, sandSide: 0xb5ae9f, path: 0xaaa499, path2: 0x9f998d, ground1: 0xe4dfd3, ground2: 0xdcd6c8, groundSide: 0x8f8a7c,
  earth: 0x8a6650, earthDeep: 0x6c4e3e, waterSide: 0x2d7d93, waterTop: 0x3d91a6,
  trunk: 0x4a3430, branch: 0x553b35, tuft: [0x74ab4a, 0x62973f], pebble: [0xbdb6a8, 0xa8a194], rock: [0x9a9c94, 0x84877f],
  stone: 0xb3aea3, plaza: 0xc6c1b5, plaza2: 0xbab4a7, paddy: 0xa3cbc0, paddy2: 0x99c3b7, rice: [0x9ccf55, 0x86bd45], mesaMap: 0x9cc7bc, pathMap: 0xa7a197,
};
let PAL = PAL_STONE, SUB = false, JP = false;
const STONE = [0xb7ad9f, 0xa49b8f, 0xc6bdae, 0x9b9387];
const TREE_PALS = [
  [0xff8c3a, 0xff7a2e, 0xff6a26, 0xffa04c], [0xff6a3a, 0xff5534, 0xf2452e, 0xff7f4f], [0xffa43f, 0xff9034, 0xff7d2b, 0xffb65a],
];

/** Village sites: centre, then hex rings. */
export const SLOTS = [new THREE.Vector2(0, 0)];
for (let ring = 1; ring <= 3; ring++) for (let side = 0; side < 6; side++) for (let step = 0; step < ring; step++) {
  const a = (side / 6) * Math.PI * 2 + Math.PI / 6, b = ((side + 1) / 6) * Math.PI * 2 + Math.PI / 6, t = step / ring;
  SLOTS.push(new THREE.Vector2((Math.cos(a) * (1 - t) + Math.cos(b) * t) * ring * SLOT_SPACING, (Math.sin(a) * (1 - t) + Math.sin(b) * t) * ring * SLOT_SPACING));
}

function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
export function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 4) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { s += vnoise(x, y) * a; n += a; x *= 2.03; y *= 2.03; a *= 0.5; }
  return s / n;
}
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
export function strHash(s, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}
function rng(seed) { let s = Math.floor(seed * 2147483646) + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

function distField(W, H, src) {
  const D = new Float32Array(W * H), R2 = Math.SQRT2;
  for (let i = 0; i < W * H; i++) D[i] = src(i) ? 0 : 1e9;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i; let d = D[k];
    if (i > 0) d = Math.min(d, D[k - 1] + 1);
    if (j > 0) { d = Math.min(d, D[k - W] + 1); if (i > 0) d = Math.min(d, D[k - W - 1] + R2); if (i < W - 1) d = Math.min(d, D[k - W + 1] + R2); }
    D[k] = d;
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i; let d = D[k];
    if (i < W - 1) d = Math.min(d, D[k + 1] + 1);
    if (j < H - 1) { d = Math.min(d, D[k + W] + 1); if (i < W - 1) d = Math.min(d, D[k + W + 1] + R2); if (i > 0) d = Math.min(d, D[k + W - 1] + R2); }
    D[k] = d;
  }
  return D;
}

/** Village plan: a fire at the site, one hub per branch at a jittered angle and distance. Not circular. */
function villageLayout(repo, branches, sx, sz) {
  const R = rng(strHash(repo, 7) * 0.98 + 0.01);
  const n = branches.length, span = (Math.PI * 2) / n, a0 = R() * Math.PI * 2;
  const hubs = branches.map((branch, i) => {
    const a = a0 + i * span + (R() - 0.5) * span * 0.35, d = 6.6 + R() * 2.2 + (n > 3 ? 0.8 : 0);
    return { branch, a, x: sx + Math.cos(a) * d, z: sz - Math.sin(a) * d };
  });
  const v = { repo, cx: sx, cz: sz, a0, span, hubs };
  for (const h of hubs) {
    const dx = Math.cos(h.a), dz = -Math.sin(h.a);
    let s = 0; while (s < 12 && villageSDF(v, h.x + dx * s, h.z + dz * s) < 0) s += 0.25;
    h.gx = h.x + dx * s; h.gz = h.z + dz * s; h.ex = h.gx + dx * 2.6; h.ez = h.gz + dz * 2.6;
  }
  return v;
}
function villageSDF(v, x, z) {
  let d = Math.hypot(x - v.cx, z - v.cz) - 4.6;
  for (const h of v.hubs) d = Math.min(d, Math.hypot(x - h.x, z - h.z) - 4.9, segDist(x, z, v.cx, v.cz, h.x, h.z) - 1.8);
  return d + (vnoise(x * 0.3 + v.cx, z * 0.3) - 0.5) * 1.6;
}
function pathSDF(v, x, z) {
  let d = Math.hypot(x - v.cx, z - v.cz) - 2.9;
  for (const h of v.hubs) d = Math.min(d, Math.hypot(x - h.x, z - h.z) - 1.5, segDist(x, z, v.cx, v.cz, h.x, h.z) - 0.55, h.ex === undefined ? Infinity : segDist(x, z, h.x, h.z, h.ex, h.ez) - 0.5);
  return d + (vnoise(x * 0.7 - 3, z * 0.7 + v.cz) - 0.5) * 0.7;
}

const TYPE = { NONE: 0, WATER: 1, SAND: 2, GRASS: 3, MESA: 4, VILLAGE: 5, PATH: 6 };

/** prev: the world currently shown. Its cells keep their terrain; only new land and changed villages are generated. */
export function generate(repos, prev, worldName = 'stone') {
  SUB = worldName === 'suburb'; JP = worldName === 'japan'; PAL = SUB ? PAL_SUB : JP ? PAL_JP : PAL_STONE;
  const n = Math.max(1, repos.length);
  const slots = SLOTS.slice(0, n);
  const villages = repos.map(({ repo, branches }, i) => slots[i] && villageLayout(repo, branches, slots[i].x, slots[i].y)).filter(Boolean);
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const s of slots) { minx = Math.min(minx, s.x); maxx = Math.max(maxx, s.x); minz = Math.min(minz, s.y); maxz = Math.max(maxz, s.y); }
  const pad = ISLAND_R + 14;
  const ox = Math.floor((minx - pad) / CHUNK) * CHUNK, oz = Math.floor((minz - pad) / CHUNK) * CHUNK;
  const W = Math.ceil((maxx + pad - ox) / CHUNK) * CHUNK, H = Math.ceil((maxz + pad - oz) / CHUNK) * CHUNK;
  const N = W * H, land = new Uint8Array(N);

  for (let cj = 0; cj < H / CHUNK; cj++) for (let ci = 0; ci < W / CHUNK; ci++) {
    const x = ox + ci * CHUNK + CHUNK / 2, z = oz + cj * CHUNK + CHUNK / 2;
    let f = Infinity, dmin = Infinity;
    for (const s of slots) { const d = Math.hypot(x - s.x, z - s.y); f = smin(f, d - ISLAND_R, 16); dmin = Math.min(dmin, d); }
    f += (fbm(x * 0.05 + 3, z * 0.05 - 9, 3) - 0.5) * 16;
    if (f < 0 || dmin < 19) for (let j = 0; j < CHUNK; j++) for (let i = 0; i < CHUNK; i++) land[(cj * CHUNK + j) * W + ci * CHUNK + i] = 1;
  }

  const cx = (i) => ox + i + 0.5, cz = (j) => oz + j + 0.5;
  const type = new Uint8Array(N), lvl = new Float32Array(N), vd = new Float32Array(N), pdA = new Float32Array(N), cdA = new Float32Array(N);
  const pkA = new Int32Array(N).fill(-1), kept = new Uint8Array(N);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!land[k]) continue;
    const x = cx(i), z = cz(j);
    if (prev) {
      const pi = Math.floor(x - prev.ox), pj = Math.floor(z - prev.oz);
      if (pi >= 0 && pj >= 0 && pi < prev.W && pj < prev.H && prev.type[pj * prev.W + pi]) pkA[k] = pj * prev.W + pi;
    }
    let d = Infinity, pd = Infinity, cd = Infinity;
    for (const v of villages) { const vc = Math.hypot(x - v.cx, z - v.cz); if (vc > 22) continue; cd = Math.min(cd, vc); d = Math.min(d, villageSDF(v, x, z)); pd = Math.min(pd, pathSDF(v, x, z)); }
    vd[k] = d; pdA[k] = pd; cdA[k] = cd;
    type[k] = d < 0 ? (pd < 0 ? TYPE.PATH : TYPE.VILLAGE) : pd < 0 && d < 3 ? TYPE.PATH : TYPE.GRASS;
    // Existing land stays as it is unless a village now claims it; old village ground is redone in case its layout changed.
    const pt = pkA[k] >= 0 ? prev.type[pkA[k]] : TYPE.NONE;
    if (type[k] === TYPE.GRASS && pt && pt !== TYPE.VILLAGE && pt !== TYPE.PATH) { type[k] = pt; kept[k] = 1; continue; }
    if (d > 3.5) {
      const wx = x + (fbm(x * 0.02, z * 0.02, 3) - 0.5) * 36, wz = z + (fbm(x * 0.02 + 40, z * 0.02 - 40, 3) - 0.5) * 36;
      const river = Math.abs(fbm(wx * 0.013 + 7, wz * 0.013 - 3, 4) - 0.5) < 0.026 + 0.012 * Math.min(1, (d - 3.5) / 10);
      const lake = fbm(x * 0.035 - 20, z * 0.035 + 11, 3) < 0.29;
      if (river || lake) type[k] = TYPE.WATER;
    }
  }
  const dw = distField(W, H, (k) => type[k] === TYPE.WATER);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, t = type[k];
    if (t === TYPE.NONE) continue;
    if (kept[k]) { lvl[k] = prev.lvl[pkA[k]]; continue; }
    if (t === TYPE.WATER) { lvl[k] = WATER_Y; continue; }
    lvl[k] = GRASS_Y;
    if (t === TYPE.VILLAGE || t === TYPE.PATH) { if (vd[k] < 0) lvl[k] = VILLAGE_Y; continue; }
    const x = cx(i), z = cz(j);
    if (vd[k] > 1 && (dw[k] < 1.8 + fbm(x * 0.09, z * 0.09, 2) * 3.2 || fbm(x * 0.06 + 70, z * 0.06, 3) > 0.68)) { type[k] = TYPE.SAND; lvl[k] = SAND_Y; continue; }
    const hN = fbm(x * 0.045 + 50, z * 0.045 + 50, 4);
    if (JP) { if (vd[k] > 6 && dw[k] > 4 && hN > 0.56) { type[k] = TYPE.MESA; lvl[k] = GRASS_Y + 0.5 * Math.min(5, 1 + Math.floor((hN - 0.56) / 0.024)); } }
    else if (vd[k] > 6 && dw[k] > 4 && hN > 0.6) { type[k] = TYPE.MESA; lvl[k] = GRASS_Y + MESA_STEP * Math.min(3, 1 + Math.floor((hN - 0.6) / 0.06)); }
  }

  // New terrain: aBorn = 1 (rises as one block). Decor: aBorn = 2 + delay, delay spreading outward from old land.
  const isNew = (k) => pkA[k] < 0;
  const bornD = prev
    ? distField(W, H, (k) => land[k] && !isNew(k))
    : distField(W, H, (k) => Math.hypot(cx(k % W) - slots[0].x, cz((k / W) | 0) - slots[0].y) < 2);
  let maxB = 1; for (let k = 0; k < N; k++) if (land[k] && bornD[k] < 1e8) maxB = Math.max(maxB, bornD[k]);
  // gen: which build a cell first appeared in. Decor with spacing rules is placed oldest land first,
  // so new land cannot crowd out trees, jetties or boats that already stand.
  const born = new Float32Array(N), gen = new Uint16Array(N), g0 = prev ? prev.maxGen + 1 : 0;
  for (let k = 0; k < N; k++) if (land[k]) { if (isNew(k)) born[k] = 1; gen[k] = isNew(k) ? g0 : prev.gen[pkA[k]]; }
  const wave = (k) => (born[k] ? 2 + 0.5 * Math.min(1, bornD[k] / maxB) : 0);
  const bornAt = (x, z) => { const i = Math.floor(x - ox), j = Math.floor(z - oz); return i >= 0 && j >= 0 && i < W && j < H && born[j * W + i] > 0; };
  // First lattice index >= min that lands on a world-aligned multiple of s, so the lattice does not shift when the grid grows.
  const at = (o, s, min) => min + ((((-o - min) % s) + s) % s);
  const cellAt = (x, z) => { const i = Math.floor(x - ox), j = Math.floor(z - oz); return i >= 0 && j >= 0 && i < W && j < H ? j * W + i : -1; };

  const tb = new Builder(), wb = new Builder(), fb = new Builder(), falls = new Builder();
  const inside = (i, j) => i >= 0 && j >= 0 && i < W && j < H && type[j * W + i] !== TYPE.NONE;
  const topCol = { [TYPE.GRASS]: lin(PAL.grass), [TYPE.SAND]: lin(PAL.sand), [TYPE.MESA]: lin(PAL.mesa), [TYPE.VILLAGE]: lin(PAL.ground1), [TYPE.PATH]: lin(PAL.path) };
  const G1 = lin(PAL.ground1), G2 = lin(PAL.ground2);
  const sideCol = { [TYPE.GRASS]: lin(PAL.grassSide), [TYPE.SAND]: lin(PAL.sandSide), [TYPE.MESA]: lin(PAL.grassSide), [TYPE.VILLAGE]: lin(PAL.groundSide), [TYPE.PATH]: lin(PAL.groundSide), [TYPE.WATER]: lin(PAL.waterSide) };
  const earth = lin(PAL.earth), deep = lin(PAL.earthDeep);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]], AO = [1, 0.86, 0.77, 0.68];

  function side(dir, x0, x1, z0, z1, yt, yb, cT, cB, bn) {
    let q, nn;
    if (dir === 0) { q = [[x1, yb, z1], [x1, yb, z0], [x1, yt, z0], [x1, yt, z1]]; nn = [1, 0, 0]; }
    else if (dir === 1) { q = [[x0, yb, z0], [x0, yb, z1], [x0, yt, z1], [x0, yt, z0]]; nn = [-1, 0, 0]; }
    else if (dir === 2) { q = [[x0, yb, z1], [x1, yb, z1], [x1, yt, z1], [x0, yt, z1]]; nn = [0, 0, 1]; }
    else { q = [[x1, yb, z0], [x0, yb, z0], [x0, yt, z0], [x1, yt, z0]]; nn = [0, 0, -1]; }
    tb.quad(q, nn, [cB, cB, cT, cT], 0, 0, null, bn);
  }
  // Sheet hanging off a cell edge, leaning out from o0 (top) to o1 (bottom) and widened by e each side.
  // Vertex colour is data for the falls shader: r = 0 at the top .. 1 at the bottom, g = 1 for the mist layer.
  function fall(dir, x0, x1, z0, z1, yt, yb, o0, o1, e, mist, bn) {
    const [nx, nz] = DIRS[dir], a = [[x1, z1], [x0, z0], [x0, z1], [x1, z0]][dir], b = [[x1, z0], [x0, z1], [x1, z1], [x0, z0]][dir];
    const ux = b[0] - a[0], uz = b[1] - a[1];
    const P = (p, s, y, o) => [p[0] + nx * o + ux * s * e, y, p[1] + nz * o + uz * s * e];
    falls.quad([P(a, -1, yb, o1), P(b, 1, yb, o1), P(b, 1, yt, o0), P(a, -1, yt, o0)], [nx, 0, nz], [[1, mist, 0], [1, mist, 0], [0, mist, 0], [0, mist, 0]], 0, 0, null, bn);
  }

  const mapPx = new Uint8ClampedArray(N * 4);
  const hexRGB = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
  const MAPC = { [TYPE.WATER]: PAL.waterTop, [TYPE.SAND]: PAL.sand, [TYPE.MESA]: PAL.mesaMap, [TYPE.VILLAGE]: PAL.ground1, [TYPE.PATH]: PAL.pathMap, [TYPE.GRASS]: PAL.grass };

  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, t = type[k];
    if (t === TYPE.NONE) continue;
    const x0 = ox + i, x1 = x0 + 1, z0 = oz + j, z1 = z0 + 1, h = lvl[k], bn = born[k];
    const plaza = (SUB || JP) && t === TYPE.PATH && cdA[k] < 3.3;
    mapPx.set([...hexRGB(plaza ? PAL.plaza : MAPC[t]), 255], k * 4);
    if (t === TYPE.WATER) wb.quad([[x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0]], [0, 1, 0], [[1, 1, 1]], 0, 0, null, bn);
    else {
      const hi = (di, dj) => (inside(i + di, j + dj) && lvl[(j + dj) * W + i + di] > h + 0.05 ? 1 : 0);
      const ao = (a, b, c) => AO[a && b ? 3 : a + b + c];
      let tc = t === TYPE.VILLAGE ? (hash(x0 * 0.7, z0 * 1.3) > 0.5 ? G1 : G2) : topCol[t];
      if (SUB && t === TYPE.PATH) tc = plaza ? lin(hash(x0 * 0.7, z0 * 1.3) > 0.5 ? PAL.plaza : PAL.plaza2) : pdA[k] > -0.32 ? lin(PAL.kerb) : tc;
      if (JP && t === TYPE.PATH) tc = lin(plaza ? (hash(x0 * 0.7, z0 * 1.3) > 0.5 ? PAL.plaza : PAL.plaza2) : hash(x0 * 1.7, z0 * 0.9) > 0.5 ? PAL.path : PAL.path2);
      if (JP && t === TYPE.MESA && !DIRS.some(([a, c]) => !inside(i + a, j + c) || lvl[(j + c) * W + i + a] < h - 0.05)) {
        // Flooded paddy with two rows of young rice; the terrace lips stay green.
        tc = lin(hash(x0 * 0.7, z0 * 1.3) > 0.5 ? PAL.paddy : PAL.paddy2);
        for (const lx of [0.27, 0.73]) fb.box(x0 + lx, h, z0 + 0.5, 0.07, 0.18 + hash(x0 + lx, z0) * 0.1, 0.07, PAL.rice[lx < 0.5 ? 0 : 1], { sway: 1.1, swayBase: h, born: wave(k), edges: false });
      }
      tb.quad([[x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0]], [0, 1, 0], [
        mul(tc, ao(hi(-1, 0), hi(0, 1), hi(-1, 1))), mul(tc, ao(hi(1, 0), hi(0, 1), hi(1, 1))),
        mul(tc, ao(hi(1, 0), hi(0, -1), hi(1, -1))), mul(tc, ao(hi(-1, 0), hi(0, -1), hi(-1, -1))),
      ], 0, 0, null, bn);
    }
    for (let dIdx = 0; dIdx < 4; dIdx++) {
      const [di, dj] = DIRS[dIdx], ni = i + di, nj = j + dj;
      if (!inside(ni, nj)) {
        const x = cx(i), z = cz(j);
        const band = t === TYPE.WATER ? 0.5 : 0.26 + 0.22 * vnoise(x * 0.4 + dIdx * 3.1, z * 0.4);
        const mid = -1.6 + (vnoise(x * 0.18 + 9, z * 0.18 - 4) - 0.5) * 0.9;
        side(dIdx, x0, x1, z0, z1, h, h - band, sideCol[t], sideCol[t], bn);
        side(dIdx, x0, x1, z0, z1, h - band, mid, earth, earth, bn);
        side(dIdx, x0, x1, z0, z1, mid, BOTTOM_Y, deep, mul(deep, 0.7), bn);
        if (t === TYPE.WATER) {
          fall(dIdx, x0, x1, z0, z1, h + 0.02, h - FALL, 0.02, 0.32, 0.02, 0, bn);
          fall(dIdx, x0, x1, z0, z1, h - FALL * 0.55, h - FALL - 0.8, 0.3, 0.8, 0.35, 1, bn);
        }
      } else {
        const nk = nj * W + ni, nh = lvl[nk];
        if (t !== TYPE.WATER && nh < h - 0.01) {
          const band = Math.min(0.3, h - nh);
          side(dIdx, x0, x1, z0, z1, h, h - band, sideCol[t], h - band <= nh + 0.01 ? mul(sideCol[t], 0.8) : sideCol[t], bn);
          if (h - band > nh + 0.01) side(dIdx, x0, x1, z0, z1, h - band, nh, earth, mul(earth, 0.72), bn);
        }
        // Skirt where new land meets old, so the rising block has solid sides. Hidden once risen.
        if (bn && !born[nk]) side(dIdx, x0, x1, z0, z1, Math.min(h, nh), BOTTOM_Y, earth, mul(deep, 0.7), bn);
      }
    }
  }

  // Outer village wall: stacked stones on every village cell that touches the outside; gaps where paths leave.
  const isV = (i, j) => inside(i, j) && (type[j * W + i] === TYPE.VILLAGE || type[j * W + i] === TYPE.PATH);
  const wallCells = new Uint8Array(N), cairns = [];
  const vBorn = villages.map((v) => (bornAt(v.cx, v.cz) ? 2.5 : 0));
  const gates = villages.flatMap((v, vi) => v.hubs.map((h, hi) => ({ x: h.gx, z: h.gz, a: h.a, accent: ACCENTS[hi % ACCENTS.length], vi })));
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (type[k] !== TYPE.VILLAGE) continue;
    let out = 0; for (const [di, dj] of DIRS) if (!isV(i + di, j + dj)) out++;
    if (!out) continue;
    const x = cx(i), z = cz(j);
    if (gates.some((g) => Math.hypot(g.x - x, g.z - z) < 1.4)) continue;
    wallCells[k] = 1;
    let vi = 0, best = Infinity;
    villages.forEach((v, n) => { const d = Math.hypot(v.cx - x, v.cz - z); if (d < best) { best = d; vi = n; } });
    const v = villages[vi], frac = ((((Math.atan2(-(z - v.cz), x - v.cx) - v.a0) / (Math.PI * 2)) % 1) + 1) % 1;
    const bn = vBorn[vi] ? Math.min(2.72, 2.5 + frac * 0.22) : 0;
    const r = hash((ox + i) * 0.37, (oz + j) * 0.91), R = rng(r * 0.98 + 0.01), y = lvl[k];
    if (SUB) { tb.box(x, y, z, 0.92, 0.36 + R() * 0.06, 0.92, PAL.hedge[Math.floor(R() * 3)], { ao: y, born: bn }); mapPx.set([0x3b, 0x77, 0x33, 255], k * 4); continue; }
    if (JP) {
      // Temple wall: stone footing, white plaster, dark tile cap.
      tb.box(x, y, z, 0.96, 0.22, 0.96, STONE[Math.floor(R() * 4)], { ao: y, born: bn });
      tb.box(x, y + 0.22, z, 0.8, 0.34, 0.8, PLASTER, { born: bn });
      tb.box(x, y + 0.56, z, 0.9, 0.08, 0.9, TILE, { born: bn });
      mapPx.set([0xe6, 0xe0, 0xd2, 255], k * 4); continue;
    }
    const cairn = out >= 2 && cairns.every((p) => Math.hypot(p[0] - x, p[1] - z) > 5);
    const h1 = 0.32 + R() * 0.08;
    tb.box(x + (R() - 0.5) * 0.08, y, z + (R() - 0.5) * 0.08, 0.94, h1, 0.94, STONE[Math.floor(R() * 4)], { rot: (R() - 0.5) * 0.12, ao: y, born: bn });
    let top = y + h1;
    { const h2 = 0.26 + R() * 0.06; tb.box(x + (R() - 0.5) * 0.16, top, z + (R() - 0.5) * 0.16, 0.66 + R() * 0.2, h2, 0.62 + R() * 0.2, STONE[Math.floor(R() * 4)], { rot: (R() - 0.5) * 0.4, born: bn }); top += h2; }
    if (cairn) {
      cairns.push([x, z]);
      for (let s = 0; s < 3; s++) { const w = 0.62 - s * 0.14, hh = 0.3 - s * 0.03; tb.box(x + (R() - 0.5) * 0.08, top, z + (R() - 0.5) * 0.08, w, hh, w, STONE[(s + 2) % 4], { rot: R() * 1.5, born: bn }); top += hh; }
    }
    mapPx.set([0x8e, 0x86, 0x7a, 255], k * 4);
  }
  for (const g of gates) {
    const px = Math.sin(g.a), pz = Math.cos(g.a), bn = vBorn[g.vi] ? 2.72 : 0;
    if (JP) {
      const kg = cellAt(g.x, g.z), ok = [-1, 1].every((s) => { const kk = cellAt(g.x + px * 1.3 * s, g.z + pz * 1.3 * s); return kk >= 0 && type[kk] !== TYPE.WATER && type[kk] !== TYPE.NONE; });
      if (ok) torii(tb, g.x, g.z, g.a - Math.PI / 2, kg >= 0 ? lvl[kg] : VILLAGE_Y, 1.3, 2.0, g.accent, bn, true);
      continue;
    }
    for (const s of [-1, 1]) {
      const x = g.x + px * 1.55 * s, z = g.z + pz * 1.55 * s, k = cellAt(x, z);
      if (k < 0 || type[k] === TYPE.WATER || type[k] === TYPE.NONE) continue;
      const gy = lvl[k];
      if (SUB) { tb.box(x, gy, z, 0.24, 0.72, 0.24, 0xf3f1ea, { rot: -g.a, ao: gy, born: bn }); tb.box(x, gy + 0.72, z, 0.32, 0.1, 0.32, g.accent, { rot: -g.a, born: bn }); continue; }
      tb.box(x, gy, z, 0.86, 0.46, 0.86, STONE[0], { rot: -g.a, ao: gy, born: bn });
      tb.box(x, gy + 0.46, z, 0.72, 0.42, 0.72, STONE[2], { rot: -g.a + 0.12, born: bn });
      tb.box(x, gy + 0.88, z, 0.66, 0.24, 0.66, g.accent, { rot: -g.a, born: bn });
    }
  }
  const nearWall = (x, z) => { for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const k = cellAt(x + di, z + dj); if (k >= 0 && wallCells[k]) return true; } return false; };

  const dl = distField(W, H, (k) => type[k] !== TYPE.WATER && type[k] !== TYPE.NONE);
  const tex = new Uint8Array(N * 4);
  for (let k = 0; k < N; k++) { tex[k * 4] = Math.min(255, Math.round((Math.min(dl[k], 12) / 12) * 255)); tex[k * 4 + 3] = 255; }
  const distTex = new THREE.DataTexture(tex, W, H, THREE.RGBAFormat);
  distTex.magFilter = THREE.LinearFilter; distTex.minFilter = THREE.LinearFilter; distTex.needsUpdate = true;

  // Nature
  const trees = [];
  for (let g = 0; g <= g0; g++) for (let j = at(oz, 3, 1); j < H - 1; j += 3) for (let i = at(ox, 3, 1); i < W - 1; i += 3) {
    const ii = Math.min(W - 2, i + Math.floor(hash(ox + i, oz + j) * 3)), jj = Math.min(H - 2, j + Math.floor(hash(oz + j, ox + i + 0.5) * 3));
    const k = jj * W + ii, t = type[k];
    if (gen[k] !== g || t === TYPE.NONE || t === TYPE.WATER || t === TYPE.PATH) continue;
    const x = cx(ii) + (hash(ox + ii, 3.3) - 0.5) * 0.5, z = cz(jj) + (hash(oz + jj, 7.1) - 0.5) * 0.5, y = lvl[k], bn = wave(k);
    const r = hash((ox + ii) * 1.31, (oz + jj) * 0.77), R = rng(hash(ox + ii + 0.1, oz + jj + 0.3) * 0.98 + 0.01);
    const flat = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, c]) => inside(ii + a, jj + c) && Math.abs(lvl[(jj + c) * W + ii + a] - y) < 0.01);
    if (t === TYPE.VILLAGE) {
      if (JP) { if (r < 0.09 && vd[k] < -0.6) tb.box(x, y, z, 0.5 + R() * 0.5, 0.03, 0.4 + R() * 0.5, R() < 0.5 ? 0x86ad5a : 0x76a050, { rot: R(), edges: false, born: bn }); }
      else if (!SUB && r < 0.1 && vd[k] < -0.6) tufts(fb, x, y, z, R, bn);
      continue;
    }
    if (JP && t === TYPE.MESA) continue;
    if (t === TYPE.SAND) {
      if (r < 0.16) for (let p = 0; p < 2; p++) tb.box(x + (R() - 0.5) * 2, y, z + (R() - 0.5) * 2, 0.42, 0.03, 0.42, PAL.pebble[p], { edges: false, born: bn });
      else if (r < 0.2 && flat) { tb.box(x, y, z, 0.95, 0.42, 0.7, PAL.rock[0], { ao: y, born: bn }); tb.box(x + 0.45, y, z + 0.35, 0.6, 0.3, 0.5, PAL.rock[1], { ao: y, born: bn }); }
      else if (r < 0.3 && dw[k] > 1.5) tufts(fb, x, y, z, R, bn);
      continue;
    }
    const dens = fbm(x * 0.03 + 200, z * 0.03, 2);
    if (JP) {
      if (fbm(x * 0.05 + 300, z * 0.05 - 120, 3) > 0.6 && flat && vd[k] > 2 && dw[k] > 1) bamboo(fb, x, y, z, R, bn);
      else if (r < 0.28 * dens && flat && vd[k] > 2.5 && dw[k] > 1.5 && trees.every((p) => Math.hypot(p[0] - x, p[1] - z) > 4.5)) { trees.push([x, z]); (R() < 0.5 ? sakura : cedar)(fb, x, y, z, R, bn); }
      else if (r < 0.36 * dens && flat && vd[k] > 1.5) azalea(fb, x, y, z, R, bn);
      else if (r < 0.62) tufts(fb, x, y, z, R, bn);
      continue;
    }
    if (r < (SUB ? 0.34 : 0.2) * dens && flat && vd[k] > 2.5 && dw[k] > 1.5 && trees.every((p) => Math.hypot(p[0] - x, p[1] - z) > (SUB ? 3.6 : 7))) { trees.push([x, z]); (SUB ? (R() < 0.58 ? pine : birch) : bigTree)(fb, x, y, z, R, bn); }
    else if (r < 0.32 * dens && flat && vd[k] > 1.5) (SUB ? subBush : bush)(fb, x, y, z, R, bn);
    else if (r < 0.62) tufts(fb, x, y, z, R, bn);
  }

  // Jetties with rowing boats where a long stretch of water meets the shore.
  if (SUB) {
    const jet = [];
    for (let g = 0; g <= g0; g++) for (let j = 2; j < H - 2; j += 2) for (let i = 2; i < W - 2; i += 2) {
      const k = j * W + i, t = type[k];
      if (gen[k] !== g || (t !== TYPE.SAND && t !== TYPE.GRASS) || vd[k] < 4 || hash((ox + i) * 0.13, (oz + j) * 0.29) > 0.55) continue;
      const x = cx(i), z = cz(j);
      if (jet.some((p) => Math.hypot(p[0] - x, p[1] - z) < 20)) continue;
      for (const [di, dj] of DIRS) {
        let n = 0; while (n < 6 && inside(i + di * (n + 1), j + dj * (n + 1)) && type[(j + dj * (n + 1)) * W + i + di * (n + 1)] === TYPE.WATER) n++;
        if (n < 6) continue;
        jet.push([x, z]); jetty(tb, x, z, di, dj, lvl[k], wave(k), hash(ox + i, oz + j));
        for (let s = 1; s <= 4; s++) mapPx.set([0xa9, 0x8a, 0x66, 255], ((j + dj * s) * W + i + di * s) * 4);
        break;
      }
    }
  }

  if (JP) {
    // Red arched bridges where a narrow river separates two banks.
    const brs = [], landOK = (k) => k >= 0 && (type[k] === TYPE.GRASS || type[k] === TYPE.SAND) && vd[k] > 2.5;
    for (let g = 0; g <= g0; g++) for (let j = 3; j < H - 3; j++) for (let i = 3; i < W - 3; i++) {
      const k0 = j * W + i;
      if (gen[k0] !== g || !landOK(k0)) continue;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        let n = 0; while (n < 8 && inside(i + di * (n + 1), j + dj * (n + 1)) && type[(j + dj * (n + 1)) * W + i + di * (n + 1)] === TYPE.WATER) n++;
        if (n < 2 || n > 6) continue;
        const i1 = i + di * (n + 1), j1 = j + dj * (n + 1);
        if (!inside(i1, j1) || !landOK(j1 * W + i1)) continue;
        const mi = i + di * Math.ceil(n / 2), mj = j + dj * Math.ceil(n / 2);
        const wet = (a) => inside(mi + dj * a, mj + di * a) && type[(mj + di * a) * W + mi + dj * a] === TYPE.WATER;
        if (![1, -1, 2, -2].every(wet)) continue;
        const x = cx(i), z = cz(j);
        if (brs.some((p) => Math.hypot(p[0] - x, p[1] - z) < 18)) continue;
        brs.push([x, z]);
        bridge(tb, x, z, cx(i1), cz(j1), lvl[k0], lvl[j1 * W + i1], wave(k0));
        for (let s = 1; s <= n; s++) mapPx.set([0xd2, 0x45, 0x2c, 255], ((j + dj * s) * W + i + di * s) * 4);
      }
    }
    // Fishing boats out on open water.
    const boats = [];
    for (let g = 0; g <= g0; g++) for (let j = at(oz, 3, 2); j < H - 2; j += 3) for (let i = at(ox, 3, 2); i < W - 2; i += 3) {
      const k = j * W + i;
      if (gen[k] !== g || type[k] !== TYPE.WATER || dl[k] < 3 || hash((ox + i) * 0.21, (oz + j) * 0.37) > 0.35) continue;
      const x = cx(i), z = cz(j);
      if (boats.some((p) => Math.hypot(p[0] - x, p[1] - z) < 16)) continue;
      boats.push([x, z]); boat(tb, x, z, hash(ox + i, (oz + j) * 0.7) * 6.28, wave(k));
    }
  }

  const cities = new Map();
  for (const v of villages) {
    const villageBorn = bornAt(v.cx, v.cz) ? 2.45 : 0;
    cities.set(v.repo, (SUB ? buildSuburb : JP ? buildTemple : buildVillage)(tb, fb, v, villageBorn, cellAt, type, nearWall));
  }
  if (JP) {
    const m = Math.max(...slots.map((s) => (s.x - s.y) * Math.SQRT1_2)) + ISLAND_R + 10;
    mountain(tb, (m - 8) * Math.SQRT1_2, (-m - 8) * Math.SQRT1_2, prev ? 0 : 1);
  }

  return {
    ox, oz, W, H, type, lvl, gen, maxGen: g0, cities, distTex, mapPx,
    center: new THREE.Vector3(ox + W / 2, GRASS_Y, oz + H / 2),
    terrainGeo: tb.geometry(), waterGeo: wb.geometry(), foliageGeo: fb.geometry(), fallsGeo: falls.geometry(),
    heightAt(x, z) { const k = cellAt(x, z); return k >= 0 && type[k] ? lvl[k] : GRASS_Y; },
  };
}

function tufts(b, x, y, z, R, born) {
  const n = 2 + Math.floor(R() * 2);
  for (let i = 0; i < n; i++) b.box(x + (R() - 0.5) * 0.6, y, z + (R() - 0.5) * 0.6, 0.15, 0.38 + R() * 0.38, 0.15, PAL.tuft[i % 2], { sway: 1.3, swayBase: y, born, edges: false });
}
function canopy(b, cx, cy, cz, s, pal, R, born, baseY) {
  const o = { sway: 0.32, swayBase: baseY, born };
  b.box(cx, cy, cz, 2.6 * s, 0.7 * s, 2.3 * s, pal[0], o);
  const n = 3 + Math.floor(R() * 3);
  for (let i = 0; i < n; i++) b.box(cx + (R() - 0.5) * 1.9 * s, cy + (0.15 + R() * 0.5) * s, cz + (R() - 0.5) * 1.7 * s, (1.1 + R()) * s, (0.5 + R() * 0.35) * s, (1.0 + R()) * s, pal[1 + (i % 2)], o);
  b.box(cx + (R() - 0.5) * 0.6 * s, cy + 0.7 * s, cz + (R() - 0.5) * 0.6 * s, 1.5 * s, 0.5 * s, 1.3 * s, pal[3], o);
}
function bigTree(b, x, y, z, R, born, pals = TREE_PALS) {
  const pal = pals[Math.floor(R() * pals.length)];
  const th = 2.0 + R() * 1.4, tw = 0.75 + R() * 0.25, top = y + th;
  b.box(x, y, z, tw, th, tw, PAL.trunk, { ao: y, born });
  const crowns = [[x, top + 0.2, z, 1.2]];
  const nb = 2 + Math.floor(R() * 2), a0 = R() * 6.28;
  for (let k = 0; k < nb; k++) {
    const a = a0 + (k * 6.28) / nb + (R() - 0.5) * 0.6, dx = Math.cos(a), dz = Math.sin(a);
    let px = x, py = top - 1.0 - R() * 0.5, pz = z;
    const steps = 2 + Math.floor(R() * 2);
    for (let s = 0; s < steps; s++) { px += dx * 0.55; pz += dz * 0.55; py += 0.4; b.box(px, py, pz, 0.48, 0.55, 0.48, PAL.branch, { born }); }
    crowns.push([px + dx * 0.4, py + 0.45, pz + dz * 0.4, 0.75 + R() * 0.3]);
  }
  for (const [cx, cy, cz, s] of crowns) canopy(b, cx, cy, cz, s, pal, R, born, y);
}
function bush(b, x, y, z, R, born) {
  const pal = TREE_PALS[1 + Math.floor(R() * 2)], o = { sway: 0.5, swayBase: y, born };
  if (R() < 0.5) {
    const th = 0.6 + R() * 0.5;
    b.box(x, y, z, 0.3, th, 0.3, PAL.branch, { ao: y, born });
    b.box(x, y + th, z, 1.3, 0.6, 1.1, pal[0], o);
    b.box(x + (R() - 0.5) * 0.6, y + th + 0.35, z + (R() - 0.5) * 0.5, 0.8, 0.5, 0.8, pal[3], o);
  } else b.box(x, y, z, 1.1 + R() * 0.5, 0.35, 0.9 + R() * 0.4, pal[1], { ...o, ao: y, sway: 0.2 });
}

function buildVillage(b, fb, v, born0, cellAt, type, nearWall) {
  const R = rng(strHash(v.repo, 31) * 0.98 + 0.01), y = VILLAGE_Y;
  let stagger = 0;
  const bn = () => (born0 ? Math.min(2.72, born0 + (stagger += 0.0025)) : 0);
  const { cx, cz } = v;

  // Fire pit, seats, totem
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; b.box(cx + Math.cos(a) * 0.62, y, cz - Math.sin(a) * 0.62, 0.28, 0.2, 0.28, PAL.stone, { ao: y, born: bn(), rot: a }); }
  b.box(cx, y, cz, 1.0, 0.14, 0.18, PAL.log, { rot: 0.5, born: bn() });
  b.box(cx, y + 0.06, cz, 1.0, 0.14, 0.18, PAL.log, { rot: -0.7, born: bn() });
  b.box(cx, y + 0.12, cz, 0.36, 0.34, 0.36, PAL.flame, { emit: -1, born: bn(), edges: false });
  b.box(cx + 0.06, y + 0.4, cz - 0.04, 0.24, 0.26, 0.24, PAL.flame2, { emit: -1.2, born: bn(), edges: false, rot: 0.6 });
  b.box(cx - 0.03, y + 0.62, cz + 0.02, 0.13, 0.16, 0.13, PAL.flame2, { emit: -1.4, born: bn(), edges: false, rot: 0.2 });
  const between = v.hubs.length > 1 ? v.hubs[0].a + Math.PI / v.hubs.length : v.hubs[0].a + Math.PI;
  for (let i = 0; i < 3; i++) {
    const a = between + Math.PI * 0.66 * i + 0.4;
    b.box(cx + Math.cos(a) * 2.3, y, cz - Math.sin(a) * 2.3, 1.1, 0.24, 0.28, PAL.log, { rot: a - Math.PI / 2, ao: y, born: bn() });
  }
  const tx = cx + Math.cos(between) * 2.9, tz = cz - Math.sin(between) * 2.9;
  const totem = [[0.44, 0.55, PAL.wood], [0.48, 0.16, ACCENTS[0]], [0.4, 0.5, 0x9c6a42], [0.48, 0.16, ACCENTS[1]], [0.42, 0.45, PAL.wood]];
  let ty = y;
  for (const [w, h, c] of totem) { b.box(tx, ty, tz, w, h, w, c, { ao: ty === y ? y : undefined, born: bn() }); ty += h; }
  b.box(tx, ty, tz, 0.95, 0.12, 0.3, PAL.wood2, { born: bn() });
  b.box(tx, ty + 0.12, tz, 0.3, 0.3, 0.3, 0xe8d6b0, { born: bn() });

  const districts = new Map();
  const huts = [];
  v.hubs.forEach((h, i) => {
    const accent = ACCENTS[i % ACCENTS.length];
    // Hub: flag pole + idle log
    b.box(h.x, y, h.z, 0.08, 1.9, 0.08, PAL.wood2, { ao: y, born: bn() });
    b.box(h.x + 0.27 * Math.cos(h.a + Math.PI / 2), y + 1.55, h.z - 0.27 * Math.sin(h.a + Math.PI / 2), 0.5, 0.32, 0.05, accent, { rot: h.a, born: bn() });
    const perp = h.a + Math.PI / 2;
    const logX = h.x + Math.cos(h.a) * 0.4 + Math.cos(perp) * 1.25, logZ = h.z - Math.sin(h.a) * 0.4 - Math.sin(perp) * 1.25;
    b.box(logX, y, logZ, 1.3, 0.24, 0.28, PAL.log, { rot: h.a, ao: y, born: bn() });
    const seats = [-0.35, 0.35].map((o) => new THREE.Vector3(logX + Math.cos(h.a) * o, y, logZ - Math.sin(h.a) * o));
    const sitFacing = Math.atan2(Math.cos(perp + Math.PI) * -1, Math.sin(perp + Math.PI)); // face the hub
    const spots = [];

    const count = 3 + Math.floor(strHash(h.branch, 3) * 3);
    const step = 0.78;
    for (let k = 0; k < count; k++) {
      const ang = h.a + (k - (count - 1) / 2) * step + (R() - 0.5) * 0.15;
      const r = 2.8 + R() * 0.6;
      const x = h.x + Math.cos(ang) * r, z = h.z - Math.sin(ang) * r;
      if (Math.hypot(x - cx, z - cz) < 4.4) continue;
      if (huts.some((p) => Math.hypot(p[0] - x, p[1] - z) < 2.3)) continue;
      const kc = cellAt(x, z);
      if (kc < 0 || (type[kc] !== 5 && type[kc] !== 6)) continue;
      const rot = Math.atan2(h.x - x, h.z - z), kind = R();
      huts.push([x, z, kind < 0.8 ? 1.0 : 1.35]);
      const fx = Math.sin(rot), fz = Math.cos(rot);
      let depth = 1.4;
      if (kind < 0.5) {
        const w = 1.3 + R() * 0.3; depth = w;
        b.box(x, y, z, w, 0.8, w, R() < 0.5 ? PAL.mud : PAL.mud2, { rot, ao: y, born: bn() });
        b.pyramid(x, y + 0.8, z, w + 0.45, w + 0.45, 0.95 + R() * 0.25, R() < 0.5 ? PAL.thatch : PAL.thatch2, rot, bn());
        b.lbox(x, z, rot, 0, y, w / 2 + 0.01, 0.36, 0.55, 0.04, PAL.door, { born: bn(), emit: 0.9 });
        b.lbox(x, z, rot, 0, y + 1.55, 0, 0.04, 0.45, 0.04, PAL.wood2, { born: bn() });
        b.lbox(x, z, rot, 0.12, y + 1.82, 0, 0.22, 0.14, 0.03, accent, { born: bn() });
      } else if (kind < 0.8) {
        const w = 1.5; depth = w;
        b.pyramid(x, y, z, w, w, 1.9, PAL.hide, rot, bn(), PAL.door);
        b.lbox(x, z, rot, 0, y + 0.55, 0, 1.12, 0.12, 1.12, accent, { born: bn(), edges: false });
        b.lbox(x, z, rot, 0, y, w / 2 - 0.12, 0.34, 0.5, 0.04, PAL.door, { born: bn(), emit: 0.8 });
        for (const [lx, lz] of [[-0.12, 0.08], [0.12, -0.08]]) b.lbox(x, z, rot, lx, y + 1.75, lz, 0.05, 0.4, 0.05, PAL.wood2, { born: bn() });
      } else {
        const w = 2.2, d = 1.3; depth = d;
        b.box(x, y, z, w, 0.85, d, PAL.mud, { rot, ao: y, born: bn() });
        b.gable(x, y + 0.85, z, w + 0.3, d + 0.35, 0.75, PAL.thatch, PAL.mud2, rot, bn());
        b.lbox(x, z, rot, 0, y, d / 2 + 0.01, 0.36, 0.55, 0.04, PAL.door, { born: bn(), emit: 1 });
        b.lbox(x, z, rot, 0, y + 1.6, 0, 2.5, 0.08, 0.1, accent, { born: bn(), edges: false });
      }
      spots.push(new THREE.Vector3(x + fx * (depth / 2 + 0.6), y, z + fz * (depth / 2 + 0.6)));
      // Props: pot by the door, stake fence behind
      if (R() < 0.6) b.lbox(x, z, rot, depth / 2 + 0.15, y, depth / 2 + 0.25, 0.24, 0.3, 0.24, PAL.pot, { ao: y, born: bn() });
    }
    if (!spots.length) spots.push(new THREE.Vector3(h.x + Math.cos(h.a) * 1.5, y, h.z - Math.sin(h.a) * 1.5));
    // Inner knee-high wall around the branch cluster; accent cap stones where each run opens.
    const rW = 4.5, n = Math.round((Math.PI * 2 * rW) / 0.52), stepA = (Math.PI * 2) / n, gapA = h.a + Math.PI;
    const ring = [];
    for (let q = 0; q < n; q++) {
      const a = gapA + (q + 0.5) * stepA, x = h.x + Math.cos(a) * rW, z = h.z - Math.sin(a) * rW, kc = cellAt(x, z);
      const ok = kc >= 0 && type[kc] === 5 && !nearWall(x, z) && Math.hypot(x - cx, z - cz) > 4.7
        && !v.hubs.some((o) => o !== h && Math.hypot(o.x - x, o.z - z) < rW) && !huts.some((p) => Math.hypot(p[0] - x, p[1] - z) < p[2] + 0.35);
      ring.push({ a, x, z, ok });
    }
    ring.forEach((p, q) => {
      if (!p.ok) return;
      const prev = ring[(q + n - 1) % n].ok, next = ring[(q + 1) % n].ok;
      if (!prev && !next) return;
      const end = !prev || !next, hh = end ? 0.42 : 0.26 + R() * 0.1;
      b.box(p.x, y, p.z, end ? 0.48 : 0.5 + R() * 0.12, hh, end ? 0.48 : 0.4, STONE[Math.floor(R() * 4)], { rot: p.a + Math.PI / 2 + (R() - 0.5) * 0.2, ao: y, born: bn() });
      if (end) b.box(p.x, y + hh, p.z, 0.4, 0.14, 0.4, accent, { rot: p.a, born: bn() });
    });
    districts.set(h.branch, { branch: h.branch, accent, hub: new THREE.Vector3(h.x, y, h.z), angle: h.a, spots, seats, sitFacing: h.a + Math.PI / 2 });
  });

  return { repo: v.repo, districts, center: new THREE.Vector3(cx, y, cz), totem: new THREE.Vector3(tx, ty + 0.5, tz), fire: new THREE.Vector3(cx, y + 0.5, cz) };
}

// ── Suburb ──────────────────────────────────────────────────────────────
const GLASS = 0x2a3a4c, METAL = 0x3a3d42, CARS = [0xdfe2e5, 0x2e3440, 0xb5362c, 0x2f5f9e, 0x6b7a5a, 0xf1efe9], HULLS = [0xf1efe9, 0xb5362c, 0x2f5f9e];

function pine(b, x, y, z, R, born) {
  const s = 0.85 + R() * 0.4, th = 0.7 * s, o = { sway: 0.22, swayBase: y, born }, G = [0x2f5d36, 0x386a3d, 0x2a5530];
  b.box(x, y, z, 0.32, th + 0.4, 0.32, 0x5a4232, { ao: y, born });
  let ty = y + th, w = 1.9 * s;
  for (let i = 0; i < 4; i++) { b.box(x, ty, z, w, 0.62 * s, w, G[i % 3], { ...o, rot: i * 0.4 + R() * 0.3 }); ty += 0.5 * s; w *= 0.7; }
  b.box(x, ty, z, 0.25 * s, 0.4 * s, 0.25 * s, G[1], o);
}
function birch(b, x, y, z, R, born) {
  const th = 2.0 + R() * 1.0, top = y + th, C = [0x9cc64a, 0x8bbb43, 0xb2d35c, 0x7fae3e], o = { sway: 0.35, swayBase: y, born };
  b.box(x, y, z, 0.26, th, 0.26, 0xeeebe2, { ao: y, born });
  for (let i = 0; i < 5; i++) b.box(x + (R() < 0.5 ? -0.07 : 0.07), y + 0.25 + R() * (th - 0.6), z + (R() < 0.5 ? -0.07 : 0.07), 0.14, 0.05, 0.14, 0x2a2a2a, { born, edges: false });
  b.box(x, top - 0.6, z, 1.3, 1.0, 1.2, C[0], o);
  for (let i = 0; i < 4; i++) b.box(x + (R() - 0.5) * 1.1, top - 0.9 + R() * 0.9, z + (R() - 0.5) * 1.0, 0.7 + R() * 0.4, 0.6 + R() * 0.4, 0.7 + R() * 0.4, C[1 + (i % 3)], o);
  b.box(x, top + 0.3, z, 0.7, 0.5, 0.7, C[2], o);
}
function subBush(b, x, y, z, R, born) {
  const o = { sway: 0.3, swayBase: y, born, ao: y }, G = [0x4f8a35, 0x5c9a3c, 0x467d30];
  b.box(x, y, z, 0.9 + R() * 0.4, 0.45 + R() * 0.2, 0.8 + R() * 0.4, G[Math.floor(R() * 3)], o);
  b.box(x + (R() - 0.5) * 0.4, y + 0.3, z + (R() - 0.5) * 0.4, 0.6, 0.35, 0.6, G[Math.floor(R() * 3)], o);
}

function jetty(b, x, z, di, dj, y0, born, r) {
  const rot = Math.atan2(di, dj), dy = y0 + 0.02, low = WATER_Y - 0.3;
  b.lbox(x, z, rot, 0, dy, 2.3, 0.8, 0.08, 4.0, 0xa98a66, { born });
  for (const lz of [1.2, 2.5, 3.8, 4.25]) for (const lx of [-0.42, 0.42]) b.lbox(x, z, rot, lx, low, lz, 0.1, dy + 0.16 - low, 0.1, 0x6e5640, { born });
  const hull = HULLS[Math.floor(r * HULLS.length)];
  b.lbox(x, z, rot, 0.98, WATER_Y - 0.05, 3.3, 0.56, 0.22, 1.2, hull, { born });
  b.lbox(x, z, rot, 0.98, WATER_Y - 0.03, 4.0, 0.34, 0.2, 0.3, hull, { born });
  b.lbox(x, z, rot, 0.98, WATER_Y + 0.12, 3.3, 0.44, 0.03, 1.06, 0x9a7650, { born, edges: false });
  b.lbox(x, z, rot, 0.98, WATER_Y + 0.15, 3.15, 0.46, 0.04, 0.14, 0x8a6a48, { born });
}

function bench(b, ox, oz, rot, y, bn) {
  b.lbox(ox, oz, rot, 0, y + 0.18, 0, 1.15, 0.06, 0.34, 0x9a6b45, { born: bn() });
  b.lbox(ox, oz, rot, 0, y + 0.3, -0.16, 1.15, 0.22, 0.05, 0x9a6b45, { born: bn() });
  for (const lx of [-0.45, 0.45]) b.lbox(ox, oz, rot, lx, y, 0, 0.06, 0.18, 0.3, 0x2c2e33, { ao: y, born: bn() });
}
function lamp(b, x, z, y, bn) {
  b.box(x, y, z, 0.07, 2.0, 0.07, METAL, { ao: y, born: bn() });
  b.box(x, y + 2.0, z, 0.28, 0.08, 0.28, METAL, { born: bn() });
  b.box(x, y + 1.96, z, 0.2, 0.04, 0.2, 0xfff1c8, { emit: 1.4, edges: false, born: bn() });
}
function roofPanel(b, ox, oz, rot, y0, D, rh, x0, x1, t0, t1, hex, born) {
  const hz = D / 2, c = Math.cos(rot), s = Math.sin(rot), L = Math.hypot(hz, rh), ny = (hz / L) * 0.03, nz = (rh / L) * 0.03;
  const T = (lx, t) => { const ly = y0 + rh * t + ny, lz = hz * (1 - t) + nz; return [ox + lx * c + lz * s, ly, oz - lx * s + lz * c]; };
  b.quad([T(x0, t0), T(x1, t0), T(x1, t1), T(x0, t1)], null, [lin(hex)], x1 - x0, (t1 - t0) * L, null, born);
}
function win(b, x, z, rot, lx, ly, lz, w, h, frame, bn, side = false) {
  const [fw, fd, gw, gd, ox, oz] = side ? [0.03, w + 0.08, 0.03, w, Math.sign(lx) * 0.01, 0] : [w + 0.08, 0.03, w, 0.03, 0, 0.01];
  b.lbox(x, z, rot, lx, ly, lz, fw, h + 0.08, fd, frame, { born: bn(), edges: false });
  b.lbox(x, z, rot, lx + ox, ly + 0.04, lz + oz, gw, h, gd, GLASS, { born: bn(), emit: 0.9, edges: false });
}

/** Three house types: 0 falu red with white trim, 1 black-clad modern, 2 white villa. Front faces local +z. */
function house(b, x, z, rot, y, kind, accent, R, bn) {
  let w, d, wh, wall, roof, rh, trim;
  if (kind === 0) { w = 1.7; d = 1.3; wh = 0.95; wall = 0xa3342b; roof = 0x33363b; rh = 0.7; trim = 0xf3efe6; }
  else if (kind === 1) { w = 1.6; d = 1.35; wh = 1.05; wall = 0x2b2c2f; roof = R() < 0.5 ? 0x5b7434 : 0x232427; rh = 0.95; trim = 0x1b1c1e; }
  else { w = 1.8; d = 1.45; wh = 1.0; wall = 0xeeeae0; roof = R() < 0.5 ? 0x8a3a2e : 0x575c63; rh = 0.75; trim = 0xffffff; }
  b.box(x, y, z, w, wh, d, wall, { rot, ao: y, born: bn() });
  b.gable(x, y + wh, z, w + 0.24, d + 0.3, rh, roof, wall, rot, bn());
  const fz = d / 2;
  if (kind !== 1) for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.lbox(x, z, rot, sx * (w / 2 - 0.02), y, sz * (d / 2 - 0.02), 0.1, wh, 0.1, trim, { born: bn(), edges: false });
  if (kind === 1) {
    b.lbox(x, z, rot, -0.45, y, fz + 0.01, 0.3, 0.58, 0.04, accent, { born: bn() });
    win(b, x, z, rot, 0.3, y + 0.22, fz, 0.62, 0.62, trim, bn);
    b.lbox(x, z, rot, 0.1, y, fz + 0.3, w * 0.8, 0.06, 0.55, 0xb08a5c, { born: bn() });
  } else {
    b.lbox(x, z, rot, 0, y, fz + 0.01, 0.3, 0.56, 0.04, accent, { born: bn() });
    for (const lx of [-0.52, 0.52]) win(b, x, z, rot, lx, y + 0.4, fz, 0.3, 0.32, trim, bn);
    b.lbox(x, z, rot, w * 0.25, y + wh, -d * 0.18, 0.18, rh + 0.35, 0.18, kind === 0 ? 0xf3efe6 : 0x8a4a3a, { born: bn() });
  }
  for (const sx of [-1, 1]) win(b, x, z, rot, sx * (w / 2), y + 0.42, 0, 0.34, 0.3, trim, bn, true);
  if (roof !== 0x5b7434 && R() < 0.55) roofPanel(b, x, z, rot, y + wh, d + 0.3, rh, -w * 0.32, w * 0.32 - (kind === 1 ? 0 : 0.1), 0.18, 0.78, 0x1f2c44, bn());
  return { w, d };
}
function car(b, ox, oz, rot, y, col, bn) {
  b.lbox(ox, oz, rot, 0, y, 0, 0.8, 0.02, 1.5, 0xb9b3a6, { born: bn(), edges: false });
  b.lbox(ox, oz, rot, 0, y + 0.1, 0, 0.6, 0.22, 1.12, col, { born: bn() });
  b.lbox(ox, oz, rot, 0, y + 0.32, -0.08, 0.54, 0.17, 0.62, GLASS, { born: bn() });
  b.lbox(ox, oz, rot, 0, y + 0.49, -0.1, 0.56, 0.04, 0.52, col, { born: bn() });
  for (const [lx, lz] of [[-0.3, 0.34], [0.3, 0.34], [-0.3, -0.36], [0.3, -0.36]]) b.lbox(ox, oz, rot, lx, y + 0.02, lz, 0.08, 0.2, 0.22, 0x1c1d20, { born: bn(), edges: false });
  for (const lx of [-0.2, 0.2]) b.lbox(ox, oz, rot, lx, y + 0.2, 0.565, 0.12, 0.05, 0.02, 0xfff3d0, { born: bn(), emit: 1, edges: false });
}
function trampoline(b, x, z, y, bn) {
  for (const [lx, lz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) b.box(x + lx, y, z + lz, 0.05, 0.32, 0.05, METAL, { born: bn(), edges: false });
  for (const r of [0, Math.PI / 4]) b.box(x, y + 0.32, z, 1.1, 0.06, 1.1, 0x2c6fb0, { rot: r, born: bn() });
  for (const r of [0, Math.PI / 4]) b.box(x, y + 0.36, z, 0.9, 0.03, 0.9, 0x1c1d20, { rot: r, born: bn(), edges: false });
}

function buildSuburb(b, fb, v, born0, cellAt, type, nearWall) {
  const R = rng(strHash(v.repo, 31) * 0.98 + 0.01), y = VILLAGE_Y;
  let stagger = 0;
  const bn = () => (born0 ? Math.min(2.72, born0 + (stagger += 0.0025)) : 0);
  const { cx, cz } = v, WATER = 0x5b9fdc;
  const L2W = (x, z, rot, lx, lz) => [x + lx * Math.cos(rot) + lz * Math.sin(rot), z - lx * Math.sin(rot) + lz * Math.cos(rot)];

  // Fountain
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; b.box(cx + Math.cos(a) * 1.05, y, cz - Math.sin(a) * 1.05, 0.88, 0.34, 0.22, PAL.stone, { rot: a + Math.PI / 2, ao: y, born: bn() }); }
  for (const r of [0, Math.PI / 4]) b.box(cx, y, cz, 1.86, 0.26, 1.86, WATER, { rot: r, born: bn(), edges: false });
  b.box(cx, y, cz, 0.32, 0.78, 0.32, PAL.stone, { ao: y, born: bn() });
  for (const r of [0, Math.PI / 4]) b.box(cx, y + 0.72, cz, 0.9, 0.1, 0.9, PAL.stone, { rot: r, born: bn() });
  b.box(cx, y + 0.78, cz, 0.72, 0.06, 0.72, WATER, { rot: Math.PI / 8, born: bn(), edges: false });
  b.box(cx, y + 0.82, cz, 0.12, 0.22, 0.12, PAL.stone, { born: bn() });

  const between = v.hubs.length > 1 ? v.hubs[0].a + Math.PI / v.hubs.length : v.hubs[0].a + Math.PI;
  for (let i = 0; i < 3; i++) {
    const a = between + Math.PI * 0.66 * i + 0.4;
    bench(b, cx + Math.cos(a) * 2.2, cz - Math.sin(a) * 2.2, a - Math.PI / 2, y, bn);
    const la = a + 0.75;
    lamp(b, cx + Math.cos(la) * 2.6, cz - Math.sin(la) * 2.6, y, bn);
  }
  // Flagpole with a Nordic-cross flag
  const tx = cx + Math.cos(between) * 2.9, tz = cz - Math.sin(between) * 2.9, fr = between;
  b.box(tx, y, tz, 0.07, 3.0, 0.07, 0xf3f1ea, { ao: y, born: bn() });
  b.box(tx, y + 3.0, tz, 0.11, 0.08, 0.11, 0xf5c400, { born: bn() });
  b.lbox(tx, tz, fr, 0.4, y + 2.45, 0, 0.72, 0.45, 0.03, 0x2a6bb3, { born: bn(), edges: false });
  b.lbox(tx, tz, fr, 0.4, y + 2.63, 0, 0.72, 0.09, 0.035, 0xf5c400, { born: bn(), edges: false });
  b.lbox(tx, tz, fr, 0.31, y + 2.45, 0, 0.09, 0.45, 0.035, 0xf5c400, { born: bn(), edges: false });

  const districts = new Map();
  const huts = [];
  v.hubs.forEach((h, i) => {
    const accent = ACCENTS[i % ACCENTS.length];
    // Street sign at the turning circle
    b.box(h.x, y, h.z, 0.07, 1.9, 0.07, 0x8a9096, { ao: y, born: bn() });
    b.box(h.x + 0.27 * Math.cos(h.a + Math.PI / 2), y + 1.55, h.z - 0.27 * Math.sin(h.a + Math.PI / 2), 0.5, 0.3, 0.05, accent, { rot: h.a, born: bn() });
    const perp = h.a + Math.PI / 2;
    const logX = h.x + Math.cos(h.a) * 0.4 + Math.cos(perp) * 1.25, logZ = h.z - Math.sin(h.a) * 0.4 - Math.sin(perp) * 1.25;
    bench(b, logX, logZ, h.a, y, bn);
    huts.push([logX, logZ, 0.7]);
    const seats = [-0.35, 0.35].map((o) => new THREE.Vector3(logX + Math.cos(h.a) * o, y, logZ - Math.sin(h.a) * o));
    const lx0 = cx + (h.x - cx) * 0.55 + Math.sin(h.a) * 0.95, lz0 = cz + (h.z - cz) * 0.55 + Math.cos(h.a) * 0.95, kl = cellAt(lx0, lz0);
    if (kl >= 0 && type[kl] === 5 && !nearWall(lx0, lz0)) { lamp(b, lx0, lz0, y, bn); huts.push([lx0, lz0, 0.3]); }
    const spots = [];

    const count = 3 + Math.floor(strHash(h.branch, 3) * 3);
    for (let k = 0; k < count; k++) {
      const ang = h.a + (k - (count - 1) / 2) * 0.78 + (R() - 0.5) * 0.15;
      const r = 3.0 + R() * 0.5;
      const x = h.x + Math.cos(ang) * r, z = h.z - Math.sin(ang) * r;
      if (Math.hypot(x - cx, z - cz) < 4.6) continue;
      if (huts.some((p) => Math.hypot(p[0] - x, p[1] - z) < p[2] + 1.3)) continue;
      const kc = cellAt(x, z);
      if (kc < 0 || (type[kc] !== 5 && type[kc] !== 6)) continue;
      const rot = Math.atan2(h.x - x, h.z - z), kind = Math.floor(R() * 3);
      const { w, d } = house(b, x, z, rot, y, kind, accent, R, bn);
      huts.push([x, z, 1.15]);
      const [mx, mz] = L2W(x, z, rot, w / 2 + 0.2, d / 2 + 0.45);
      b.box(mx, y, mz, 0.05, 0.42, 0.05, METAL, { ao: y, born: bn(), edges: false });
      b.lbox(mx, mz, rot, 0, y + 0.42, 0, 0.16, 0.14, 0.24, accent, { born: bn() });
      const e = R(), fits = (px, pz, rr) => { const c = cellAt(px, pz); return c >= 0 && type[c] === 5 && !nearWall(px, pz) && Math.hypot(px - cx, pz - cz) > 4.4 && huts.slice(0, -1).every((p) => Math.hypot(p[0] - px, p[1] - pz) > p[2] + rr); };
      if (e < 0.55) {
        const [px, pz] = L2W(x, z, rot, -(w / 2 + 0.55), 0.15);
        if (fits(px, pz, 0.7)) { car(b, px, pz, rot, y, CARS[Math.floor(R() * CARS.length)], bn); huts.push([px, pz, 0.7]); }
      } else if (e < 0.85) {
        const [px, pz] = L2W(x, z, rot, 0, -(d / 2 + 0.85));
        if (fits(px, pz, 0.6)) { trampoline(b, px, pz, y, bn); huts.push([px, pz, 0.6]); }
      }
      const fx = Math.sin(rot), fz = Math.cos(rot);
      spots.push(new THREE.Vector3(x + fx * (d / 2 + 0.6 + (kind === 1 ? 0.2 : 0)), y, z + fz * (d / 2 + 0.6 + (kind === 1 ? 0.2 : 0))));
    }
    if (!spots.length) spots.push(new THREE.Vector3(h.x + Math.cos(h.a) * 1.5, y, h.z - Math.sin(h.a) * 1.5));
    // Low hedge around the cul-de-sac; accent posts where each run opens.
    const rW = 4.6, n = Math.round((Math.PI * 2 * rW) / 0.52), stepA = (Math.PI * 2) / n, gapA = h.a + Math.PI;
    const ring = [];
    for (let q = 0; q < n; q++) {
      const a = gapA + (q + 0.5) * stepA, x = h.x + Math.cos(a) * rW, z = h.z - Math.sin(a) * rW, kc = cellAt(x, z);
      const ok = kc >= 0 && type[kc] === 5 && !nearWall(x, z) && Math.hypot(x - cx, z - cz) > 4.7
        && !v.hubs.some((o) => o !== h && Math.hypot(o.x - x, o.z - z) < rW) && !huts.some((p) => Math.hypot(p[0] - x, p[1] - z) < p[2] + 0.35);
      ring.push({ a, x, z, ok });
    }
    ring.forEach((p, q) => {
      if (!p.ok) return;
      const prev = ring[(q + n - 1) % n].ok, next = ring[(q + 1) % n].ok;
      if (!prev && !next) return;
      if (!prev || !next) { b.box(p.x, y, p.z, 0.16, 0.5, 0.16, 0xf3f1ea, { ao: y, born: bn() }); b.box(p.x, y + 0.5, p.z, 0.22, 0.08, 0.22, accent, { born: bn() }); return; }
      b.box(p.x, y, p.z, 0.56, 0.38 + R() * 0.05, 0.42, PAL.hedge[Math.floor(R() * 3)], { rot: p.a + Math.PI / 2, ao: y, born: bn() });
    });
    districts.set(h.branch, { branch: h.branch, accent, hub: new THREE.Vector3(h.x, y, h.z), angle: h.a, spots, seats, sitFacing: h.a + Math.PI / 2 });
  });

  return { repo: v.repo, districts, center: new THREE.Vector3(cx, y, cz), totem: new THREE.Vector3(tx, y + 3.2, tz), fire: new THREE.Vector3(cx, y + 1.0, cz) };
}

// ── Japan: spring temple mountain ───────────────────────────────────────
const VERM = 0xd2452c, TILE = 0x58606b, TILE2 = 0x4a515b, PLASTER = 0xefe9dc, DWOOD = 0x4a3426, CEDARW = 0x8a5a3c, SHOJI = 0xf4ecd8, POOL = 0x8fd3cf, INK = 0x2a2526;
const SAKURA = [[0xf6c1d0, 0xf2a9c0, 0xfad3df, 0xffe4ec], [0xf4b3c7, 0xee9cb6, 0xf8c8d6, 0xfde0e8], [0xfbd0dc, 0xf6bccd, 0xfde2ea, 0xffeef3]];

function sakura(b, x, y, z, R, born) {
  const pal = SAKURA[Math.floor(R() * SAKURA.length)], th = 1.3 + R() * 0.6, top = y + th;
  b.box(x, y, z, 0.42, th, 0.42, PAL.trunk, { ao: y, born });
  const crowns = [[x, top + 0.1, z, 0.62]], a0 = R() * 6.28;
  for (let k = 0; k < 2; k++) {
    const a = a0 + k * 3.14 + (R() - 0.5) * 0.8, dx = Math.cos(a), dz = Math.sin(a);
    b.box(x + dx * 0.35, top - 0.45, z + dz * 0.35, 0.26, 0.4, 0.26, PAL.branch, { born });
    b.box(x + dx * 0.65, top - 0.15, z + dz * 0.65, 0.24, 0.35, 0.24, PAL.branch, { born });
    crowns.push([x + dx * 0.95, top + 0.05, z + dz * 0.95, 0.45 + R() * 0.12]);
  }
  for (const [cx, cy, cz, s] of crowns) canopy(b, cx, cy, cz, s, pal, R, born, y);
  for (let i = 0; i < 7; i++) { const a = R() * 6.28, d = 0.6 + R() * 1.8; b.box(x + Math.cos(a) * d, y, z + Math.sin(a) * d, 0.18, 0.02, 0.13, SAKURA[0][i % 4], { rot: R() * 3, born, edges: false }); }
}
function cedar(b, x, y, z, R, born) {
  const s = 0.9 + R() * 0.35, o = { sway: 0.16, swayBase: y, born }, G = [0x2c5a3c, 0x346643, 0x284f36];
  b.box(x, y, z, 0.3, 1.1 * s, 0.3, 0x7a4a36, { ao: y, born });
  let ty = y + 0.9 * s, w = 1.35 * s;
  for (let i = 0; i < 6; i++) { b.box(x, ty, z, w, 0.7 * s, w, G[i % 3], { ...o, rot: i * 0.5 + R() * 0.3 }); ty += 0.55 * s; w *= 0.8; }
  b.box(x, ty, z, 0.2 * s, 0.45 * s, 0.2 * s, G[1], o);
}
function bamboo(b, x, y, z, R, born) {
  const n = 4 + Math.floor(R() * 4), C = [0x8dbb4a, 0x7caa3e, 0x9cc657], L = [0xa8d36a, 0x8fc25a, 0x7fb24c];
  for (let i = 0; i < n; i++) {
    const px = x + (R() - 0.5) * 1.6, pz = z + (R() - 0.5) * 1.6, h = 2.6 + R() * 2.0, o = { sway: 0.2, swayBase: y, born };
    b.box(px, y, pz, 0.11, h, 0.11, C[i % 3], { ...o, ao: y });
    for (let s = 1; s < 4; s++) b.box(px, y + (h * s) / 4, pz, 0.14, 0.04, 0.14, 0x6a9434, { ...o, edges: false });
    for (let l = 0; l < 3; l++) b.box(px + (R() - 0.5) * 0.5, y + h - 0.3 - l * 0.35, pz + (R() - 0.5) * 0.5, 0.45 + R() * 0.3, 0.12, 0.25 + R() * 0.2, L[l], { ...o, rot: R() * 3 });
  }
}
function azalea(b, x, y, z, R, born) {
  const o = { sway: 0.25, swayBase: y, born }, F = [0xe0679a, 0xf08cb4, 0xd4507f, 0xf4eef0], w = 0.8 + R() * 0.4;
  b.box(x, y, z, w, 0.4, w * 0.9, 0x4f8a3a, { ...o, ao: y });
  b.box(x, y + 0.4, z, w * 0.85, 0.12, w * 0.75, F[Math.floor(R() * 4)], o);
}

/** Torii centred on (x, z); local x (rot) spans the path. */
function torii(b, x, z, rot, y, half, h, accent, born, big = false) {
  const pw = big ? 0.2 : 0.1, t = big ? 0.16 : 0.1, o = { born };
  for (const s of [-1, 1]) {
    b.lbox(x, z, rot, s * half, y, 0, pw * 1.4, big ? 0.22 : 0.12, pw * 1.4, INK, { born, ao: y });
    b.lbox(x, z, rot, s * half, y, 0, pw, h, pw, VERM, { born, ao: y });
  }
  b.lbox(x, z, rot, 0, y + h * 0.78, 0, half * 2 + pw * 2.2, t * 0.7, pw * 0.8, VERM, o);
  b.lbox(x, z, rot, 0, y + h, 0, half * 2 + pw * 5, t, pw * 1.6, VERM, o);
  b.lbox(x, z, rot, 0, y + h + t, 0, half * 2 + pw * 6.5, t * 0.8, pw * 1.9, INK, o);
  if (accent != null) b.lbox(x, z, rot, 0, y + h * 0.78 + t * 0.7, 0, half * 0.4, h * 0.22 - t * 0.7, 0.04 + pw * 0.6, accent, o);
}
function toro(b, x, z, y, bn) {
  const S = 0xa9a49a;
  b.box(x, y, z, 0.34, 0.1, 0.34, S, { ao: y, born: bn() });
  b.box(x, y + 0.1, z, 0.13, 0.42, 0.13, S, { born: bn() });
  b.box(x, y + 0.52, z, 0.32, 0.06, 0.32, S, { born: bn() });
  b.box(x, y + 0.58, z, 0.22, 0.2, 0.22, 0xe8dcc0, { born: bn(), emit: 1.6, edges: false });
  b.pyramid(x, y + 0.78, z, 0.44, 0.44, 0.2, S, 0, bn());
  b.box(x, y + 0.96, z, 0.07, 0.08, 0.07, S, { born: bn() });
}
function chochin(b, x, z, rot, lx, ly, lz, bn) {
  b.lbox(x, z, rot, lx, ly, lz, 0.18, 0.24, 0.18, 0xd8442e, { born: bn(), emit: 1.3, edges: false });
  for (const dy of [-0.03, 0.24]) b.lbox(x, z, rot, lx, ly + dy, lz, 0.12, 0.03, 0.12, INK, { born: bn(), edges: false });
}

/** Temple hall on a stone plinth with steps; irimoya roof (hip + gable). Front faces local +z. */
function hall(b, x, z, rot, y, accent, R, bn) {
  const w = 1.8, d = 1.35, ph = 0.28, wh = 0.85, fy = y + ph, fz = d / 2, edge = d / 2 + 0.25;
  b.lbox(x, z, rot, 0, y, 0, w + 0.5, ph, d + 0.5, 0xb3aea3, { ao: y, born: bn() });
  b.lbox(x, z, rot, 0, y, edge + 0.1, 0.72, ph * 0.66, 0.2, 0xa9a49a, { ao: y, born: bn() });
  b.lbox(x, z, rot, 0, y, edge + 0.3, 0.72, ph * 0.33, 0.2, 0xa9a49a, { ao: y, born: bn() });
  b.lbox(x, z, rot, 0, fy, 0, w - 0.12, wh, d - 0.12, PLASTER, { born: bn() });
  for (const sx of [-1, -0.33, 0.33, 1]) for (const sz of [-1, 1]) b.lbox(x, z, rot, sx * (w / 2 - 0.05), fy, sz * (d / 2 - 0.05), 0.1, wh, 0.1, VERM, { born: bn() });
  b.lbox(x, z, rot, 0, fy + wh - 0.1, 0, w, 0.1, d, VERM, { born: bn() });
  for (const lx of [-0.55, 0, 0.55]) b.lbox(x, z, rot, lx, fy + 0.04, fz - 0.04, 0.46, wh - 0.2, 0.03, SHOJI, { born: bn(), emit: 1, edges: false });
  b.lbox(x, z, rot, 0, fy + wh - 0.36, fz + 0.03, 0.56, 0.24, 0.02, accent, { born: bn(), edges: false });
  const ry = fy + wh;
  b.lbox(x, z, rot, 0, ry, 0, w + 0.9, 0.07, d + 0.9, TILE2, { born: bn() });
  b.pyramid(x, ry + 0.07, z, w + 0.85, d + 0.85, 0.75, TILE, rot, bn(), DWOOD);
  b.gable(x, ry + 0.42, z, w * 0.62, (d + 0.85) * 0.55, 0.5, TILE, DWOOD, rot, bn());
  b.lbox(x, z, rot, 0, ry + 0.86, 0, w * 0.62 + 0.12, 0.1, 0.1, TILE2, { born: bn() });
  for (const sx of [-1, 1]) {
    b.lbox(x, z, rot, sx * (w * 0.31 + 0.06), ry + 0.86, 0, 0.1, 0.2, 0.12, TILE2, { born: bn() });
    chochin(b, x, z, rot, sx * (w / 2 + 0.1), ry - 0.4, fz + 0.28, bn);
  }
  return { front: edge + 0.4 };
}
function pagoda(b, x, z, rot, y, accent, R, bn) {
  b.lbox(x, z, rot, 0, y, 0, 1.6, 0.24, 1.6, 0xb3aea3, { ao: y, born: bn() });
  let ty = y + 0.24;
  for (let i = 0; i < 3; i++) {
    const s = 0.98 - i * 0.16, bh = 0.5 - i * 0.04, e = s + 0.78 - i * 0.06;
    b.lbox(x, z, rot, 0, ty, 0, s, bh, s, VERM, { born: bn(), ao: i ? undefined : ty });
    b.lbox(x, z, rot, 0, ty + 0.06, s / 2 + 0.005, s * 0.4, bh - 0.16, 0.02, i ? DWOOD : SHOJI, { born: bn(), emit: i ? 0 : 1, edges: false });
    ty += bh;
    b.lbox(x, z, rot, 0, ty, 0, e, 0.07, e, TILE2, { born: bn() });
    b.pyramid(x, ty + 0.07, z, e - 0.04, e - 0.04, 0.32, TILE, rot, bn(), DWOOD);
    ty += 0.21;
  }
  b.lbox(x, z, rot, 0, ty, 0, 0.2, 0.1, 0.2, accent, { born: bn() });
  b.lbox(x, z, rot, 0, ty, 0, 0.06, 1.0, 0.06, 0x8a7a4a, { born: bn() });
  for (let r = 0; r < 4; r++) b.lbox(x, z, rot, 0, ty + 0.25 + r * 0.15, 0, 0.16, 0.04, 0.16, 0x8a7a4a, { born: bn(), edges: false });
  return { front: 0.8 };
}
/** Monks' lodging: plaster and dark timber, engawa veranda, thatch or tile gable. */
function lodge(b, x, z, rot, y, accent, R, bn) {
  const w = 1.7, d = 1.25, wh = 0.8, fy = y + 0.14, fz = d / 2, thatch = R() < 0.5, rh = thatch ? 0.95 : 0.7;
  b.lbox(x, z, rot, 0, y, 0, w + 0.1, 0.14, d + 0.1, 0x8f8a7c, { ao: y, born: bn() });
  b.lbox(x, z, rot, 0, fy, 0, w, wh, d, PLASTER, { born: bn() });
  for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) b.lbox(x, z, rot, sx * (w / 2 - 0.03), fy, sz * (d / 2 - 0.03), 0.08, wh, 0.08, DWOOD, { born: bn(), edges: false });
  b.lbox(x, z, rot, 0, fy + wh * 0.55, 0, w + 0.02, 0.05, d + 0.02, DWOOD, { born: bn(), edges: false });
  for (const lx of [-0.42, 0.42]) b.lbox(x, z, rot, lx, fy + 0.05, fz + 0.005, 0.58, wh * 0.5 - 0.05, 0.02, SHOJI, { born: bn(), emit: 1, edges: false });
  b.lbox(x, z, rot, 0, fy + wh * 0.55 - 0.22, fz + 0.03, 0.5, 0.2, 0.02, accent, { born: bn(), edges: false });
  b.lbox(x, z, rot, 0, y + 0.02, fz + 0.28, w, 0.18, 0.42, CEDARW, { ao: y, born: bn() });
  b.gable(x, fy + wh, z, w + 0.4, d + 0.55, rh, thatch ? 0x8c7552 : TILE, DWOOD, rot, bn());
  b.lbox(x, z, rot, 0, fy + wh + rh - 0.06, 0, w + 0.44, 0.12, 0.16, thatch ? 0x5a4a36 : TILE2, { born: bn() });
  chochin(b, x, z, rot, w / 2 - 0.15, fy + wh - 0.3, fz + 0.2, bn);
  return { front: fz + 0.5 };
}
/** Teahouse bench with red felt under a wagasa parasol. */
function nodate(b, ox, oz, rot, y, bn) {
  b.lbox(ox, oz, rot, 0, y + 0.18, 0, 1.2, 0.06, 0.4, CEDARW, { born: bn() });
  b.lbox(ox, oz, rot, 0, y + 0.24, 0, 1.22, 0.02, 0.42, 0xc23a2e, { born: bn(), edges: false });
  for (const lx of [-0.5, 0.5]) for (const lz of [-0.14, 0.14]) b.lbox(ox, oz, rot, lx, y, lz, 0.06, 0.18, 0.06, DWOOD, { ao: y, born: bn(), edges: false });
  const c = Math.cos(rot), s = Math.sin(rot), lx = 0.55, lz = -0.24, px = ox + lx * c + lz * s, pz = oz - lx * s + lz * c;
  b.box(px, y, pz, 0.04, 1.62, 0.04, DWOOD, { ao: y, born: bn() });
  b.pyramid(px, y + 1.42, pz, 1.4, 1.4, 0.32, 0xc8402e, rot + Math.PI / 4, bn(), 0xe8d6b0);
}
function bridge(b, x0, z0, x1, z1, y0, y1, born) {
  const L = Math.hypot(x1 - x0, z1 - z0), rot = Math.atan2(x1 - x0, z1 - z0), n = Math.max(4, Math.round(L / 0.34)), arch = 0.25 + L * 0.09, o = { born };
  const yAt = (t) => y0 + (y1 - y0) * t + arch * Math.sin(Math.PI * t);
  for (let s = 0; s < n; s++) {
    const t = (s + 0.5) / n, lz = t * L, yy = yAt(t), seg = L / n + 0.02;
    b.lbox(x0, z0, rot, 0, yy - 0.08, lz, 0.95, 0.14, seg, CEDARW, o);
    const end = s === 0 || s === n - 1;
    if (end || s % 3 === 0) for (const lx of [-0.46, 0.46]) {
      b.lbox(x0, z0, rot, lx, yy, lz, 0.08, 0.45, 0.08, VERM, o);
      if (end) b.lbox(x0, z0, rot, lx, yy + 0.45, lz, 0.1, 0.1, 0.1, INK, o);
    }
    for (const lx of [-0.46, 0.46]) b.lbox(x0, z0, rot, lx, yy + 0.36, lz, 0.06, 0.06, seg, VERM, { born, edges: false });
  }
  for (const t of [0.3, 0.7]) for (const lx of [-0.4, 0.4]) { const yy = yAt(t); b.lbox(x0, z0, rot, lx, WATER_Y - 0.4, t * L, 0.12, yy - 0.08 - WATER_Y + 0.4, 0.12, VERM, o); }
}
function boat(b, x, z, rot, born) {
  const o = { born }, y = WATER_Y - 0.12, HULL = 0x9a7650;
  b.lbox(x, z, rot, 0, y, 0, 0.72, 0.3, 1.9, HULL, o);
  b.lbox(x, z, rot, 0, y + 0.06, 1.05, 0.46, 0.32, 0.3, HULL, o);
  b.lbox(x, z, rot, 0, y + 0.16, 1.25, 0.24, 0.3, 0.2, HULL, o);
  b.lbox(x, z, rot, 0, y + 0.29, 0.2, 0.56, 0.02, 1.2, 0xb8946a, { born, edges: false });
  b.lbox(x, z, rot, 0, y + 0.3, -0.45, 0.52, 0.36, 0.6, PLASTER, o);
  b.lbox(x, z, rot, 0, y + 0.66, -0.45, 0.64, 0.06, 0.74, TILE, o);
  b.lbox(x, z, rot, 0, y + 0.3, 0.4, 0.05, 1.3, 0.05, DWOOD, o);
  b.lbox(x, z, rot, 0, y + 1.0, 0.48, 0.13, 0.17, 0.13, 0xf3e3b8, { born, emit: 1.5, edges: false });
  b.lbox(x, z, rot, 0.17, y + 1.38, 0.4, 0.3, 0.1, 0.02, VERM, { born, edges: false });
  b.lbox(x, z, rot, 0.17, y + 1.28, 0.4, 0.3, 0.1, 0.02, PLASTER, { born, edges: false });
}
/** Stepped snow-capped peak off the island's right-hand corner. */
function mountain(b, x, z, born) {
  const L = 18, H = 17, R0 = 11, rs = rng(0.4321), w0 = R0 * 1.7 + 1.5;
  for (const r of [0, Math.PI / 4]) {
    b.box(x, BOTTOM_Y, z, w0, GRASS_Y - 0.3 - BOTTOM_Y, w0, PAL.earthDeep, { rot: r, born });
    b.box(x, GRASS_Y - 0.3, z, w0, 0.3, w0, PAL.grass, { rot: r, born });
  }
  for (let i = 0; i < L; i++) {
    const t = i / L, r = R0 * Math.pow(1 - t, 1.15) + 0.6, yy = GRASS_Y + t * H, hh = H / L + 0.02;
    const col = t < 0.32 ? (i % 2 ? 0x3f6a3e : 0x4a7848) : t < 0.66 ? (i % 2 ? 0x7d8494 : 0x8a90a0) : (i % 2 ? 0xf2f4f6 : 0xe4e9ee);
    for (const rr of [0, Math.PI / 4]) b.box(x, yy, z, r * 1.7, hh, r * 1.7, col, { rot: rr + i * 0.11, born });
    if (t > 0.5 && t < 0.66) for (let q = 0; q < 6; q++) { const a = rs() * 6.28; b.box(x + Math.cos(a) * r * 0.78, yy, z + Math.sin(a) * r * 0.78, 1.2 + rs(), hh + 0.05, 0.9 + rs(), 0xeef1f4, { rot: a, born }); }
  }
}

function buildTemple(b, fb, v, born0, cellAt, type, nearWall) {
  const R = rng(strHash(v.repo, 31) * 0.98 + 0.01), y = VILLAGE_Y;
  let stagger = 0;
  const bn = () => (born0 ? Math.min(2.72, born0 + (stagger += 0.0025)) : 0);
  const { cx, cz } = v;

  // Onsen: milky pool ringed with rocks, a bamboo spout; steam comes from the engine.
  for (const r of [0, Math.PI / 4]) b.box(cx, y - 0.04, cz, 2.3, 0.12, 2.3, POOL, { rot: r, born: bn(), edges: false });
  for (let i = 0; i < 15; i++) {
    const a = (i / 15) * Math.PI * 2 + R() * 0.2, rr = 1.2 + R() * 0.18, s = 0.34 + R() * 0.22;
    b.box(cx + Math.cos(a) * rr, y - 0.02, cz - Math.sin(a) * rr, s, 0.18 + R() * 0.22, s * 0.9, R() < 0.3 ? 0x8a9670 : STONE[Math.floor(R() * 4)], { rot: R() * 3, ao: y, born: bn() });
  }
  const between = v.hubs.length > 1 ? v.hubs[0].a + Math.PI / v.hubs.length : v.hubs[0].a + Math.PI;
  const sa = between + Math.PI, sx = cx + Math.cos(sa) * 1.45, sz = cz - Math.sin(sa) * 1.45;
  b.box(sx, y, sz, 0.1, 0.8, 0.1, 0x8dbb4a, { ao: y, born: bn() });
  b.lbox(sx, sz, Math.atan2(cx - sx, cz - sz), 0, y + 0.7, 0.28, 0.07, 0.07, 0.6, 0x8dbb4a, { born: bn() });
  for (let i = 0; i < 3; i++) { const a = between + Math.PI * 0.66 * i + 0.4; toro(b, cx + Math.cos(a) * 2.5, cz - Math.sin(a) * 2.5, y, bn); }
  const tx = cx + Math.cos(between) * 2.9, tz = cz - Math.sin(between) * 2.9;
  sakura(fb, tx, y, tz, R, bn());

  const districts = new Map();
  const huts = [];
  v.hubs.forEach((h, i) => {
    const accent = ACCENTS[i % ACCENTS.length];
    // Torii tunnel along the path from the onsen to the district.
    const hd = Math.hypot(h.x - cx, h.z - cz);
    for (let dd = 3.5; dd < hd - 2.1; dd += 0.78) torii(b, cx + Math.cos(h.a) * dd, cz - Math.sin(h.a) * dd, h.a - Math.PI / 2, y, 0.62, 1.3, null, bn());
    // Nobori banner at the hub
    b.box(h.x, y, h.z, 0.06, 2.2, 0.06, DWOOD, { ao: y, born: bn() });
    b.lbox(h.x, h.z, h.a, 0.17, y + 2.1, 0, 0.36, 0.04, 0.04, DWOOD, { born: bn() });
    fb.lbox(h.x, h.z, h.a, 0.19, y + 0.92, 0, 0.3, 1.16, 0.025, accent, { born: bn(), sway: 0.1, swayBase: y + 0.92, edges: false });
    const perp = h.a + Math.PI / 2;
    const logX = h.x + Math.cos(h.a) * 0.4 + Math.cos(perp) * 1.25, logZ = h.z - Math.sin(h.a) * 0.4 - Math.sin(perp) * 1.25;
    nodate(b, logX, logZ, h.a, y, bn);
    huts.push([logX, logZ, 0.6]);
    const seats = [-0.35, 0.35].map((o) => new THREE.Vector3(logX + Math.cos(h.a) * o, y, logZ - Math.sin(h.a) * o));
    const lx2 = h.x + Math.cos(h.a) * 0.4 - Math.cos(perp) * 1.3, lz2 = h.z - Math.sin(h.a) * 0.4 + Math.sin(perp) * 1.3;
    toro(b, lx2, lz2, y, bn); huts.push([lx2, lz2, 0.3]);
    const spots = [];

    const count = 3 + Math.floor(strHash(h.branch, 3) * 3), pIdx = strHash(h.branch, 4) < 0.7 ? Math.floor(count / 2) : -1;
    for (let k = 0; k < count; k++) {
      const ang = h.a + (k - (count - 1) / 2) * 0.8 + (R() - 0.5) * 0.12, r = 3.25 + R() * 0.3;
      const x = h.x + Math.cos(ang) * r, z = h.z - Math.sin(ang) * r;
      if (Math.hypot(x - cx, z - cz) < 4.8) continue;
      if (huts.some((p) => Math.hypot(p[0] - x, p[1] - z) < p[2] + 1.1)) continue;
      const kc = cellAt(x, z);
      if (kc < 0 || (type[kc] !== 5 && type[kc] !== 6)) continue;
      const rot = Math.atan2(h.x - x, h.z - z);
      const f = (k === pIdx ? pagoda : R() < 0.5 ? hall : lodge)(b, x, z, rot, y, accent, R, bn);
      huts.push([x, z, 1.25]);
      spots.push(new THREE.Vector3(x + Math.sin(rot) * (f.front + 0.45), y, z + Math.cos(rot) * (f.front + 0.45)));
    }
    if (!spots.length) spots.push(new THREE.Vector3(h.x + Math.cos(h.a) * 1.5, y, h.z - Math.sin(h.a) * 1.5));
    // Low bamboo fence around the precinct; accent-capped posts where each run opens.
    const rW = 4.5, n = Math.round((Math.PI * 2 * rW) / 0.52), stepA = (Math.PI * 2) / n, gapA = h.a + Math.PI;
    const ring = [];
    for (let q = 0; q < n; q++) {
      const a = gapA + (q + 0.5) * stepA, x = h.x + Math.cos(a) * rW, z = h.z - Math.sin(a) * rW, kc = cellAt(x, z);
      const ok = kc >= 0 && type[kc] === 5 && !nearWall(x, z) && Math.hypot(x - cx, z - cz) > 4.7
        && !v.hubs.some((o) => o !== h && Math.hypot(o.x - x, o.z - z) < rW) && !huts.some((p) => Math.hypot(p[0] - x, p[1] - z) < p[2] + 0.35);
      ring.push({ a, x, z, ok });
    }
    ring.forEach((p, q) => {
      if (!p.ok) return;
      const prev = ring[(q + n - 1) % n].ok, next = ring[(q + 1) % n].ok;
      if (!prev && !next) return;
      if (!prev || !next) { b.box(p.x, y, p.z, 0.14, 0.55, 0.14, DWOOD, { ao: y, born: bn() }); b.box(p.x, y + 0.55, p.z, 0.2, 0.07, 0.2, accent, { born: bn() }); return; }
      b.box(p.x, y, p.z, 0.06, 0.5, 0.06, 0xb8a868, { ao: y, born: bn(), edges: false });
      for (const hy of [0.18, 0.38]) b.box(p.x, y + hy, p.z, 0.54, 0.04, 0.04, 0xa8984f, { rot: p.a + Math.PI / 2, born: bn(), edges: false });
    });
    districts.set(h.branch, { branch: h.branch, accent, hub: new THREE.Vector3(h.x, y, h.z), angle: h.a, spots, seats, sitFacing: h.a + Math.PI / 2 });
  });

  return { repo: v.repo, districts, center: new THREE.Vector3(cx, y, cz), totem: new THREE.Vector3(tx, y + 4.2, tz), fire: new THREE.Vector3(cx, y + 0.1, cz) };
}

