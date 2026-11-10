// 3D view: the same sim, seen in perspective with an orbiting camera. Reads sim state, never writes it.
// World plan coordinates (x, y) map to three.js (x, up, y); heights are real metres (LEVELS z0 / z1).
//
// v0.9 detail pass. The look is a presentation model: warm white roofs, glazed facades with mullions, painted
// runway and apron markings, model trees, a control tower, jet bridges that dock, turnaround vehicles, parked cars,
// curb canopies, and a night that lights up (glazing, runway and taxiway lights, apron floodlights, street lamps).
//
// The static scene is rebuilt only when the layout, the level of detail or the selection changes; aircraft,
// bridges, vehicles, cars and people are instanced and move every frame. New buildings rise into place.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Pt, Rect, dist, sub, norm, add, mul, lerpPt, polyLen, sliceLine, offsetLine } from './geom';
import { PAL, SITE, ZONES, LEVELS, ZoneType, FRONTAGE, CLASSES, GROWTH, TUNE } from './config';
import type { Sim, Flight } from './sim';
import type { Renderer } from './render';
import { wayWidth, runwayWidth, siteOf, Zone, Site } from './world';
import { scenery } from './scenery';
import { roadPlan } from './roads';
import { carPoses, CAR_COLS } from './traffic';
import { aircraftGeo, treeGeo, towerGeo, poleGeo, glowTexture, textTexture, skyTexture, PlaneGeo } from './models3d';

const UP = 0.05;   // lift flat things a little off the ground so they don't flicker
const ROOF = '#F1ECE2', PLINTH = '#8C8576', MULLION = '#E4DDCF';
const GLASS: Record<ZoneType, string> = {
  checkin: '#B6C3C4', security: '#AEB9BA', concourse: '#BBC8C9', claim: '#B1BDBE', curb: '#A49E92', parking: '#C9BEA8',
  passport: '#B3BFC6', rideshare: '#A7A39A', rental: '#B9C2BE', bus: '#B9C2BE', hotel: '#AFC0CC', train: '#BFCBCB',
};
const MOD_COL: Record<ZoneType, string> = {
  checkin: '#CDBFA6', security: '#BDB29E', concourse: '#D4CBB8', claim: '#C3B9A6', curb: '#A49E92', parking: '#C9BEA8',
  passport: '#C6BCA8', rideshare: '#A7A39A', rental: '#C9BEA8', bus: '#C9BEA8', hotel: '#D4CBB8', train: '#D4CBB8',
};
const LOT_COL: Record<string, string> = { shop: '#6E6252', food: '#B07A3E', lounge: '#4D7390' };
const ITEM_H: Record<string, number> = { counter: 1.1, xray: 1.6, body: 2.2, divest: 0.9, recompose: 0.9, kiosk: 1.4, wc: 3, office: 3, table: 0.75, belt: 0.5, carousel: 0.6 };
const YELLOW = '#D6A43C', WHITE = '#F0ECE2';
const RISE_MS = 1400;

export class Renderer3D {
  canvas: HTMLCanvasElement;
  gl: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private stat = new THREE.Group();
  private ghostG = new THREE.Group();
  private riseG = new THREE.Group();
  private key = '';
  private dRef: unknown = null; private dGen = 0;
  private sun: THREE.DirectionalLight; private hemi: THREE.HemisphereLight;
  private skyDay: THREE.Texture; private skyNight: THREE.Texture;
  // shared materials whose look follows the time of day
  private glassMat = new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#F4C46A', emissiveIntensity: 0 });
  private cityMat = new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#E8B868', emissiveIntensity: 0 });
  private lightMats: THREE.PointsMaterial[] = [];      // moving lights (headlights, beacons): live for the session
  private statLights: THREE.PointsMaterial[] = [];     // fixed lights: rebuilt with the static scene
  private poolMat: THREE.MeshBasicMaterial;
  // moving things
  private planeGeos: PlaneGeo[];
  private planes: { body: THREE.InstancedMesh; fin: THREE.InstancedMesh; eng: THREE.InstancedMesh }[];
  private bridges: THREE.InstancedMesh; private drums: THREE.InstancedMesh;
  private gse: THREE.InstancedMesh;
  private cars: THREE.InstancedMesh; private cabs: THREE.InstancedMesh;
  private parked: THREE.InstancedMesh; private parkedKey = '';
  private people: THREE.InstancedMesh;
  private heads: THREE.Points; private headPos = new Float32Array(3000 * 3);
  private beacons: THREE.Points; private beaconPos = new Float32Array(400 * 3);
  // construction: zones appear by rising out of the ground
  private born = new Map<number, number>(); private known: Set<number> | null = null;
  private tmp = new THREE.Object3D();
  private ray = new THREE.Raycaster();
  private col = new THREE.Color();

  constructor(private ren: Renderer) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view3d';
    ren.canvas.parentElement!.insertBefore(this.canvas, ren.canvas);
    this.gl = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.gl.shadowMap.enabled = true; this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(38, 1, 2, 60000);
    // the 2D canvas stays on top and transparent, so the UI keeps one set of pointer handlers
    this.controls = new OrbitControls(this.camera, ren.canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.48; this.controls.minDistance = 25; this.controls.maxDistance = 16000;
    this.controls.screenSpacePanning = false;

    this.skyDay = skyTexture('#CFDCE0', '#EFE6D3'); this.skyNight = skyTexture('#11152A', '#3A3B52');
    this.scene.background = this.skyDay;
    this.scene.fog = new THREE.Fog('#EFE6D3', 7000, 24000);
    this.hemi = new THREE.HemisphereLight('#F4EEE2', '#8C8270', 0.85);
    this.sun = new THREE.DirectionalLight('#FFEBCB', 1.9);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.4;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.stat, this.ghostG, this.riseG);
    this.poolMat = new THREE.MeshBasicMaterial({ map: glowTexture('#FFD58A'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });

    const lam = (c: string, side: THREE.Side = THREE.FrontSide) => new THREE.MeshLambertMaterial({ color: c, side });
    const inst = (g: THREE.BufferGeometry, m: THREE.Material, n: number, colors = false) => {
      const x = new THREE.InstancedMesh(g, m, n); x.castShadow = true; x.receiveShadow = true; x.count = 0; x.frustumCulled = false;
      if (colors) x.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      this.scene.add(x); return x;
    };
    this.planeGeos = CLASSES.map(c => aircraftGeo(c.cls));
    this.planes = this.planeGeos.map(pg => ({
      body: inst(pg.body, lam('#F5F2EB', THREE.DoubleSide), 160),
      fin: inst(pg.fin, lam('#ffffff', THREE.DoubleSide), 160, true),
      eng: inst(pg.engines, lam('#9A9C9E', THREE.DoubleSide), 160),
    }));
    this.bridges = inst(new THREE.BoxGeometry(1, 1, 1), lam('#DCD5C6'), 400);
    this.drums = inst(new THREE.CylinderGeometry(1, 1, 1, 10), lam('#BDB4A3'), 800);
    this.gse = inst(new THREE.BoxGeometry(1, 1, 1), lam('#ffffff'), 2400, true);
    this.cars = inst(new THREE.BoxGeometry(4.5, 0.9, 1.85), lam('#ffffff'), 3000, true);
    this.cabs = inst(new THREE.BoxGeometry(2.4, 0.6, 1.6), lam('#2C2A27'), 3000);
    this.parked = inst(new THREE.BoxGeometry(4.4, 1.4, 1.8), lam('#ffffff'), 8000, true);
    const person = new THREE.CylinderGeometry(0.26, 0.3, 1.25, 6); person.translate(0, 0.62, 0);
    const head = new THREE.SphereGeometry(0.2, 6, 4); head.translate(0, 1.5, 0);
    this.people = inst(mergeTwo(person, head), lam('#ffffff'), 8000, true);
    this.heads = this.points(this.headPos, '#FFF2C8', 2.2); this.heads.geometry.setDrawRange(0, 0);
    this.beacons = this.points(this.beaconPos, '#FF5A3C', 3); this.beacons.geometry.setDrawRange(0, 0);
    this.resize();
  }

  private points(pos: Float32Array, color: string, size: number) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color, size, map: glowTexture(color), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
    this.lightMats.push(m);
    const p = new THREE.Points(g, m); p.frustumCulled = false; this.scene.add(p); return p;
  }

  resize() {
    const r = this.ren.canvas.getBoundingClientRect();
    this.gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.gl.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height); this.camera.updateProjectionMatrix();
  }

  /** Enter 3D looking at what the plan view was showing, from the south-west at about 50°. */
  enterFrom(cx: number, cy: number, zoom: number) {
    const span = this.ren.H / Math.max(0.05, zoom);
    const d = span / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * 0.9;
    this.controls.target.set(cx, 0, cy);
    this.camera.position.set(cx - d * 0.35, d * 0.75, cy + d * 0.6);
    this.controls.update();
  }
  /** Back to plan: the 2D camera centres where the orbit target is, at a matching scale. */
  planCamera() {
    const t = this.controls.target; const d = this.camera.position.distanceTo(t);
    const zoom = this.ren.H / (2 * d * Math.tan((this.camera.fov * Math.PI) / 360)) * 0.9;
    return { x: t.x, y: t.z, zoom: Math.min(8, Math.max(0.06, zoom)) };
  }
  frame(st: Rect) {
    const c = { x: st.x + st.w / 2, y: st.y + st.h / 2 };
    const d = Math.max(st.w, st.h) * 1.3 + 150;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.set(c.x, 0, c.y);
    this.camera.position.set(c.x + dir.x * d, Math.max(80, dir.y * d), c.y + dir.z * d);
    this.controls.update();
  }

  /** Screen point to a point on the horizontal plane at height z (metres). */
  toWorld(sx: number, sy: number, z = 0): Pt {
    const r = this.ren.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((sx / r.width) * 2 - 1, -(sy / r.height) * 2 + 1), this.camera);
    const hit = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -z), hit)) return { x: hit.x, y: hit.z };
    return { x: this.controls.target.x, y: this.controls.target.z };
  }
  project(x: number, y: number, z = 0): [number, number] {
    const v = new THREE.Vector3(x, z, y).project(this.camera);
    return [(v.x + 1) / 2 * this.ren.W, (1 - v.y) / 2 * this.ren.H];
  }

  // ------------------------------------------------------------ frame
  draw(sim: Sim, night: number) {
    this.controls.update();
    const now = performance.now();
    if (sim.d !== this.dRef) { this.dRef = sim.d; this.dGen++; this.noteBirths(sim, now); }
    const rising = [...this.born.entries()].filter(([, t]) => now - t < RISE_MS).map(([id]) => id);
    const key = [this.dGen, this.ren.lod, this.ren.focus, this.ren.level, JSON.stringify(this.ren.selected), this.ren.commerce, sim.world.sites?.length, rising.join(',')].join('|');
    if (key !== this.key) { this.key = key; this.buildStatic(sim, new Set(rising)); }
    this.drawRising(sim, rising, now);
    this.drawMoving(sim, night, now);
    this.drawParked(sim);
    this.drawGhost();
    // daylight: the sun follows the view so shadows stay crisp where you look
    const t = this.controls.target; const span = Math.min(2500, Math.max(250, this.camera.position.distanceTo(t)));
    this.sun.position.set(t.x - span * 0.6, span * 1.1, t.z + span * 0.45); this.sun.target.position.copy(t);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 1; sc.far = span * 4; sc.updateProjectionMatrix();
    this.sun.intensity = 1.9 * (1 - 0.85 * night); this.hemi.intensity = 0.85 * (1 - 0.55 * night);
    this.hemi.color.set(night > 0.5 ? '#8E97C2' : '#F7F2E8');
    this.scene.background = night > 0.5 ? this.skyNight : this.skyDay;
    (this.scene.fog as THREE.Fog).color.set('#EFE6D3').lerp(this.col.set('#3A3B52'), night);
    { const w = this.ren.weather; const fog = this.scene.fog as THREE.Fog; fog.near = w === 'fog' ? 120 : w === 'clear' ? 7000 : 1500; fog.far = w === 'fog' ? 1700 : w === 'clear' ? 24000 : 9000; if (w !== 'clear') fog.color.lerp(this.col.set(night > 0.5 ? '#4A4C5E' : '#D9D8D2'), 0.7); }
    this.glassMat.emissiveIntensity = 0.05 + 0.85 * night; this.cityMat.emissiveIntensity = 0.55 * night;
    for (const m of [...this.lightMats, ...this.statLights]) m.opacity = Math.min(1, night * 1.4);
    this.poolMat.opacity = 0.55 * night;
    this.gl.render(this.scene, this.camera);
  }

  /** Remember when each zone first appeared, so it can rise into place. Nothing rises on first load. */
  private noteBirths(sim: Sim, now: number) {
    const ids = new Set(sim.d.zones.filter(z => ZONES[z.type].terminal).map(z => z.id));
    if (this.known) for (const id of ids) if (!this.known.has(id)) this.born.set(id, now);
    for (const id of [...this.born.keys()]) if (!ids.has(id)) this.born.delete(id);
    this.known = ids;
  }

  // ------------------------------------------------------------ static scene
  private buildStatic(sim: Sim, rising: Set<number>) {
    for (const o of [...this.stat.children]) { this.stat.remove(o); dispose(o, [this.glassMat, this.cityMat, this.poolMat, ...this.lightMats]); }
    this.statLights = [];
    const d = sim.d; const lod = this.ren.lod; const focus = this.ren.focus;
    const add3 = (m: THREE.Object3D) => { this.stat.add(m); return m; };
    const sc = scenery(sim.world, d);

    // ---- ground: the open country, the airport's graded land, runway strips, the lake, the city
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(SITE.width * 3, SITE.height * 3), new THREE.MeshLambertMaterial({ color: '#D9CDAE' }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(SITE.width / 2, 0, SITE.height / 2); ground.receiveShadow = true; add3(ground);
    add3(flatRect(SITE.buildable, 0.01, '#D6CBAD'));
    add3(flatShape(SITE.lake, 0.03, '#C9CDC4'));
    add3(lineLoop(SITE.lake, 0.06, '#AFB2A6'));
    const blocks: Box[] = [];
    for (let x = SITE.cityX; x < SITE.width; x += 150) for (let y = 300; y < SITE.height - 200; y += 150) {
      const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; const r = h - Math.floor(h);
      if (r < 0.18) continue;
      const w = 114 * (0.7 + 0.3 * r), H = 8 + r * r * 60;
      blocks.push({ x: x + 18, y: y + 18, w, h: 114, z0: 0, z1: H, c: r > 0.7 ? '#D2C6AC' : '#DDD2BA' });
    }
    add3(instancedBoxes(blocks, true, this.cityMat));
    const strips: Strip[] = [];
    for (const r of d.runways) strips.push({ a: r.rw.a, b: r.rw.b, w: r.width + 300, z: 0.02, c: '#E7DEC6' });   // graded strip

    // ---- pavements
    for (const r of d.runways) strips.push({ a: sub(r.rw.a, mul(r.dir, 60)), b: add(r.rw.b, mul(r.dir, 60)), w: r.width + 8, z: 0.13, c: '#B7AC95' }, { a: r.rw.a, b: r.rw.b, w: r.width, z: 0.15, c: '#3A3631' });
    for (const w of [...sim.world.ways, ...d.autoWalks]) if (w.kind !== 'road') strips.push({ a: w.a, b: w.b, w: wayWidth(w.kind, w.cls, w.lanes), z: w.kind === 'taxi' ? 0.1 : 0.14, c: w.kind === 'taxi' ? '#BDB29C' : '#EFE8DA' });
    for (const x of d.airExtra) strips.push({ a: x.a, b: x.b, w: wayWidth('taxi', x.cls, 0), z: 0.1, c: '#BDB29C' });
    // roads (roads.ts): each one a smooth path, with junction curves and highway slip ramps so every corner has a curved kerb
    const RP = roadPlan(d);
    const chords = (pts: Pt[], f: (a: Pt, b: Pt) => void, ext = 0) => { for (let i = 1; i < pts.length; i++) { const dv = norm(sub(pts[i], pts[i - 1])); f(sub(pts[i - 1], mul(dv, ext)), add(pts[i], mul(dv, ext))); } };
    for (const s of RP.paths) if (!s.ramp) chords(s.pts, (a, b) => strips.push({ a, b, w: s.w, z: 0.12, c: '#8E8A83' }), s.pts.length > 2 ? 0.5 : 0);
    const bez = (k: { p1: Pt; c: Pt; p2: Pt }, t: number): Pt => ({ x: (1 - t) * (1 - t) * k.p1.x + 2 * (1 - t) * t * k.c.x + t * t * k.p2.x, y: (1 - t) * (1 - t) * k.p1.y + 2 * (1 - t) * t * k.c.y + t * t * k.p2.y });
    for (const k of [...RP.turns, ...RP.ramps]) for (let i = 0; i < 8; i++) strips.push({ a: bez(k, i / 8 - 0.02), b: bez(k, (i + 1) / 8 + 0.02), w: k.w, z: 0.121, c: '#8E8A83' });
    // roundabouts: the ring, a paved truck apron and a planted island
    for (const r of RP.rounds) {
      const disc = (rad: number, h: number, c: string) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, h, 48), new THREE.MeshLambertMaterial({ color: c })); m.position.set(r.c.x, h / 2, r.c.y); m.receiveShadow = true; add3(m); };
      const inner = r.r - r.w / 2;
      disc(r.r + r.w / 2, 0.122, '#8E8A83'); disc(inner, 0.22, '#C9BFAC'); disc(inner - 2.2, 0.5, '#8A8375'); disc(inner - 2.6, 0.62, '#A9B28A');
    }
    add3(stripMesh(strips));
    const flats: Box[] = [];
    for (const ap of d.aprons) flats.push({ ...ap.rect, z0: 0, z1: 0.09, c: '#CDC4B0' });
    for (const z of d.zones) if (z.type === 'parking') flats.push({ ...z, z0: 0, z1: 0.11, c: '#A7A39A' });
    for (const z of d.zones) if (z.type === 'curb' && z.level === 0) flats.push({ ...z, z0: 0, z1: 0.16, c: '#8E8A83' });
    add3(instancedBoxes(flats, false));

    // ---- markings: runways, taxiways, stands, roads, crosswalks, parking bays
    const mk: Strip[] = [];
    const m = (a: Pt, b: Pt, w: number, c: string, z = 0.2) => mk.push({ a, b, w, z, c });
    const dashed = (a: Pt, b: Pt, w: number, c: string, dash: number, gap: number, z = 0.2) => {
      const L = dist(a, b); const dv = norm(sub(b, a));
      for (let s = gap / 2; s < L - dash / 2; s += dash + gap) m(add(a, mul(dv, s)), add(a, mul(dv, Math.min(L, s + dash))), w, c, z);
    };
    for (const r of d.runways) {
      const W = r.width; const n = r.normal, dv = r.dir;
      for (const s of [-1, 1]) m(add(r.rw.a, mul(n, s * (W / 2 - 1.2))), add(r.rw.b, mul(n, s * (W / 2 - 1.2))), 0.9, WHITE);
      dashed(add(r.rw.a, mul(dv, 90)), sub(r.rw.b, mul(dv, 90)), 0.9, WHITE, 30, 20);
      for (const [end, sgn] of [[r.rw.a, 1], [r.rw.b, -1]] as const) {
        const at = (s: number, l: number) => add(add(end, mul(dv, sgn * s)), mul(n, l));
        const bars = W >= 45 ? 12 : 8; const span = W - 6;
        for (let i = 0; i < bars; i++) { const l = -span / 2 + (i + 0.5) * span / bars; if (Math.abs(l) < 2.5) continue; m(at(6, l), at(36, l), 1.8, WHITE); }
        for (const l of [-1, 1]) { m(at(300, l * W * 0.22), at(345, l * W * 0.22), 9, WHITE); }
        for (const s0 of [150, 450, 600]) for (const l of [-1, 1]) for (const k of [0, 1, 2]) { const off = l * (W * 0.2 + k * 2.6); m(at(s0, off), at(s0 + 22, off), 1.6, WHITE); }
      }
      // designators, read as you land: labels[0] at end a, facing along the runway
      for (const [end, sgn, txt] of [[r.rw.a, 1, r.labels[0]], [r.rw.b, -1, r.labels[1]]] as const) {
        const p = add(end, mul(dv, sgn * 62));
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(W * 0.55, 22), 30), new THREE.MeshBasicMaterial({ map: textTexture(txt, 256, 360, 300), transparent: true, depthWrite: false }));
        plane.rotation.order = 'YXZ'; plane.rotation.y = -Math.atan2(dv.y * sgn, dv.x * sgn) - Math.PI / 2; plane.rotation.x = -Math.PI / 2;
        plane.position.set(p.x, 0.25, p.y); add3(plane);
      }
    }
    const taxiLines = (a: Pt, b: Pt, w: number) => { m(a, b, 0.35, YELLOW); const n = perp(a, b); for (const s of [-1, 1]) m(add(a, mul(n, s * (w / 2 - 0.7))), add(b, mul(n, s * (w / 2 - 0.7))), 0.25, YELLOW); };
    for (const w of sim.world.ways) if (w.kind === 'taxi') taxiLines(w.a, w.b, wayWidth('taxi', w.cls, 0));
    for (const x of d.airExtra) m(x.a, x.b, 0.35, YELLOW);
    for (const g of d.gates) {
      const L = CLASSES[g.cls].length; const dv = norm(sub(g.door, g.stand)); const nose = add(g.stand, mul(dv, L / 2));
      m(g.front, add(nose, mul(dv, 2)), 0.35, YELLOW);
      const n = { x: -dv.y, y: dv.x }; m(add(nose, mul(n, -3)), add(nose, mul(n, 3)), 0.6, YELLOW);
      const half = CLASSES[g.cls].gateSpacing / 2 - 1; // stand boundary ticks
      for (const s of [-1, 1]) dashed(add(g.door, mul(n, s * half)), add(add(g.door, mul(n, s * half)), mul(dv, -CLASSES[g.cls].apronDepth * 0.8)), 0.3, '#EDE7D9', 3, 3, 0.18);
    }
    const dashedPath = (pts: Pt[], w: number, c: string, dash: number, gap: number, z = 0.2) => {
      const L = polyLen(pts); for (let u = gap / 2; u < L - dash / 2; u += dash + gap) chords(sliceLine(pts, u, Math.min(L, u + dash)), (a, b) => m(a, b, w, c, z));
    };
    for (const s of RP.paths) {
      if (s.ramp || s.len - s.trimA - s.trimB < 2) continue;
      const mid = sliceLine(s.pts, s.trimA, s.len - s.trimB);
      const solid = (k: number, w: number, c: string) => chords(offsetLine(mid, k), (a, b) => m(a, b, w, c, 0.17), 0.05);
      solid(s.w / 2 - 0.6, 0.2, WHITE); solid(-(s.w / 2 - 0.6), 0.2, s.ow ? YELLOW : WHITE);
      if (s.hwy) { solid(0, 1.1, '#7F7A70'); for (const k of [-8, -4.4, 4.4, 8]) dashedPath(offsetLine(s.pts, k), 0.18, WHITE, 3, 6, 0.17); }
      else if (s.ow) for (const k of s.lanes >= 4 ? [-s.w / 4, 0, s.w / 4] : [0]) dashedPath(offsetLine(mid, k), 0.18, WHITE, 3, 6, 0.17);
      else if (s.lanes >= 4) { solid(-0.25, 0.18, YELLOW); solid(0.25, 0.18, YELLOW); for (const k of [-1, 1]) dashedPath(offsetLine(mid, k * s.w / 4), 0.18, WHITE, 3, 6, 0.17); }
      else dashedPath(mid, 0.18, YELLOW, 3, 6, 0.17);
    }
    for (const ar of RP.arrows) { const dv = { x: Math.cos(ar.ang), y: Math.sin(ar.ang) }; m(sub(ar.p, mul(dv, 2.4)), add(ar.p, mul(dv, 0.6)), 0.3, WHITE, 0.18); m(add(ar.p, mul(dv, 0.6)), add(ar.p, mul(dv, 2.4)), 1.1, WHITE, 0.18); }
    for (const y of RP.yields) { const L = dist(y.a, y.b); const dv = norm(sub(y.b, y.a)); for (let u = 0; u < L - 0.4; u += 1.6) m(add(y.a, mul(dv, u)), add(y.a, mul(dv, Math.min(L, u + 0.8))), 0.5, WHITE, 0.19); }
    for (const il of RP.islands) { const base = lerpPt(il[2], il[3], 0.5); mk.push({ a: il[0], b: base, w: dist(il[2], il[3]) * 0.8, z: 0.32, c: '#C9BFAC' }); }
    for (const r of RP.rounds) {
      const circ = (rad: number, w: number, c: string, dash = 0) => { const n = Math.max(24, Math.round(rad * 1.6)); for (let i = 0; i < n; i++) { if (dash && i % 2) continue; const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2; m({ x: r.c.x + Math.cos(a0) * rad, y: r.c.y + Math.sin(a0) * rad }, { x: r.c.x + Math.cos(a1) * rad, y: r.c.y + Math.sin(a1) * rad }, w, c, 0.24); } };
      circ(r.r - r.w / 2 + 0.45, 0.2, YELLOW); if (r.lanes > 1) circ(r.r, 0.18, WHITE, 1);
    }
    for (const c of d.crosswalks) {
      const road = { x: Math.cos(c.ang), y: Math.sin(c.ang) }, walk = { x: -road.y, y: road.x };
      for (let s = -c.width / 2 + 0.9; s <= c.width / 2 - 0.6; s += 1.4) { const p = add(c.p, mul(walk, s)); m(add(p, mul(road, -2)), add(p, mul(road, 2)), 0.7, WHITE, 0.19); }
    }
    for (const z of d.zones) if (z.type === 'parking') {
      for (let y = z.y + 8; y < z.y + z.h - 4; y += 14) {
        for (let x = z.x + 6; x < z.x + z.w - 6; x += 2.7) { m({ x, y: y - 5 }, { x, y }, 0.12, '#E8E2D4', 0.16); m({ x, y: y + 6 }, { x, y: y + 11 }, 0.12, '#E8E2D4', 0.16); }
      }
    }
    for (const st of RP.stops) m(st.a, st.b, 0.5, WHITE, 0.19);
    for (const md of RP.medians) chords(md, (a, b) => mk.push({ a, b, w: 1.9, z: 0.3, c: '#8A8375' }, { a, b, w: 1.4, z: 0.34, c: '#A9B28A' }), 0.3);
    add3(stripMesh(mk));

    // ---- upper decks: slab on columns with ramps; curb canopies over the sidewalk at each curb
    const misc: Box[] = [];
    for (const dk of d.decks) {
      // v0.13: the slab follows the deck's own path, climbing along each ramp from the road it splits from
      const z1 = LEVELS[1].z0;
      add3(slabPath(dk.pts, dk.zs.map(k => 0.2 + (z1 - 0.2) * k), dk.ws.map(w => Math.max(11, w) + 2), 0.8, '#B9B2A4'));
      const cum = [0]; for (let i = 1; i < dk.pts.length; i++) cum.push(cum[i - 1] + dist(dk.pts[i - 1], dk.pts[i]));
      for (let u = 0; u <= cum[cum.length - 1]; u += 30) {
        let k = 0; while (k < cum.length - 2 && cum[k + 1] < u) k++;
        const t = (u - cum[k]) / (cum[k + 1] - cum[k] || 1); const zk = dk.zs[k] + (dk.zs[k + 1] - dk.zs[k]) * t; if (zk < 0.35) continue;
        const p = lerpPt(dk.pts[k], dk.pts[k + 1], t); const dir = norm(sub(dk.pts[k + 1], dk.pts[k])); const w = dk.ws[k] + (dk.ws[k + 1] - dk.ws[k]) * t;
        for (const side of [-1, 1]) { const c = add(p, { x: -dir.y * side * (w / 2), y: dir.x * side * (w / 2) }); misc.push({ x: c.x - 0.8, y: c.y - 0.8, w: 1.6, h: 1.6, z0: 0, z1: Math.max(0.5, z1 * zk - 0.8), c: '#8C8576' }); }
      }
    }
    for (const z of d.zones) if (z.type === 'curb') {
      const zz = LEVELS[z.level].z0; if (z.level === 1) misc.push({ ...z, z0: zz - 0.6, z1: zz, c: '#B4AEA2' });
      const f = d.frames.get(z.id); if (!f) continue;
      // canopy: 7 m deep over the sidewalk, on a row of slender columns
      const a = f.a, b = f.b, inw = f.inward;
      // sidewalk slab by the building and a planted island between the pull-in lanes and the through lanes
      const D = f.depth; const strip = (v0: number, v1: number, h: number, c: string) => misc.push({ ...bbox([add(a, mul(inw, D * v0)), add(b, mul(inw, D * v1))]), z0: zz, z1: zz + h, c });
      strip(0, 0.26, 0.22, '#EFE8DA'); strip(0.6, 0.7, 0.25, '#A9B28A');
      const corners = [a, b, add(b, mul(inw, 7)), add(a, mul(inw, 7))];
      misc.push({ ...bbox(corners), z0: zz + 5.2, z1: zz + 5.7, c: ROOF });
      const L = dist(a, b); const al = norm(sub(b, a));
      for (let s = 6; s < L - 3; s += 12) { const p = add(add(a, mul(al, s)), mul(inw, 6.4)); misc.push({ x: p.x - 0.2, y: p.y - 0.2, w: 0.4, h: 0.4, z0: zz, z1: zz + 5.2, c: '#7C725F' }); }
    }

    // ---- landside facilities (v0.10): garages, hotels, rental centres, bus stations, rideshare lots, the AirTrain
    const glassF: Box[] = [];
    for (const z of d.zones) {
      const horiz = z.w >= z.h;
      if (z.type === 'parking' && (z.floors ?? 1) > 1) {
        const n = z.floors!;
        for (let k = 1; k <= n; k++) misc.push({ ...z, z0: k * 3.2 - 0.5, z1: k * 3.2, c: k === n ? '#A7A39A' : '#CFC8BA' });
        for (let x = z.x + 1; x <= z.x + z.w; x += 9) for (const y of [z.y + 0.4, z.y + z.h - 1]) misc.push({ x: x - 0.3, y, w: 0.6, h: 0.6, z0: 0, z1: n * 3.2, c: '#8C8576' });
        for (let y = z.y + 9; y < z.y + z.h; y += 9) for (const x of [z.x + 0.4, z.x + z.w - 1]) misc.push({ x, y: y - 0.3, w: 0.6, h: 0.6, z0: 0, z1: n * 3.2, c: '#8C8576' });
        misc.push({ x: z.x + 3, y: z.y + 3, w: 9, h: 9, z0: 0, z1: n * 3.2 + 3, c: '#B9B2A4' });   // stair and lift core
      } else if (z.type === 'hotel') {
        const H = GROWTH.hotelFloors * 3.6;
        misc.push({ ...z, z0: 0, z1: 4.4, c: PLINTH });
        glassF.push({ x: z.x + 0.5, y: z.y + 0.5, w: z.w - 1, h: z.h - 1, z0: 4.4, z1: H + 4, c: GLASS.hotel });
        for (let k = 0; k <= GROWTH.hotelFloors; k++) misc.push({ x: z.x - 0.3, y: z.y - 0.3, w: z.w + 0.6, h: z.h + 0.6, z0: 4.4 + k * 3.6 - 0.35, z1: 4.4 + k * 3.6, c: ROOF });
        misc.push({ x: z.x + z.w * 0.3, y: z.y + z.h * 0.3, w: z.w * 0.4, h: z.h * 0.4, z0: H + 4, z1: H + 6.5, c: '#CFC8BA' });
      } else if (z.type === 'rental') {
        misc.push({ ...z, z0: 0, z1: 0.11, c: '#A7A39A' });
        const bw = Math.min(z.w, z.h) * 0.3; const b = horiz ? { x: z.x, y: z.y, w: z.w, h: bw } : { x: z.x, y: z.y, w: bw, h: z.h };
        misc.push({ ...b, z0: 0, z1: 0.6, c: PLINTH }); glassF.push({ x: b.x + 0.4, y: b.y + 0.4, w: b.w - 0.8, h: b.h - 0.8, z0: 0.6, z1: 5, c: GLASS.rental }); misc.push({ x: b.x - 0.6, y: b.y - 0.6, w: b.w + 1.2, h: b.h + 1.2, z0: 5, z1: 5.6, c: ROOF });
        for (let y = z.y + (horiz ? bw + 5 : 5); y < z.y + z.h - 5; y += 7) for (let x = z.x + (horiz ? 4 : bw + 4); x < z.x + z.w - 3; x += 2.9) misc.push({ x, y, w: 1.8, h: 4.4, z0: 0.11, z1: 1.5, c: ['#3A352D', '#E9E4DA', '#8C8576'][Math.floor(hashN(x, y) * 3)] });
      } else if (z.type === 'rideshare' || z.type === 'bus') {
        misc.push({ ...z, z0: 0, z1: 0.14, c: '#8E8A83' });
        const L = horiz ? z.w : z.h;
        for (let u = 4; u + 12 < L; u += 14) {
          const sh = horiz ? { x: z.x + u + 2, y: z.y + 1.5, w: 8, h: 2.6 } : { x: z.x + 1.5, y: z.y + u + 2, w: 2.6, h: 8 };
          misc.push({ ...sh, z0: 2.6, z1: 2.85, c: ROOF }); misc.push({ x: sh.x, y: sh.y, w: 0.25, h: 0.25, z0: 0, z1: 2.6, c: '#7C725F' }, { x: sh.x + sh.w - 0.25, y: sh.y + sh.h - 0.25, w: 0.25, h: 0.25, z0: 0, z1: 2.6, c: '#7C725F' });
          if (z.type === 'bus' && hashN(u, z.id) > 0.4) { const S = horiz ? z.h : z.w; const bus = horiz ? { x: z.x + u, y: z.y + S * 0.45, w: 12, h: 2.6 } : { x: z.x + S * 0.45, y: z.y + u, w: 2.6, h: 12 }; misc.push({ ...bus, z0: 0.3, z1: 3.3, c: '#5E7A55' }); }
        }
      } else if (z.type === 'train') {
        misc.push({ ...z, z0: 6.2, z1: 7, c: '#D6CEBE' });
        misc.push({ x: z.x - 1, y: z.y - 1, w: z.w + 2, h: z.h + 2, z0: 11.4, z1: 12, c: ROOF });
        glassF.push({ x: z.x + 0.5, y: z.y + 0.5, w: z.w - 1, h: z.h - 1, z0: 7, z1: 11.4, c: GLASS.train });
        for (const [cx, cy] of [[z.x + 2, z.y + 2], [z.x + z.w - 3, z.y + 2], [z.x + 2, z.y + z.h - 3], [z.x + z.w - 3, z.y + z.h - 3]]) misc.push({ x: cx, y: cy, w: 1, h: 1, z0: 0, z1: 6.2, c: '#8C8576' });
        misc.push({ x: z.x + z.w / 2 - 3, y: z.y + z.h / 2 - 3, w: 6, h: 6, z0: 0, z1: 6.2, c: '#B9B2A4' });
      }
    }
    // the AirTrain guideway: twin beams on pylons
    const beams: Strip[] = [];
    for (const l of d.trainLinks) {
      const n = perp(l.a, l.b); const L = dist(l.a, l.b); const dv = norm(sub(l.b, l.a));
      for (const k of [-1.4, 1.4]) beams.push({ a: add(l.a, mul(n, k)), b: add(l.b, mul(n, k)), w: 1.1, z: 7.3, c: '#C9C2B4' });
      for (let u = 25; u < L - 10; u += 32) { const q = add(l.a, mul(dv, u)); misc.push({ x: q.x - 0.7, y: q.y - 0.7, w: 1.4, h: 1.4, z0: 0, z1: 7.2, c: '#A9A396' }); misc.push({ x: q.x - 2.4, y: q.y - 0.5, w: 4.8, h: 1, z0: 6.6, z1: 7.2, c: '#A9A396' }); }
    }
    if (beams.length) add3(stripMesh(beams));
    if (glassF.length) add3(instancedBoxes(glassF, true, this.glassMat));

    // gate plazas at car parks and rental centres: a booth and two barrier arms
    for (const gt of RP.gates) {
      const n = { x: -gt.dir.y, y: gt.dir.x }; const c = add(gt.p, mul(gt.dir, 4));
      misc.push({ x: c.x - 1.2, y: c.y - 1.2, w: 2.4, h: 2.4, z0: 0, z1: 2.8, c: '#E9E3D6' }, { x: c.x - 1.8, y: c.y - 1.8, w: 3.6, h: 3.6, z0: 2.8, z1: 3.1, c: ROOF });
      for (const k of [-1, 1]) { const e = add(c, mul(n, k * 3)); misc.push({ ...bbox([add(c, mul(n, k * 1.2)), add(e, mul(n, k * 1.6))]), z0: 1, z1: 1.2, c: '#B0472B' }); }
    }

    // ---- terminal sites and their names
    for (const st of sim.world.sites ?? []) {
      const T = d.terminals.find(t => t.site?.id === st.id);
      add3(outline(st, 0.3, this.ren.selected?.kind === 'site' && this.ren.selected.id === st.id ? PAL.select : '#7C725F'));
      if (!T?.zones.length) add3(flatRect(st, 0.05, '#D8CCB2', 0.7));
      add3(labelSprite(T ? `T${T.id}` : 'T', st, T?.active ? PAL.ink : PAL.bad));
    }

    // ---- buildings: a glazed box under a white roof, or opened up (glass walls, floor and fit-out)
    const openSite = (z: Zone) => lod === 'terminal' && (focus === null || siteOf(sim.world, z)?.id === focus || d.termOf.get(z.id)?.site?.id === focus);
    const solid: Box[] = []; const glazing: Box[] = []; const see: Box[] = []; const fit: Box[] = []; const roofs: Box[] = [];
    for (const z of d.zones) {
      if (!ZONES[z.type].terminal || rising.has(z.id)) continue;
      const L = LEVELS[z.level];
      const sel = this.ren.selected?.kind === 'zone' && this.ren.selected.id === z.id;
      if (!openSite(z)) { massing(z, L.z0, L.z1, sel, solid, glazing, roofs); continue; }
      const c = sel ? '#8FB0C6' : MOD_COL[z.type];
      if (z.level > this.ren.level) { see.push({ ...z, z0: L.z0, z1: L.z1 - 0.4, c }); continue; }
      solid.push({ ...z, z0: L.z0, z1: L.z0 + 0.5, c });
      if (z.level < this.ren.level) continue;
      see.push({ ...z, z0: L.z0 + 0.5, z1: L.z1 - 0.4, c });
      const f = d.frames.get(z.id);
      for (const it of f?.items ?? []) {
        const h = ITEM_H[it.k]; if (!h || !it.closed) continue;
        const b = bbox(it.pts); fit.push({ ...b, z0: L.z0 + 0.5, z1: L.z0 + 0.5 + h, c: it.k === 'wc' || it.k === 'office' ? '#B9AF9C' : '#5F574A' });
      }
      for (const sh of d.shops.get(z.id) ?? []) {
        if (!sim.leased(sh)) continue;
        const b = bbox(sh.pts); fit.push({ ...b, z0: L.z0 + 0.5, z1: L.z0 + (sh.tenant === 'dutyfree' ? 2.6 : 1.2), c: sh.tenant === 'dutyfree' ? '#5E7A55' : LOT_COL[sh.type] });
      }
      for (const k of d.cores) if (inRectPt(k, z)) fit.push({ x: k.x - 6, y: k.y - 6, w: 12, h: 12, z0: 0, z1: L.z1 - 0.6, c: '#7C725F' });
    }
    add3(instancedBoxes([...solid, ...misc, ...fit], true));
    if (glazing.length) add3(instancedBoxes(glazing, true, this.glassMat));
    if (roofs.length) { add3(instancedBoxes(roofs, true)); add3(edgeLines(roofs.filter(b => b.w > 12 && b.h > 12 && b.z1 - b.z0 < 1.2), 0.35)); }
    if (see.length) add3(instancedBoxes(see, false, undefined, 0.22));

    // ---- trees, lamps, floodlight masts, the control tower
    const tg = treeGeo();
    const crowns = new THREE.InstancedMesh(tg.crown, new THREE.MeshLambertMaterial({ color: '#ffffff' }), Math.max(1, sc.trees.length));
    const trunks = new THREE.InstancedMesh(tg.trunk, new THREE.MeshLambertMaterial({ color: '#7A6A55' }), Math.max(1, sc.trees.length));
    const o = this.tmp;
    sc.trees.forEach((t, i) => {
      o.position.set(t.x, 0, t.y); o.rotation.set(0, t.k * 6, 0); o.scale.set(t.s, t.s * (0.9 + t.k * 0.4), t.s); o.updateMatrix();
      crowns.setMatrixAt(i, o.matrix); trunks.setMatrixAt(i, o.matrix);
      crowns.setColorAt(i, this.col.set(t.k < 0.33 ? '#A9B28A' : t.k < 0.66 ? '#98A47D' : '#B7B694'));
    });
    crowns.count = trunks.count = sc.trees.length; crowns.castShadow = true; crowns.receiveShadow = true; trunks.castShadow = true;
    add3(crowns); add3(trunks);
    const poles = new THREE.InstancedMesh(poleGeo(), new THREE.MeshLambertMaterial({ color: '#6D6454' }), Math.max(1, sc.lamps.length + sc.masts.length));
    const glow: number[] = []; const pools: { p: Pt; r: number }[] = [];
    [...sc.lamps.map(p => ({ p, h: 9 })), ...sc.masts.map(p => ({ p, h: 24 }))].forEach(({ p, h }, i) => {
      o.position.set(p.x, 0, p.y); o.rotation.set(0, 0, 0); o.scale.set(h > 10 ? 2.4 : 1, h, h > 10 ? 2.4 : 1); o.updateMatrix(); poles.setMatrixAt(i, o.matrix);
      glow.push(p.x, h + 0.4, p.y); pools.push({ p, r: h > 10 ? 38 : 11 });
    });
    poles.count = sc.lamps.length + sc.masts.length; poles.castShadow = true; add3(poles);
    add3(this.lightPoints(glow, '#FFE0A0', 7));
    add3(lightPools(pools, this.poolMat));
    if (sc.tower) {
      const tw = towerGeo();
      const solidT = new THREE.Mesh(tw.solid, new THREE.MeshLambertMaterial({ color: '#E9E3D6' })); solidT.position.set(sc.tower.x, 0, sc.tower.y); solidT.castShadow = true;
      const glassT = new THREE.Mesh(tw.glass, this.glassMat); glassT.position.copy(solidT.position);
      add3(solidT); add3(glassT);
      add3(this.lightPoints([sc.tower.x, 63.5, sc.tower.y], '#FF5A3C', 6));
    }
    // airfield lights: runway edges every 60 m, taxiway centrelines every 30 m
    const rl: number[] = [], tl: number[] = [];
    for (const r of d.runways) for (let s = 0; s <= r.length; s += 60) for (const k of [-1, 1]) { const p = add(add(r.rw.a, mul(r.dir, s)), mul(r.normal, k * (r.width / 2 + 2))); rl.push(p.x, 0.6, p.y); }
    for (const w of [...sim.world.ways.filter(x => x.kind === 'taxi'), ...d.airExtra]) { const L = dist(w.a, w.b); const dv = norm(sub(w.b, w.a)); for (let s = 0; s <= L; s += 30) { const p = add(w.a, mul(dv, s)); tl.push(p.x, 0.5, p.y); } }
    add3(this.lightPoints(rl, '#FFF1C8', 9)); add3(this.lightPoints(tl, '#9BE07C', 6));
  }

  private lightPoints(xyz: number[], color: string, size: number) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(xyz.length ? xyz : [0, -999, 0], 3));
    const mt = new THREE.PointsMaterial({ color, size, map: glowTexture(color), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
    this.statLights.push(mt);
    const p = new THREE.Points(g, mt); p.frustumCulled = false; return p;
  }

  /** New modules rise out of the ground on a sandy scaffold colour, then settle. */
  private drawRising(sim: Sim, rising: number[], now: number) {
    for (const o of [...this.riseG.children]) { this.riseG.remove(o); dispose(o, [this.glassMat]); }
    if (!rising.length) return;
    const bs: Box[] = [];
    for (const id of rising) {
      const z = sim.d.zones.find(q => q.id === id); if (!z) continue;
      const k = Math.min(1, (now - this.born.get(id)!) / RISE_MS);
      const e = 1 - Math.pow(1 - k, 3) + Math.sin(k * Math.PI) * 0.06;   // ease out with a little overshoot
      const L = LEVELS[z.level];
      bs.push({ ...z, z0: L.z0, z1: L.z0 + Math.max(0.3, (L.z1 - L.z0) * e), c: k < 0.6 ? '#E2C68E' : '#E9E1D0' });
    }
    this.riseG.add(instancedBoxes(bs, true));
  }

  // ------------------------------------------------------------ moving things
  private drawMoving(sim: Sim, night: number, now: number) {
    const o = this.tmp;
    // aircraft, by class
    const n = [0, 0, 0, 0]; let nb = 0, ng = 0, dr = 0, nbe = 0;
    const atStand = new Map<string, Flight>();
    for (const f of sim.flights) {
      if (f.state === 'pending' || f.state === 'hold' || f.state === 'gone' || f.state === 'cancelled' || !f.path.length) continue;
      const P = this.planes[f.cls]; const i = n[f.cls]; if (i >= 160) continue;
      const h = f.alt * 340;
      o.position.set(f.x, h, f.y); o.rotation.set(0, -f.ang, f.alt > 0.02 ? -0.06 : 0); o.scale.set(1, 1, 1); o.updateMatrix();
      P.body.setMatrixAt(i, o.matrix); P.fin.setMatrixAt(i, o.matrix); P.eng.setMatrixAt(i, o.matrix);
      P.fin.setColorAt(i, this.col.set(f.airline.color));
      n[f.cls]++;
      if (f.state === 'stand') atStand.set(f.gate.id, f);
      if (nbe < 400 && f.state !== 'stand') { const k = nbe * 3; this.beaconPos[k] = f.x; this.beaconPos[k + 1] = h + this.planeGeos[f.cls].doorY + this.planeGeos[f.cls].radius * 1.6; this.beaconPos[k + 2] = f.y; nbe++; }
    }
    this.planes.forEach((P, c) => { for (const mm of [P.body, P.fin, P.eng]) { mm.count = n[c]; mm.instanceMatrix.needsUpdate = true; } if (P.fin.instanceColor) P.fin.instanceColor.needsUpdate = true; });
    this.beacons.geometry.setDrawRange(0, Math.floor(now / 600) % 2 ? nbe : 0); (this.beacons.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    // jet bridges: a rotunda off the building face, a tunnel that docks at the forward door, or sits retracted
    for (const g of sim.d.gates) {
      if (nb >= 400 || dr >= 790) break;
      const out = g.apron.outward; const face = add(g.door, mul(out, 7));
      const C = CLASSES[g.cls]; const pg = this.planeGeos[g.cls];
      const side = { x: -out.y, y: out.x };
      // the aircraft's forward door is on its `side`: the rotunda stands out there, on a fixed link from the face
      const rot = add(add(face, mul(out, 4)), mul(side, C.span * 0.24 + 7));
      const link0 = add(face, mul(side, C.span * 0.24 + 7));
      const zLv = LEVELS[g.zone.level].z0 + (g.zone.level ? 1 : 3.2);
      const f = atStand.get(g.id);
      let end: Pt, zEnd: number;
      if (f) {
        const dv = { x: Math.cos(f.ang), y: Math.sin(f.ang) }; const left = { x: dv.y, y: -dv.x };
        end = add(add({ x: f.x, y: f.y }, mul(dv, pg.doorX - (dv.x * 0 + 0))), mul(left, pg.radius + 1.4));
        zEnd = pg.doorY + 0.2;
      } else { end = add(add(rot, mul(out, 13)), mul(side, -5)); zEnd = zLv - 0.4; }
      const a3 = new THREE.Vector3(rot.x, zLv, rot.y), b3 = new THREE.Vector3(end.x, zEnd, end.y);
      const len = a3.distanceTo(b3);
      o.position.copy(a3).lerp(b3, 0.5); o.scale.set(2.8, 2.9, len); o.lookAt(b3); o.updateMatrix(); this.bridges.setMatrixAt(nb++, o.matrix);
      { const l0 = new THREE.Vector3(link0.x, zLv, link0.y); o.position.copy(l0).lerp(a3, 0.5); o.scale.set(2.6, 2.8, l0.distanceTo(a3) + 1); o.lookAt(a3); o.updateMatrix(); if (nb < 400) this.bridges.setMatrixAt(nb++, o.matrix); }
      o.rotation.set(0, 0, 0);
      o.position.set(rot.x, zLv / 2, rot.y); o.scale.set(2.4, zLv + 1.2, 2.4); o.updateMatrix(); this.drums.setMatrixAt(dr++, o.matrix);
      const leg = a3.clone().lerp(b3, 0.8);
      o.position.set(leg.x, leg.y / 2, leg.z); o.scale.set(0.5, leg.y, 0.5); o.updateMatrix(); this.drums.setMatrixAt(dr++, o.matrix);
      // the turnaround: tug and bag carts aft, a catering truck forward, fuel under the wing, a pushback tug at the nose
      if (f) {
        const dv = { x: Math.cos(f.ang), y: Math.sin(f.ang) }; const left = { x: dv.y, y: -dv.x }; const L = C.length;
        const veh = (fx: number, fl: number, w: number, l: number, h: number, c: string, z0 = 0) => {
          if (ng >= 2400) return;
          const p = add(add({ x: f.x, y: f.y }, mul(dv, fx)), mul(left, fl));
          o.position.set(p.x, z0 + h / 2, p.y); o.rotation.set(0, -f.ang, 0); o.scale.set(l, h, w); o.updateMatrix();
          this.gse.setMatrixAt(ng, o.matrix); this.gse.setColorAt(ng, this.col.set(c)); ng++;
        };
        const busy = sim.t - f.standT > 3 && f.readyT - sim.t > 6;
        veh(L / 2 + 5, 0, 2.2, 4.5, 1.6, '#D8B44A');                                         // pushback tug
        if (busy) {
          for (let k = 0; k < 3; k++) veh(-L * 0.22 - k * 4.2, -(pg.radius + 5), 1.8, 3.4, 1.3, '#A9A396');   // bag carts
          veh(-L * 0.22 + 4.5, -(pg.radius + 5), 1.8, 3, 1.5, '#5E7A55');                    // bag tug
          veh(L * 0.3, -(pg.radius + 3.5), 1.8, 10, 1.2, '#8C8576'); veh(L * 0.3, -(pg.radius + 3.5), 1.8, 4, 1.4, '#DCD5C6', 1.2);   // belt loader
          veh(L * 0.32, pg.radius + 5, 2.5, 7, 2.8, '#ECE7DD', 0.6);                           // catering truck
          veh(-L * 0.05, C.span * 0.3, 2.6, 9, 3, '#C9A24A');                                  // fuel truck
        }
      }
    }
    sim.d.trainLinks.forEach((l, i) => {
      if (ng >= 2400) return;
      const L = dist(l.a, l.b); const T = Math.max(1.5, L / (TUNE.walkSpeed * GROWTH.trainSpeed)) + 1; const ph = ((sim.t + i * 1.7) % (2 * T)) / T; const k = ph < 1 ? ph : 2 - ph;
      const e = Math.min(1, Math.max(0, (k * T - 0.5) / (T - 1))); const c = lerpPt(l.a, l.b, e);
      o.position.set(c.x, 9.2, c.y); o.rotation.set(0, -Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x), 0); o.scale.set(20, 3, 2.8); o.updateMatrix();
      this.gse.setMatrixAt(ng, o.matrix); this.gse.setColorAt(ng, this.col.set('#F4F1EA')); ng++;
      o.position.set(c.x, 9.5, c.y); o.scale.set(19, 0.9, 2.9); o.updateMatrix(); this.gse.setMatrixAt(ng, o.matrix); this.gse.setColorAt(ng, this.col.set('#2F5D7C')); ng++;
    });
    this.bridges.count = nb; this.drums.count = dr; this.gse.count = ng;
    for (const mm of [this.bridges, this.drums, this.gse]) mm.instanceMatrix.needsUpdate = true;
    if (this.gse.instanceColor) this.gse.instanceColor.needsUpdate = true;

    // cars, with headlights after dark
    let c = 0, hl = 0;
    const poses = this.ren.lod !== 'airfield' ? carPoses(sim) : null;
    if (poses) for (const car of sim.cars) {
      const ps = poses.get(car); if (!ps || c >= 3000) continue;
      const up = ps.up * LEVELS[1].z0;
      o.position.set(ps.x, up + 0.65, ps.y); o.rotation.set(0, -ps.ang, 0); o.scale.set(1, 1, 1); o.updateMatrix();
      this.cars.setMatrixAt(c, o.matrix); this.cars.setColorAt(c, this.col.set(CAR_COLS[car.id % CAR_COLS.length]));
      o.position.set(ps.x - Math.cos(ps.ang) * 0.3, up + 1.4, ps.y - Math.sin(ps.ang) * 0.3); o.updateMatrix(); this.cabs.setMatrixAt(c, o.matrix);
      if (night > 0.1 && hl < 3000 && car.stage !== 'bay') { const k = hl * 3; this.headPos[k] = ps.x + Math.cos(ps.ang) * 2.6; this.headPos[k + 1] = up + 0.8; this.headPos[k + 2] = ps.y + Math.sin(ps.ang) * 2.6; hl++; }
      c++;
    }
    this.cars.count = this.cabs.count = c;
    for (const mm of [this.cars, this.cabs]) mm.instanceMatrix.needsUpdate = true;
    if (this.cars.instanceColor) this.cars.instanceColor.needsUpdate = true;
    this.heads.geometry.setDrawRange(0, hl); (this.heads.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    // people: mood colours, so a queue going sour still reads in 3D
    let p = 0;
    if (this.ren.lod !== 'airfield') {
      const cols = ['#3E5A72', PAL.warn, PAL.bad];
      for (const q of sim.pax) {
        if (q.stage === 'done' || p >= 8000) continue;
        if (q.ride) continue;   // on the AirTrain
        o.position.set(q.x, LEVELS[q.level].z0 + 0.5, q.y); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); o.updateMatrix();
        this.people.setMatrixAt(p, o.matrix); this.people.setColorAt(p, this.col.set(q.mood ? cols[q.mood] : q.id % 3 ? '#3E5A72' : q.id % 2 ? '#8A6BB0' : '#5E7A55')); p++;
      }
    }
    this.people.count = p; this.people.instanceMatrix.needsUpdate = true; if (this.people.instanceColor) this.people.instanceColor.needsUpdate = true;
  }

  /** Parked cars fill each lot's bays as the lot fills; refreshed only when occupancy moves by a few percent. */
  private drawParked(sim: Sim) {
    const lots = sim.d.zones.filter(z => z.type === 'parking');
    const cap = sim.lotCapacity() || 1; const frac = Math.min(1, sim.lotUsed / cap);
    const key = `${this.dGen}|${Math.round(frac * 40)}`;
    if (key === this.parkedKey) return; this.parkedKey = key;
    const o = this.tmp; let k = 0;
    for (const z of lots) {
      const bays: { x: number; y: number; r: number }[] = [];
      for (let y = z.y + 8; y < z.y + z.h - 4; y += 14) for (let x = z.x + 7.35; x < z.x + z.w - 6; x += 2.7) {
        bays.push({ x, y: y - 2.6, r: hashN(x, y) }, { x, y: y + 8.6, r: hashN(y, x) });
      }
      bays.sort((a, b) => a.r - b.r);
      const nOn = Math.round(bays.length * frac);
      for (let i = 0; i < nOn && k < 8000; i++) {
        const b = bays[i];
        o.position.set(b.x, 0.8 + ((z.floors ?? 1) > 1 ? z.floors! * 3.2 : 0), b.y); o.rotation.set(0, Math.PI / 2, 0); o.scale.set(1, 1, 1); o.updateMatrix();
        this.parked.setMatrixAt(k, o.matrix); this.parked.setColorAt(k, this.col.set(CAR_COLS[Math.floor(b.r * 977) % CAR_COLS.length])); k++;
      }
    }
    this.parked.count = k; this.parked.instanceMatrix.needsUpdate = true; if (this.parked.instanceColor) this.parked.instanceColor.needsUpdate = true;
  }

  private drawGhost() {
    for (const o of [...this.ghostG.children]) { this.ghostG.remove(o); dispose(o, []); }
    const gh = this.ren.ghost;
    if (this.ren.cursor && !gh) this.ghostG.add(ring(this.ren.cursor, PAL.select));
    if (!gh) return;
    const col = gh.ok ? PAL.select : PAL.bad;
    if (gh.kind === 'zone' && gh.rect) {
      const L = LEVELS[this.ren.level];
      const m = new THREE.Mesh(boxGeo({ ...gh.rect, z0: L.z0, z1: L.z1 }), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, depthWrite: false }));
      this.ghostG.add(m, outline(gh.rect, L.z0 + 0.3, col));
    } else if (gh.a && gh.b) {
      const w = gh.kind === 'runway' ? runwayWidth(dist(gh.a, gh.b)) : gh.way ? wayWidth(gh.way.kind, gh.way.cls, gh.way.lanes) : 10;
      this.ghostG.add(stripMesh([{ a: gh.a, b: gh.b, w, z: 0.4, c: col }], 0.6));
      for (const x of gh.extras ?? []) this.ghostG.add(stripMesh([{ a: x.a, b: x.b, w: wayWidth('taxi', x.cls, 0), z: 0.4, c: col }], 0.6));
    }
  }
}

// ------------------------------------------------------------ geometry helpers
interface Box extends Rect { z0: number; z1: number; c: string }
interface Strip { a: Pt; b: Pt; w: number; z: number; c: string }

const hashN = (a: number, b: number) => { const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return h - Math.floor(h); };
const perp = (a: Pt, b: Pt) => { const d = norm(sub(b, a)); return { x: -d.y, y: d.x }; };
const inRectPt = (p: Pt, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const bbox = (pts: Pt[]): Rect => {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y); const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  const A = a.index ? a.toNonIndexed() : a, B = b.index ? b.toNonIndexed() : b;
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal']) {
    const pa = A.getAttribute(k).array as Float32Array, pb = B.getAttribute(k).array as Float32Array;
    const o = new Float32Array(pa.length + pb.length); o.set(pa); o.set(pb, pa.length); g.setAttribute(k, new THREE.BufferAttribute(o, 3));
  }
  return g;
}
/**
 * A module as an architectural model: a dark plinth, a glazed band with mullions every 7.5 m, a white roof slab
 * with a slight overhang, and on top either a clerestory along a concourse's spine or a couple of plant enclosures.
 */
function massing(z: Zone, z0: number, z1: number, sel: boolean, solid: Box[], glazing: Box[], roofs: Box[]) {
  const top = z1 - 0.4;
  solid.push({ ...z, z0, z1: z0 + 0.7, c: PLINTH });
  glazing.push({ x: z.x + 0.6, y: z.y + 0.6, w: z.w - 1.2, h: z.h - 1.2, z0: z0 + 0.7, z1: top - 1.1, c: sel ? '#8FB0C6' : GLASS[z.type] });
  roofs.push({ x: z.x - 0.8, y: z.y - 0.8, w: z.w + 1.6, h: z.h + 1.6, z0: top - 1.1, z1: top, c: sel ? '#CFE0EA' : ROOF });
  const mull = (x: number, y: number) => solid.push({ x: x - 0.18, y: y - 0.18, w: 0.36, h: 0.36, z0: z0 + 0.7, z1: top - 1.1, c: MULLION });
  for (let x = z.x + 0.6; x <= z.x + z.w - 0.5; x += 7.5) { mull(x, z.y + 0.6); mull(x, z.y + z.h - 0.6); }
  for (let y = z.y + 0.6 + 7.5; y < z.y + z.h - 0.6; y += 7.5) { mull(z.x + 0.6, y); mull(z.x + z.w - 0.6, y); }
  if (z.type === 'concourse') {
    const horiz = z.w >= z.h; const wC = Math.min(12, (horiz ? z.h : z.w) * 0.28);
    const r: Rect = horiz ? { x: z.x + 8, y: z.y + z.h / 2 - wC / 2, w: z.w - 16, h: wC } : { x: z.x + z.w / 2 - wC / 2, y: z.y + 8, w: wC, h: z.h - 16 };
    if (z.mezz) { const m: Rect = horiz ? { x: r.x - 2, y: r.y - 5, w: r.w + 4, h: r.h + 10 } : { x: r.x - 5, y: r.y - 2, w: r.w + 10, h: r.h + 4 }; glazing.push({ ...m, z0: top, z1: top + 4.2, c: GLASS.concourse }); roofs.push({ x: m.x - 0.7, y: m.y - 0.7, w: m.w + 1.4, h: m.h + 1.4, z0: top + 4.2, z1: top + 4.8, c: ROOF }); return; }
    glazing.push({ ...r, z0: top, z1: top + 2.2, c: GLASS.concourse });
    roofs.push({ x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1, z0: top + 2.2, z1: top + 2.7, c: ROOF });
  } else {
    const k = hashN(z.x, z.y);
    for (let i = 0; i < 2; i++) {
      const w = 10 + k * 8, h = 6 + i * 3; const x = z.x + z.w * (0.25 + 0.4 * i) - w / 2, y = z.y + z.h * (0.35 + 0.25 * ((k + i) % 1)) - h / 2;
      if (w < z.w - 6 && h < z.h - 6) solid.push({ x, y, w, h, z0: top, z1: top + 2.4, c: '#CFC8BA' });
    }
  }
}
function boxGeo(b: Box | (Rect & { z0: number; z1: number })) {
  const g = new THREE.BoxGeometry(Math.max(0.2, b.w), Math.max(0.05, b.z1 - b.z0), Math.max(0.2, b.h));
  g.translate(b.x + b.w / 2, (b.z0 + b.z1) / 2, b.y + b.h / 2);
  return g;
}
/** Many boxes as one instanced mesh, coloured per instance (multiplying the material's own colour). */
function instancedBoxes(bs: Box[], shadows: boolean, material?: THREE.Material, opacity = 1) {
  const mat = material ?? new THREE.MeshLambertMaterial({ color: '#ffffff', transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, Math.max(1, bs.length));
  const o = new THREE.Object3D(); const c = new THREE.Color();
  bs.forEach((b, i) => {
    o.position.set(b.x + b.w / 2, (b.z0 + b.z1) / 2, b.y + b.h / 2); o.scale.set(Math.max(0.2, b.w), Math.max(0.05, b.z1 - b.z0), Math.max(0.2, b.h)); o.updateMatrix();
    m.setMatrixAt(i, o.matrix); m.setColorAt(i, c.set(b.c));
  });
  m.count = bs.length; m.castShadow = shadows; m.receiveShadow = true;
  return m;
}
/** Flat strips (pavements, markings) merged into one mesh with vertex colours. */
function stripMesh(ss: Strip[], opacity = 1) {
  const pos: number[] = [], col: number[] = [], idx: number[] = []; const c = new THREE.Color();
  for (const s of ss) {
    const d = norm(sub(s.b, s.a)); const n = { x: -d.y * s.w / 2, y: d.x * s.w / 2 };
    const k = pos.length / 3;
    for (const p of [{ x: s.a.x + n.x, y: s.a.y + n.y }, { x: s.b.x + n.x, y: s.b.y + n.y }, { x: s.b.x - n.x, y: s.b.y - n.y }, { x: s.a.x - n.x, y: s.a.y - n.y }]) {
      pos.push(p.x, s.z + UP, p.y); c.set(s.c); col.push(c.r, c.g, c.b);
    }
    idx.push(k, k + 2, k + 1, k, k + 3, k + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: opacity < 1, opacity }));
  m.receiveShadow = true;
  return m;
}
/** A deck slab from a to b, level at height z1, sloping to the ground over `ramp` metres at each end. */
/** A slab along a path, with its own height and width at each point (a deck with its ramps). */
function slabPath(pts: Pt[], zs: number[], ws: number[], thick: number, c: string) {
  const pos: number[] = []; const idx: number[] = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; const dv = norm(sub(b, a));
    const n = { x: -dv.y * ws[i] / 2, y: dv.x * ws[i] / 2 }; const z = zs[i], zb = Math.max(0, z - thick);
    pos.push(p.x + n.x, z, p.y + n.y, p.x - n.x, z, p.y - n.y, p.x + n.x, zb, p.y + n.y, p.x - n.x, zb, p.y - n.y);
    if (i) { const k = (i - 1) * 4, j = i * 4; idx.push(k, j, k + 1, j, j + 1, k + 1, k + 2, k + 3, j + 2, j + 2, k + 3, j + 3, k, k + 2, j, j, k + 2, j + 2, k + 1, j + 1, k + 3, j + 1, j + 3, k + 3); }
  });
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide })); m.castShadow = true; m.receiveShadow = true;
  return m;
}
function slab(a: Pt, b: Pt, w: number, z0: number, z1: number, c: string, ramp: number) {
  const d = norm(sub(b, a)); const L = dist(a, b); const n = { x: -d.y * w / 2, y: d.x * w / 2 };
  const prof = [[0, 0.2], [ramp, z1], [L - ramp, z1], [L, 0.2]];
  const pos: number[] = []; const idx: number[] = [];
  prof.forEach(([s, z], i) => {
    const p = { x: a.x + d.x * s, y: a.y + d.y * s };
    pos.push(p.x + n.x, z, p.y + n.y, p.x - n.x, z, p.y - n.y, p.x + n.x, Math.max(0, z - (z1 - z0)), p.y + n.y, p.x - n.x, Math.max(0, z - (z1 - z0)), p.y - n.y);
    if (i) { const k = (i - 1) * 4, j = i * 4; idx.push(k, j, k + 1, j, j + 1, k + 1, k + 2, k + 3, j + 2, j + 2, k + 3, j + 3, k, k + 2, j, j, k + 2, j + 2, k + 1, j + 1, k + 3, j + 1, j + 3, k + 3); }
  });
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide })); m.castShadow = true; m.receiveShadow = true;
  return m;
}
function flatShape(pts: Pt[], z: number, c: string) {
  const sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, -p.y)));
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), new THREE.MeshLambertMaterial({ color: c })); m.rotation.x = -Math.PI / 2; m.position.y = z; m.receiveShadow = true;
  return m;
}
function flatRect(r: Rect, z: number, c: string, opacity = 1) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), new THREE.MeshLambertMaterial({ color: c, transparent: opacity < 1, opacity }));
  m.rotation.x = -Math.PI / 2; m.position.set(r.x + r.w / 2, z + UP, r.y + r.h / 2); m.receiveShadow = true;
  return m;
}
function lightPools(ps: { p: Pt; r: number }[], mat: THREE.Material) {
  const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, Math.max(1, ps.length));
  const o = new THREE.Object3D();
  ps.forEach(({ p, r }, i) => { o.position.set(p.x, 0.3, p.y); o.rotation.set(-Math.PI / 2, 0, 0); o.scale.set(r * 2, r * 2, 1); o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
  m.count = ps.length; m.frustumCulled = false;
  return m;
}
function outline(r: Rect, z: number, c: string) {
  return lineLoop([{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], z, c);
}
function lineLoop(pts: Pt[], z: number, c: string) {
  const p = [...pts, pts[0]].flatMap(q => [q.x, z, q.y]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color: c }));
}
function edgeLines(bs: Box[], opacity: number) {
  const p: number[] = [];
  for (const b of bs) {
    const x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h, z = b.z1 + 0.02;
    p.push(x0, z, y0, x1, z, y0, x1, z, y0, x1, z, y1, x1, z, y1, x0, z, y1, x0, z, y1, x0, z, y0);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#7C725F', transparent: true, opacity }));
}
function ring(p: Pt, c: string) {
  const m = new THREE.Mesh(new THREE.RingGeometry(4, 6, 24), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.set(p.x, 0.6, p.y);
  return m;
}
/** Terminal name, a constant size on screen, floating over the site's corner. */
function labelSprite(text: string, st: Site, color: string) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d')!;
  g.font = '900 96px Archivo, "Helvetica Neue", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = 'rgba(240,232,215,0.9)'; g.strokeText(text, 128, 64); g.fillStyle = color; g.fillText(text, 128, 64);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
  sp.scale.set(0.09, 0.045, 1); sp.position.set(st.x + 20, LEVELS[1].z1 + 18, st.y + 10);
  return sp;
}
/** Free GPU memory for a removed object, except shared materials that live for the whole session. */
function dispose(o: THREE.Object3D, keep: THREE.Material[]) {
  o.traverse(x => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose?.();
    const mt = m.material as THREE.Material | THREE.Material[] | undefined;
    for (const q of Array.isArray(mt) ? mt : mt ? [mt] : []) {
      if (keep.includes(q)) continue;
      (q as THREE.SpriteMaterial).map?.dispose(); q.dispose();
    }
  });
}
