import { THREE, plainMat, holoMat, flagMat } from './materials.js';
import { FIRE_RING, strHash } from './terrain.js';

export const NEEDS_INPUT = 0xffc21a, ERRORED = 0xff4a32;

const boxG = new THREE.BoxGeometry(1, 1, 1);
const M = new Map();
const mat = (hex, o) => { const k = hex + JSON.stringify(o || {}); if (!M.has(k)) M.set(k, plainMat(hex, o)); return M.get(k); };
const FX = {
  spark: holoMat(0xfff1b0, 4), dust: plainMat(0xe9cf9e, { transparent: true, opacity: 0.7, depthWrite: false }),
  flag: flagMat(NEEDS_INPUT), dirt: plainMat(0xc4935c, { roughness: 1 }), dirt2: plainMat(0xb3824e, { roughness: 1 }),
  paint: plainMat(0xd8432e, { emissive: new THREE.Color(0xd8432e), emissiveIntensity: 0.15 }),
  hit: new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false }),
  screen: plainMat(0xcfe9ff, { emissive: new THREE.Color(0x8fd0ff), emissiveIntensity: 1.4 }),
};
const FLAG_GEO = new THREE.PlaneGeometry(0.85, 0.5, 8, 2).translate(0.425, 0, 0);
const PATCH = [[0, 0, 1.5, 1.2, 0], [0.5, 0.4, 0.8, 0.7, 1], [-0.6, -0.3, 0.7, 0.8, 1], [0.2, -0.65, 0.9, 0.5, 0], [-0.35, 0.6, 0.6, 0.5, 1], [0.75, -0.2, 0.4, 0.4, 1]];

/** A box part: size, centre, colour. Returned mesh casts shadows. */
function part(parent, w, h, d, x, y, z, hex, opts) {
  const m = new THREE.Mesh(boxG, typeof hex === 'number' ? mat(hex, opts) : hex);
  m.scale.set(w, h, d); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
}
/** A pivot group with a box hanging below (legs, arms) or extending above. */
function limb(parent, x, y, z, w, h, d, hex, up = false) {
  const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g);
  part(g, w, h, d, 0, up ? h / 2 : -h / 2, 0, hex); return g;
}

const SKIN = [0xc98b5e, 0xb07448, 0xe0a77a, 0x8f5a38], FUR = [0x8a5a35, 0xa06b3e, 0x6e4a2e, 0xb5844e], HAIR = [0x3b2416, 0x5a3a22, 0x2a1a10, 0x7a4a26];

function buildCaveman(g, accent, seed) {
  const pick = (a, s) => a[Math.floor(strHash(seed, s) * a.length)];
  const skin = pick(SKIN, 1), fur = pick(FUR, 2), hair = pick(HAIR, 3);
  const legs = [-0.1, 0.1].map((x) => limb(g, x, 0.32, 0, 0.13, 0.32, 0.13, skin));
  const body = new THREE.Group(); body.position.y = 0.32; g.add(body);
  part(body, 0.44, 0.4, 0.32, 0, 0.2, 0, fur);
  part(body, 0.46, 0.08, 0.34, 0, 0.08, 0, accent);
  part(body, 0.2, 0.12, 0.33, -0.12, 0.38, 0, fur);
  const head = new THREE.Group(); head.position.y = 0.4; body.add(head);
  part(head, 0.38, 0.36, 0.34, 0, 0.2, 0, skin);
  part(head, 0.42, 0.14, 0.38, 0, 0.42, -0.01, hair);
  part(head, 0.42, 0.3, 0.1, 0, 0.26, -0.17, hair);
  if (strHash(seed, 4) > 0.45) part(head, 0.3, 0.14, 0.06, 0, 0.06, 0.18, hair);
  part(head, 0.07, 0.07, 0.02, -0.09, 0.24, 0.175, 0x1d1410);
  part(head, 0.07, 0.07, 0.02, 0.09, 0.24, 0.175, 0x1d1410);
  part(head, 0.32, 0.05, 0.05, 0, 0.32, 0.17, hair);
  const arms = [-0.28, 0.28].map((x) => limb(body, x, 0.36, 0, 0.11, 0.32, 0.11, skin));
  const tool = new THREE.Group(); tool.position.set(0, -0.3, 0.05); arms[1].add(tool);
  part(tool, 0.07, 0.36, 0.07, 0, -0.05, 0.08, 0x7a4a2a);
  part(tool, 0.16, 0.14, 0.16, 0, -0.24, 0.08, 0x9aa3ae);
  return { kind: 'caveman', legs, body, head, arms, tool, height: 1.2, sitY: 0.24 };
}

const P_SKIN = [0xf1c9a8, 0xe0ac86, 0xb47a52, 0x7a4b2e], HOODIE = [0x3a4a5e, 0x8a9097, 0x2f6b58, 0xcbb89a, 0x7c3040, 0x2a2b2f, 0xd8d4cc];
const PANTS = [0x34507a, 0x2a2b2f, 0x4a5a6e, 0xb8aa8c], P_HAIR = [0x2a1a10, 0x5a3a22, 0xd8b46a, 0x8a5a2e, 0xe6d3a0];

function buildPerson(g, accent, seed) {
  const pick = (a, s) => a[Math.floor(strHash(seed, s) * a.length)];
  const skin = pick(P_SKIN, 11), top = pick(HOODIE, 12), pants = pick(PANTS, 13), hair = pick(P_HAIR, 14);
  const legs = [-0.09, 0.09].map((x) => { const l = limb(g, x, 0.32, 0, 0.12, 0.3, 0.12, pants); part(l, 0.13, 0.06, 0.18, 0, -0.29, 0.02, 0xf2f1ec); return l; });
  const body = new THREE.Group(); body.position.y = 0.32; g.add(body);
  part(body, 0.42, 0.4, 0.28, 0, 0.2, 0, top);
  part(body, 0.43, 0.06, 0.29, 0, 0.03, 0, accent);
  part(body, 0.3, 0.14, 0.08, 0, 0.36, -0.16, top);
  for (const x of [-0.07, 0.07]) part(body, 0.03, 0.14, 0.02, x, 0.28, 0.145, 0xf2f1ec);
  const head = new THREE.Group(); head.position.y = 0.4; body.add(head);
  part(head, 0.34, 0.34, 0.3, 0, 0.19, 0, skin);
  if (strHash(seed, 15) < 0.35) part(head, 0.37, 0.16, 0.33, 0, 0.38, 0, accent);
  else part(head, 0.36, 0.1, 0.32, 0, 0.38, -0.01, hair);
  const hl = strHash(seed, 16) > 0.6 ? 0.42 : 0.22;
  part(head, 0.36, hl, 0.08, 0, 0.4 - hl / 2, -0.14, hair);
  for (const x of [-0.08, 0.08]) part(head, 0.06, 0.06, 0.02, x, 0.21, 0.155, 0x1d1410);
  if (strHash(seed, 17) > 0.7) part(head, 0.3, 0.03, 0.02, 0, 0.245, 0.165, 0x1d1d1f);
  const arms = [-0.27, 0.27].map((x) => { const a = limb(body, x, 0.36, 0, 0.1, 0.3, 0.1, top); part(a, 0.09, 0.08, 0.09, 0, -0.33, 0, skin); return a; });
  const tool = new THREE.Group(); tool.position.set(0, 0.2, 0.3); body.add(tool);
  part(tool, 0.38, 0.03, 0.26, 0, 0, 0, 0xa7adb3);
  const lid = new THREE.Group(); lid.position.set(0, 0.015, 0.13); lid.rotation.x = 0.25; tool.add(lid);
  part(lid, 0.38, 0.26, 0.02, 0, 0.13, 0, 0xa7adb3);
  part(lid, 0.32, 0.2, 0.005, 0, 0.13, -0.013, FX.screen).castShadow = false;
  return { kind: 'caveman', person: true, legs, body, head, arms, tool, height: 1.15, sitY: 0.24 };
}

const YUKATA = [0x2c3e6b, 0x3d5f8f, 0xe9e3d6, 0x6b2f3a, 0x46705c, 0xc2603e, 0x2a2b2f, 0x7a5a8c], J_HAIR = [0x1a1412, 0x241a16, 0x2e221c, 0x3a2a20];

/** Villager in a yukata (long robe) or happi coat; obi in the district accent; reads a scroll while working. */
function buildVillager(g, accent, seed) {
  const pick = (a, s) => a[Math.floor(strHash(seed, s) * a.length)];
  const skin = pick(P_SKIN.slice(0, 3), 21), robe = pick(YUKATA, 22), hair = pick(J_HAIR, 23), happi = strHash(seed, 24) > 0.62;
  const legs = [-0.09, 0.09].map((x) => { const l = limb(g, x, 0.32, 0, 0.11, 0.3, 0.11, happi ? 0x2a2b2f : skin); part(l, 0.12, 0.05, 0.2, 0, -0.295, 0.02, 0x6e4a30); return l; });
  const body = new THREE.Group(); body.position.y = 0.32; g.add(body);
  part(body, 0.42, 0.42, 0.28, 0, 0.21, 0, robe);
  if (!happi) part(body, 0.4, 0.22, 0.27, 0, -0.09, 0, robe);
  part(body, 0.44, 0.09, 0.3, 0, 0.12, 0, accent);
  for (const s of [-1, 1]) part(body, 0.04, 0.22, 0.02, s * 0.05, 0.31, 0.145, 0xf2efe6).rotation.z = s * 0.45;
  const head = new THREE.Group(); head.position.y = 0.42; body.add(head);
  part(head, 0.34, 0.34, 0.3, 0, 0.19, 0, skin);
  part(head, 0.36, 0.1, 0.32, 0, 0.38, -0.01, hair);
  part(head, 0.36, 0.26, 0.08, 0, 0.27, -0.14, hair);
  const hat = strHash(seed, 25);
  if (hat < 0.28) { part(head, 0.7, 0.04, 0.7, 0, 0.42, 0, 0xd9b86a); part(head, 0.42, 0.06, 0.42, 0, 0.46, 0, 0xcfa95a); part(head, 0.18, 0.06, 0.18, 0, 0.51, 0, 0xc49e50); }
  else if (hat < 0.55) part(head, 0.37, 0.06, 0.33, 0, 0.31, 0, 0xf2efe6);
  else part(head, 0.14, 0.12, 0.14, 0, 0.47, -0.06, hair);
  for (const x of [-0.08, 0.08]) part(head, 0.06, 0.05, 0.02, x, 0.21, 0.155, 0x1d1410);
  const arms = [-0.27, 0.27].map((x) => { const a = limb(body, x, 0.38, 0, 0.13, 0.3, 0.13, robe); part(a, 0.08, 0.07, 0.08, 0, -0.33, 0, skin); return a; });
  const tool = new THREE.Group(); tool.position.set(0, 0.22, 0.3); tool.rotation.x = -0.6; body.add(tool);
  part(tool, 0.34, 0.02, 0.22, 0, 0, 0, 0xf4ecd8);
  for (const x of [-0.18, 0.18]) part(tool, 0.05, 0.05, 0.26, x, 0, 0, 0x4a3426);
  return { kind: 'caveman', person: true, legs, body, head, arms, tool, height: 1.2, sitY: 0.24 };
}

function buildElephant(g, accent) {
  const grey = 0x8e9196, dark = 0x777a80;
  const legs = [[-0.2, 0.28], [0.2, 0.28], [-0.2, -0.28], [0.2, -0.28]].map(([x, z]) => limb(g, x, 0.46, z, 0.2, 0.46, 0.2, dark));
  const body = new THREE.Group(); body.position.y = 0.46; g.add(body);
  part(body, 0.62, 0.55, 0.9, 0, 0.26, -0.02, grey);
  part(body, 0.64, 0.08, 0.3, 0, 0.36, 0.28, accent);
  const head = new THREE.Group(); head.position.set(0, 0.36, 0.45); body.add(head);
  part(head, 0.46, 0.44, 0.34, 0, 0.02, 0.12, grey);
  part(head, 0.06, 0.4, 0.34, -0.27, 0.04, 0.02, dark);
  part(head, 0.06, 0.4, 0.34, 0.27, 0.04, 0.02, dark);
  part(head, 0.06, 0.06, 0.02, -0.12, 0.08, 0.3, 0x1d1d1f); part(head, 0.06, 0.06, 0.02, 0.12, 0.08, 0.3, 0x1d1d1f);
  const trunk = limb(head, 0, -0.12, 0.25, 0.14, 0.42, 0.14, grey);
  part(head, 0.05, 0.05, 0.16, -0.12, -0.16, 0.3, 0xf2ead8); part(head, 0.05, 0.05, 0.16, 0.12, -0.16, 0.3, 0xf2ead8);
  part(body, 0.04, 0.24, 0.04, 0, 0.3, -0.5, dark);
  return { kind: 'animal', legs, body, head, neck: trunk, height: 1.3, lieY: -0.28 };
}

function buildGiraffe(g, accent) {
  const gold = 0xf2b544, spot = 0x9a5a2a;
  const legs = [[-0.13, 0.22], [0.13, 0.22], [-0.13, -0.22], [0.13, -0.22]].map(([x, z]) => limb(g, x, 0.72, z, 0.1, 0.72, 0.1, gold));
  const body = new THREE.Group(); body.position.y = 0.72; g.add(body);
  part(body, 0.38, 0.36, 0.7, 0, 0.16, 0, gold);
  for (const [x, y, z] of [[0.195, 0.2, 0.15], [-0.195, 0.12, -0.12], [0.195, 0.08, -0.2], [-0.195, 0.24, 0.18], [0, 0.345, -0.05]]) part(body, x ? 0.02 : 0.14, x ? 0.12 : 0.02, 0.14, x, y, z, spot);
  const neck = new THREE.Group(); neck.position.set(0, 0.28, 0.28); neck.rotation.x = 0.35; body.add(neck);
  part(neck, 0.15, 0.8, 0.15, 0, 0.4, 0, gold);
  part(neck, 0.17, 0.07, 0.17, 0, 0.18, 0, accent);
  const head = new THREE.Group(); head.position.y = 0.8; neck.add(head);
  part(head, 0.18, 0.18, 0.34, 0, 0.04, 0.08, gold);
  part(head, 0.04, 0.12, 0.04, -0.05, 0.18, -0.02, spot); part(head, 0.04, 0.12, 0.04, 0.05, 0.18, -0.02, spot);
  part(head, 0.05, 0.05, 0.02, -0.092, 0.08, 0.12, 0x1d1d1f); part(head, 0.05, 0.05, 0.02, 0.092, 0.08, 0.12, 0x1d1d1f);
  return { kind: 'animal', legs, body, head, neck, height: 2.0, lieY: -0.5 };
}

function buildLion(g, accent) {
  const tan = 0xe0a448, mane = 0x9a5526;
  const legs = [[-0.13, 0.24], [0.13, 0.24], [-0.13, -0.24], [0.13, -0.24]].map(([x, z]) => limb(g, x, 0.32, z, 0.13, 0.32, 0.13, tan));
  const body = new THREE.Group(); body.position.y = 0.32; g.add(body);
  part(body, 0.36, 0.34, 0.72, 0, 0.17, 0, tan);
  const head = new THREE.Group(); head.position.set(0, 0.28, 0.38); body.add(head);
  part(head, 0.46, 0.46, 0.22, 0, 0.04, -0.02, mane);
  part(head, 0.3, 0.28, 0.26, 0, 0.0, 0.12, tan);
  part(head, 0.32, 0.06, 0.24, 0, -0.17, 0.0, accent);
  part(head, 0.05, 0.05, 0.02, -0.07, 0.05, 0.255, 0x1d1d1f); part(head, 0.05, 0.05, 0.02, 0.07, 0.05, 0.255, 0x1d1d1f);
  part(head, 0.1, 0.06, 0.04, 0, -0.05, 0.26, 0x5a3a2a);
  const tail = limb(body, 0, 0.26, -0.36, 0.05, 0.36, 0.05, tan); tail.rotation.x = 2.4;
  return { kind: 'animal', legs, body, head, neck: tail, height: 0.9, lieY: -0.2 };
}

const ICON = {
  working: null,
  needs_input: { text: '▲', bg: '#ffc21a', fg: '#1b1c20', anim: 'civbob 1s ease-in-out infinite' },
  idle: { text: 'zZ', bg: 'var(--i-pill, rgba(27,28,32,0.88))', fg: 'var(--i-soft, #7d828c)' },
  errored: { text: '■', bg: 'var(--i-red, #ff6a4d)', fg: 'var(--i-on-red, #1b1c20)' },
};

export class CreatureView {
  constructor(data, district, city, style) {
    this.data = data; this.style = style;
    this.group = new THREE.Group();
    this.seed = strHash(data.sessionId, 9) * 100;
    const s = data.sessionId;
    this.rig = style === 'animals'
      ? [buildElephant, buildGiraffe, buildLion][Math.floor(strHash(s, 5) * 3)](this.group, district.accent)
      : style === 'people' ? buildPerson(this.group, district.accent, s)
      : style === 'villagers' ? buildVillager(this.group, district.accent, s) : buildCaveman(this.group, district.accent, s);
    const start = district.hub.clone();
    this.pos = new THREE.Vector3(start.x + (strHash(s, 6) - 0.5) * 1.5, start.y, start.z + (strHash(s, 7) - 0.5) * 1.5);
    this.group.position.copy(this.pos);
    this.path = []; this.pauseUntil = 0; this.planned = ''; this.heading = 0;

    const flagX = this.rig.kind === 'caveman' ? 0.42 : 0.75;
    this.flag = new THREE.Group(); this.flag.position.set(flagX, 0, 0.12);
    part(this.flag, 0.07, 2.0, 0.07, 0, 1.0, 0, this.rig.person ? 0x9aa0a6 : 0x6e4630);
    part(this.flag, 0.11, 0.08, 0.11, 0, 2.02, 0, 0x4a3020);
    const cloth = new THREE.Mesh(FLAG_GEO, FX.flag); cloth.position.set(0.035, 1.68, 0); cloth.castShadow = true; this.flag.add(cloth);
    this.patch = new THREE.Group();
    for (const [x, z, w, d, k] of PATCH) part(this.patch, w, k ? 0.026 : 0.02, d, x, 0, z, k ? FX.dirt2 : FX.dirt).castShadow = false;
    this.patch.children.forEach((p) => { p.position.y = p.scale.y / 2; p.receiveShadow = true; });
    this.mark = new THREE.Group();
    for (const a of [Math.PI / 4, -Math.PI / 4]) { const p = part(this.mark, 1.3, 0.024, 0.2, 0, 0.012, 0, FX.paint); p.rotation.y = a; p.castShadow = false; p.receiveShadow = true; }
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; const p = part(this.mark, 0.14, 0.024, 0.14, Math.cos(a) * 0.95, 0.012, Math.sin(a) * 0.95, FX.paint); p.castShadow = false; p.receiveShadow = true; }
    this.sparks = Array.from({ length: 4 }, () => { const p = part(this.group, 0.05, 0.05, 0.05, 0, 0, 0, this.rig.kind === 'caveman' ? FX.spark : FX.dust); p.castShadow = false; return p; });
    this.hitbox = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.9, this.rig.height * 0.6), 8, 6), FX.hit);
    this.hitbox.position.y = this.rig.height * 0.5; this.hitbox.userData.sessionId = data.sessionId;
    this.group.add(this.flag, this.patch, this.mark, this.hitbox);
    this.flagK = 0; this.markK = 0;

    this.icon = document.createElement('div');
    Object.assign(this.icon.style, { position: 'absolute', left: '0', top: '0', font: "700 11px 'JetBrains Mono', ui-monospace, monospace", minWidth: '22px', height: '22px',
      padding: '0 5px', display: 'none', placeItems: 'center', borderRadius: '3px', pointerEvents: 'none', whiteSpace: 'nowrap', willChange: 'transform', boxSizing: 'border-box' });
  }

  get focus() { return this.group.position.clone().add(new THREE.Vector3(0, this.rig.height * 0.6, 0)); }
  get iconY() { return this.rig.height + 0.55; }

  plan(city, d, slot) {
    const st = this.data.state;
    let goal = null;
    if (st === 'needs_input') {
      const a = d.angle + (slot % 2 ? -1 : 1) * (0.35 + 0.3 * Math.floor(slot / 2));
      goal = new THREE.Vector3(city.center.x + Math.cos(a) * FIRE_RING, city.center.y, city.center.z - Math.sin(a) * FIRE_RING);
    } else if (st === 'idle') goal = d.seats[slot % d.seats.length].clone();
    else if (st === 'working') {
      const s = d.spots[Math.floor(Math.random() * d.spots.length)];
      goal = s.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5));
    }
    this.path = [];
    if (!goal) return;
    // Everyone moves via the district hub, so routes stay on the trodden paths between huts.
    if (this.pos.distanceTo(d.hub) > 1.2 && goal.distanceTo(d.hub) > 0.8) this.path.push(d.hub.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6)));
    this.path.push(goal);
  }

  update(dt, t, city, d, slot, camera) {
    const st = this.data.state, key = `${st}:${d.branch}:${slot}`;
    if (key !== this.planned) { this.planned = key; this.plan(city, d, slot); this.pauseUntil = 0; }
    const speed = this.rig.kind === 'animal' ? 1.2 : 1.5;
    let walking = false;
    const next = this.path[0];
    if (next && t >= this.pauseUntil) {
      const dx = next.x - this.pos.x, dz = next.z - this.pos.z, dist = Math.hypot(dx, dz);
      if (dist < 0.05) {
        this.path.shift();
        if (!this.path.length && st === 'working') { this.pauseUntil = t + 2 + Math.random() * 4; this.planned = ''; }
      } else {
        walking = true;
        const step = Math.min(dist, speed * dt);
        this.pos.x += (dx / dist) * step; this.pos.z += (dz / dist) * step;
        const want = Math.atan2(dx, dz);
        let dh = want - this.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        this.heading += dh * Math.min(1, dt * 10);
      }
    }
    const r = this.rig, s = t * (r.kind === 'animal' ? 7 : 9) + this.seed;
    const sitting = st === 'idle' && !walking, busy = st === 'working' && !walking;
    if (!walking) {
      let face = null;
      if (st === 'needs_input') face = Math.atan2(city.center.x - this.pos.x, city.center.z - this.pos.z) + Math.PI;
      else if (sitting) face = Math.atan2(d.hub.x - this.pos.x, d.hub.z - this.pos.z);
      if (face !== null) { let dh = face - this.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); this.heading += dh * Math.min(1, dt * 6); }
    }
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.heading;

    const holding = st === 'needs_input' && !walking, slumped = st === 'errored' && !walking;
    this.flagK += ((holding ? 1 : 0) - this.flagK) * Math.min(1, dt * (holding ? 3 : 8));
    this.markK += ((slumped ? 1 : 0) - this.markK) * Math.min(1, dt * 4);
    const fk = this.flagK, mk = this.markK;
    this.flag.visible = fk > 0.01;
    this.patch.visible = !r.person && fk > 0.01;
    this.flag.scale.set(1, Math.max(0.001, 1 - (1 - fk) ** 3), 1);
    this.patch.scale.set(Math.max(0.001, fk), 1, Math.max(0.001, fk));
    this.mark.visible = mk > 0.01;
    this.mark.scale.set(Math.max(0.001, mk), 1, Math.max(0.001, mk));
    const seated = sitting || slumped, seatY = sitting ? r.sitY : 0.1;
    if (r.kind === 'caveman') {
      r.body.position.y = seated ? seatY : 0.32 + (walking ? Math.abs(Math.sin(s)) * 0.05 : 0);
      r.body.rotation.x = slumped ? 0.75 : st === 'errored' ? 0.3 : busy ? (r.person ? 0.1 : 0.35) : 0;
      r.legs.forEach((l, i) => { l.rotation.x = seated ? -1.45 : walking ? Math.sin(s + i * Math.PI) * 0.6 : 0; l.position.y = seated ? seatY : 0.32; l.position.z = seated ? 0.04 : 0; });
      r.arms[0].rotation.x = walking ? -Math.sin(s) * 0.5 : st === 'errored' ? 0.25 : 0;
      r.arms[1].rotation.x = walking ? Math.sin(s) * 0.5 : busy ? (r.person ? -1.15 + Math.sin(t * 14 + this.seed + 1.7) * 0.07 : -1.9 + Math.max(0, Math.sin(t * 9 + this.seed)) * 1.6) : st === 'errored' ? 0.25 : 0;
      if (r.person && busy) r.arms[0].rotation.x = -1.15 + Math.sin(t * 14 + this.seed) * 0.07;
      r.head.rotation.x = slumped ? 0.5 : 0;
      r.arms[1].rotation.z = 0.45 * fk;
      r.arms[0].rotation.z = slumped ? -0.25 : 0;
      r.tool.visible = r.person ? busy : st === 'working';
    } else {
      const lying = sitting || st === 'errored';
      r.body.position.y = r.legs[0].position.y + (lying ? r.lieY : walking ? Math.abs(Math.sin(s)) * 0.03 : 0);
      r.body.rotation.z = st === 'errored' ? 0.25 : 0;
      r.legs.forEach((l, i) => { l.rotation.x = lying ? (i < 2 ? -1.3 : 1.3) : walking ? Math.sin(s + (i === 0 || i === 3 ? 0 : Math.PI)) * 0.5 : 0; l.visible = true; l.scale.y = lying ? 0.55 : 1; });
      const graze = busy ? Math.max(0, Math.sin(t * 1.3 + this.seed)) : 0;
      r.head.rotation.x = graze * 0.7 + (st === 'errored' ? 0.4 : 0);
      if (r.neck) r.neck.rotation.z = Math.sin(t * 2 + this.seed) * (walking ? 0.25 : 0.12);
    }

    const showSparks = busy;
    this.sparks.forEach((p, i) => {
      p.visible = showSparks && !r.person && Math.sin(t * (r.kind === 'caveman' ? 23 : 3) + i * 2.3 + this.seed) > 0.3;
      if (r.kind === 'caveman') p.position.set(0.2 + Math.sin(t * 31 + i) * 0.14, 0.12 + Math.abs(Math.cos(t * 27 + i * 1.7)) * 0.2, 0.5 + Math.sin(t * 19 + i) * 0.1);
      else { const k = (t * 0.8 + i * 0.25) % 1; p.position.set(Math.sin(i * 2) * 0.3, 0.05 + k * 0.3, 0.6 + k * 0.2); p.scale.setScalar(0.08 + k * 0.1); }
    });
    if (this.icon.dataset.state !== st) {
      this.icon.dataset.state = st;
      const ic = ICON[st];
      this.icon.textContent = ic ? ic.text : '';
      if (ic) Object.assign(this.icon.style, { background: ic.bg, color: ic.fg, fontStyle: ic.italic ? 'italic' : 'normal', animation: ic.anim || 'none' });
    }
  }

  dispose() { this.icon.remove(); this.group.removeFromParent(); }
}
