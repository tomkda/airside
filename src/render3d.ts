// 3D view (v0.8): the same sim, seen in perspective with an orbiting camera. Reads sim state, never writes it.
// World plan coordinates (x, y) map to three.js (x, up, y); heights are real metres (LEVELS z0 / z1).
// The static scene (ground, pavements, buildings, decks, fit-out) is rebuilt only when the layout, the level of
// detail or the selection changes; aircraft, cars and people are instanced and move every frame.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Pt, Rect, dist, sub, norm } from './geom';
import { PAL, SITE, ZONES, LEVELS, ZoneType, FRONTAGE } from './config';
import type { Sim } from './sim';
import type { Renderer } from './render';
import { wayWidth, runwayWidth, siteOf, Zone, Site } from './world';

const UP = 0.05;   // lift flat things a little off the ground so they don't flicker
const MOD_COL: Record<ZoneType, string> = {
  checkin: '#CDBFA6', security: '#BDB29E', concourse: '#D4CBB8', claim: '#C3B9A6', curb: '#A49E92', parking: '#C9BEA8',
};
const LOT_COL: Record<string, string> = { shop: '#6E6252', food: '#B07A3E', lounge: '#4D7390' };
const ITEM_H: Record<string, number> = { counter: 1.1, xray: 1.6, body: 2.2, divest: 0.9, recompose: 0.9, kiosk: 1.4, wc: 3, office: 3, table: 0.75, belt: 0.5, carousel: 0.6 };

export class Renderer3D {
  canvas: HTMLCanvasElement;
  gl: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private stat = new THREE.Group();
  private ghostG = new THREE.Group();
  private key = '';
  private dRef: unknown = null; private dGen = 0;
  private sun: THREE.DirectionalLight; private hemi: THREE.HemisphereLight;
  private planes: { fus: THREE.InstancedMesh; wing: THREE.InstancedMesh; tail: THREE.InstancedMesh };
  private cars: THREE.InstancedMesh;
  private people: THREE.InstancedMesh;
  private tmp = new THREE.Object3D();
  private ray = new THREE.Raycaster();
  private col = new THREE.Color();

  constructor(private ren: Renderer) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view3d';
    ren.canvas.parentElement!.insertBefore(this.canvas, ren.canvas);
    this.gl = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.gl.shadowMap.enabled = true; this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(40, 1, 4, 60000);
    // the 2D canvas stays on top and transparent, so the UI keeps one set of pointer handlers
    this.controls = new OrbitControls(this.camera, ren.canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.47; this.controls.minDistance = 40; this.controls.maxDistance = 16000;
    this.controls.screenSpacePanning = false;

    this.scene.background = new THREE.Color('#E9E1CF');
    this.scene.fog = new THREE.Fog('#E9E1CF', 9000, 26000);
    this.hemi = new THREE.HemisphereLight('#F6F0E4', '#9C9078', 1.15);
    this.sun = new THREE.DirectionalLight('#FFF2DA', 2.7);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.stat, this.ghostG);

    const lam = (c: string) => new THREE.MeshLambertMaterial({ color: c });
    this.planes = {
      fus: new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), lam('#F4F1EA'), 400),
      wing: new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), lam('#E3DED3'), 400),
      tail: new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), lam('#2F5D7C'), 400),
    };
    this.cars = new THREE.InstancedMesh(new THREE.BoxGeometry(4.6, 1.5, 1.9), lam('#ffffff'), 3000);
    this.people = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.32, 0.32, 1.7, 6), lam('#ffffff'), 8000);
    for (const m of [this.planes.fus, this.planes.wing, this.planes.tail, this.cars, this.people]) { m.castShadow = true; m.count = 0; m.frustumCulled = false; this.scene.add(m); }
    this.cars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3000 * 3), 3);
    this.people.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(8000 * 3), 3);
    this.resize();
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
    if (sim.d !== this.dRef) { this.dRef = sim.d; this.dGen++; }
    const key = [this.dGen, this.ren.lod, this.ren.focus, this.ren.level, JSON.stringify(this.ren.selected), this.ren.commerce, sim.world.sites?.length].join('|');
    if (key !== this.key) { this.key = key; this.buildStatic(sim); }
    this.drawMoving(sim);
    this.drawGhost();
    // daylight: the sun follows the view so shadows stay crisp where you look
    const t = this.controls.target; const span = Math.min(2500, Math.max(300, this.camera.position.distanceTo(t)));
    this.sun.position.set(t.x - span * 0.6, span * 1.2, t.z + span * 0.4); this.sun.target.position.copy(t);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 1; sc.far = span * 4; sc.updateProjectionMatrix();
    this.sun.intensity = 2.7 * (1 - 0.8 * night); this.hemi.intensity = 1.15 * (1 - 0.6 * night);
    (this.scene.background as THREE.Color).set(night > 0.5 ? '#2B3048' : '#E9E1CF').lerp(new THREE.Color('#2B3048'), night * 0.6);
    this.gl.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------ static scene
  private buildStatic(sim: Sim) {
    for (const o of [...this.stat.children]) { this.stat.remove(o); dispose(o); }
    const d = sim.d; const lod = this.ren.lod; const focus = this.ren.focus;
    const add = (m: THREE.Object3D) => { this.stat.add(m); return m; };
    const mat = cache();

    // ground, lake, buildable boundary
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(SITE.width * 3, SITE.height * 3), mat(PAL.ground));
    ground.rotation.x = -Math.PI / 2; ground.position.set(SITE.width / 2, 0, SITE.height / 2); ground.receiveShadow = true; add(ground);
    add(flatShape(SITE.lake, 0.02, mat(PAL.lake)));
    // the city, as blocks east of the airport
    const blocks: { r: Rect; h: number }[] = [];
    for (let x = SITE.cityX; x < SITE.width; x += 150) for (let y = 300; y < SITE.height - 200; y += 150) {
      const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; const r = h - Math.floor(h);
      if (r < 0.18) continue;
      blocks.push({ r: { x: x + 18, y: y + 18, w: 114 * (0.7 + 0.3 * r), h: 114 }, h: 8 + r * r * 60 });
    }
    add(instancedBoxes(blocks.map(b => ({ x: b.r.x, y: b.r.y, w: b.r.w, h: b.r.h, z0: 0, z1: b.h, c: '#D6CAB0' })), true));

    // pavements: runways, taxiways, aprons, roads, sidewalks
    const strips: Strip[] = [];
    for (const r of d.runways) strips.push({ a: r.rw.a, b: r.rw.b, w: r.width, z: 0.15, c: PAL.runway });
    for (const w of sim.world.ways) strips.push({ a: w.a, b: w.b, w: wayWidth(w.kind, w.cls, w.lanes), z: w.kind === 'taxi' ? 0.1 : w.kind === 'road' ? 0.12 : 0.14, c: w.kind === 'taxi' ? PAL.pave : w.kind === 'road' ? PAL.road : PAL.walk });
    for (const x of d.airExtra) strips.push({ a: x.a, b: x.b, w: wayWidth('taxi', x.cls, 0), z: 0.1, c: PAL.pave });
    strips.push({ a: { x: 0, y: SITE.highwayY }, b: { x: SITE.width, y: SITE.highwayY }, w: 24, z: 0.12, c: PAL.road });
    for (const g of d.gates) strips.push({ a: g.front, b: g.stand, w: 1, z: 0.13, c: PAL.paveLine });
    for (const r of d.runways) {   // centreline dashes
      for (let s = 30; s < r.length - 30; s += 60) { const p = { x: r.rw.a.x + r.dir.x * s, y: r.rw.a.y + r.dir.y * s }; strips.push({ a: p, b: { x: p.x + r.dir.x * 30, y: p.y + r.dir.y * 30 }, w: 0.9, z: 0.17, c: '#E8E2D4' }); }
    }
    add(stripMesh(strips));
    const flats: Box[] = [];
    for (const ap of d.aprons) flats.push({ ...ap.rect, z0: 0, z1: 0.09, c: PAL.paveLight });
    for (const z of d.zones) if (z.type === 'parking') flats.push({ ...z, z0: 0, z1: 0.11, c: PAL.paveLight });
    for (const z of d.zones) if (z.type === 'curb' && z.level === 0) flats.push({ ...z, z0: 0, z1: 0.16, c: PAL.road });
    add(instancedBoxes(flats, false, true));

    // upper decks: slab on columns, with ramps down to the road at either end
    const deckBoxes: Box[] = [];
    for (const dk of d.decks) {
      const L = dist(dk.a, dk.b); const dir = norm(sub(dk.b, dk.a)); const ramp = FRONTAGE.ramp;
      const z1 = LEVELS[1].z0;
      add(slab(dk.a, dk.b, dk.width + 2, z1 - 0.8, z1, '#B4AEA2', ramp));
      for (let s = ramp; s <= L - ramp; s += 30) for (const side of [-1, 1]) {
        const c = { x: dk.a.x + dir.x * s - dir.y * side * (dk.width / 2), y: dk.a.y + dir.y * s + dir.x * side * (dk.width / 2) };
        deckBoxes.push({ x: c.x - 0.8, y: c.y - 0.8, w: 1.6, h: 1.6, z0: 0, z1: z1 - 0.8, c: '#8C8576' });
      }
    }
    for (const z of d.zones) if (z.type === 'curb' && z.level === 1) deckBoxes.push({ ...z, z0: LEVELS[1].z0 - 0.6, z1: LEVELS[1].z0, c: '#B4AEA2' });
    add(instancedBoxes(deckBoxes, true));

    // terminal sites
    for (const st of sim.world.sites ?? []) {
      const T = d.terminals.find(t => t.site?.id === st.id);
      add(outline(st, 0.3, this.ren.selected?.kind === 'site' && this.ren.selected.id === st.id ? PAL.select : '#7C725F'));
      if (!T?.zones.length) add(flatRect(st, 0.05, '#D8CCB2', 0.7));
      add(labelSprite(T ? `T${T.id}` : 'T', st, T?.active ? PAL.ink : PAL.bad));
    }

    // buildings: solid massing, or opened up (glass walls, floors and fit-out) in the terminal you are working on
    const openSite = (z: Zone) => lod === 'terminal' && (focus === null || siteOf(sim.world, z)?.id === focus || d.termOf.get(z.id)?.site?.id === focus);
    const solid: Box[] = []; const glass: Box[] = []; const fit: Box[] = [];
    for (const z of d.zones) {
      if (!ZONES[z.type].terminal) continue;
      const L = LEVELS[z.level];
      const sel = this.ren.selected?.kind === 'zone' && this.ren.selected.id === z.id;
      const c = sel ? '#8FB0C6' : MOD_COL[z.type];
      if (!openSite(z)) { solid.push({ ...z, z0: L.z0, z1: L.z1 - 0.4, c }); continue; }
      // opened: a floor slab, glass to the level you're on, nothing above it
      if (z.level > this.ren.level) { glass.push({ ...z, z0: L.z0, z1: L.z1 - 0.4, c }); continue; }
      solid.push({ ...z, z0: L.z0, z1: L.z0 + 0.5, c });
      if (z.level < this.ren.level) continue;
      glass.push({ ...z, z0: L.z0 + 0.5, z1: L.z1 - 0.4, c });
      const f = d.frames.get(z.id);
      for (const it of f?.items ?? []) {
        const h = ITEM_H[it.k]; if (!h || !it.closed) continue;
        const b = bbox(it.pts); fit.push({ ...b, z0: L.z0 + 0.5, z1: L.z0 + 0.5 + h, c: it.k === 'wc' || it.k === 'office' ? '#B9AF9C' : '#5F574A' });
      }
      for (const sh of d.shops.get(z.id) ?? []) {
        if (!sim.leased(sh)) continue;
        const b = bbox(sh.pts); fit.push({ ...b, z0: L.z0 + 0.5, z1: L.z0 + (sh.tenant === 'dutyfree' ? 2.6 : 1.2), c: sh.tenant === 'dutyfree' ? '#5E7A55' : LOT_COL[sh.type] });
      }
    }
    for (const k of d.cores) solid.push({ x: k.x - 6, y: k.y - 6, w: 12, h: 12, z0: 0, z1: LEVELS[1].z1, c: '#7C725F' });
    add(instancedBoxes(solid, true));
    add(instancedBoxes(fit, true));
    if (glass.length) add(instancedBoxes(glass, false, false, 0.22));
    // crisp roof and wall edges, like a massing model
    const edges: Box[] = solid.filter(b => b.z1 - b.z0 > 2);
    add(edgeLines([...edges, ...glass]));
  }

  // ------------------------------------------------------------ moving things
  private drawMoving(sim: Sim) {
    const { fus, wing, tail } = this.planes; const o = this.tmp;
    let n = 0;
    for (const f of sim.flights) {
      if (f.state === 'pending' || f.state === 'hold' || f.state === 'gone' || f.state === 'cancelled' || !f.path.length || n >= 400) continue;
      const L = f.ac.length, S = f.ac.span, h = f.alt * 340 + 3;
      const yaw = -f.ang;
      const put = (m: THREE.InstancedMesh, fx: number, fy: number, fz: number, sx: number, sy: number, sz: number) => {
        o.position.set(f.x + Math.cos(f.ang) * fx - Math.sin(f.ang) * fz, h + fy, f.y + Math.sin(f.ang) * fx + Math.cos(f.ang) * fz);
        o.rotation.set(0, yaw, 0); o.scale.set(sx, sy, sz); o.updateMatrix(); m.setMatrixAt(n, o.matrix);
      };
      const D = L * (f.cls === 3 ? 0.09 : 0.075);
      put(fus, 0, 0, 0, L, D, D);
      put(wing, -L * 0.05, -D * 0.2, 0, L * 0.16, D * 0.18, S);
      put(tail, -L * 0.44, D * 0.9, 0, L * 0.12, D * 1.4, D * 0.18);
      n++;
    }
    for (const m of [fus, wing, tail]) { m.count = n; m.instanceMatrix.needsUpdate = true; }

    const showCars = this.ren.lod !== 'airfield';
    let c = 0;
    if (showCars) for (const car of sim.cars) {
      if (car.stage === 'gone' || c >= 3000) continue;
      const up = car.curb?.zone.level === 1 && (car.stage === 'queue' || car.stage === 'bay') ? LEVELS[1].z0 : 0;
      o.position.set(car.x, up + 0.9, car.y); o.rotation.set(0, -car.ang, 0); o.scale.set(1, 1, 1); o.updateMatrix();
      this.cars.setMatrixAt(c, o.matrix);
      this.cars.setColorAt(c, this.col.set(car.pick ? '#3A352D' : car.id % 3 ? '#8C8576' : '#B0472B'));
      c++;
    }
    this.cars.count = c; this.cars.instanceMatrix.needsUpdate = true; if (this.cars.instanceColor) this.cars.instanceColor.needsUpdate = true;

    let p = 0;
    if (this.ren.lod !== 'airfield') {
      const cols = ['#3A352D', PAL.warn, PAL.bad];
      for (const q of sim.pax) {
        if (q.stage === 'done' || p >= 8000) continue;
        o.position.set(q.x, LEVELS[q.level].z0 + 0.5 + 0.85, q.y); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); o.updateMatrix();
        this.people.setMatrixAt(p, o.matrix); this.people.setColorAt(p, this.col.set(cols[q.mood])); p++;
      }
    }
    this.people.count = p; this.people.instanceMatrix.needsUpdate = true; if (this.people.instanceColor) this.people.instanceColor.needsUpdate = true;
  }

  private drawGhost() {
    for (const o of [...this.ghostG.children]) { this.ghostG.remove(o); dispose(o); }
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

function cache() {
  const m = new Map<string, THREE.Material>();
  return (c: string) => { let x = m.get(c); if (!x) { x = new THREE.MeshLambertMaterial({ color: c }); m.set(c, x); } return x; };
}
const bbox = (pts: Pt[]): Rect => {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y); const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
function boxGeo(b: Box | (Rect & { z0: number; z1: number })) {
  const g = new THREE.BoxGeometry(Math.max(0.2, b.w), Math.max(0.05, b.z1 - b.z0), Math.max(0.2, b.h));
  g.translate(b.x + b.w / 2, (b.z0 + b.z1) / 2, b.y + b.h / 2);
  return g;
}
/** Many boxes as one instanced mesh, coloured per instance. */
function instancedBoxes(bs: Box[], shadows: boolean, receive = false, opacity = 1) {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial({ color: '#ffffff', transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }), Math.max(1, bs.length));
  const o = new THREE.Object3D(); const c = new THREE.Color();
  bs.forEach((b, i) => {
    o.position.set(b.x + b.w / 2, (b.z0 + b.z1) / 2, b.y + b.h / 2); o.scale.set(Math.max(0.2, b.w), Math.max(0.05, b.z1 - b.z0), Math.max(0.2, b.h)); o.updateMatrix();
    m.setMatrixAt(i, o.matrix); m.setColorAt(i, c.set(b.c));
  });
  m.count = bs.length; m.castShadow = shadows; m.receiveShadow = true; void receive;
  return m;
}
/** Flat strips (pavements) merged into one mesh with vertex colours. */
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
function flatShape(pts: Pt[], z: number, mat: THREE.Material) {
  const sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, -p.y)));
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), mat); m.rotation.x = -Math.PI / 2; m.position.y = z; m.receiveShadow = true;
  return m;
}
function flatRect(r: Rect, z: number, c: string, opacity = 1) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), new THREE.MeshLambertMaterial({ color: c, transparent: opacity < 1, opacity }));
  m.rotation.x = -Math.PI / 2; m.position.set(r.x + r.w / 2, z + UP, r.y + r.h / 2); m.receiveShadow = true;
  return m;
}
function outline(r: Rect, z: number, c: string) {
  const p = [r.x, z, r.y, r.x + r.w, z, r.y, r.x + r.w, z, r.y + r.h, r.x, z, r.y + r.h, r.x, z, r.y];
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color: c }));
}
function edgeLines(bs: Box[]) {
  const p: number[] = [];
  for (const b of bs) {
    const x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h;
    for (const z of [b.z0, b.z1]) p.push(x0, z, y0, x1, z, y0, x1, z, y0, x1, z, y1, x1, z, y1, x0, z, y1, x0, z, y1, x0, z, y0);
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) p.push(x, b.z0, y, x, b.z1, y);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#28241E', transparent: true, opacity: 0.35 }));
}
function ring(p: Pt, c: string) {
  const m = new THREE.Mesh(new THREE.RingGeometry(4, 6, 24), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.set(p.x, 0.6, p.y);
  return m;
}
function labelSprite(text: string, st: Site, color: string) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d')!;
  g.font = '900 96px Archivo, "Helvetica Neue", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = 'rgba(240,232,215,0.9)'; g.strokeText(text, 128, 64); g.fillStyle = color; g.fillText(text, 128, 64);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
  const k = Math.max(24, Math.min(60, Math.max(st.w, st.h) * 0.08));
  sp.scale.set(k * 2, k, 1); sp.position.set(st.x + k, LEVELS[1].z1 + 12 + k / 2, st.y + k * 0.5);
  return sp;
}
function dispose(o: THREE.Object3D) {
  o.traverse(x => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose?.();
    const mt = m.material as THREE.Material | THREE.Material[] | undefined;
    for (const q of Array.isArray(mt) ? mt : mt ? [mt] : []) { (q as THREE.SpriteMaterial).map?.dispose(); q.dispose(); }
  });
}
