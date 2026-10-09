import * as THREE from 'three/webgpu';
import {
  Fn, uniform, attribute, vec2, vec3, float, color, mix, smoothstep, step, sin, cos, pow, clamp, min, max, exp, abs,
  positionLocal, positionWorld, normalView, texture, vertexColor, fwidth, mx_noise_float, distance, screenCoordinate, screenUV, add, fract, dot,
} from 'three/tsl';

export { THREE };

// Shared uniforms: every node material reads these same nodes.
export const U = {
  time: uniform(0), wind: uniform(1), grow: uniform(1), rim: uniform(1), night: uniform(0), mist: uniform(0),
  fogColor: uniform(new THREE.Color()), mistColor: uniform(new THREE.Color()), fogNear: uniform(60), fogFar: uniform(200), fogAmt: uniform(0.5),
  focus: uniform(new THREE.Vector3()), rimColor: uniform(new THREE.Color(1, 0.9, 0.8)),
  gridOrigin: uniform(new THREE.Vector2()), gridSize: uniform(new THREE.Vector2(1, 1)),
  deep: uniform(new THREE.Color(0x4a92de)), mid: uniform(new THREE.Color(0x6aaaea)), shallow: uniform(new THREE.Color(0x9ccdf3)), foam: uniform(new THREE.Color(0xeef8ff)),
  skyTop: uniform(new THREE.Color(0xf2955a)), skyBot: uniform(new THREE.Color(0xffe1b3)), shadowSoft: uniform(3),
  // Intro fog veil: everything farther than revealR from the focus is fully fogged.
  revealR: uniform(0.001),
};

const one = float(1);
const placeholder = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
placeholder.needsUpdate = true;
const distTex = texture(placeholder, positionWorld.xz.sub(U.gridOrigin).div(U.gridSize));
export function setDistTex(t) { distTex.value = t; }

/** Node material for world geometry. Flags pick which custom attributes it reads. */
export function stdMat({ vertexColors = true, color: hex = 0xffffff, roughness = 0.88, metalness = 0, emissive, emissiveIntensity = 1,
  wind = false, water = false, falls = false, grow = false, edges = false, emit = false, rim = true, transparent = false, opacity = 1, depthWrite = true, fog = true } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ color: hex, roughness, metalness, flatShading: true, transparent, opacity, depthWrite, fog });
  if (emissive !== undefined) { m.emissive = new THREE.Color(emissive); m.emissiveIntensity = emissiveIntensity; }

  let pos = positionLocal;
  if (wind) {
    const sw = attribute('aSway', 'float').mul(U.wind), p = positionLocal, t = U.time;
    pos = pos.add(vec3(
      sin(t.mul(1.7).add(p.x.mul(0.31)).add(p.z.mul(0.17))).mul(0.09).add(sin(t.mul(4.3).add(p.z.mul(0.9))).mul(0.025)).mul(sw),
      0,
      cos(t.mul(1.3).add(p.z.mul(0.27)).add(p.x.mul(0.11))).mul(0.07).mul(sw),
    ));
  }
  if (grow) {
    // aBorn: 0 = old. 1 = new terrain: the whole new slab rises as one block.
    // 2 + d (d in 0..0.74) = new decor: grows up out of the ground with a small overshoot, delayed by d.
    const b = attribute('aBorn', 'float');
    const isT = step(0.5, b).mul(step(b, 1.5)), isD = step(1.5, b);
    const kT = clamp(U.grow.div(0.35), 0, 1), eT = one.sub(pow(one.sub(kT), 3));
    const kD = clamp(U.grow.sub(b.sub(2).mul(0.7)).sub(0.3).div(0.18), 0, 1);
    const x1 = kD.sub(1), eD = one.add(x1.mul(x1).mul(x1).mul(2.70158)).add(x1.mul(x1).mul(1.70158));
    // New decor sits on new land, so it rides up with the terrain instead of floating where the ground will be.
    const lift = one.sub(eT).mul(14);
    const yT = pos.y.sub(lift.mul(isT));
    const yD = mix(float(-0.1), pos.y, eD).sub(lift);
    pos = vec3(pos.x, mix(yT, yD, isD), pos.z);
  }
  if (wind || grow) m.positionNode = pos;

  let base = vertexColors ? vertexColor() : color(hex);
  if (water) {
    const p = positionWorld.xz, t = U.time;
    const dist = distTex.r.mul(12);
    const n = mx_noise_float(vec3(p.mul(0.55).add(vec2(t.mul(0.25), t.mul(-0.18))), 0)).mul(0.5);
    const d2 = dist.add(n.mul(0.55));
    let c = mix(U.deep, U.mid, step(d2, 2.6));
    c = mix(c, U.shallow, step(d2, 1.35));
    c = mix(c, U.foam, step(d2, float(0.8).add(sin(t.mul(1.8).add(p.x.mul(1.7)).add(p.y.mul(1.1))).mul(0.1))));
    const r = mx_noise_float(vec3(p.x.mul(0.35).add(t.mul(0.15)), p.y.mul(2.2).sub(t.mul(0.05)), 3)).mul(0.5).add(0.5);
    c = mix(c, U.shallow, smoothstep(0.78, 0.82, r).mul(step(2.2, d2)).mul(0.55));
    base = c;
  }
  if (falls) {
    // Streaks scroll down the sheet and break into foam; the mist layer billows up where the sheet ends.
    const f = vertexColor().x, isMist = vertexColor().y, p = positionWorld, t = U.time, along = p.x.add(p.z);
    const streak = mx_noise_float(vec3(along.mul(2.5), p.y.mul(0.4).add(t.mul(1.8)), 5)).mul(0.5).add(0.5);
    const puff = mx_noise_float(vec3(along.mul(1.3), p.y.mul(1.4).sub(t.mul(0.7)), t.mul(0.25))).mul(0.5).add(0.5);
    const sheet = mix(mix(U.mid, U.shallow, streak), U.foam, max(smoothstep(0.35, 0.85, f), smoothstep(0.62, 0.8, streak)));
    base = mix(sheet, U.foam, isMist);
    m.opacityNode = mix(
      one.sub(smoothstep(0.65, 1.0, f.add(streak.sub(0.5).mul(0.4)))).mul(0.9),
      smoothstep(0, 0.35, f).mul(one.sub(smoothstep(0.55, 1, f))).mul(smoothstep(0.3, 0.75, puff)).mul(0.8),
      isMist,
    );
  }
  let em = vec3(0);
  if (emit) {
    // aEmit > 0: lit at night only (windows, lamps). aEmit < 0: always glowing, flickering (fire).
    const e = attribute('aEmit', 'float');
    const nightE = max(e, 0), always = max(e.negate(), 0);
    const warm = vec3(1.0, 0.6, 0.24);
    base = mix(base, warm.mul(0.25), U.night.mul(step(0.001, nightE)));
    const flick = sin(U.time.mul(13).add(positionWorld.x.mul(7))).mul(0.15).add(sin(U.time.mul(7.3).add(positionWorld.z.mul(5))).mul(0.1)).add(0.85);
    em = em.add(warm.mul(nightE).mul(U.night).mul(5)).add(vec3(1.0, 0.45, 0.12).mul(always).mul(flick).mul(4));
  }
  if (rim) {
    const fres = pow(one.sub(clamp(normalView.z, 0, 1)), 3);
    em = em.add(U.rimColor.mul(base).mul(fres).mul(U.rim).mul(0.22).mul(one.sub(U.night.mul(0.8))));
  }
  if (edges) {
    const f = attribute('aFace', 'vec4');
    const e2 = min(f.xy, f.zw.sub(f.xy)), ed = min(e2.x, e2.y);
    const aa = fwidth(ed).mul(1.2).add(1e-4);
    const mask = one.sub(smoothstep(float(0.045).sub(aa), float(0.045).add(aa), ed)).mul(one.sub(smoothstep(0.03, 0.08, aa))).mul(step(0.001, f.z));
    em = em.add(base.mul(mask).mul(U.rim).mul(0.3).mul(one.sub(U.night.mul(0.7))));
  }
  m.colorNode = base;
  if (emit || rim || edges) m.emissiveNode = em;
  return m;
}

export function plainMat(hex, opts = {}) {
  return new THREE.MeshStandardNodeMaterial({ color: hex, roughness: opts.roughness ?? 0.8, flatShading: true, ...opts });
}

export function holoMat(hex, boost = 2.5) {
  return new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(hex).multiplyScalar(boost), transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
}

/** Cloth that waves along +x (geometry should start at x = 0). */
export function flagMat(hex) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: hex, roughness: 0.85, flatShading: true, side: THREE.DoubleSide });
  const p = positionLocal, k = p.x.div(0.85), ph = U.time.mul(6).sub(p.x.mul(7));
  const amp = U.wind.mul(0.6).add(0.4);
  mat.positionNode = p.add(vec3(0, sin(ph.mul(0.7)).mul(0.03).mul(k), sin(ph).mul(0.1).mul(k).mul(amp)));
  mat.emissiveNode = color(hex).mul(0.12);
  return mat;
}

/** Sky gradient behind the world; the intro veil fogs toward it so veiled land is invisible. */
export const skyNode = mix(U.skyTop, U.skyBot, pow(smoothstep(0.0, 1.0, screenUV.y), 0.8));

/** Fog: aerial falloff from the camera focus plus a low height mist. */
export function fogFactor() {
  const fd = distance(positionWorld.xz, U.focus.xz);
  const f = smoothstep(U.fogNear, U.fogFar, fd).mul(U.fogAmt);
  const mh = exp(max(positionWorld.y.add(0.3), 0).div(-1.25));
  const mn = sin(positionWorld.x.mul(0.13).add(U.time.mul(0.2))).mul(sin(positionWorld.z.mul(0.11).sub(U.time.mul(0.15)))).mul(0.35).add(0.65);
  const m = clamp(mh.mul(U.mist).mul(mn), 0, 1);
  const veil = smoothstep(U.revealR.mul(0.45), U.revealR, fd);
  const base = clamp(one.sub(one.sub(f).mul(one.sub(m.mul(0.88)))), 0, 1);
  const tint = mix(U.fogColor, U.mistColor, m.div(max(f.add(m), 1e-3)));
  return { factor: max(base, veil), color: mix(tint, skyNode, min(veil.div(max(base, veil).add(1e-3)), 1)) };
}

/** 12-tap rotated Vogel-disk PCF; radius in texels comes from U.shadowSoft. */
export const softShadowFilter = Fn(({ depthTexture, shadowCoord }) => {
  const phi = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))))).mul(6.2831853);
  const texel = float(1).div(2048);
  let sum = float(0);
  for (let i = 0; i < 12; i++) {
    const r = Math.sqrt((i + 0.5) / 12), a = i * 2.39996323;
    const off = vec2(cos(phi.add(a)), sin(phi.add(a))).mul(r).mul(U.shadowSoft).mul(texel);
    sum = sum.add(texture(depthTexture, shadowCoord.xy.add(off)).compare(shadowCoord.z));
  }
  return sum.div(12);
});
