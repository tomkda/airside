// Low-poly models for the 3D view (v0.9): aircraft by class, trees, the control tower, lamp posts, and the
// canvas textures (glow, runway numbers). Stylised like a presentation model, not photoreal.
// Aircraft are built in metres with the nose along +x, span along z and up along +y.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CLASSES } from './config';

/** A flat swept surface (wing, tailplane) as a thin slab: root chord at x0..x1, tip at span s, swept back by sw. */
function surface(rootX0: number, rootX1: number, span: number, sweep: number, tipChord: number, thick: number, y: number, side: 1 | -1) {
  const s = new THREE.Shape();
  s.moveTo(rootX1, 0); s.lineTo(rootX1 - sweep, span); s.lineTo(rootX1 - sweep - tipChord, span); s.lineTo(rootX0, 0); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
  g.rotateX(Math.PI / 2);          // shape XY -> XZ, extruded downward
  g.translate(0, y + thick / 2, 0);
  if (side < 0) g.scale(1, 1, -1);
  return g;
}
const nonIndexed = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
const merge = (gs: THREE.BufferGeometry[]) => mergeGeometries(gs.map(g => { const n = nonIndexed(g); n.deleteAttribute('uv'); return n; }))!;

export interface PlaneGeo { body: THREE.BufferGeometry; fin: THREE.BufferGeometry; engines: THREE.BufferGeometry; doorX: number; radius: number; doorY: number }

/** One aircraft class: white body and wings, a fin to colour by airline, grey engines. */
export function aircraftGeo(cls: number): PlaneGeo {
  const C = CLASSES[cls]; const L = C.length, S = C.span;
  const r = cls === 3 ? 3.6 : cls === 2 ? 2.0 : cls === 1 ? 1.5 : 1.35;
  const tall = cls === 3 ? 1.3 : 1;                      // the A380's double deck
  const yc = r * tall + (cls === 0 ? 1.4 : 1.9);           // fuselage centre above the ground
  const fusL = L * 0.74;
  const body: THREE.BufferGeometry[] = [];
  const fus = new THREE.CylinderGeometry(r, r, fusL, 14, 1); fus.rotateZ(Math.PI / 2); fus.scale(1, tall, 1); fus.translate(L * 0.02, yc, 0); body.push(fus);
  const nose = new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2); nose.rotateZ(-Math.PI / 2); nose.scale(L * 0.11 / r, tall, 1); nose.translate(L * 0.02 + fusL / 2, yc, 0); body.push(nose);
  const tail = new THREE.ConeGeometry(r, L * 0.2, 14, 1); tail.rotateZ(Math.PI / 2); tail.scale(1, tall, 1); tail.translate(L * 0.02 - fusL / 2 - L * 0.1, yc + r * 0.35, 0); body.push(tail);
  // wings: high and straight on the turboprop, low and swept on the jets
  const wy = cls === 0 ? yc + r * 0.9 : yc - r * 0.55;
  const rootC = cls === 0 ? L * 0.11 : L * 0.2, sweep = cls === 0 ? L * 0.02 : S * 0.24, tipC = cls === 0 ? L * 0.08 : L * 0.06;
  const wx1 = cls === 0 ? L * 0.08 : L * 0.12;
  for (const side of [1, -1] as const) body.push(surface(wx1 - rootC, wx1, S / 2, sweep, tipC, cls === 3 ? 0.9 : 0.5, wy, side));
  const hs = cls === 3 ? L * 0.15 : L * 0.17; const hx = L * 0.02 - fusL / 2 - L * 0.08;
  for (const side of [1, -1] as const) body.push(surface(hx - L * 0.07, hx, hs, L * 0.06, L * 0.035, 0.35, yc + r * 0.4, side));
  const fin = new THREE.Shape(); const fx = L * 0.02 - fusL / 2 - L * 0.02, fh = cls === 3 ? 14 : L * 0.22;
  fin.moveTo(fx, 0); fin.lineTo(fx - L * 0.2, fh); fin.lineTo(fx - L * 0.28, fh); fin.lineTo(fx - L * 0.22, 0); fin.closePath();
  const finG = new THREE.ExtrudeGeometry(fin, { depth: 0.5, bevelEnabled: false }); finG.translate(0, yc + r * tall * 0.8, -0.25);
  // engines: two (four on the A380) under the wing, or two nacelles with propeller discs on the turboprop
  const eng: THREE.BufferGeometry[] = [];
  const nE = cls === 3 ? [0.35, 0.68] : [0.36];
  for (const k of nE) for (const side of [1, -1]) {
    const z = side * S / 2 * k; const er = cls === 0 ? 0.75 : cls === 3 ? 1.6 : 1.05;
    const x = wx1 - (sweep * k) + (cls === 0 ? L * 0.04 : L * 0.03);
    const e = new THREE.CylinderGeometry(er, er * 0.85, cls === 0 ? L * 0.16 : L * 0.12, 10); e.rotateZ(Math.PI / 2);
    e.translate(x, cls === 0 ? wy - er * 0.2 : wy - er - 0.3, z); eng.push(e);
    if (cls === 0) { const p = new THREE.CylinderGeometry(1.9, 1.9, 0.1, 16); p.rotateZ(Math.PI / 2); p.translate(x + L * 0.09, wy - er * 0.2, z); eng.push(p); }
  }
  return { body: merge(body), fin: merge([finG]), engines: merge(eng), doorX: L * 0.02 + fusL / 2 - L * 0.06, radius: r, doorY: yc };
}

/** A presentation-model tree: a soft sphere crown on a thin trunk, unit size (scale by height). */
export function treeGeo() {
  const crown = new THREE.DodecahedronGeometry(0.42, 0); crown.translate(0, 0.62, 0);   // 36 faces: faceted, like a model tree
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.3, 5); trunk.translate(0, 0.15, 0);
  return { crown, trunk };
}

/** Control tower: a tapered shaft, a glazed octagonal cab and a flat roof. Base at the origin. */
export function towerGeo() {
  const shaft = new THREE.CylinderGeometry(3.2, 4.6, 46, 8); shaft.translate(0, 23, 0);
  const deck = new THREE.CylinderGeometry(7.5, 5.5, 3, 8); deck.translate(0, 47.5, 0);
  const roof = new THREE.CylinderGeometry(8.2, 7.8, 1.2, 8); roof.translate(0, 55.6, 0);
  const mast = new THREE.CylinderGeometry(0.25, 0.25, 7, 4); mast.translate(0, 59.7, 0);
  const cab = new THREE.CylinderGeometry(7.6, 7, 6.4, 8, 1, true); cab.translate(0, 52.2, 0);
  return { solid: merge([shaft, deck, roof, mast]), glass: cab };
}

/** Lamp post / floodlight mast: a pole of unit height with a small head, scale y for height. */
export function poleGeo() {
  const p = new THREE.CylinderGeometry(0.12, 0.16, 1, 5); p.translate(0, 0.5, 0);
  return p;
}

/** Soft round glow for lights (additive sprites and points). */
export function glowTexture(color = '#FFE2A8') {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d')!; const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.18, color); gr.addColorStop(0.5, 'rgba(255,200,120,0.25)'); gr.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Painted text (runway designators), white on transparent. */
export function textTexture(text: string, w = 256, h = 256, px = 180) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d')!;
  g.font = `800 ${px}px Archivo, "Helvetica Neue", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#F2EEE4'; g.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** A vertical sky gradient for the background. */
export function skyTexture(top: string, horizon: string) {
  const cv = document.createElement('canvas'); cv.width = 4; cv.height = 256;
  const g = cv.getContext('2d')!; const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, top); gr.addColorStop(0.75, horizon); gr.addColorStop(1, horizon);
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
