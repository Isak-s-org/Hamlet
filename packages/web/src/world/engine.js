import { THREE, U, stdMat, plainMat, holoMat, setDistTex, fogFactor, softShadowFilter, skyNode } from './materials.js';
import { pass, renderOutput, vec2, vec3, vec4, float, mix, smoothstep, screenUV, uniform, dot, clamp, length, fog, Fn, pow } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { generate, GRASS_Y } from './terrain.js';
import { CreatureView } from './creatures.js';

const V = THREE.Vector3, C = (h) => new THREE.Color(h);
const DIST = 400, BASE_YAW = Math.PI / 4;
const PITCH_MIN = THREE.MathUtils.degToRad(28), PITCH_MAX = THREE.MathUtils.degToRad(70);

// Time-of-day keyframes (hours). Colours are sRGB.
const KF = (() => {
  const night = { top: '#0a1230', bot: '#1d2a52', sun: '#9db0ff', si: 0.6, hs: '#3a4a86', hg: '#2a2036', hi: 0.6, night: 1, exp: 1.05, sat: 0.95, con: 1.02, gain: [0.88, 0.94, 1.1], lift: [0.01, 0.02, 0.05], bloom: 0.9 };
  return [
    { h: 0, ...night }, { h: 5, ...night },
    { h: 6.5, top: '#6d8cc6', bot: '#ffc39b', sun: '#ffae7a', si: 1.7, hs: '#a9b8e6', hg: '#c09078', hi: 1.0, night: 0.25, exp: 1.0, sat: 1.06, con: 1.03, gain: [1.04, 0.99, 0.95], lift: [0.01, 0, 0.02], bloom: 0.6 },
    { h: 9, top: '#86bdee', bot: '#e8f3f6', sun: '#fff1dc', si: 2.9, hs: '#cfe2ff', hg: '#e6b88e', hi: 1.25, night: 0, exp: 1.0, sat: 1.1, con: 1.04, gain: [1, 1, 1], lift: [0, 0, 0], bloom: 0.4 },
    { h: 13, top: '#79b4ea', bot: '#e4f1f8', sun: '#fff6e8', si: 3.1, hs: '#d2e4ff', hg: '#e9bc90', hi: 1.25, night: 0, exp: 1.0, sat: 1.1, con: 1.04, gain: [1, 1, 1], lift: [0, 0, 0], bloom: 0.4 },
    { h: 16.5, top: '#86b0de', bot: '#fde3bd', sun: '#ffdcae', si: 2.9, hs: '#d4ddf2', hg: '#ecb27e', hi: 1.2, night: 0, exp: 1.0, sat: 1.12, con: 1.05, gain: [1.03, 1, 0.96], lift: [0, 0, 0], bloom: 0.45 },
    { h: 18.7, top: '#5a70b0', bot: '#ffad76', sun: '#ff9a5c', si: 2.1, hs: '#9aa6d8', hg: '#c47c62', hi: 0.95, night: 0.2, exp: 1.0, sat: 1.1, con: 1.05, gain: [1.06, 0.97, 0.9], lift: [0.01, 0, 0], bloom: 0.65 },
    { h: 20, top: '#283466', bot: '#b8667a', sun: '#ff7a6a', si: 0.6, hs: '#5a5f96', hg: '#4a3040', hi: 0.7, night: 0.85, exp: 1.05, sat: 1.0, con: 1.03, gain: [0.95, 0.92, 1.05], lift: [0.01, 0.01, 0.04], bloom: 0.85 },
    { h: 21.5, ...night }, { h: 24, ...night },
  ];
})();

function sampleKF(hour) {
  let i = 0; while (i < KF.length - 2 && KF[i + 1].h <= hour) i++;
  const a = KF[i], b = KF[i + 1], t = (hour - a.h) / Math.max(1e-3, b.h - a.h), k = t * t * (3 - 2 * t);
  const col = (x, y) => C(x).lerp(C(y), k), num = (x, y) => x + (y - x) * k;
  const v3 = (x, y) => new V(num(x[0], y[0]), num(x[1], y[1]), num(x[2], y[2]));
  return { top: col(a.top, b.top), bot: col(a.bot, b.bot), sun: col(a.sun, b.sun), si: num(a.si, b.si), hs: col(a.hs, b.hs), hg: col(a.hg, b.hg),
    hi: num(a.hi, b.hi), night: num(a.night, b.night), exp: num(a.exp, b.exp), sat: num(a.sat, b.sat), con: num(a.con, b.con),
    gain: v3(a.gain, b.gain), lift: v3(a.lift, b.lift), bloom: num(a.bloom, b.bloom) };
}
function paletteColors(p) {
  if (Array.isArray(p) && p.length >= 2) return [C(p[0]), C(p[1])];
  if (typeof p === 'string') { const t = C(p); return [t, t.clone().lerp(C('#ffffff'), 0.6)]; }
  return [C('#f2955a'), C('#ffe1b3')];
}

export async function createWorld({ canvas, labels, bubble, options, callbacks }) {
  const opts = { ...options };
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: !!opts.forceWebGL });
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, DIST * 2 + 300);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
  sun.shadow.filterNode = softShadowFilter;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.2);
  scene.add(sun, sun.target, hemi);
  const fires = Array.from({ length: 4 }, () => { const l = new THREE.PointLight(0xff9a40, 0, 14, 1.4); scene.add(l); return l; });

  // Sky gradient and fog as nodes.
  scene.backgroundNode = skyNode;
  const ff = fogFactor();
  scene.fogNode = fog(ff.color, ff.factor);

  const terrainMat = stdMat({ grow: true, edges: true, emit: true });
  const foliageMat = stdMat({ grow: true, edges: true, wind: true, roughness: 0.8 });
  const waterMat = stdMat({ vertexColors: false, water: true, grow: true, roughness: 0.32, rim: false });
  const fallsMat = stdMat({ falls: true, grow: true, roughness: 0.32, rim: false, transparent: true, depthWrite: false });
  const smokeMat = plainMat(0x77716b, { roughness: 1, transparent: true, opacity: 0.4, depthWrite: false });
  const smokeGeo = new THREE.BoxGeometry(1, 1, 1);
  const sprayMat = plainMat(0xcfeaff, { roughness: 0.3, transparent: true, opacity: 0.75, depthWrite: false });
  const steamMat = plainMat(0xf4f6f6, { roughness: 1, transparent: true, opacity: 0.3, depthWrite: false });
  const WATER = { stone: [0x4a92de, 0x6aaaea, 0x9ccdf3, 0xeef8ff], suburb: [0x2c68b0, 0x3f80c6, 0x7fb6e2, 0xe8f4ff], japan: [0x23708a, 0x3b93a6, 0x86cfc8, 0xf0fbf7] };
  const worldOf = (o) => (o.world === 'suburb' || o.world === 'japan' ? o.world : 'stone');
  const styleOf = (o) => (o.world === 'suburb' ? 'people' : o.world === 'japan' ? 'villagers' : o.botStyle || 'cavemen');

  // Japan ambience: drifting sakura petals by day, fireflies at night. Positions wrap around the camera target.
  const dummy = new THREE.Object3D(), wrap = (v, S) => ((((v + S / 2) % S) + S) % S) - S / 2;
  const PN = 240, petals = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.015, 0.1), plainMat(0xf7c0d0, { roughness: 0.7 }), PN);
  const FN = 70, flies = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.07, 0.07), holoMat(0xd9ff7a, 4), FN);
  for (const m of [petals, flies]) { m.frustumCulled = false; m.visible = false; scene.add(m); }
  const rnd = (a) => (Math.random() - 0.5) * a;
  const pState = Array.from({ length: PN }, () => ({ x: rnd(60), z: rnd(60), y: Math.random(), s: 0.6 + Math.random() * 0.8, ph: Math.random() * 6.28 }));
  const fState = Array.from({ length: FN }, () => ({ x: rnd(40), z: rnd(40), y: 0.4 + Math.random() * 1.4, ph: Math.random() * 6.28 }));
  function updateAmbience(dt, t, builtK) {
    const jp = opts.world === 'japan', w = opts.wind ?? 1;
    petals.visible = jp && builtK > 0.5 && cs.fh < 120;
    flies.visible = jp && builtK > 0.5 && U.night.value > 0.15;
    if (petals.visible) {
      const S = Math.min(70, cs.fh * 1.3);
      pState.forEach((p, i) => {
        p.y -= dt * 0.045 * p.s; p.x += dt * 0.5 * w * p.s; p.z += dt * 0.25 * w;
        if (p.y < 0) { p.y += 1; p.x = cs.target.x + rnd(S); p.z = cs.target.z + rnd(S); }
        dummy.position.set(cs.target.x + wrap(p.x - cs.target.x, S) + Math.sin(t * 1.5 + p.ph) * 0.3, GRASS_Y + p.y * 9, cs.target.z + wrap(p.z - cs.target.z, S));
        dummy.rotation.set(t * p.s * 1.3 + p.ph, p.ph, Math.sin(t * 2 * p.s + p.ph) * 0.8);
        dummy.scale.setScalar(1); dummy.updateMatrix(); petals.setMatrixAt(i, dummy.matrix);
      });
      petals.instanceMatrix.needsUpdate = true;
    }
    if (flies.visible) {
      const S = Math.min(40, cs.fh), n = U.night.value;
      fState.forEach((f, i) => {
        const x = cs.target.x + wrap(f.x - cs.target.x, S) + Math.sin(t * 0.6 + f.ph) * 0.6, z = cs.target.z + wrap(f.z - cs.target.z, S) + Math.cos(t * 0.5 + f.ph) * 0.6;
        dummy.position.set(x, (world ? world.heightAt(x, z) : GRASS_Y) + f.y + Math.sin(t * 0.9 + f.ph * 2) * 0.25, z);
        dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(Math.max(0.001, n * (0.3 + 0.7 * Math.max(0, Math.sin(t * 2.2 + f.ph * 5))))); dummy.updateMatrix(); flies.setMatrixAt(i, dummy.matrix);
      });
      flies.instanceMatrix.needsUpdate = true;
    }
  }

  // Post: scene → GTAO → bloom → tone map → grade. Rebuilt when effect toggles change.
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  const scenePass = pass(scene, camera, { samples: 4 });
  const sceneColor = scenePass.getTextureNode('output');
  // AO needs a single-sampled depth prepass (GTAO gathers depth, which MSAA textures can't do). Normals are rebuilt from depth.
  const prePass = pass(scene, camera, { samples: 0 });
  prePass.transparent = false;
  const preDepth = prePass.getTextureNode('depth');
  const G = { sat: uniform(1.1), con: uniform(1.04), gain: uniform(new V(1, 1, 1)), lift: uniform(new V()), vig: uniform(0.3), ao: uniform(0) };
  const grade = Fn(([c]) => {
    const l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    let x = mix(vec3(l), c.rgb, G.sat);
    x = x.sub(0.5).mul(G.con).add(0.5);
    x = x.mul(G.gain).add(G.lift.mul(float(1).sub(x)));
    const v = float(1).sub(smoothstep(0.3, 0.95, length(screenUV.sub(0.5).mul(vec2(1, 0.85)))));
    return vec4(clamp(x.mul(mix(float(1), v, G.vig)), 0, 1), 1);
  });
  let aoPass = null, bloomPass = null, postKey = '';
  function buildPipeline() {
    const key = [opts.ambientOcclusion !== false, opts.bloom !== false, opts.colorGrade !== false].join();
    if (key === postKey) return;
    postKey = key;
    let c = sceneColor;
    if (opts.ambientOcclusion !== false) {
      if (!aoPass) { aoPass = ao(preDepth, null, camera); aoPass.resolutionScale = 0.5; if (aoPass.radius) aoPass.radius.value = 0.7; if (aoPass.thickness) aoPass.thickness.value = 1; }
      // AO runs after fog, so it fades in with the reveal or it would outline the veiled land.
      c = c.mul(vec4(vec3(mix(float(1), aoPass.getTextureNode().r, G.ao)), 1));
    }
    if (bloomPass) { bloomPass.dispose?.(); bloomPass = null; }
    if (opts.bloom !== false) { bloomPass = bloom(c, 0.5, 0.55, 1.1); c = c.add(bloomPass); }
    let out = renderOutput(c);
    if (opts.colorGrade !== false) out = grade(out);
    pipeline.outputNode = out;
    pipeline.needsUpdate = true;
  }
  buildPipeline();

  // Camera state
  const cs = { target: new V(0, GRASS_Y, 0), yaw: BASE_YAW, yawGoal: BASE_YAW, pitch: 0.62, pitchGoal: 0.62, fh: 70, fhGoal: 70, vel: new V(), yawVel: 0, anchor: null };
  let vw = 1, vh = 1, flight = null;
  function applyCamera() {
    const a = vw / vh, cp = Math.cos(cs.pitch), sp = Math.sin(cs.pitch), cy = Math.cos(cs.yaw), sy = Math.sin(cs.yaw);
    camera.position.set(cs.target.x + cp * sy * DIST, cs.target.y + sp * DIST, cs.target.z + cp * cy * DIST);
    camera.lookAt(cs.target);
    camera.left = (-cs.fh * a) / 2; camera.right = (cs.fh * a) / 2; camera.top = cs.fh / 2; camera.bottom = -cs.fh / 2;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  }
  function groundAt(nx, ny, gy = GRASS_Y) {
    const a = vw / vh, cp = Math.cos(cs.pitch), sp = Math.sin(cs.pitch), cy = Math.cos(cs.yaw), sy = Math.sin(cs.yaw);
    const r = new V(cy, 0, -sy), up = new V(-sp * sy, cp, -sp * cy), f = new V(-cp * sy, -sp, -cp * cy);
    const o = cs.target.clone().addScaledVector(f, -DIST).addScaledVector(r, (nx * cs.fh * a) / 2).addScaledVector(up, (ny * cs.fh) / 2);
    return o.addScaledVector(f, (gy - o.y) / f.y);
  }
  const ndc = (cx, cy) => { const b = canvas.getBoundingClientRect(); return [((cx - b.left) / b.width) * 2 - 1, -((cy - b.top) / b.height) * 2 + 1]; };
  const groundAtClient = (e) => groundAt(...ndc(e.clientX, e.clientY));

  let world = null, terrain = null, foliage = null, water = null, falls = null, cities = new Map(), labelItems = [], reposKey = '', grow = 1, smokes = [];
  function clampTarget() {
    if (!world) return;
    cs.target.x = THREE.MathUtils.clamp(cs.target.x, world.ox, world.ox + world.W);
    cs.target.z = THREE.MathUtils.clamp(cs.target.z, world.oz, world.oz + world.H);
  }
  function fitFh() { if (!world) return 70; const d = Math.hypot(world.W, world.H); return Math.max(d * 0.52, (d * 0.82) / (vw / vh)); }
  function flyTo(pos, fh, dur = 1.2) { flight = { from: cs.target.clone(), to: new V(pos.x, GRASS_Y, pos.z), fh0: cs.fh, fh1: fh ?? cs.fh, t: 0, dur }; cs.vel.set(0, 0, 0); cs.anchor = null; }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  const LABEL_BASE = { position: 'absolute', left: '0', top: '0', display: 'none', whiteSpace: 'nowrap', pointerEvents: 'none', willChange: 'transform', boxSizing: 'border-box' };
  function addLabel(kind, text, pos, accent) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, LABEL_BASE, kind === 'banner'
      ? { font: "700 12px 'JetBrains Mono', ui-monospace, monospace", letterSpacing: '0.12em', textTransform: 'uppercase', padding: '3px 8px', background: 'var(--i-slab, #1b1c20)', color: 'var(--i-ink, #ece8df)', border: '1px solid var(--i-edge, #34363d)', borderRadius: '3px', boxShadow: '0 4px 12px rgba(20,10,0,0.2)' }
      : { font: "11px 'JetBrains Mono', ui-monospace, monospace", padding: '1px 6px', borderRadius: '2px', background: 'var(--i-pill, rgba(27,28,32,0.88))', color: 'var(--i-mid, #c9c6bf)' });
    if (kind !== 'banner' && accent != null) {
      el.textContent = '';
      const sq = document.createElement('span');
      Object.assign(sq.style, { display: 'inline-block', width: '6px', height: '6px', marginRight: '6px', verticalAlign: '1px', background: '#' + accent.toString(16).padStart(6, '0') });
      el.append(sq, text);
    }
    if (kind === 'banner') el.style.zIndex = '2';
    labels.appendChild(el);
    const item = { el, pos, maxFh: kind === 'banner' ? 260 : 42, born: false };
    labelItems.push(item);
    return item;
  }

  function setRepos(list, rebuild = false) {
    const key = JSON.stringify(list);
    if (key === reposKey) return;
    reposKey = key;
    const first = !world || rebuild, before = rebuild ? new Set() : new Set(cities.keys()), wn = worldOf(opts), suburb = wn === 'suburb', jp = wn === 'japan';
    const w = generate(list, first ? null : world, wn);
    const wc = WATER[wn];
    [U.deep, U.mid, U.shallow, U.foam].forEach((u, i) => u.value.setHex(wc[i]));
    for (const m of [terrain, foliage, water, falls]) if (m) { m.geometry.dispose(); m.removeFromParent(); }
    if (world) world.distTex.dispose();
    terrain = new THREE.Mesh(w.terrainGeo, terrainMat); terrain.castShadow = terrain.receiveShadow = true;
    foliage = new THREE.Mesh(w.foliageGeo, foliageMat); foliage.castShadow = foliage.receiveShadow = true;
    water = new THREE.Mesh(w.waterGeo, waterMat); water.receiveShadow = true;
    falls = new THREE.Mesh(w.fallsGeo, fallsMat);
    scene.add(terrain, foliage, water, falls);
    setDistTex(w.distTex); U.gridOrigin.value.set(w.ox, w.oz); U.gridSize.value.set(w.W, w.H);
    cities = w.cities;
    for (const l of labelItems) l.el.remove();
    labelItems = [];
    for (const s of smokes) s.group.removeFromParent();
    smokes = [];
    for (const c of cities.values()) {
      const isNewCity = first || !before.has(c.repo);
      addLabel('banner', c.repo, c.center.clone().setY(c.center.y + 4.6)).born = isNewCity;
      for (const d of c.districts.values()) addLabel('branch', d.branch, d.hub.clone().setY(d.hub.y + 2.4), d.accent).born = isNewCity;
      const g = new THREE.Group();
      const cubes = Array.from({ length: suburb ? 12 : jp ? 10 : 6 }, () => { const m = new THREE.Mesh(smokeGeo, suburb ? sprayMat : jp ? steamMat : smokeMat); g.add(m); return m; });
      g.position.copy(c.fire); scene.add(g);
      smokes.push({ group: g, cubes, spray: suburb, steam: jp, born: first || !before.has(c.repo) });
    }
    for (const v of views.values()) v.dispose();
    views.clear();
    world = w;
    // A full build appears behind the fog veil; only cities added later grow in.
    grow = first ? 1 : -0.3; U.grow.value = Math.max(0, grow);
    if (rebuild) api.reveal();
    if (first && !rebuild) { cs.target.copy(w.center); cs.fh = cs.fhGoal = fitFh(); }
    else if (!rebuild) {
      const added = [...cities.keys()].filter((r) => !before.has(r));
      if (added.length) flyTo(cities.get(added[added.length - 1]).center, Math.max(44, Math.min(cs.fh, 70)), 1.3);
    }
    applyBots(lastBots);
  }

  const views = new Map();
  let lastBots = [];
  const slots = new Map();
  function applyBots(bots) {
    lastBots = bots;
    const live = new Set(bots.map((b) => b.sessionId));
    for (const [id, v] of views) if (!live.has(id)) { v.dispose(); views.delete(id); }
    slots.clear();
    const seen = new Map();
    for (const b of [...bots].sort((a, c) => a.sessionId.localeCompare(c.sessionId))) {
      const k = `${b.repo}\n${b.branch}\n${b.state}`;
      slots.set(b.sessionId, seen.get(k) ?? 0); seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const b of bots) {
      const city = cities.get(b.repo), d = city?.districts.get(b.branch);
      if (!d) continue;
      let v = views.get(b.sessionId);
      if (!v) { v = new CreatureView(b, d, city, styleOf(opts)); views.set(b.sessionId, v); scene.add(v.group); labels.appendChild(v.icon); }
      v.data = b;
    }
  }

  let selected = null;

  // Input
  const keys = new Set();
  let drag = null, mouse = null;
  const raycaster = new THREE.Raycaster();
  function pickBot(e) {
    raycaster.setFromCamera(new THREE.Vector2(...ndc(e.clientX, e.clientY)), camera);
    const hit = raycaster.intersectObjects([...views.values()].map((v) => v.hitbox))[0];
    return hit ? hit.object.userData.sessionId : null;
  }
  const onContext = (e) => e.preventDefault();
  const onDown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { mode: 'pan', x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, p0: groundAtClient(e), button: e.button, t: performance.now() };
    flight = null; cs.vel.set(0, 0, 0); cs.yawVel = 0;
  };
  const onMove = (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (!drag) { canvas.style.cursor = pickBot(e) ? 'pointer' : 'default'; return; }
    const now = performance.now(), dt = Math.max(1, now - drag.t) / 1000;
    drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
    applyCamera();
    const d = drag.p0.clone().sub(groundAtClient(e));
    cs.target.add(d); clampTarget();
    cs.vel.lerp(d.divideScalar(dt), 0.5);
    canvas.style.cursor = 'move';
  };
  const onUp = (e) => {
    if (!drag) return;
    if (!drag.moved && drag.button === 0) callbacks.onSelect?.(pickBot(e));
    if (performance.now() - drag.t > 80) cs.vel.set(0, 0, 0);
    drag = null; canvas.style.cursor = 'default';
  };
  const onLeave = () => { mouse = null; };
  const onDbl = (e) => {
    const [nx, ny] = ndc(e.clientX, e.clientY);
    let p = groundAt(nx, ny);
    if (world) p = groundAt(nx, ny, world.heightAt(p.x, p.z));
    flyTo(p, Math.max(16, cs.fh * 0.5), 0.9);
  };
  const onWheel = (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    cs.fhGoal = THREE.MathUtils.clamp(cs.fhGoal * Math.exp(dy * 0.0012), 10, fitFh() * 1.3);
    cs.anchor = ndc(e.clientX, e.clientY);
    flight = null;
  };
  const typing = (e) => /input|textarea|select/i.test(e.target?.tagName || '') || e.target?.isContentEditable;
  const onKeyDown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    const k = e.key.toLowerCase();
    if ((k === 'a' || k === 'd') && callbacks.permissionOpen?.()) return;
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys.add(k); flight = null; if (k.startsWith('arrow')) e.preventDefault(); }
    else if (k === '+' || k === '=') api.zoom(-1);
    else if (k === '-' || k === '_') api.zoom(1);
    else if (k === 'f') api.frameAll();
  };
  const onKeyUp = (e) => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    vw = Math.max(1, r.width); vh = Math.max(1, r.height);
    renderer.setSize(vw, vh, false);
  }
  new ResizeObserver(resize).observe(canvas.parentElement); resize();

  let hour = opts.timeOfDay ?? 16.5, lastNight = null;
  const wx = { mist: 0, rim: opts.rimLight === false ? 0 : 1 };
  const tmpDir = new V(), sunDir = new V(), moonDir = new V(-0.3, 0.8, 0.5).normalize();
  function updateLighting(dt) {
    const L = sampleKF(hour);
    wx.mist += ((opts.weather === 'mist' ? 1 : 0) - wx.mist) * (1 - Math.exp(-dt * 0.9));
    wx.rim += ((opts.rimLight === false ? 0 : 1) - wx.rim) * (1 - Math.exp(-dt * 5));
    const [pt, pb] = paletteColors(opts.skyPalette), day = 1 - L.night, haze = wx.mist * 0.35;
    const top = L.top.clone().lerp(pt, day * 0.9).lerp(C('#c9ced6'), haze), bot = L.bot.clone().lerp(pb, day * 0.9).lerp(C('#e6e2dc'), haze);
    U.skyTop.value.copy(top); U.skyBot.value.copy(bot);
    const ph = ((hour - 6) / 12) * Math.PI, el = Math.max(0.12, Math.sin(ph)) * THREE.MathUtils.degToRad(62), az = ph - 0.87;
    sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    tmpDir.copy(sunDir).lerp(moonDir, L.night).normalize();
    const si = L.si * (1 - haze * 0.8);
    sun.color.copy(L.sun); sun.intensity = si;
    hemi.color.copy(L.hs).lerp(pt, day * 0.1); hemi.groundColor.copy(L.hg); hemi.intensity = L.hi * 1.45 * (1 + haze);
    renderer.toneMappingExposure = L.exp;
    U.night.value = L.night;
    U.mist.value = wx.mist;
    U.rim.value = wx.rim;
    U.wind.value = opts.wind ?? 1;
    U.fogColor.value.copy(bot).lerp(top, 0.25).lerp(C('#f3ece2'), 0.35);
    U.mistColor.value.copy(bot).lerp(C('#ffffff'), 0.35 - L.night * 0.3);
    U.fogNear.value = cs.fh * 0.55; U.fogFar.value = cs.fh * 1.5 + 30;
    U.fogAmt.value = 0.45 + haze;
    U.focus.value.copy(cs.target);
    U.rimColor.value.copy(L.bot).lerp(L.sun, 0.5);
    U.shadowSoft.value = opts.softShadows === false ? 1 : 3.5;

    const half = THREE.MathUtils.clamp(cs.fh * 0.62 * Math.max(1, vw / vh) + 6, 12, 150);
    const sc = sun.shadow.camera;
    if (sc.right !== half) { sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 1; sc.far = 420; sc.updateProjectionMatrix(); }
    sun.target.position.copy(cs.target);
    sun.position.copy(cs.target).addScaledVector(tmpDir, 200);

    const near = [...cities.values()].sort((a, b) => a.center.distanceToSquared(cs.target) - b.center.distanceToSquared(cs.target)), sub = opts.world === 'suburb' || opts.world === 'japan';
    fires.forEach((l, i) => { const c = near[i]; l.visible = !!c; if (c) { l.position.copy(c.fire).setY(c.fire.y + 0.6); l.color.setHex(opts.world === 'japan' ? 0xffc890 : sub ? 0xffe2b4 : 0xff9a40); l.intensity = sub ? 0.2 + L.night * 9 : (1.5 + L.night * 16) * (0.9 + Math.sin(performance.now() * 0.013 + i) * 0.1); } });

    if (bloomPass?.strength) bloomPass.strength.value = L.bloom;
    G.sat.value = 1 + (L.sat - 1) * 0.5 * (1 - haze); G.con.value = L.con; G.gain.value.copy(L.gain); G.lift.value.copy(L.lift);
    const isNight = L.night > 0.5;
    if (isNight !== lastNight) { lastNight = isNight; callbacks.onNight?.(isNight); }
  }

  function updateCamera(dt) {
    if (flight) {
      flight.t = Math.min(1, flight.t + dt / flight.dur);
      const k = ease(flight.t);
      cs.target.lerpVectors(flight.from, flight.to, k);
      cs.fh = cs.fhGoal = flight.fh0 + (flight.fh1 - flight.fh0) * k;
      if (flight.t === 1) flight = null;
    } else {
      const cy = Math.cos(cs.yaw), sy = Math.sin(cs.yaw), right = new V(cy, 0, -sy), fwd = new V(-sy, 0, -cy), mv = new V();
      if (keys.has('w') || keys.has('arrowup')) mv.add(fwd);
      if (keys.has('s') || keys.has('arrowdown')) mv.sub(fwd);
      if (keys.has('d') || keys.has('arrowright')) mv.add(right);
      if (keys.has('a') || keys.has('arrowleft')) mv.sub(right);
      if (mouse && !drag && opts.edgePan !== false) {
        const b = canvas.getBoundingClientRect(), m = 14;
        if (mouse.x - b.left < m) mv.sub(right); if (b.right - mouse.x < m) mv.add(right);
        if (mouse.y - b.top < m) mv.add(fwd); if (b.bottom - mouse.y < m) mv.sub(fwd);
      }
      if (mv.lengthSq() > 0) cs.vel.lerp(mv.normalize().multiplyScalar(cs.fh * 0.85), 1 - Math.exp(-dt * 10));
      else if (!drag) cs.vel.multiplyScalar(Math.exp(-dt * 5));
      if (!drag) cs.target.addScaledVector(cs.vel, dt);
      if (!drag && Math.abs(cs.yawVel) > 1e-4) { cs.yawGoal += cs.yawVel * dt; cs.yawVel *= Math.exp(-dt * 6); }
      if (Math.abs(cs.fhGoal - cs.fh) > 1e-3) {
        const before = cs.anchor ? groundAt(...cs.anchor) : null;
        cs.fh += (cs.fhGoal - cs.fh) * (1 - Math.exp(-dt * 10));
        if (before) cs.target.add(before.sub(groundAt(...cs.anchor)));
      } else cs.anchor = null;
      clampTarget();
    }
    cs.yaw += (cs.yawGoal - cs.yaw) * (1 - Math.exp(-dt * 9));
    cs.pitch += (cs.pitchGoal - cs.pitch) * (1 - Math.exp(-dt * 9));
    applyCamera();
  }

  const proj = new V();
  function place(el, pos, dy = 0) {
    proj.copy(pos).project(camera);
    if (Math.abs(proj.x) > 1.2 || Math.abs(proj.y) > 1.2) { el.style.display = 'none'; return false; }
    el.style.transform = `translate(${((proj.x + 1) / 2) * vw}px, ${((1 - proj.y) / 2) * vh + dy}px) translate(-50%, -100%)`;
    return true;
  }

  const timer = new THREE.Timer();
  let errCount = 0, revealT = -1;
  function frame() {
    requestAnimationFrame(frame);
    try { step(); } catch (e) { if (errCount++ < 3) console.error('[world] ' + e.message + '\n' + e.stack); }
  }
  function step() {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1), t = timer.getElapsed();
    U.time.value = t;
    if (opts.dayCycle) hour = (hour + dt * 0.1) % 24;
    else { let d = (opts.timeOfDay ?? 16.5) - hour; if (d > 12) d -= 24; if (d < -12) d += 24; hour = (hour + d * (1 - Math.exp(-dt * 3)) + 24) % 24; }
    updateCamera(dt);
    updateLighting(dt);
    if (grow < 1) { grow = Math.min(1, grow + dt / 4.5); U.grow.value = Math.max(0, grow); }
    const builtK = Math.max(0, Math.min(1, (U.grow.value - 0.62) / 0.3));
    for (const s of smokes) {
      s.group.visible = !s.born || builtK > 0.5;
      s.cubes.forEach((m, i) => {
        if (s.spray) {
          const k = (t * 0.7 + i / s.cubes.length) % 1, a = i * 2.4 + t * 0.3;
          m.position.set(Math.cos(a) * k * 0.55, 0.15 + 2.4 * k - 3.2 * k * k, Math.sin(a) * k * 0.55);
          m.scale.setScalar(0.09); m.rotation.set(k * 3, i, 0);
          return;
        }
        if (s.steam) {
          const k = (t * 0.16 + i / s.cubes.length) % 1, a = i * 2.4;
          m.position.set(Math.cos(a) * 0.7 * (1 - k * 0.5) + k * 0.4 * (opts.wind ?? 1), 0.05 + k * 2.2, Math.sin(a) * 0.7 * (1 - k * 0.5));
          m.scale.setScalar(0.25 + k * 0.7); m.rotation.set(k * 1.5 + i, k * 2, 0);
          return;
        }
        const k = (t * 0.22 + i / s.cubes.length) % 1;
        m.position.set(Math.sin(t * 0.7 + i * 2.1) * 0.3 * k + k * 0.6 * (opts.wind ?? 1) * 0.5, 0.5 + k * 4, Math.cos(t * 0.5 + i) * 0.2 * k);
        m.scale.setScalar((0.18 + k * 0.6) * (1 - k * 0.35));
        m.rotation.set(k * 2 + i, k * 3, 0);
      });
    }

    if (revealT >= 0 && revealT < 1) {
      revealT = Math.min(1, revealT + dt / 2.6);
      U.revealR.value = revealT === 1 ? 1e5 : 2 + ease(revealT) * (world ? Math.hypot(world.W, world.H) : 100);
      G.ao.value = ease(revealT);
    }
    const veiled = revealT < 0.5;
    updateAmbience(dt, t, builtK);
    for (const v of views.values()) {
      const city = cities.get(v.data.repo), d = city?.districts.get(v.data.branch);
      if (!d) continue;
      v.update(dt, t, city, d, slots.get(v.data.sessionId) ?? 0, camera);
      const newSmoke = smokes.find((s) => s.group.position.distanceToSquared(city.fire) < 0.01);
      v.group.visible = !(newSmoke?.born) || builtK > 0.8;
      const st = v.data.state, show = v.group.visible && ((st === 'needs_input' || st === 'errored') ? cs.fh < 400 : st === 'idle' && cs.fh < 60);
      if (show && !veiled && v.icon.textContent && place(v.icon, v.group.position.clone().setY(v.group.position.y + v.iconY))) v.icon.style.display = 'grid';
      else v.icon.style.display = 'none';
    }
    for (const l of labelItems) { if (veiled || cs.fh > l.maxFh || (l.born && builtK < 0.6)) l.el.style.display = 'none'; else if (place(l.el, l.pos)) l.el.style.display = 'block'; }

    const sel = selected ? views.get(selected) : null;
    if (bubble) {
      if (sel) {
        proj.copy(sel.group.position).setY(sel.group.position.y + sel.iconY - 0.2).project(camera);
        const on = Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
        bubble.style.visibility = on ? 'visible' : 'hidden';
        if (on) bubble.style.transform = `translate(${((proj.x + 1) / 2) * vw}px, ${((1 - proj.y) / 2) * vh - 14}px) translate(-50%, -100%)`;
      } else bubble.style.visibility = 'hidden';
    }
    pipeline.render();
  }

  const api = {
    setRepos,
    setBots: applyBots,
    /** Compiles every material now so the reveal does not stutter on first draw. */
    compile: () => renderer.compileAsync(scene, camera),
    /** Clears the intro fog outward from the camera focus. */
    reveal() { revealT = 0; U.revealR.value = 0.001; G.ao.value = 0; },
    setOptions(o) {
      const prevStyle = styleOf(opts), prevWorld = opts.world || 'stone';
      Object.assign(opts, o);
      buildPipeline();
      if ((opts.world || 'stone') !== prevWorld && reposKey) { const list = JSON.parse(reposKey); reposKey = ''; selected = null; setRepos(list, true); }
      else if (styleOf(opts) !== prevStyle) { for (const v of views.values()) v.dispose(); views.clear(); applyBots(lastBots); }
    },
    select(id, fly = true) { selected = id; const v = id ? views.get(id) : null; if (v && fly) flyTo(v.focus, Math.min(cs.fh, 24)); },
    flyToCity(repo, fh = 36) { const c = cities.get(repo); if (c) flyTo(c.center, fh); },
    zoom(dir) { cs.fhGoal = THREE.MathUtils.clamp(cs.fhGoal * (dir > 0 ? 1.4 : 1 / 1.4), 10, fitFh() * 1.3); cs.anchor = null; },
    frameAll() { if (world) flyTo(world.center, fitFh(), 1.0); },
  };
  frame();
  return api;
}
