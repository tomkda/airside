// Canvas renderer. Reads sim state, never writes it.
// Far zoom reads as an airport-diagram print; zooming in reveals fit-out, people and vehicles.
// "2.5D" is an oblique projection: y compresses and heights lift toward the top of the screen.
import { Pt, Rect, add, mul, sub, norm, clamp, center, dist } from './geom';
import { PAL, SITE, ZONES, LEVELS, Level, TUNE, TAXI_CLASSES, CLASSES, COMMERCE, FRONTAGE, Lod } from './config';
import type { Sim, Flight } from './sim';
import { Zone, Frame, WayKind, wayWidth, runwayWidth, siteOf, padRect } from './world';
import type { LItem } from './layout';
import { Renderer3D } from './render3d';
const lerp2 = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
/** Sequential ramp for the commercial heatmap, pale sand to rust, in the print's palette. */
export function heatRamp(v: number, alpha = 1) {
  const t = clamp(v, 0, 1);
  const c0 = [226, 214, 188], c1 = [194, 133, 46], c2 = [140, 48, 28];
  const [p, q, k] = t < 0.5 ? [c0, c1, t / 0.5] : [c1, c2, (t - 0.5) / 0.5];
  const m = (i: number) => Math.round(p[i] + (q[i] - p[i]) * k);
  return `rgba(${m(0)},${m(1)},${m(2)},${(0.55 + 0.4 * t) * alpha})`;
}

export interface Camera { x: number; y: number; zoom: number }
export interface Ghost {
  kind: 'zone' | 'runway' | 'way'; rect?: Rect; a?: Pt; b?: Pt; ok: boolean;
  way?: { kind: WayKind; cls: number; lanes: number }; snapA?: boolean; snapB?: boolean;
  extras?: { a: Pt; b: Pt; cls: number }[];
}
export type Sel = { kind: 'zone' | 'runway' | 'way' | 'gate' | 'site'; id: number; key?: string };

const HS = 3.4;            // vertical exaggeration for heights

export class Renderer {
  ctx: CanvasRenderingContext2D;
  cam: Camera = { x: 3150, y: 2700, zoom: 0.5 };
  tilt = 0; tiltTarget = 0;
  level: Level = 1;
  overlay = false;             // queue and road-congestion heatmap (H)
  /** Level of detail (v0.8): the airfield diagram, the landside and roads, or one terminal opened up. */
  lod: Lod = 'landside';
  focus: number | null = null;  // the terminal site opened at LOD 'terminal'
  showFront = false;            // road tool: frontage guides where a road would grow a curb
  /** v0.8: a true 3D view with an orbiting camera (render3d.ts), made on first use. */
  mode3d = false;
  r3?: Renderer3D;
  commerce = false;            // commercial heatmap: footfall and revenue per lot (C)
  W = 0; H = 0; dpr = 1;
  selected: Sel | null = null;
  hover: Sel | null = null;
  ghost: Ghost | null = null;
  cursor: Pt | null = null;
  showGuides = false;          // taxiway / concourse tools show where gates would grow    // snapped cursor point while a drawing tool is active

  constructor(public canvas: HTMLCanvasElement) { this.ctx = canvas.getContext('2d')!; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = r.width; this.H = r.height;
    this.canvas.width = Math.round(r.width * this.dpr); this.canvas.height = Math.round(r.height * this.dpr);
    this.r3?.resize();
  }

  /** Switch between the plan and the 3D view, keeping the same place in view. */
  set3d(on: boolean) {
    if (on === this.mode3d) return;
    if (on) {
      if (!this.r3) this.r3 = new Renderer3D(this);
      this.r3.resize();
      this.r3.enterFrom(this.cam.x, this.cam.y, this.cam.zoom);
      this.r3.canvas.style.display = 'block'; this.r3.controls.enabled = true;
      this.tilt = this.tiltTarget = 0;
    } else if (this.r3) {
      const c = this.r3.planCamera(); this.cam = { x: c.x, y: c.y, zoom: c.zoom };
      this.r3.canvas.style.display = 'none'; this.r3.controls.enabled = false;
    }
    this.mode3d = on;
  }
  /** In 3D, left-drag orbits only with Select; with a build tool it draws. */
  setOrbitLeft(orbit: boolean) {
    if (!this.r3) return;
    (this.r3.controls.mouseButtons as Record<string, number | null>).LEFT = orbit ? 0 : null;
  }

  get yScale() { return 1 - 0.32 * this.tilt; }

  P(x: number, y: number, z = 0): [number, number] {
    if (this.mode3d && this.r3) return this.r3.project(x, y, z);
    const c = this.cam;
    return [(x - c.x) * c.zoom + this.W / 2, (y - c.y) * c.zoom * this.yScale + this.H / 2 - z * HS * this.tilt * c.zoom];
  }
  toWorld(sx: number, sy: number, z = 0): Pt {
    if (this.mode3d && this.r3) return this.r3.toWorld(sx, sy, z);
    const c = this.cam;
    return { x: (sx - this.W / 2) / c.zoom + c.x, y: (sy - this.H / 2 + z * HS * this.tilt * c.zoom) / (c.zoom * this.yScale) + c.y };
  }

  // ------------------------------------------------------------ helpers
  path(pts: Pt[], z = 0, close = true) {
    const g = this.ctx; g.beginPath();
    pts.forEach((p, i) => { const [x, y] = this.P(p.x, p.y, z); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    if (close) g.closePath();
  }
  rectPts(r: Rect): Pt[] { return [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]; }
  line(a: Pt, b: Pt, wM: number, color: string, z = 0, cap: CanvasLineCap = 'butt', minPx = 0.6) {
    const g = this.ctx; g.strokeStyle = color; g.lineWidth = Math.max(minPx, wM * this.cam.zoom); g.lineCap = cap;
    this.path([a, b], z, false); g.stroke();
  }
  poly(pts: Pt[], fill: string, z = 0) { this.ctx.fillStyle = fill; this.path(pts, z); this.ctx.fill(); }
  label(text: string, p: Pt, z: number, px: number, color: string, opts: { weight?: number; spacing?: number; align?: CanvasTextAlign; rot?: number; bg?: string } = {}) {
    const g = this.ctx; const [x, y] = this.P(p.x, p.y, z);
    g.save(); g.translate(x, y); if (opts.rot) g.rotate(opts.rot);
    g.font = `${opts.weight ?? 600} ${px}px Archivo, "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = opts.align ?? 'center'; g.textBaseline = 'middle';
    (g as unknown as { letterSpacing: string }).letterSpacing = `${opts.spacing ?? 0.12 * px}px`;
    if (opts.bg) { const w = g.measureText(text).width + 8; g.fillStyle = opts.bg; g.fillRect(-w / 2, -px * 0.75, w, px * 1.5); }
    g.fillStyle = color; g.fillText(text, 0, 0); g.restore();
  }

  nightness(t: number) {
    const m = t % 1440; const rise = 6.25 * 60, set = 19.75 * 60, tw = 45;
    if (m < rise - tw || m > set + tw) return 1;
    if (m < rise + tw) return 1 - (m - (rise - tw)) / (2 * tw);
    if (m > set - tw) return (m - (set - tw)) / (2 * tw);
    return 0;
  }

  // ------------------------------------------------------------ frame
  draw(sim: Sim) {
    const g = this.ctx;
    if (this.mode3d && this.r3) {
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, this.W, this.H);
      this.r3.draw(sim, this.nightness(sim.t));
      return;
    }
    this.tilt += (this.tiltTarget - this.tilt) * 0.18;
    if (Math.abs(this.tilt - this.tiltTarget) < 0.002) this.tilt = this.tiltTarget;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = PAL.groundDeep; g.fillRect(0, 0, this.W, this.H);

    const lod = this.lod;
    this.drawTerrain();
    this.drawRoads(sim);
    this.drawAirfield(sim);
    this.drawLots(sim);
    if (lod !== 'airfield') this.drawWalks(sim);
    this.drawDecks(sim);
    this.drawStands(sim);
    if (lod !== 'landside') this.drawGateSlots(sim);
    this.drawGateGuides(sim, this.showGuides);
    this.drawSites(sim);
    this.drawBuildings(sim);
    this.drawFrontGuides(sim);
    if (lod !== 'airfield') this.drawCars(sim);
    if (lod === 'terminal') this.drawPax(sim);
    this.drawAircraft(sim);
    this.drawFocus(sim);
    this.drawLinks(sim);
    this.drawGhost();

    const n = this.nightness(sim.t);
    if (n > 0) {
      g.save(); g.globalCompositeOperation = 'multiply'; g.fillStyle = `rgba(70,78,118,${0.42 * n})`; g.fillRect(0, 0, this.W, this.H); g.restore();
      this.drawLights(sim, n);
    }
  }

  drawTerrain() {
    const g = this.ctx; const z = this.cam.zoom;
    this.poly(this.rectPts({ x: 0, y: 0, w: SITE.width, h: SITE.height }), PAL.ground);
    this.poly(SITE.lake, PAL.lake);
    g.strokeStyle = PAL.lakeEdge; g.lineWidth = 1; this.path(SITE.lake); g.stroke();
    if (z < 0.6) this.label('NORTH BAY', { x: 700, y: 1500 }, 0, 10, PAL.ink3, { spacing: 4, rot: -1.2 });
    for (let x = SITE.cityX; x < SITE.width; x += 150) for (let y = 300; y < SITE.height - 200; y += 150) {
      const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; const r = h - Math.floor(h);
      if (r < 0.18) continue;
      this.poly(this.rectPts({ x: x + 18, y: y + 18, w: 114 * (0.7 + 0.3 * r), h: 114 }), PAL.groundDeep);
    }
    if (z < 0.9) this.label('LAKESHORE', { x: SITE.cityX + 520, y: 2400 }, 0, clamp(220 * z, 11, 22), PAL.ink3, { weight: 800, spacing: 6 });
    const b = SITE.buildable;
    g.setLineDash([4, 5]); g.strokeStyle = PAL.ink3; g.lineWidth = 0.8; this.path(this.rectPts(b)); g.stroke(); g.setLineDash([]);
    if (z > 0.7) {
      g.strokeStyle = 'rgba(40,36,30,0.05)'; g.lineWidth = 1;
      const tl = this.toWorld(0, 0), br = this.toWorld(this.W, this.H);
      const step = z > 2.5 ? 10 : 50;
      g.beginPath();
      for (let x = Math.floor(tl.x / step) * step; x < br.x; x += step) { const [sx] = this.P(x, 0); g.moveTo(sx, 0); g.lineTo(sx, this.H); }
      for (let y = Math.floor(tl.y / step) * step; y < br.y; y += step) { const [, sy] = this.P(0, y); g.moveTo(0, sy); g.lineTo(this.W, sy); }
      g.stroke();
    }
  }

  // ------------------------------------------------------------ roads (vehicles): asphalt, lane markings, kerb lines
  drawRoads(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    const HY = SITE.highwayY;
    const hwy = { a: { x: 0, y: HY }, b: { x: SITE.width, y: HY }, w: 24, lanes: 6, id: -1 };
    const roads = [hwy, ...sim.world.ways.filter(w => w.kind === 'road').map(w => ({ a: w.a, b: w.b, w: wayWidth('road', 0, w.lanes), lanes: w.lanes, id: w.id }))];
    g.lineJoin = 'round';
    // kerb (darker, slightly wider) then asphalt
    if (this.lod === 'airfield') g.globalAlpha = 0.55;
    for (const r of roads) this.line(r.a, r.b, r.w + 2, PAL.roadEdge, 0, 'round', 1.6);
    for (const r of roads) this.line(r.a, r.b, r.w, PAL.road, 0, 'round', 1);
    g.globalAlpha = 1;
    // congestion overlay
    if (this.overlay) {
      for (const e of sim.d.road.edges) {
        const x = sim.edgeLoadRatio(e.id); if (x < 0.25) continue;
        const col = x < 0.5 ? 'rgba(194,133,46,0.55)' : x < 1 ? 'rgba(194,96,46,0.7)' : 'rgba(176,71,43,0.85)';
        this.line(sim.d.road.nodes[e.u], sim.d.road.nodes[e.v], e.kind === 'hwy' ? 24 : wayWidth('road', 0, e.lanes), col, 0, 'round', 2);
      }
    }
    // markings
    if (z > 0.35 && this.lod !== 'airfield') {
      for (const r of roads) {
        const n = norm({ x: -(r.b.y - r.a.y), y: r.b.x - r.a.x });
        if (r.lanes >= 4) {
          for (const s of [-0.6, 0.6]) this.line(add(r.a, mul(n, s)), add(r.b, mul(n, s)), 0.35, PAL.roadLine, 0, 'butt', 0.6);
          g.setLineDash([Math.max(2, 4 * z), Math.max(3, 7 * z)]);
          const k = r.w / 4;
          for (const s of [-k, k]) this.line(add(r.a, mul(n, s)), add(r.b, mul(n, s)), 0.25, PAL.roadLine, 0, 'butt', 0.5);
          g.setLineDash([]);
        } else {
          g.setLineDash([Math.max(2, 4 * z), Math.max(3, 7 * z)]);
          this.line(r.a, r.b, 0.3, PAL.roadLine, 0, 'butt', 0.6);
          g.setLineDash([]);
        }
      }
    }
    this.label('STATE ROUTE 12', { x: 1500, y: HY + 48 }, 0, clamp(60 * z, 8, 11), PAL.ink3, { spacing: 3 });
    this.label('TO LAKESHORE →', { x: SITE.cityX - 500, y: HY + 48 }, 0, clamp(60 * z, 8, 11), PAL.ink3, { spacing: 3 });
    for (const r of sim.world.ways) if (r.kind === 'road') this.wayHighlight(r.id, r.a, r.b, wayWidth('road', 0, r.lanes));
  }

  // ------------------------------------------------------------ sidewalks (people): pale paving with fine edges
  drawWalks(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    const walks = sim.world.ways.filter(w => w.kind === 'walk');
    if (z < 0.3) {
      g.setLineDash([2, 2]);
      for (const w of walks) this.line(w.a, w.b, 0, PAL.walkEdge, 0, 'butt', 1.2);
      g.setLineDash([]);
    } else {
      for (const w of walks) this.line(w.a, w.b, 4 + 0.8, PAL.walkEdge, 0, 'square', 2);
      for (const w of walks) this.line(w.a, w.b, 4, PAL.walk, 0, 'square', 1);
      if (z > 1.2) for (const w of walks) {   // paving joints
        const L = dist(w.a, w.b); const d = norm(sub(w.b, w.a)); const n = { x: -d.y, y: d.x };
        for (let s = 3; s < L; s += 3) { const p = add(w.a, mul(d, s)); this.line(add(p, mul(n, -2)), add(p, mul(n, 2)), 0.12, PAL.walkEdge, 0, 'butt', 0.4); }
      }
    }
    // crosswalks: where a sidewalk crosses a road, the asphalt shows through with zebra bars
    if (z > 0.3) for (const c of sim.d.crosswalks) {
      const road = { x: Math.cos(c.ang), y: Math.sin(c.ang) }, walk = { x: -road.y, y: road.x };
      const half = c.width / 2;
      this.line(add(c.p, mul(walk, -half)), add(c.p, mul(walk, half)), 5.2, PAL.road, 0, 'butt', 1);
      if (z > 0.6) for (let s = -half + 0.9; s <= half - 0.6; s += 1.5) {
        const m = add(c.p, mul(walk, s));
        this.line(add(m, mul(road, -2)), add(m, mul(road, 2)), 0.75, PAL.roadLine, 0, 'butt', 0.6);
      }
    }
    for (const w of walks) this.wayHighlight(w.id, w.a, w.b, 4);
    void g;
  }

  wayHighlight(id: number, a: Pt, b: Pt, w: number) {
    const sel = this.selected?.kind === 'way' && this.selected.id === id;
    const hov = this.hover?.kind === 'way' && this.hover.id === id;
    if (!sel && !hov) return;
    this.ctx.globalAlpha = sel ? 0.9 : 0.5;
    this.line(a, b, w + 10, 'rgba(47,93,124,0.45)', 0, 'round', 4);
    this.ctx.globalAlpha = 1;
  }

  drawAirfield(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom; const d = sim.d;
    for (const a of d.aprons) this.poly(this.rectPts(a.rect), PAL.pave);
    // Taxiways (player) plus generated stubs into aprons and onto runways
    g.lineJoin = 'round';
    const taxis = sim.world.ways.filter(w => w.kind === 'taxi');
    for (const t of taxis) this.line(t.a, t.b, wayWidth('taxi', t.cls, 0), PAL.pave, 0, 'round', 1.2);
    for (const t of d.airExtra) this.line(t.a, t.b, wayWidth('taxi', t.cls, 0), PAL.pave, 0, 'round', 1.2);
    this.drawFillets(sim);
    if (z > 0.6) {
      for (const t of taxis) this.line(t.a, t.b, 0.4, PAL.paveLine, 0, 'butt', 0.6);
      for (const t of taxis) if (t.cls >= 3) {   // Code F: edge stripes
        const n = norm({ x: -(t.b.y - t.a.y), y: t.b.x - t.a.x }); const k = TAXI_CLASSES[1].width / 2 - 2;
        for (const s of [-k, k]) this.line(add(t.a, mul(n, s)), add(t.b, mul(n, s)), 0.3, PAL.paveLine, 0, 'butt', 0.5);
      }
    }
    for (const t of taxis) this.wayHighlight(t.id, t.a, t.b, wayWidth('taxi', t.cls, 0));
    // Runways: shoulders, pavement, designators
    for (const r of d.runways) {
      const ext = mul(r.dir, 70);
      this.line(sub(r.rw.a, ext), add(r.rw.b, ext), r.width + 14, PAL.pave);
      this.line(r.rw.a, r.rw.b, r.width, PAL.runway);
      const px = clamp(20 * z, 6, 13);
      const rot = Math.atan2(r.dir.y * this.yScale, r.dir.x);
      const up = Math.cos(rot) < 0;
      const ang = up ? rot + Math.PI : rot;
      this.label(r.labels[0], add(r.rw.a, mul(r.dir, 70 + px / z)), 0, px, PAL.paveLine, { rot: ang + (up ? Math.PI / 2 : -Math.PI / 2), weight: 700, spacing: 1 });
      this.label(r.labels[1], add(r.rw.b, mul(r.dir, -70 - px / z)), 0, px, PAL.paveLine, { rot: ang + (up ? -Math.PI / 2 : Math.PI / 2), weight: 700, spacing: 1 });
      if (z > 0.6) {
        g.setLineDash([30 * z, 20 * z]);
        this.line(add(r.rw.a, mul(r.dir, 160)), add(r.rw.b, mul(r.dir, -160)), 0.9, 'rgba(230,220,200,0.55)');
        g.setLineDash([]);
        // threshold piano keys, count by width
        const keys = Math.round(r.width / 7.5);
        for (const [end, dir] of [[r.rw.a, r.dir], [r.rw.b, mul(r.dir, -1)]] as [Pt, Pt][]) {
          for (let i = 0; i < keys; i++) {
            const off = (i - (keys - 1) / 2) * (r.width / keys);
            const p = add(add(end, mul(dir, 10)), mul(r.normal, off));
            this.line(p, add(p, mul(dir, 30)), Math.min(1.8, r.width / keys * 0.5), 'rgba(230,220,200,0.6)');
          }
        }
      }
      const sel = this.selected?.kind === 'runway' && this.selected.id === r.rw.id;
      const hov = this.hover?.kind === 'runway' && this.hover.id === r.rw.id;
      if (sel || hov) { g.globalAlpha = sel ? 1 : 0.5; this.line(r.rw.a, r.rw.b, r.width + 30, 'rgba(47,93,124,0.35)'); g.globalAlpha = 1; }
      if (sel && !this.ghost) for (const p of [r.rw.a, r.rw.b]) {
        const [x, y] = this.P(p.x, p.y);
        g.fillStyle = PAL.paveLine; g.strokeStyle = PAL.select; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.fill(); g.stroke();
        const d = norm(sub(p, p === r.rw.a ? r.rw.b : r.rw.a));
        g.beginPath(); g.moveTo(x + d.x * 4 - d.y * 3.5, y + d.y * 4 * this.yScale + d.x * 3.5); g.lineTo(x + d.x * 9, y + d.y * 9 * this.yScale); g.lineTo(x + d.x * 4 + d.y * 3.5, y + d.y * 4 * this.yScale - d.x * 3.5);
        g.fillStyle = PAL.select; g.fill();
      }
    }
    // Taxiway letters, like an airport diagram
    if (z > 0.14) for (const l of d.taxiLabels) {
      const n = { x: -Math.sin(l.ang), y: Math.cos(l.ang) };
      this.label(l.text, add(l.p, mul(n, 22 / Math.max(z, 0.3))), 0, clamp(11 * z + 4, 8, 12), PAL.ink, { weight: 800, spacing: 0, bg: 'rgba(230,219,195,0.9)' });
    }
    for (const h of d.hotspots) {
      const [x, y] = this.P(h.x, h.y);
      g.strokeStyle = PAL.bad; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, Math.max(6, 60 * z), 0, Math.PI * 2); g.stroke();
      if (z > 0.25) this.label('HS', { x: h.x + 80, y: h.y - 80 }, 0, 9, PAL.bad, { weight: 800 });
    }
  }

  /**
   * Radiused corners where taxiways meet each other, taxilanes or a runway. Each pair of legs at a
   * junction gets a curve stroked at pavement width, which rounds the inside corner; at higher zoom
   * the painted centreline follows the same curve.
   */
  drawFillets(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom; const air = sim.d.air;
    if (z < 0.08) return;
    const width = (k: string, cls: number) => (k === 'taxi' ? wayWidth('taxi', cls, 0) : k === 'lane' ? 23 : 0);
    const curves: { p1: Pt; c: Pt; p2: Pt; w: number; centre: boolean }[] = [];
    for (let n = 0; n < air.nodes.length; n++) {
      const legs = air.adj[n].map(id => air.edges[id]).filter(e => e.kind !== 'stand');
      if (legs.length < 2) continue;
      const P = air.nodes[n];
      const dirs = legs.map(e => ({ e, d: norm(sub(air.nodes[e.u === n ? e.v : e.u], P)) }));
      for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
        const A = dirs[i], B = dirs[j];
        if (A.e.kind === 'rwy' && B.e.kind === 'rwy') continue;
        const c = A.d.x * B.d.x + A.d.y * B.d.y;
        if (c < -0.985 || c > 0.7) continue;                  // straight through, or a sharp wedge aircraft don't turn
        const wA = width(A.e.kind, A.e.cls), wB = width(B.e.kind, B.e.cls);
        const w = A.e.kind === 'rwy' ? wB : B.e.kind === 'rwy' ? wA : Math.min(wA, wB);
        if (!w) continue;
        const base = w >= 30 ? 70 : 50;
        const R = Math.min(base * (1.15 - 0.5 * c), A.e.len * 0.45, B.e.len * 0.45);
        curves.push({ p1: add(P, mul(A.d, R)), c: P, p2: add(P, mul(B.d, R)), w, centre: A.e.kind !== 'rwy' && B.e.kind !== 'rwy' });
      }
    }
    g.strokeStyle = PAL.pave; g.lineCap = 'round';
    for (const k of curves) {
      g.lineWidth = Math.max(1.2, k.w * z);
      const [x1, y1] = this.P(k.p1.x, k.p1.y), [cx, cy] = this.P(k.c.x, k.c.y), [x2, y2] = this.P(k.p2.x, k.p2.y);
      g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cx, cy, x2, y2); g.stroke();
    }
    if (z > 0.6) {
      g.strokeStyle = PAL.paveLine; g.lineWidth = Math.max(0.6, 0.4 * z);
      for (const k of curves) if (k.centre) {
        const [x1, y1] = this.P(k.p1.x, k.p1.y), [cx, cy] = this.P(k.c.x, k.c.y), [x2, y2] = this.P(k.p2.x, k.p2.y);
        g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cx, cy, x2, y2); g.stroke();
      }
    }
  }

  drawLots(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    // the curb on the level you are looking at draws last, over the one on the other deck
    const order = [...sim.d.zones].sort((a, b) => Number(a.level === this.level) - Number(b.level === this.level));
    for (const zn of order) {
      if (zn.type === 'parking') {
        this.poly(this.rectPts(zn), PAL.paveLight);
        const used = sim.lotUsed / (sim.lotCapacity() || 1);
        if (z > 0.35) {
          g.strokeStyle = 'rgba(40,36,30,0.16)'; g.lineWidth = 1;
          for (let y = zn.y + 8; y < zn.y + zn.h - 4; y += 14) { this.path([{ x: zn.x + 6, y }, { x: zn.x + zn.w - 6, y }], 0, false); g.stroke(); }
          const rows = Math.floor((zn.h - 12) / 14);
          for (let i = 0; i < Math.round(rows * used); i++) this.poly(this.rectPts({ x: zn.x + 8, y: zn.y + 8 + i * 14 + 3, w: zn.w - 16, h: 8 }), 'rgba(110,100,84,0.35)');
        }
        this.zoneLabel(sim, zn, 0);
      } else if (zn.type === 'curb') {
        if (zn.level !== this.level && order.some(o => o.type === 'curb' && o.level === this.level && rectsTouch(o, zn))) continue;
        this.poly(this.rectPts(zn), zn.level === 1 ? '#B4AEA2' : PAL.road);
        const f = sim.d.frames.get(zn.id)!;
        if (z > 0.6) {
          g.setLineDash([6 * z, 6 * z]);
          for (const k of [0.36, 0.62]) this.line(add(f.a, mul(f.inward, f.depth * k)), add(f.b, mul(f.inward, f.depth * k)), 0.3, PAL.roadLine);
          g.setLineDash([]);
        }
        // sidewalk strip on the building side
        this.line(add(f.a, mul(f.inward, 2)), add(f.b, mul(f.inward, 2)), 4, PAL.walk, 0, 'butt', 1.2);
        this.line(add(f.a, mul(f.inward, 4)), add(f.b, mul(f.inward, 4)), 0.3, PAL.walkEdge, 0, 'butt', 0.5);
        if (this.lod !== 'airfield' && (zn.level === this.level || this.cam.zoom < 0.7)) this.zoneLabel(sim, zn, 0);
      }
      if (zn.type === 'parking' || zn.type === 'curb') this.selectOutline(zn, 0);
    }
  }

  drawStands(sim: Sim) {
    if (this.cam.zoom < 0.22) return;
    for (const gt of sim.d.gates) this.line(gt.front, gt.stand, 0.8, PAL.paveLine);
  }

  // ------------------------------------------------------------ buildings
  drawBuildings(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    const zones = sim.d.zones.filter(q => ZONES[q.type].terminal);
    const active = this.lod === 'terminal' ? this.level : 1;
    // fit-out and labels only where you are looking: the open terminal, or every terminal at landside zoom
    const detail = (zn: Zone) => this.lod === 'terminal' ? (this.focus === null || siteOf(sim.world, zn)?.id === this.focus || sim.d.termOf.get(zn.id)?.site?.id === this.focus) : false;
    zones.sort((a, b) => a.level - b.level || (a.y + a.h) - (b.y + b.h));
    const tilted = this.tilt > 0.02;
    const labels: [Zone, number][] = [];
    for (const zn of zones) {
      const L = LEVELS[zn.level];
      if (zn.level > active) continue;
      const isActive = zn.level === active;
      const top = tilted ? L.z1 : 0;
      if (tilted) {
        const y2 = zn.y + zn.h;
        g.fillStyle = PAL.bldgSide;
        this.path([{ x: zn.x, y: y2 }, { x: zn.x + zn.w, y: y2 }], L.z0, false);
        const [x1, y1] = this.P(zn.x + zn.w, y2, top), [x0, y0] = this.P(zn.x, y2, top);
        g.lineTo(x1, y1); g.lineTo(x0, y0); g.closePath(); g.fill();
      }
      this.poly(this.rectPts(zn), isActive ? PAL.bldgTop : (tilted ? PAL.bldg : PAL.bldgGhost), top);
      if (isActive || tilted) { g.strokeStyle = 'rgba(40,36,30,0.35)'; g.lineWidth = 1; this.path(this.rectPts(zn), top); g.stroke(); }
      if (isActive && detail(zn)) {
        if (this.overlay) this.heat(sim, zn, top);
        if (this.commerce && zn.type === 'concourse') this.flowBand(sim, zn, top);
        this.fitout(sim, zn, top);
        labels.push([zn, top]);
      } else if (isActive && this.lod === 'landside') {
        if (this.overlay) this.heat(sim, zn, top);
        labels.push([zn, top]);
      }
      this.selectOutline(zn, top);
    }
    for (const zn of zones) if (zn.level > active && this.lod === 'terminal') {
      const top = tilted ? LEVELS[zn.level].z1 : 0;
      g.setLineDash([5, 4]); g.strokeStyle = 'rgba(40,36,30,0.45)'; g.lineWidth = 1; this.path(this.rectPts(zn), top); g.stroke(); g.setLineDash([]);
      this.selectOutline(zn, top);
    }
    // Vertical cores (stairs, escalators, lifts); frontage cores sit on the curb edge
    if (this.lod !== 'airfield') for (const c of sim.d.cores) {
      const top = tilted ? LEVELS[active].z1 : 0;
      const s = c.frontage ? 5 : 7;
      const r = { x: c.x - s, y: c.y - s, w: s * 2, h: s * 2 };
      this.poly(this.rectPts(r), PAL.ink2, top);
      if (z > 0.8) for (let i = 1; i < 5; i++) this.line({ x: r.x + 1, y: r.y + i * (s * 2 / 5) }, { x: r.x + r.w - 1, y: r.y + i * (s * 2 / 5) }, 0.5, PAL.bldgTop, top);
    }
    for (const [zn, top] of labels) this.zoneLabel(sim, zn, top);
    this.drawTerminals(sim);
  }

  /** Terminal names in the print's heavy type; closed terminals get a dashed rust outline and a reason. */
  drawTerminals(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    if (z < 0.12) return;
    const top = this.tilt > 0.02 ? LEVELS[1].z1 : 0;
    for (const T of sim.d.terminals) {
      const b = T.bbox; const pad = T.site ? 0 : 18;
      const r = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
      if (this.lod === 'terminal' && this.focus !== null && T.site?.id !== this.focus) continue;
      if (!T.active) { g.setLineDash([7, 5]); g.strokeStyle = PAL.bad; g.lineWidth = 1.5; this.path(this.rectPts(r), top); g.stroke(); g.setLineDash([]); }
      const px = clamp(16 * z + 6, 10, 18);
      const at = { x: r.x - 10 / z, y: r.y + 4 / z };
      this.label(`T${T.id}`, at, top, px * 1.6, T.active ? PAL.ink : PAL.bad, { weight: 900, spacing: 0, align: 'right' });
      const sub = T.active ? `TERMINAL ${T.id} · OPEN · ${T.gates} GATES` : `TERMINAL ${T.id} · CLOSED`;
      this.label(sub, { x: at.x, y: at.y + (px * 1.25) / (z * this.yScale) }, top, 9, T.active ? PAL.ink2 : PAL.bad, { weight: 700, spacing: 1.5, align: 'right' });
      if (!T.active && z > 0.25) this.label(T.problems[0].split(':')[0], { x: at.x, y: at.y + (px * 1.25 + 13) / (z * this.yScale) }, top, 9, PAL.bad, { weight: 500, spacing: 0.3, align: 'right' });
    }
  }

  heat(sim: Sim, zn: Zone, top: number) {
    const p = sim.procs.get(zn.id);
    let v = 0;
    if (p && (p.type === 'checkin' || p.type === 'security')) {
      const tol = TUNE.tolerance[p.type];
      const waitNow = p.queue.length && p.servers ? (p.queue.length * (p.type === 'checkin' ? TUNE.checkinTime[zn.tier] : TUNE.securityTime[zn.tier])) / p.servers : 0;
      v = Math.max(waitNow, p.recentWait) / tol;
    } else if (p && p.type === 'claim') {
      v = sim.pax.filter(q => q.stage === 'waitBag' && q.proc === p).reduce((s, q) => Math.max(s, sim.t - q.since), 0) / TUNE.tolerance.claim;
    } else if (zn.type === 'concourse') {
      const seats = sim.d.budgets.get(zn.id)?.seats ?? 0;
      const atGates = seats ? sim.pax.filter(q => q.stage === 'dwell' && q.flight.gate.zone.id === zn.id).length / seats : 0;
      const list = sim.d.shops.get(zn.id) ?? [];
      const cap = list.filter(sh => sim.leased(sh)).reduce((n, sh) => n + sh.cap, 0) || 1;
      v = Math.max(atGates, list.reduce((n, sh) => n + (sim.shopLoad.get(sh) ?? 0), 0) / cap);
    }
    v = clamp(v, 0, 2);
    if (v < 0.05) return;
    this.poly(this.rectPts(zn), v < 1 ? `rgba(194,133,46,${0.12 + 0.3 * v})` : `rgba(176,71,43,${0.35 + 0.25 * (v - 1)})`, top);
  }

  fitout(sim: Sim, zn: Zone, top: number) {
    const z = this.cam.zoom; const f = sim.d.frames.get(zn.id) as Frame; if (!f) return;
    const ink = 'rgba(40,36,30,0.55)', soft = 'rgba(40,36,30,0.22)';
    const at = (s: number, d: number) => add(add(f.a, mul(f.along, s)), mul(f.inward, d));
    const rect = (c: Pt, w: number, h: number) => {
      const a = mul(f.along, w / 2), b = mul(f.inward, h / 2);
      return [sub(sub(c, a), b), add(sub(c, b), a), add(add(c, a), b), add(sub(c, a), b)];
    };
    void at; void rect;
    this.drawItems(sim, zn, f, top);
    if (zn.type === 'claim' && z > 1) {
      const p = sim.procs.get(zn.id);
      f.slots.forEach((c, i) => { const fl = p?.carousels?.[i]; if (fl) this.label(fl.code, c, top, 8, PAL.ink, { weight: 700, spacing: 0.5, bg: 'rgba(240,232,215,0.85)' }); });
    } else if (zn.type === 'concourse') {
      if (z > 1.1) for (const gt of sim.d.gates) if (gt.zone.id === zn.id) this.label(gt.num, add(gt.door, mul(gt.apron.outward, -3)), top, 9, PAL.ink, { weight: 700, spacing: 1, bg: 'rgba(240,232,215,0.85)' });
      // commercial lots: leased ones filled by type, vacant ones dashed ("for lease"). The commercial heatmap
      // fills every lot by footfall instead and labels it with its revenue.
      const list = sim.d.shops.get(zn.id) ?? [];
      const fill: Record<string, string> = { shop: 'rgba(70,62,50,0.42)', food: 'rgba(168,112,48,0.5)', lounge: 'rgba(47,93,124,0.45)' };
      const g = this.ctx;
      for (const sh of list) {
        const on = sim.leased(sh); const df = sh.tenant === 'dutyfree';
        const c = { x: (sh.pts[0].x + sh.pts[2].x) / 2, y: (sh.pts[0].y + sh.pts[2].y) / 2 };
        if (this.commerce) {
          this.poly(sh.pts, heatRamp(sh.footScore, on ? 1 : 0.45), top);
          if (!on) { g.setLineDash([3, 3]); g.strokeStyle = soft; g.lineWidth = 1; this.path(sh.pts, top); g.stroke(); g.setLineDash([]); }
        } else if (df) this.poly(sh.pts, 'rgba(94,122,85,0.5)', top);
        else if (on) this.poly(sh.pts, fill[sh.type], top);
        else { g.setLineDash([3, 3]); g.strokeStyle = soft; g.lineWidth = 1; this.path(sh.pts, top); g.stroke(); g.setLineDash([]); }
        if (df && z > 0.6) this.serpentine(sh.pts, top);
        const sel = this.selected?.kind === 'zone' && this.selected.id === zn.id && this.selected.key === sh.key;
        if (sel) { g.strokeStyle = PAL.select; g.lineWidth = 2.5; this.path(sh.pts, top); g.stroke(); }
        const wpx = Math.hypot(sh.pts[1].x - sh.pts[0].x, sh.pts[1].y - sh.pts[0].y) * z;
        if (this.commerce && z > 1.1 && on) {
          const L = sim.lotPrev.get(sh.id) ?? sim.lotDay.get(sh.id);
          const num = L && L.rev >= 1 ? (L.rev >= 1000 ? (L.rev / 1000).toFixed(1) + 'k' : String(Math.round(L.rev))) : '—';
          const txt = [`$${num}`, num].find(t => wpx > t.length * 4.8 + 2);
          if (txt) this.label(txt, c, top, 7.5, sh.footScore > 0.55 ? '#F4EDDF' : PAL.ink, { weight: 800, spacing: 0 });
        } else if (!this.commerce && z > 1.6 && on) {
          const big = wpx > sh.kind.length * 5.6 + 10;
          this.label(big ? sh.kind.toUpperCase() : df ? 'DF' : sh.type === 'shop' ? 'S' : sh.type === 'food' ? 'F' : 'L', c, top, big ? 7 : 8, '#F4EDDF', { weight: 800, spacing: big ? 0.6 : 0 });
        }
      }
    }
  }

  /** Walk-through duty free: the winding path everyone follows between the displays. */
  serpentine(pts: Pt[], top: number) {
    const [a, b, , d] = pts;
    const along = sub(b, a), across = sub(d, a);
    const long = Math.hypot(along.x, along.y) >= Math.hypot(across.x, across.y);
    const U = long ? along : across, V = long ? across : along;
    const line: Pt[] = [];
    for (let i = 0; i <= 8; i++) { const t = (i + 0.5) / 9; line.push(add(add(a, mul(V, i % 2 ? 0.75 : 0.25)), mul(U, t))); }
    const g = this.ctx; g.setLineDash([3, 3]); g.strokeStyle = 'rgba(40,36,30,0.5)'; g.lineWidth = 1;
    this.path(line, top, false); g.stroke(); g.setLineDash([]);
  }

  /** Commercial heatmap: today's footfall along the spine, bin by bin, as a band on the concourse centreline. */
  flowBand(sim: Sim, zn: Zone, top: number) {
    const B = sim.d.budgets.get(zn.id); const f = sim.flowDay.get(zn.id) ?? zn.flow; if (!B || !f) return;
    const max = Math.max(1, ...f.w);
    const bin = COMMERCE.binM;
    const vMid = B.horiz ? zn.h / 2 : zn.w / 2;
    for (let i = 0; i < f.w.length; i++) {
      const v = f.w[i] / max; if (v < 0.03) continue;
      const u0 = i * bin, u1 = Math.min(B.long, u0 + bin); const h = 2 + 4 * v;
      const r = B.horiz ? { x: zn.x + u0, y: zn.y + vMid - h / 2, w: u1 - u0, h } : { x: zn.x + vMid - h / 2, y: zn.y + u0, w: h, h: u1 - u0 };
      this.poly(this.rectPts(r), heatRamp(v, 0.9), top);
    }
  }

  /** Draw a module's procedural plan. Open desks, lanes and built carousels read darker than idle ones. */
  drawItems(sim: Sim, zn: Zone, f: Frame, top: number) {
    const g = this.ctx; const z = this.cam.zoom;
    if (z < 0.3) return;
    const p = sim.procs.get(zn.id);
    const open = (it: LItem) => it.slot === undefined || !p || it.slot < p.servers;
    const ink = 'rgba(40,36,30,0.62)', mid = 'rgba(40,36,30,0.34)', soft = 'rgba(40,36,30,0.16)';
    for (const it of f.items) {
      switch (it.k) {
        case 'door': this.poly(it.pts, 'rgba(240,232,215,0.9)', top); break;
        case 'counter': case 'xray': this.poly(it.pts, open(it) ? ink : soft, top); break;
        case 'body': this.poly(it.pts, open(it) ? mid : soft, top); break;
        case 'belt': case 'divest': case 'recompose': this.poly(it.pts, mid, top); break;
        case 'kiosk': if (z > 0.6) this.poly(it.pts, ink, top); break;
        case 'stanchion': if (z > 0.7) { g.setLineDash([2, 2]); this.line(it.pts[0], it.pts[1], 0.15, mid, top, 'butt', 0.6); g.setLineDash([]); } break;
        case 'lane': if (z > 0.6) this.line(it.pts[0], it.pts[1], 0.15, soft, top, 'butt', 0.5); break;
        case 'carousel': {
          const busy = p?.carousels?.[it.slot ?? -1];
          g.strokeStyle = busy ? 'rgba(40,36,30,0.85)' : mid; g.lineWidth = Math.max(1.2, 1.6 * z);
          this.path(it.pts, top); g.stroke();
          this.poly(it.pts, busy ? 'rgba(40,36,30,0.18)' : 'rgba(40,36,30,0.06)', top);
          break;
        }
        case 'carousel-off': if (z > 0.5) { g.setLineDash([3, 4]); g.strokeStyle = soft; g.lineWidth = 1; this.path(it.pts, top); g.stroke(); g.setLineDash([]); } break;
        case 'feed': if (z > 0.6) this.line(it.pts[0], it.pts[1], 0.9, mid, top); break;
        case 'seat': if (z > 0.55) this.line(it.pts[0], it.pts[1], 0.6, mid, top, 'butt', 0.6); break;
        case 'spine': if (z > 0.5) { g.setLineDash([6, 4]); this.line(it.pts[0], it.pts[1], 0.3, soft, top, 'butt', 0.6); g.setLineDash([]); } break;
        case 'wc': case 'office':
          this.poly(it.pts, 'rgba(40,36,30,0.12)', top);
          g.strokeStyle = mid; g.lineWidth = 1; this.path(it.pts, top); g.stroke();
          if (z > 1.3 && it.label) { const c = { x: it.pts.reduce((s2, q) => s2 + q.x, 0) / it.pts.length, y: it.pts.reduce((s2, q) => s2 + q.y, 0) / it.pts.length }; this.label(it.label, c, top, 7.5, PAL.ink2, { weight: 700, spacing: 0.6 }); }
          break;
        case 'table': if (z > 0.7) this.poly(it.pts, mid, top); break;
        case 'plant': if (z > 0.5) this.poly(it.pts, 'rgba(94,122,85,0.5)', top); break;
        case 'hold': this.poly(it.pts, 'rgba(47,93,124,0.08)', top); break;
      }
    }
  }

  /** Terminal sites: the land each terminal was given. An empty site reads as a hatched plot waiting for modules. */
  drawSites(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    for (const st of sim.world.sites ?? []) {
      const T = sim.d.terminals.find(t => t.site?.id === st.id);
      const empty = !T || !T.zones.length;
      const sel = this.selected?.kind === 'site' && this.selected.id === st.id;
      const hov = this.hover?.kind === 'site' && this.hover.id === st.id;
      if (this.lod === 'airfield' || empty) this.poly(this.rectPts(st), empty ? 'rgba(149,138,118,0.10)' : 'rgba(149,138,118,0.22)');
      if (empty && z > 0.2) {
        g.save(); this.path(this.rectPts(st)); g.clip();
        g.strokeStyle = 'rgba(40,36,30,0.12)'; g.lineWidth = 1;
        for (let k = -st.h; k < st.w; k += 24) this.line({ x: st.x + k, y: st.y + st.h }, { x: st.x + k + st.h, y: st.y }, 0, 'rgba(40,36,30,0.12)', 0, 'butt', 1);
        g.restore();
        if (z > 0.25) this.label('NEW TERMINAL · DOUBLE-CLICK TO LAY IT OUT', center(st), 0, 9, PAL.ink2, { weight: 700, spacing: 1.2, bg: 'rgba(240,232,215,0.85)' });
      }
      g.setLineDash([10, 5]); g.strokeStyle = sel ? PAL.select : hov ? 'rgba(47,93,124,0.7)' : 'rgba(40,36,30,0.4)'; g.lineWidth = sel ? 2 : 1;
      this.path(this.rectPts(st)); g.stroke(); g.setLineDash([]);
      // corner ticks, like a site boundary on a survey
      const t = 10 / Math.max(z, 0.2);
      for (const [cx, cy, dx, dy] of [[st.x, st.y, 1, 1], [st.x + st.w, st.y, -1, 1], [st.x + st.w, st.y + st.h, -1, -1], [st.x, st.y + st.h, 1, -1]]) {
        this.line({ x: cx, y: cy }, { x: cx + dx * t, y: cy }, 0, PAL.ink2, 0, 'butt', 1.6);
        this.line({ x: cx, y: cy }, { x: cx, y: cy + dy * t }, 0, PAL.ink2, 0, 'butt', 1.6);
      }
    }
  }

  /** Two-level frontage roads: the upper deck over the road, on columns, with ramps at either end. */
  drawDecks(sim: Sim) {
    const z = this.cam.zoom; const g = this.ctx;
    for (const dk of sim.d.decks) {
      const n = norm({ x: -(dk.b.y - dk.a.y), y: dk.b.x - dk.a.x }); const d = norm(sub(dk.b, dk.a)); const L = dist(dk.a, dk.b);
      const ramp = FRONTAGE.ramp;
      const pts = [add(dk.a, mul(n, -dk.width / 2)), add(dk.b, mul(n, -dk.width / 2)), add(dk.b, mul(n, dk.width / 2)), add(dk.a, mul(n, dk.width / 2))];
      g.save(); g.shadowColor = 'rgba(40,36,30,0.35)'; g.shadowBlur = 6; g.shadowOffsetY = 3;
      this.poly(pts, '#B4AEA2'); g.restore();
      g.strokeStyle = PAL.roadEdge; g.lineWidth = 1.2; this.path(pts); g.stroke();
      if (z > 0.35) {
        g.setLineDash([Math.max(2, 4 * z), Math.max(3, 7 * z)]);
        this.line(dk.a, dk.b, 0.3, PAL.roadLine, 0, 'butt', 0.6);
        g.setLineDash([]);
        // ramps: where the deck meets the ground road
        for (const [e, s] of [[dk.a, 1], [dk.b, -1]] as const) {
          const r0 = e, r1 = add(e, mul(d, s * ramp));
          for (const k of [0.25, 0.5, 0.75]) { const q = lerp2(r0, r1, k); this.line(add(q, mul(n, -dk.width / 2)), add(q, mul(n, dk.width / 2)), 0.2, 'rgba(40,36,30,0.25)', 0, 'butt', 0.5); }
        }
      }
      if (z > 0.6) for (let s = ramp; s < L - ramp; s += 30) for (const side of [-1, 1]) {
        const c = add(add(dk.a, mul(d, s)), mul(n, side * (dk.width / 2 - 1.5)));
        const [x, y] = this.P(c.x, c.y); g.fillStyle = PAL.ink2; g.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
      if (z > 0.45 && this.lod !== 'airfield') {
        const rot = Math.atan2((dk.b.y - dk.a.y) * this.yScale, dk.b.x - dk.a.x); const up = Math.cos(rot) < 0;
        this.label('UPPER DECK · DEPARTURES', lerp2(dk.a, dk.b, 0.5), 0, 8, '#F4EDDF', { weight: 800, spacing: 1.4, rot: up ? rot + Math.PI : rot });
      }
    }
  }

  /** Road tool: where a road would grow a curb along each terminal face (FRONTAGE.ideal out, plus half the road). */
  drawFrontGuides(sim: Sim) {
    if (!this.showFront) return;
    const g = this.ctx; const z = this.cam.zoom;
    for (const gd of sim.d.frontGuides) {
      if (sim.d.zones.some(c => c.auto?.module === gd.zone.id)) continue;
      const off = FRONTAGE.ideal + 8;
      const a = add(gd.a, mul(gd.out, off)), b = add(gd.b, mul(gd.out, off));
      this.poly([add(gd.a, mul(gd.out, FRONTAGE.minGap)), add(gd.b, mul(gd.out, FRONTAGE.minGap)), add(gd.b, mul(gd.out, FRONTAGE.maxGap)), add(gd.a, mul(gd.out, FRONTAGE.maxGap))], 'rgba(47,93,124,0.06)');
      g.setLineDash([8, 6]); this.line(a, b, 0, PAL.select, 0, 'butt', 1.5); g.setLineDash([]);
      if (z > 0.3) {
        const rot = Math.atan2((b.y - a.y) * this.yScale, b.x - a.x); const up = Math.cos(rot) < 0;
        this.label('ROAD HERE → CURB', add(lerp2(a, b, 0.5), mul(gd.out, 12 / z)), 0, 9, PAL.select, { weight: 700, spacing: 1.2, rot: up ? rot + Math.PI : rot, bg: 'rgba(230,219,195,0.85)' });
      }
    }
  }

  /** Terminal level of detail: everything outside the open terminal's site steps back. */
  drawFocus(sim: Sim) {
    if (this.lod !== 'terminal' || this.focus === null) return;
    const st = sim.world.sites?.find(q => q.id === this.focus); if (!st) return;
    const g = this.ctx; const r = padRect(st, 30);
    const [x0, y0] = this.P(r.x, r.y), [x1, y1] = this.P(r.x + r.w, r.y + r.h);
    g.save(); g.fillStyle = 'rgba(222,209,182,0.55)';
    g.beginPath(); g.rect(0, 0, this.W, this.H); g.rect(x1, y0, x0 - x1, y1 - y0); g.fill('evenodd'); g.restore();
  }

  /** Gate slots: removed gates show as dashed stands you can click to add back. */
  drawGateSlots(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    if (z < 0.22) return;
    for (const sl of sim.d.gateSlots) {
      const sel = this.selected?.kind === 'gate' && this.selected.key === sl.key && this.selected.id === sl.zone.id;
      const hov = this.hover?.kind === 'gate' && this.hover.key === sl.key && this.hover.id === sl.zone.id;
      if (!sl.on) {
        g.setLineDash([4, 4]); g.strokeStyle = 'rgba(40,36,30,0.35)'; g.lineWidth = 1; this.path(sl.cell); g.stroke(); g.setLineDash([]);
        if (z > 0.4) this.label('+', lerp2(sl.door, sl.front, 0.45), 0, 14, 'rgba(40,36,30,0.45)', { weight: 600, spacing: 0 });
      }
      if (sel || hov) { g.strokeStyle = PAL.select; g.lineWidth = sel ? 2 : 1; g.setLineDash(sel ? [] : [4, 3]); this.path(sl.cell); g.stroke(); g.setLineDash([]); }
    }
  }

  /** Where to draw a taxiway so a concourse grows gates: the ideal line one stand depth out, and the reach band. */
  drawGateGuides(sim: Sim, all: boolean) {
    const g = this.ctx; const z = this.cam.zoom;
    for (const gd of sim.d.gateGuides) {
      const sel = this.selected?.kind === 'zone' && this.selected.id === gd.zone.id;
      if (!all && !sel) continue;
      if (gd.served && !sel) continue;
      const a = add(gd.a, mul(gd.out, gd.ideal)), b = add(gd.b, mul(gd.out, gd.ideal));
      const a2 = add(gd.a, mul(gd.out, gd.reach)), b2 = add(gd.b, mul(gd.out, gd.reach));
      this.poly([add(gd.a, mul(gd.out, gd.ideal - 6)), add(gd.b, mul(gd.out, gd.ideal - 6)), b2, a2], 'rgba(47,93,124,0.06)');
      g.setLineDash([8, 6]); this.line(a, b, 0, gd.served ? 'rgba(47,93,124,0.5)' : PAL.select, 0, 'butt', 1.5); g.setLineDash([]);
      if (z > 0.3 && !gd.served) {
        const rot = Math.atan2((b.y - a.y) * this.yScale, b.x - a.x); const up = Math.cos(rot) < 0;
        this.label('TAXIWAY HERE → GATES', add(lerp2(a, b, 0.5), mul(gd.out, 10 / z)), 0, 9, PAL.select, { weight: 700, spacing: 1.2, rot: up ? rot + Math.PI : rot, bg: 'rgba(230,219,195,0.85)' });
      }
    }
  }

  zoneLabel(sim: Sim, zn: Zone, top: number) {
    const z = this.cam.zoom;
    if (z < 0.42) return;
    const u = sim.d.units.get(zn.id);
    const def = ZONES[zn.type];
    let c = center(zn);
    const f = sim.d.frames.get(zn.id);
    for (const k of sim.d.cores) if (Math.abs(k.x - c.x) < 40 && Math.abs(k.y - c.y) < 18) c = { x: c.x, y: k.y + (c.y >= k.y ? 18 : -18) };
    const big = zn.type === 'curb' || zn.type === 'parking';
    const px = clamp(10 * z, 8, 11);
    const bg = 'rgba(240,232,215,0.82)';
    const title = zn.type === 'concourse' ? `CONCOURSE ${sim.d.gateLetter.get(zn.id) ?? ''}` : def.short.toUpperCase();
    this.label(title, c, top, px, big ? PAL.ink2 : PAL.ink, { weight: 700, spacing: 2, bg });
    if (u && z > 0.65) {
      const ls = sim.d.lease.get(zn.id);
      const sub2 = zn.type === 'concourse' ? `${u.count} gates · ${ls?.count ?? 0} of ${ls?.max ?? 0} lots open` : `${u.count} ${def.unit}`;
      this.label(sub2, { x: c.x, y: c.y + 13 / (z * this.yScale) }, top, px - 1.5, PAL.ink2, { weight: 500, spacing: 1, bg });
    }
  }

  selectOutline(zn: Zone, top: number) {
    const g = this.ctx;
    const sel = this.selected?.kind === 'zone' && this.selected.id === zn.id;
    const hov = this.hover?.kind === 'zone' && this.hover.id === zn.id;
    if (!sel && !hov) return;
    g.strokeStyle = PAL.select; g.lineWidth = sel ? 2 : 1; g.setLineDash(sel ? [] : [4, 3]);
    this.path(this.rectPts(zn), top); g.stroke(); g.setLineDash([]);
  }

  // ------------------------------------------------------------ moving things
  drawCars(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    if (z < 0.25) return;
    for (const c of sim.cars) {
      if (c.stage === 'gone') continue;
      const [x, y] = this.P(c.x, c.y);
      g.save(); g.translate(x, y); g.scale(1, this.yScale); g.rotate(c.ang);
      const L = Math.max(3, 4.6 * z), W = Math.max(1.6, 2 * z);
      g.fillStyle = c.pick ? PAL.ink : PAL.ink2;
      g.fillRect(-L / 2, -W / 2 + (c.stage === 'queue' || c.stage === 'bay' ? 0 : W * 0.6), L, W); g.restore();
    }
  }

  drawPax(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    if (z < 0.28) return;
    const tilted = this.tilt > 0.02;
    const r = clamp(0.75 * z, 0.9, 3);
    const cols = ['rgba(40,36,30,0.78)', PAL.warn, PAL.bad];
    const terminalZones = sim.d.zones.filter(q => ZONES[q.type].terminal);
    for (let m = 0; m < 3; m++) {
      g.fillStyle = cols[m];
      g.beginPath();
      for (const p of sim.pax) {
        if (p.stage === 'done' || p.mood !== m) continue;
        const indoor = terminalZones.some(q => q.level === p.level && p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h);
        if (indoor && p.level !== this.level) continue;
        if (!indoor && this.level !== 0 && tilted) continue;
        const zz = tilted && indoor ? LEVELS[p.level].z1 : 0;
        const [x, y] = this.P(p.x, p.y, zz);
        g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2);
      }
      g.fill();
    }
    // stranded passengers get a ring so they read at a glance
    if (z > 0.5) {
      g.strokeStyle = PAL.bad; g.lineWidth = 1;
      g.beginPath();
      for (const p of sim.pax) if (p.stage === 'stuck' && (p.level === this.level || !tilted)) { const [x, y] = this.P(p.x, p.y, tilted ? LEVELS[p.level].z1 : 0); g.moveTo(x + r + 2.5, y); g.arc(x, y, r + 2.5, 0, Math.PI * 2); }
      g.stroke();
    }
  }

  drawAircraft(sim: Sim) {
    const z = this.cam.zoom;
    for (const f of sim.flights) {
      if (f.state === 'pending' || f.state === 'hold' || f.state === 'gone' || f.state === 'cancelled' || !f.path.length) continue;
      const alt = f.alt;
      if (alt > 0.02) this.plane(f, f.x + 160 * alt, f.y + 120 * alt, 0, 'rgba(40,36,30,0.18)', 1);
      this.plane(f, f.x, f.y, alt * 260, PAL.ink, 1 + alt * 0.5);
      if (z > 1.3 && (f.state === 'stand' || f.state === 'taxiIn' || f.state === 'waitGate'))
        this.label(f.code, add({ x: f.x, y: f.y }, mul(norm(sub(f.gate.stand, f.gate.door)), f.ac.length / 2 + 10)), 0, 9, PAL.ink2, { weight: 600, spacing: 0.5 });
      if (f.state === 'stand' && z > 0.4) {
        const nose = add(f.gate.stand, mul(norm(sub(f.gate.door, f.gate.stand)), f.ac.length / 2 - 4));
        const side = add(nose, mul(norm({ x: -(f.gate.door.y - f.gate.stand.y), y: f.gate.door.x - f.gate.stand.x }), 3));
        this.line(f.gate.door, side, 3.2, PAL.bldgSide, 0);
        if (f.cls === 3) this.line(f.gate.door, add(side, mul(norm(sub(f.gate.stand, f.gate.door)), 14)), 3.2, PAL.bldgSide, 0);
      }
    }
  }

  plane(f: Flight, x: number, y: number, zLift: number, color: string, scale: number) {
    const g = this.ctx; const z = this.cam.zoom;
    const [sx, sy0] = this.P(x, y); const sy = sy0 - zLift * z * 0.4;
    const L = f.ac.length * scale, S = f.ac.span * scale;
    const k = Math.max(z, 7 / L);
    g.save(); g.translate(sx, sy); g.scale(k, k * this.yScale); g.rotate(f.ang);
    g.fillStyle = color; g.beginPath();
    const fw = L * (f.cls === 3 ? 0.07 : 0.055);
    g.moveTo(L / 2, 0); g.quadraticCurveTo(L / 2 - fw, -fw, L * 0.38, -fw); g.lineTo(-L * 0.46, -fw * 0.7); g.lineTo(-L / 2, 0);
    g.lineTo(-L * 0.46, fw * 0.7); g.lineTo(L * 0.38, fw); g.quadraticCurveTo(L / 2 - fw, fw, L / 2, 0);
    if (f.cls === 0) {   // turboprop: straight high wing
      g.moveTo(L * 0.08, -fw); g.lineTo(L * 0.08, -S / 2); g.lineTo(-L * 0.04, -S / 2); g.lineTo(-L * 0.04, -fw);
      g.moveTo(L * 0.08, fw); g.lineTo(L * 0.08, S / 2); g.lineTo(-L * 0.04, S / 2); g.lineTo(-L * 0.04, fw);
    } else {
      g.moveTo(L * 0.1, -fw); g.lineTo(-L * 0.12, -S / 2); g.lineTo(-L * 0.2, -S / 2); g.lineTo(-L * 0.06, -fw);
      g.moveTo(L * 0.1, fw); g.lineTo(-L * 0.12, S / 2); g.lineTo(-L * 0.2, S / 2); g.lineTo(-L * 0.06, fw);
    }
    g.moveTo(-L * 0.36, -fw); g.lineTo(-L * 0.47, -S * 0.17); g.lineTo(-L * 0.5, -S * 0.17); g.lineTo(-L * 0.45, 0);
    g.lineTo(-L * 0.5, S * 0.17); g.lineTo(-L * 0.47, S * 0.17); g.lineTo(-L * 0.36, fw);
    g.fill();
    g.restore();
  }

  drawLinks(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    for (const l of sim.d.links) {
      g.setLineDash([6, 5]);
      this.line(l.a, l.b, 0, PAL.bad, 0, 'round', 1.5);
      g.setLineDash([]);
      for (const p of [l.a, l.b]) { const [x, y] = this.P(p.x, p.y); g.fillStyle = PAL.bad; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
      if (z > 0.2) this.label(l.text.toUpperCase(), { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }, 0, 9, '#FFF6EA', { weight: 700, spacing: 1, bg: PAL.bad });
    }
  }

  drawLights(sim: Sim, n: number) {
    const g = this.ctx; const z = this.cam.zoom;
    g.save(); g.globalAlpha = n;
    g.fillStyle = '#F4E7C0';
    for (const r of sim.d.runways) {
      const step = z > 0.4 ? 60 : 180;
      for (let s = 0; s <= r.length; s += step) for (const side of [-1, 1]) {
        const p = add(add(r.rw.a, mul(r.dir, s)), mul(r.normal, side * (r.width / 2 + 3)));
        const [x, y] = this.P(p.x, p.y); g.fillRect(x - 1, y - 1, 2, 2);
      }
    }
    g.fillStyle = '#B9D3A8';
    for (const t of sim.world.ways) if (t.kind === 'taxi') {
      const L = dist(t.a, t.b); const step = z > 0.4 ? 50 : 150; const d = norm(sub(t.b, t.a));
      for (let s = 0; s <= L; s += step) { const p = add(t.a, mul(d, s)); const [x, y] = this.P(p.x, p.y); g.fillRect(x - 0.7, y - 0.7, 1.4, 1.4); }
    }
    g.fillStyle = '#F2D9A6';
    for (const t of sim.world.ways) if (t.kind === 'road') {
      const L = dist(t.a, t.b); const step = z > 0.4 ? 40 : 120; const d = norm(sub(t.b, t.a));
      for (let s = 0; s <= L; s += step) { const p = add(t.a, mul(d, s)); const [x, y] = this.P(p.x, p.y); g.fillRect(x - 0.6, y - 0.6, 1.2, 1.2); }
    }
    g.strokeStyle = 'rgba(244,205,140,0.8)'; g.lineWidth = 1.5;
    const tilted = this.tilt > 0.02;
    for (const zn of sim.d.zones) if (ZONES[zn.type].terminal && zn.level <= this.level) { this.path(this.rectPts(zn), tilted ? LEVELS[zn.level].z1 : 0); g.stroke(); }
    g.restore();
  }

  drawGhost() {
    const g = this.ctx; const gh = this.ghost;
    if (this.cursor && !gh) this.snapRing(this.cursor, true);
    if (!gh) return;
    const col = gh.ok ? PAL.select : PAL.bad;
    const top = this.tilt > 0.02 ? LEVELS[this.level].z1 : 0;
    if (gh.kind === 'zone' && gh.rect) {
      this.poly(this.rectPts(gh.rect), gh.ok ? 'rgba(47,93,124,0.16)' : 'rgba(176,71,43,0.18)', top);
      g.strokeStyle = col; g.lineWidth = 1.5; g.setLineDash([5, 4]); this.path(this.rectPts(gh.rect), top); g.stroke(); g.setLineDash([]);
    } else if (gh.kind === 'runway' && gh.a && gh.b) {
      const w = runwayWidth(dist(gh.a, gh.b));
      this.line(gh.a, gh.b, w, gh.ok ? 'rgba(40,36,30,0.55)' : 'rgba(176,71,43,0.55)');
      g.setLineDash([5, 4]);
      const n = norm({ x: -(gh.b.y - gh.a.y), y: gh.b.x - gh.a.x });
      for (const s of [-1, 1]) this.line(add(gh.a, mul(n, s * TUNE.runwayClear)), add(gh.b, mul(n, s * TUNE.runwayClear)), 0.8, col);
      g.setLineDash([]);
      this.ghostExtras(gh);
    } else if (gh.kind === 'way' && gh.a && gh.b && gh.way) {
      const w = wayWidth(gh.way.kind, gh.way.cls, gh.way.lanes);
      const fill = gh.way.kind === 'taxi' ? PAL.pave : gh.way.kind === 'road' ? PAL.road : PAL.walk;
      g.globalAlpha = 0.85;
      this.line(gh.a, gh.b, w + 2, gh.ok ? PAL.select : PAL.bad, 0, 'round', 3);
      this.line(gh.a, gh.b, w, fill, 0, 'round', 1.5);
      g.globalAlpha = 1;
      this.ghostExtras(gh);
      this.snapRing(gh.a, !!gh.snapA); this.snapRing(gh.b, !!gh.snapB);
    }
  }

  ghostExtras(gh: Ghost) {
    for (const x of gh.extras ?? []) {
      this.ctx.globalAlpha = 0.85;
      this.line(x.a, x.b, wayWidth('taxi', x.cls, 0) + 2, PAL.select, 0, 'round', 3);
      this.line(x.a, x.b, wayWidth('taxi', x.cls, 0), PAL.pave, 0, 'round', 1.5);
      this.ctx.globalAlpha = 1;
    }
  }

  snapRing(p: Pt, snapped: boolean) {
    const g = this.ctx; const [x, y] = this.P(p.x, p.y);
    g.strokeStyle = snapped ? PAL.select : 'rgba(40,36,30,0.5)'; g.lineWidth = snapped ? 2 : 1;
    g.beginPath(); g.arc(x, y, snapped ? 6 : 4, 0, Math.PI * 2); g.stroke();
    if (snapped) { g.fillStyle = PAL.select; g.beginPath(); g.arc(x, y, 2, 0, Math.PI * 2); g.fill(); }
  }
}

const rectsTouch = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
