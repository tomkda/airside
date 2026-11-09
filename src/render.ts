// Canvas renderer. Reads sim state, never writes it.
// Far zoom reads as an airport-diagram print; zooming in reveals fit-out, people and vehicles.
// "2.5D" is an oblique projection: y compresses and heights lift toward the top of the screen.
import { Pt, Rect, add, mul, sub, norm, clamp, center, dist, sliceLine, offsetLine, polyLen, along } from './geom';
import { PAL, SITE, ZONES, LEVELS, Level, TUNE, TAXI_CLASSES, CLASSES, COMMERCE, FRONTAGE, Lod, GROWTH, WeatherKind } from './config';
import type { Sim, Flight } from './sim';
import { Zone, Frame, WayKind, wayWidth, runwayWidth, siteOf, padRect } from './world';
import type { LItem } from './layout';
import { Renderer3D } from './render3d';
import { scenery } from './scenery';
import { roadPlan } from './roads';
import { isRingRef, wayPts, wayMid } from './ways';
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
  kind: 'zone' | 'runway' | 'way' | 'round'; rect?: Rect; a?: Pt; b?: Pt; c?: Pt; r?: number; ok: boolean;
  way?: { kind: WayKind; cls: number; lanes: number }; snapA?: boolean; snapB?: boolean;
  extras?: { a: Pt; b: Pt; cls: number }[];
}
export type Sel = { kind: 'zone' | 'runway' | 'way' | 'gate' | 'site' | 'round'; id: number; key?: string };

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
  weather: WeatherKind = 'clear';
  /** v0.9 feedback: modules pulse as they appear, and what you spent floats up from where you built. */
  private born = new Map<number, number>(); private knownIds: Set<number> | null = null; private dSeen: unknown = null;
  private floaters: { text: string; p: Pt; z: number; t0: number; color: string }[] = [];
  float(text: string, p: Pt, color: string = PAL.ink, z = 0) { this.floaters.push({ text, p, z, t0: performance.now(), color }); }
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
    if (sim.d !== this.dSeen) {
      this.dSeen = sim.d; const ids = new Set(sim.d.zones.map(q => q.id)); const now = performance.now();
      if (this.knownIds) for (const id of ids) if (!this.knownIds.has(id)) this.born.set(id, now);
      this.knownIds = ids;
    }
    if (this.mode3d && this.r3) {
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, this.W, this.H);
      this.r3.draw(sim, this.nightness(sim.t));
      if (this.weather !== 'fog') this.drawWeather(sim);
      this.drawFloaters();
      return;
    }
    this.tilt += (this.tiltTarget - this.tilt) * 0.18;
    if (Math.abs(this.tilt - this.tiltTarget) < 0.002) this.tilt = this.tiltTarget;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = PAL.groundDeep; g.fillRect(0, 0, this.W, this.H);

    const lod = this.lod;
    this.drawTerrain();
    this.drawRoads(sim);
    this.drawGround(sim);
    this.drawAirfield(sim);
    this.drawApronJoints(sim);
    this.drawLots(sim);
    if (lod !== 'airfield') this.drawWalks(sim);
    this.drawScenery(sim);
    this.drawDecks(sim);
    this.drawTrain(sim);
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
    this.drawPulses(sim);

    const n = this.nightness(sim.t);
    if (n > 0) {
      g.save(); g.globalCompositeOperation = 'multiply'; g.fillStyle = `rgba(70,78,118,${0.42 * n})`; g.fillRect(0, 0, this.W, this.H); g.restore();
      this.drawLights(sim, n);
    }
    this.drawWeather(sim);
    if (this.cam.zoom > 0.1) this.drawSheet();
    this.drawFloaters();
  }

  /** New modules and curbs: a ring that grows out from the outline and fades. */
  drawPulses(sim: Sim) {
    const now = performance.now(); const g = this.ctx;
    for (const [id, t0] of this.born) {
      const k = (now - t0) / 1100; if (k >= 1) { this.born.delete(id); continue; }
      const zn = sim.d.zones.find(q => q.id === id); if (!zn) continue;
      const grow = (8 + 22 * k) / this.cam.zoom;
      g.strokeStyle = zn.auto ? `rgba(194,133,46,${1 - k})` : `rgba(47,93,124,${1 - k})`; g.lineWidth = 3 * (1 - k) + 1;
      this.path(this.rectPts({ x: zn.x - grow, y: zn.y - grow, w: zn.w + 2 * grow, h: zn.h + 2 * grow }), 0); g.stroke();
      if (k < 0.5) this.poly(this.rectPts(zn), `rgba(255,248,230,${0.5 - k})`, 0);
    }
  }
  /** Costs and grants rising from where they happened. */
  drawFloaters() {
    const now = performance.now();
    this.floaters = this.floaters.filter(f => now - f.t0 < 1800);
    for (const f of this.floaters) {
      const k = (now - f.t0) / 1800;
      const [x, y] = this.P(f.p.x, f.p.y, f.z);
      const g = this.ctx; g.save(); g.globalAlpha = 1 - k * k;
      g.font = '800 15px Archivo, "Helvetica Neue", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 4; g.strokeStyle = 'rgba(244,237,223,0.95)'; g.strokeText(f.text, x, y - 46 * k);
      g.fillStyle = f.color; g.fillText(f.text, x, y - 46 * k); g.restore();
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

  // ------------------------------------------------------------ roads (vehicles), drawn from roads.ts
  curve(k: { p1: Pt; c: Pt; p2: Pt }, wM: number, color: string, minPx = 1) {
    const g = this.ctx; g.strokeStyle = color; g.lineWidth = Math.max(minPx, wM * this.cam.zoom); g.lineCap = 'butt';
    const [x1, y1] = this.P(k.p1.x, k.p1.y), [cx, cy] = this.P(k.c.x, k.c.y), [x2, y2] = this.P(k.p2.x, k.p2.y);
    g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cx, cy, x2, y2); g.stroke();
  }
  drawRoads(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom; const HY = SITE.highwayY;
    const RP = roadPlan(sim.d); const far = this.lod === 'airfield';
    const VERGE = 'rgba(150,158,118,0.28)', KERB = '#8A8375', ASPHALT = '#9C968A', HWY = '#948E83', LINE = '#F1EBDC', YEL = '#D9B24C';
    g.lineJoin = 'round';
    if (far) g.globalAlpha = 0.55;
    // grass verge, kerb, asphalt: each road as one smooth path, then the turning curves and ramps that round every junction
    const ringOut = (r: { r: number; w: number }) => r.r + r.w / 2;
    if (!far && z > 0.3) {
      for (const s of RP.paths) this.pline(s.pts, s.w + (s.hwy ? 14 : 9), VERGE, 'round', 2);
      for (const k of RP.ramps) this.curve(k, k.w + 9, VERGE, 2);
      for (const r of RP.rounds) this.disc(r.c, ringOut(r) + 5, VERGE);
    }
    for (const s of RP.paths) this.pline(s.pts, s.w + 1.6, KERB, 'round', 1.6);
    for (const k of [...RP.turns, ...RP.ramps]) this.curve(k, k.w + 1.6, KERB, 1.6);
    for (const r of RP.rounds) this.disc(r.c, ringOut(r) + 0.8, KERB);
    for (const s of RP.paths) this.pline(s.pts, s.w, s.hwy ? HWY : ASPHALT, 'round', 1);
    for (const k of [...RP.turns, ...RP.ramps]) this.curve(k, k.w, ASPHALT, 1);
    for (const r of RP.rounds) this.disc(r.c, ringOut(r), ASPHALT);
    g.globalAlpha = 1;
    // roundabouts: a paved truck apron round a planted island
    for (const r of RP.rounds) {
      const inner = r.r - r.w / 2;
      this.disc(r.c, inner, far ? '#B5BD92' : '#B9AE9B');
      if (far) continue;
      this.disc(r.c, inner - 0.3, '#C9BFAC'); this.disc(r.c, inner - 2.2, KERB); this.disc(r.c, inner - 2.6, '#B5BD92');
      if (z > 0.6 && inner > 9) this.ring(r.c, (inner - 2.6) * 0.62, 0.5, 'rgba(96,112,72,0.35)');
    }
    // congestion overlay
    if (this.overlay) for (const e of sim.d.road.edges) {
      const x = sim.edgeLoadRatio(e.id); if (x < 0.25) continue;
      const col = x < 0.5 ? 'rgba(194,133,46,0.55)' : x < 1 ? 'rgba(194,96,46,0.7)' : 'rgba(176,71,43,0.85)';
      this.line(sim.d.road.nodes[e.u], sim.d.road.nodes[e.v], e.kind === 'hwy' ? 24 : isRingRef(e.ref) ? 6 : wayWidth('road', 0, e.lanes), col, 0, 'round', 2);
    }
    if (z > 0.35 && !far) {
      const dash = [Math.max(2, 3 * z), Math.max(3, 6 * z)];
      for (const s of RP.paths) {
        if (s.len - s.trimA - s.trimB < 2) continue;
        const mid = sliceLine(s.pts, s.trimA, s.len - s.trimB);
        const off = (k: number, w: number, col: string, mp = 0.5) => this.pline(offsetLine(mid, k), w, col, 'butt', mp);
        // edge lines; on a one-way road the left one is yellow
        off(s.w / 2 - 0.5, 0.18, LINE); off(-(s.w / 2 - 0.5), 0.18, s.ow ? YEL : LINE);
        if (s.hwy) {   // three lanes each way either side of a barrier
          this.pline(s.pts, 1.2, '#7F7A70', 'butt', 1); this.pline(s.pts, 0.3, '#CFC8BA', 'butt', 0.5);
          g.setLineDash(dash); for (const k of [-8, -4.4, 4.4, 8]) this.pline(offsetLine(s.pts, k), 0.18, LINE, 'butt', 0.5); g.setLineDash([]);
        } else if (s.ow) {
          g.setLineDash(dash); for (const k of s.lanes >= 4 ? [-s.w / 4, 0, s.w / 4] : [0]) off(k, 0.18, LINE); g.setLineDash([]);
        } else if (s.lanes >= 4) {
          g.setLineDash(dash); for (const k of [-1, 1]) off(k * s.w / 4, 0.18, LINE); g.setLineDash([]);
          for (const k of [-1.1, 1.1]) off(k, 0.16, YEL);
        } else { g.setLineDash(dash); off(0, 0.2, YEL, 0.6); g.setLineDash([]); }
      }
      // planted medians, with a tree every 14 m
      for (const m of RP.medians) {
        this.pline(m, 1.9, '#8A8375', 'round', 1.2); this.pline(m, 1.5, '#B5BD92', 'round', 1);
        if (z > 0.8) { const L = polyLen(m); g.fillStyle = 'rgba(96,112,72,0.7)'; g.beginPath(); for (let u = 5; u < L - 3; u += 14) { const p = along(m, u).p; const [x, y] = this.P(p.x, p.y); g.moveTo(x + 1.6 * z, y); g.ellipse(x, y, 1.6 * z, 1.6 * z * this.yScale, 0, 0, Math.PI * 2); } g.fill(); }
      }
      // roundabout markings: splitter islands, yield lines, the ring's edge lines, arrows round the ring
      for (const il of RP.islands) { g.strokeStyle = KERB; g.lineWidth = Math.max(1, 0.5 * z); g.lineJoin = 'round'; this.path(il, 0); g.stroke(); this.poly(il, '#C9BFAC'); }
      if (z > 0.5) { g.setLineDash([Math.max(1.5, 0.9 * z), Math.max(1.5, 0.9 * z)]); for (const y of RP.yields) this.line(y.a, y.b, 0.5, LINE, 0, 'butt', 1); g.setLineDash([]); }
      for (const r of RP.rounds) {
        this.ring(r.c, r.r - r.w / 2 + 0.45, 0.18, YEL);
        if (r.lanes > 1) { g.setLineDash(dash); this.ring(r.c, r.r, 0.18, LINE); g.setLineDash([]); }
        // the outer edge line breaks at each entry
        const gaps = r.entries.map(e => ({ a: e.ang, h: Math.min(0.9, (e.w / 2 + 9) / ringOut(r)) })).sort((p, q) => p.a - q.a);
        if (!gaps.length) this.ring(r.c, ringOut(r) - 0.45, 0.18, LINE);
        else for (let i = 0; i < gaps.length; i++) {
          const a0 = gaps[i].a + gaps[i].h; const nx = gaps[(i + 1) % gaps.length]; let a1 = nx.a - nx.h; if (i === gaps.length - 1) a1 += Math.PI * 2;
          if (a1 > a0) this.ring(r.c, ringOut(r) - 0.45, 0.18, LINE, a0, a1);
        }
        if (z > 1) {
          const n = Math.max(3, Math.round(r.r / 5));
          for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + 0.3; if (r.entries.some(e => Math.abs(Math.atan2(Math.sin(a - e.ang), Math.cos(a - e.ang))) < 0.3)) continue; this.arrow({ x: r.c.x + Math.cos(a) * r.r, y: r.c.y + Math.sin(a) * r.r }, a - Math.PI / 2, 'ahead', LINE); }
        }
      }
      if (z > 0.55) for (const st of RP.stops) this.line(st.a, st.b, 0.5, LINE, 0, 'butt', 1);
      if (z > 1) for (const ar of RP.arrows) this.arrow(ar.p, ar.ang, ar.kind, LINE);
      // gate plazas: booths and barrier arms, IN on the right as you arrive
      if (z > 0.45) for (const gt of RP.gates) {
        const n = { x: -gt.dir.y, y: gt.dir.x }; const c = add(gt.p, mul(gt.dir, 3));
        this.poly([add(gt.p, mul(n, -6)), add(gt.p, mul(n, 6)), add(add(gt.p, mul(n, 6)), mul(gt.dir, 9)), add(add(gt.p, mul(n, -6)), mul(gt.dir, 9))], ASPHALT);
        this.poly([add(c, mul(n, -0.9)), add(c, mul(n, 0.9)), add(add(c, mul(n, 0.9)), mul(gt.dir, 3)), add(add(c, mul(n, -0.9)), mul(gt.dir, 3))], PAL.ink2);
        for (const k of [-1, 1]) this.line(add(c, mul(n, k * 0.9)), add(c, mul(n, k * 4.6)), 0.35, PAL.bad, 0, 'butt', 1.2);
        if (z > 1.2) {
          if (gt.twin) { const first = RP.gates.find(q => q.zone === gt.zone) === gt; this.label(first ? 'IN' : 'OUT', add(gt.p, mul(gt.dir, -5)), 0, 7.5, LINE, { weight: 800, spacing: 0.8 }); }
          else { this.label('IN', add(add(gt.p, mul(n, 2.4)), mul(gt.dir, -4)), 0, 7, LINE, { weight: 800, spacing: 0.5 }); this.label('OUT', add(add(gt.p, mul(n, -2.4)), mul(gt.dir, -4)), 0, 7, LINE, { weight: 800, spacing: 0.5 }); }
        }
      }
    }
    this.label('STATE ROUTE 12', { x: 1500, y: HY + 48 }, 0, clamp(60 * z, 8, 11), PAL.ink3, { spacing: 3 });
    this.label('TO LAKESHORE →', { x: SITE.cityX - 500, y: HY + 48 }, 0, clamp(60 * z, 8, 11), PAL.ink3, { spacing: 3 });
    for (const r of sim.world.ways) if (r.kind === 'road') this.wayHighlight(r.id, r.a, r.b, wayWidth('road', 0, r.lanes), wayPts(r));
    const sw = this.selected?.kind === 'way' ? sim.world.ways.find(q => q.id === this.selected!.id && q.kind !== 'taxi') : undefined;
    if (sw && !this.ghost) for (const [p, mid] of [[sw.a, false], [sw.b, false], ...(sw.kind === 'road' ? [[wayMid(sw), true] as const] : [])] as const) {
      const [x, y] = this.P(p.x, p.y);
      g.fillStyle = mid ? PAL.select : '#FBF8F1'; g.strokeStyle = PAL.select; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, mid ? 6 : 5, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    for (const r of RP.rounds) {
      const sel = this.selected?.kind === 'round' && this.selected.id === r.id, hov = this.hover?.kind === 'round' && this.hover.id === r.id;
      if (sel || hov) this.ring(r.c, ringOut(r) + 3, 3, sel ? 'rgba(47,93,124,0.45)' : 'rgba(47,93,124,0.25)');
    }
  }
  /** A painted lane arrow: ahead, or hooked left or right. */
  arrow(p: Pt, ang: number, kind: 'ahead' | 'left' | 'right', color: string) {
    const g = this.ctx; const z = this.cam.zoom; const [x, y] = this.P(p.x, p.y);
    g.save(); g.translate(x, y); g.scale(z, z * this.yScale); g.rotate(ang);
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 0.35; g.lineCap = 'butt';
    const k = kind === 'left' ? -1 : 1;
    g.beginPath(); g.moveTo(-3, 0); g.lineTo(kind === 'ahead' ? 1.5 : 0.6, 0); if (kind !== 'ahead') g.lineTo(0.6, k * 0.9); g.stroke();
    g.beginPath(); if (kind === 'ahead') { g.moveTo(3, 0); g.lineTo(1.2, -0.8); g.lineTo(1.2, 0.8); } else { g.moveTo(0.6, k * 2.3); g.lineTo(-0.2, k * 0.9); g.lineTo(1.4, k * 0.9); } g.closePath(); g.fill();
    g.restore();
  }

  // ------------------------------------------------------------ sidewalks (people): pale paving with fine edges
  drawWalks(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    const walks = [...sim.world.ways.filter(w => w.kind === 'walk'), ...sim.d.autoWalks];
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

  /** A stroked polyline, w metres wide. */
  pline(pts: Pt[], wM: number, color: string, cap: CanvasLineCap = 'butt', minPx = 0.6) {
    if (pts.length < 2) return;
    const g = this.ctx; g.strokeStyle = color; g.lineWidth = Math.max(minPx, wM * this.cam.zoom); g.lineCap = cap; g.lineJoin = 'round';
    this.path(pts, 0, false); g.stroke();
  }
  disc(c: Pt, r: number, fill: string) {
    const g = this.ctx; const [x, y] = this.P(c.x, c.y); const z = this.cam.zoom;
    g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, Math.max(0.5, r * z), Math.max(0.5, r * z * this.yScale), 0, 0, Math.PI * 2); g.fill();
  }
  ring(c: Pt, r: number, wM: number, color: string, a0 = 0, a1 = Math.PI * 2) {
    const g = this.ctx; const [x, y] = this.P(c.x, c.y); const z = this.cam.zoom;
    g.strokeStyle = color; g.lineWidth = Math.max(0.6, wM * z); g.lineCap = 'butt';
    g.beginPath(); g.ellipse(x, y, Math.max(0.5, r * z), Math.max(0.5, r * z * this.yScale), 0, a0, a1); g.stroke();
  }
  wayHighlight(id: number, a: Pt, b: Pt, w: number, pts?: Pt[]) {
    const sel = this.selected?.kind === 'way' && this.selected.id === id;
    const hov = this.hover?.kind === 'way' && this.hover.id === id;
    if (!sel && !hov) return;
    this.ctx.globalAlpha = sel ? 0.9 : 0.5;
    this.pline(pts ?? [a, b], w + 10, 'rgba(47,93,124,0.45)', 'round', 4);
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
        const decks = zn.floors ?? 1;
        if (decks > 1) this.shadow(zn, decks * 3.2);
        this.poly(this.rectPts(zn), decks > 1 ? '#BDB4A0' : PAL.paveLight);
        const used = sim.lotUsed / (sim.lotCapacity() || 1);
        if (z > 0.35) {
          g.strokeStyle = 'rgba(40,36,30,0.16)'; g.lineWidth = 1;
          for (let y = zn.y + 8; y < zn.y + zn.h - 4; y += 14) { this.path([{ x: zn.x + 6, y }, { x: zn.x + zn.w - 6, y }], 0, false); g.stroke(); }
          if (z > 1.1) {   // every car in its bay
            const cols = ['rgba(58,53,45,0.75)', 'rgba(140,133,118,0.8)', 'rgba(233,228,218,0.9)', 'rgba(176,71,43,0.75)', 'rgba(47,78,120,0.75)', 'rgba(94,122,85,0.7)'];
            for (let y = zn.y + 8; y < zn.y + zn.h - 4; y += 14) for (let x = zn.x + 7.35; x < zn.x + zn.w - 6; x += 2.7) for (const [dy, hx, hy] of [[-5, x, y], [1.4, y, x]] as const) {
              const r = hash2(hx, hy); if (r > used) continue;
              this.poly(this.rectPts({ x: x - 0.9, y: y + dy, w: 1.8, h: 4.2 }), cols[Math.floor(r * 977) % cols.length]);
            }
          } else { const rows = Math.floor((zn.h - 12) / 14); for (let i = 0; i < Math.round(rows * used); i++) this.poly(this.rectPts({ x: zn.x + 8, y: zn.y + 8 + i * 14 + 3, w: zn.w - 16, h: 8 }), 'rgba(110,100,84,0.35)'); }
        }
        if (decks > 1) {   // a garage: heavy edge, a ramp helix in the corner, the deck count
          g.strokeStyle = PAL.ink2; g.lineWidth = 2; this.path(this.rectPts(zn)); g.stroke();
          const c = { x: zn.x + 14, y: zn.y + 14 }; const [cx, cy] = this.P(c.x, c.y);
          g.strokeStyle = PAL.ink2; g.lineWidth = 1.2; for (const r of [4, 8, 11]) { g.beginPath(); g.ellipse(cx, cy, r * z, r * z * this.yScale, 0, 0, Math.PI * 1.6); g.stroke(); }
          if (z > 0.3) this.label(`P × ${decks}`, { x: zn.x + zn.w - 24 / z, y: zn.y + 12 / z }, 0, 10, PAL.ink, { weight: 900, spacing: 0.5, bg: 'rgba(240,232,215,0.85)' });
        }
        this.zoneLabel(sim, zn, 0);
      } else if (zn.type === 'rideshare' || zn.type === 'rental' || zn.type === 'bus' || zn.type === 'hotel' || zn.type === 'train') {
        this.facility(sim, zn);
      } else if (zn.type === 'curb') {
        if (zn.level !== this.level && order.some(o => o.type === 'curb' && o.level === this.level && rectsTouch(o, zn))) continue;
        // the curbside cross-section, from the building out: sidewalk, two pull-in lanes, a planted island with
        // crossings, then the through lanes that merge with the road (ACRP Report 40's inner and outer roadways)
        const f = sim.d.frames.get(zn.id)!; const D = f.depth; const upper = zn.level === 1;
        const band = (v0: number, v1: number) => [add(f.a, mul(f.inward, D * v0)), add(f.b, mul(f.inward, D * v0)), add(f.b, mul(f.inward, D * v1)), add(f.a, mul(f.inward, D * v1))];
        const at = (u: number, v: number) => add(add(f.a, mul(f.along, u)), mul(f.inward, D * v));
        this.poly(this.rectPts(zn), upper ? '#ABA598' : '#9C968A');
        this.poly(band(0, 0.26), PAL.walk);
        this.line(at(0, 0.26), at(f.edgeLen, 0.26), 0.3, PAL.walkEdge, 0, 'butt', 0.6);
        if (z > 0.5) {
          const L = f.edgeLen;
          g.setLineDash([Math.max(2, 3 * z), Math.max(3, 5 * z)]); this.line(at(4, 0.43), at(L - 4, 0.43), 0.18, PAL.roadLine, 0, 'butt', 0.5); g.setLineDash([]);
          // island: planted, broken by a crossing every ~36 m
          const nX = Math.max(1, Math.round(L / 36)); const gap = 5;
          for (let k = 0; k <= nX; k++) {
            const u0 = k === 0 ? 3 : (L * k) / nX - 0 + gap / 2, u1 = k === nX ? L - 3 : (L * (k + 1)) / nX - gap / 2;
            if (k === nX || u1 - u0 < 3) continue;
            this.poly([at(u0, 0.6), at(u1, 0.6), at(u1, 0.7), at(u0, 0.7)], '#8A8375'); this.poly([at(u0 + 0.3, 0.615), at(u1 - 0.3, 0.615), at(u1 - 0.3, 0.685), at(u0 + 0.3, 0.685)], '#B5BD92');
            if (z > 0.9) { g.fillStyle = 'rgba(96,112,72,0.75)'; g.beginPath(); for (let u = u0 + 4; u < u1 - 2; u += 9) { const [x, y] = this.P(at(u, 0.65).x, at(u, 0.65).y); g.moveTo(x + 1.3 * z, y); g.arc(x, y, 1.3 * z, 0, Math.PI * 2); } g.fill(); }
            if (k > 0 && z > 0.7) for (let s = 0.28; s < 0.98; s += 0.07) { const c = at((L * k) / nX, s); this.line(add(c, mul(f.along, -1.8)), add(c, mul(f.along, 1.8)), 0.55, PAL.roadLine, 0, 'butt', 0.8); }
          }
          if (z > 0.9) for (let u = 6; u < L - 4; u += 9) this.line(at(u, 0.27), at(u, 0.34), 0.15, PAL.roadLine, 0, 'butt', 0.5);   // bay ticks
          if (z > 1.3 && L > 60) {
            const txt = zn.auto?.deck === 'dep' ? 'DEPARTURES' : zn.auto?.deck === 'arr' ? 'ARRIVALS' : 'DROP-OFF · PICK-UP';
            const rot = Math.atan2(f.along.y * this.yScale, f.along.x); const flip = Math.cos(rot) < 0;
            for (const u of L > 200 ? [L * 0.25, L * 0.75] : [L / 2]) this.label(txt, at(u, 0.5), 0, 8, 'rgba(241,235,220,0.9)', { weight: 800, spacing: 2.5, rot: flip ? rot + Math.PI : rot });
          }
        }
        if (this.lod !== 'airfield' && (zn.level === this.level || this.cam.zoom < 0.7)) this.zoneLabel(sim, zn, 0);
      }
      if (!ZONES[zn.type].terminal) this.selectOutline(zn, 0);
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
    if (!tilted) for (const zn of zones) if (zn.level <= active) this.shadow(zn, LEVELS[zn.level].z1 * 0.9);
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
        this.roofPlan(zn, top);
        labels.push([zn, top]);
      } else if (isActive) this.roofPlan(zn, top);
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

  /** A soft cast shadow to the south-east, as long as the thing is tall: what makes a plan read as buildings. */
  shadow(r: Rect, h: number) {
    const k = h * 0.55; const g = this.ctx;
    g.fillStyle = 'rgba(40,36,30,0.13)';
    this.path([{ x: r.x + r.w, y: r.y }, { x: r.x + r.w + k, y: r.y + k }, { x: r.x + r.w + k, y: r.y + r.h + k }, { x: r.x + k, y: r.y + r.h + k }, { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h }]); g.fill();
  }

  /** Landside facilities (v0.10), each drawn so it reads at a glance on the plan. */
  facility(sim: Sim, zn: Zone) {
    const g = this.ctx; const z = this.cam.zoom; const horiz = zn.w >= zn.h;
    const ok = sim.d.served.has(zn.id);
    const R = (x: number, y: number, w: number, h: number) => this.rectPts({ x: zn.x + x, y: zn.y + y, w, h });
    if (zn.type === 'hotel') {
      this.shadow(zn, GROWTH.hotelFloors * 3.6);
      this.poly(this.rectPts(zn), '#C9BFAC'); g.strokeStyle = PAL.ink2; g.lineWidth = 1.5; this.path(this.rectPts(zn)); g.stroke();
      // a double-loaded corridor with rooms either side
      const c = horiz ? R(3, zn.h / 2 - 1.2, zn.w - 6, 2.4) : R(zn.w / 2 - 1.2, 3, 2.4, zn.h - 6);
      this.poly(c, 'rgba(244,237,223,0.7)');
      if (z > 0.7) { g.strokeStyle = 'rgba(40,36,30,0.3)'; g.lineWidth = 0.8; g.beginPath(); const L = horiz ? zn.w : zn.h; for (let u = 4; u < L - 2; u += 4) { const a = horiz ? { x: zn.x + u, y: zn.y + 1 } : { x: zn.x + 1, y: zn.y + u }, b = horiz ? { x: zn.x + u, y: zn.y + zn.h - 1 } : { x: zn.x + zn.w - 1, y: zn.y + u }; const [x0, y0] = this.P(a.x, a.y), [x1, y1] = this.P(b.x, b.y); g.moveTo(x0, y0); g.lineTo(x1, y1); } g.stroke(); }
    } else if (zn.type === 'rental') {
      this.poly(this.rectPts(zn), PAL.paveLight);
      const bw = Math.min(zn.w, zn.h) * 0.3; const b = horiz ? { x: zn.x, y: zn.y, w: zn.w, h: bw } : { x: zn.x, y: zn.y, w: bw, h: zn.h };
      this.shadow(b, 6); this.poly(this.rectPts(b), PAL.bldgTop); g.strokeStyle = PAL.ink2; g.lineWidth = 1; this.path(this.rectPts(b)); g.stroke();
      if (z > 0.6) { const cols = ['rgba(58,53,45,0.7)', 'rgba(233,228,218,0.9)', 'rgba(140,133,118,0.8)']; for (let y = zn.y + (horiz ? bw + 5 : 5); y < zn.y + zn.h - 5; y += 7) for (let x = zn.x + (horiz ? 4 : bw + 4); x < zn.x + zn.w - 3; x += 2.9) this.poly(this.rectPts({ x, y, w: 1.9, h: 4.4 }), cols[Math.floor(hash2(x, y) * 3)]); }
    } else if (zn.type === 'rideshare') {
      this.poly(this.rectPts(zn), PAL.road);
      if (z > 0.5) { const L = horiz ? zn.w : zn.h; for (let u = 6; u < L - 4; u += 7) { const a = horiz ? { x: zn.x + u, y: zn.y + 3 } : { x: zn.x + 3, y: zn.y + u }, b = horiz ? { x: zn.x + u + 3, y: zn.y + zn.h * 0.45 } : { x: zn.x + zn.w * 0.45, y: zn.y + u + 3 }; this.line(a, b, 0.3, PAL.roadLine, 0, 'butt', 0.6); } }
      this.poly(horiz ? R(0, zn.h - 5, zn.w, 5) : R(zn.w - 5, 0, 5, zn.h), PAL.walk);
    } else if (zn.type === 'bus') {
      this.poly(this.rectPts(zn), PAL.road);
      const L = horiz ? zn.w : zn.h; const S = horiz ? zn.h : zn.w;
      this.poly(horiz ? R(0, 0, zn.w, S * 0.38) : R(0, 0, S * 0.38, zn.h), PAL.walk);
      for (let u = 4; u + 12 < L; u += 14) {   // sawtooth bays, a bus in every other one
        const bay = horiz ? { x: zn.x + u, y: zn.y + S * 0.45, w: 12, h: 3 } : { x: zn.x + S * 0.45, y: zn.y + u, w: 3, h: 12 };
        g.setLineDash([3, 3]); g.strokeStyle = PAL.roadLine; g.lineWidth = 1; this.path(this.rectPts(bay)); g.stroke(); g.setLineDash([]);
        if (ok && hash2(u, zn.id + Math.floor(sim.t / 20)) > 0.45) this.poly(this.rectPts(bay), '#5E7A55');
        const sh = horiz ? { x: zn.x + u + 2, y: zn.y + 2, w: 8, h: 2.4 } : { x: zn.x + 2, y: zn.y + u + 2, w: 2.4, h: 8 };
        this.poly(this.rectPts(sh), 'rgba(176,192,196,0.8)');
      }
    } else {   // AirTrain station: platform either side of the track
      this.shadow(zn, 9);
      this.poly(this.rectPts(zn), '#D6CEBE'); g.strokeStyle = PAL.ink2; g.lineWidth = 1.5; this.path(this.rectPts(zn)); g.stroke();
      this.poly(horiz ? R(2, zn.h / 2 - 2, zn.w - 4, 4) : R(zn.w / 2 - 2, 2, 4, zn.h - 4), 'rgba(47,93,124,0.35)');
    }
    if (!ok) { g.setLineDash([5, 4]); g.strokeStyle = PAL.bad; g.lineWidth = 1.5; this.path(this.rectPts(zn)); g.stroke(); g.setLineDash([]); }
    if (this.lod !== 'airfield') this.zoneLabel(sim, zn, 0);
  }

  /** The AirTrain: a twin-beam guideway between stations, with trains shuttling along it. */
  drawTrain(sim: Sim) {
    const z = this.cam.zoom;
    for (const [i, l] of sim.d.trainLinks.entries()) {
      const n = norm({ x: -(l.b.y - l.a.y), y: l.b.x - l.a.x });
      this.line(l.a, l.b, 5, 'rgba(40,36,30,0.10)', 0, 'butt', 2);
      for (const s of [-1.4, 1.4]) this.line(add(l.a, mul(n, s)), add(l.b, mul(n, s)), 0.5, PAL.select, 0, 'butt', 1);
      const L = dist(l.a, l.b); if (z > 0.5) for (let u = 20; u < L; u += 30) { const p = lerp2(l.a, l.b, u / L); this.line(add(p, mul(n, -2.2)), add(p, mul(n, 2.2)), 0.8, 'rgba(47,93,124,0.5)', 0, 'butt', 0.8); }
      // a train out and back, about every four minutes
      const T = Math.max(1.5, L / (TUNE.walkSpeed * GROWTH.trainSpeed)) + 1; const ph = ((sim.t + i * 1.7) % (2 * T)) / T; const k = ph < 1 ? ph : 2 - ph;
      const e = clamp((k * T - 0.5) / (T - 1), 0, 1); const c = lerp2(l.a, l.b, e); const d = norm(sub(l.b, l.a));
      this.line(add(c, mul(d, -9)), add(c, mul(d, 9)), 3.2, '#F4EDDF', 0, 'round', 3); this.line(add(c, mul(d, -9)), add(c, mul(d, 9)), 1.2, PAL.select, 0, 'butt', 1);
    }
  }

  /** Under everything: farmland parcels in the countryside and depth rings in the lake, like a survey sheet. */
  drawGround(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom; void sim;
    const b = SITE.buildable;
    for (let x = 0; x < SITE.cityX - 200; x += 420) for (let y = 0; y < SITE.height; y += 360) {
      const inside = x + 420 > b.x && x < b.x + b.w && y + 360 > b.y && y < b.y + b.h; if (inside) continue;
      const h = hash2(x, y); if (h < 0.35) continue;
      const r = { x: x + 20 + h * 60, y: y + 20, w: 240 + h * 120, h: 200 + hash2(y, x) * 110 };
      if (pointInLake(r.x, r.y) || pointInLake(r.x + r.w, r.y + r.h) || Math.abs(r.y + r.h / 2 - SITE.highwayY) < 220) continue;
      this.poly(this.rectPts(r), h > 0.7 ? 'rgba(170,160,110,0.16)' : 'rgba(150,160,120,0.14)');
      if (z > 0.18) { g.save(); this.path(this.rectPts(r)); g.clip(); g.strokeStyle = 'rgba(120,112,84,0.16)'; g.lineWidth = 1; g.beginPath(); const step = 16; const diag = h > 0.6; for (let k = -r.h; k < r.w + r.h; k += step) { const [x0, y0] = this.P(r.x + k, r.y + (diag ? r.h : 0)), [x1, y1] = this.P(r.x + k + (diag ? r.h : 0), r.y + (diag ? 0 : r.h)); g.moveTo(x0, y0); g.lineTo(x1, y1); } g.stroke(); g.restore(); }
    }
    const cx = SITE.lake.reduce((n, p) => n + p.x, 0) / SITE.lake.length, cy = SITE.lake.reduce((n, p) => n + p.y, 0) / SITE.lake.length;
    g.strokeStyle = 'rgba(120,128,128,0.35)'; g.lineWidth = 0.8;
    for (const k of [0.88, 0.74, 0.58]) { this.path(SITE.lake.map(p => ({ x: 0 + (p.x - 0) * k + (cx * 0.12) * (1 - k), y: 0 + (p.y - 0) * k + (cy * 0.12) * (1 - k) }))); g.stroke(); }
  }

  /** Concrete slab joints on the aprons, close in. */
  drawApronJoints(sim: Sim) {
    const z = this.cam.zoom; if (z < 0.9) return;
    const g = this.ctx; g.strokeStyle = 'rgba(40,36,30,0.07)'; g.lineWidth = 1; g.beginPath();
    for (const ap of sim.d.aprons) { const r = ap.rect;
      for (let x = r.x + 7.5; x < r.x + r.w; x += 7.5) { const [x0, y0] = this.P(x, r.y), [x1, y1] = this.P(x, r.y + r.h); g.moveTo(x0, y0); g.lineTo(x1, y1); }
      for (let y = r.y + 7.5; y < r.y + r.h; y += 7.5) { const [x0, y0] = this.P(r.x, y), [x1, y1] = this.P(r.x + r.w, y); g.moveTo(x0, y0); g.lineTo(x1, y1); } }
    g.stroke();
  }

  /** Weather over the plan: rain streaks blown with the wind, a fog veil, or snow on the ground and in the air. */
  drawWeather(sim: Sim) {
    const w = this.weather; if (w === 'clear') return;
    const g = this.ctx; const t = performance.now() / 1000;
    g.save();
    if (w === 'fog') { const gr = g.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.15, this.W / 2, this.H / 2, this.H * 0.85); gr.addColorStop(0, 'rgba(236,232,224,0.25)'); gr.addColorStop(1, 'rgba(236,232,224,0.8)'); g.fillStyle = gr; g.fillRect(0, 0, this.W, this.H); }
    else {
      g.fillStyle = w === 'rain' ? 'rgba(70,84,104,0.16)' : 'rgba(250,250,252,0.3)'; g.fillRect(0, 0, this.W, this.H);
      const a = ((sim.wind.from + 180) * Math.PI) / 180; const dx = Math.sin(a), dy = -Math.cos(a);
      g.strokeStyle = w === 'rain' ? 'rgba(60,76,100,0.35)' : 'rgba(255,255,255,0.9)'; g.fillStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1; g.beginPath();
      const n = w === 'rain' ? 260 : 200; const sp = w === 'rain' ? 520 : 60;
      for (let i = 0; i < n; i++) {
        const hx = Math.sin(i * 127.1) * 43758.5453, hy = Math.sin(i * 311.7) * 43758.5453;
        const x = (((hx - Math.floor(hx)) * this.W + dx * t * sp + (w === 'snow' ? Math.sin(t + i) * 12 : 0)) % this.W + this.W) % this.W;
        const y = (((hy - Math.floor(hy)) * this.H + (dy * 0.4 + 1) * t * sp) % this.H + this.H) % this.H;
        if (w === 'rain') { g.moveTo(x, y); g.lineTo(x + dx * 5 + 1, y + 9); } else { g.moveTo(x + 1.6, y); g.arc(x, y, 1.6, 0, Math.PI * 2); }
      }
      if (w === 'rain') g.stroke(); else g.fill();
    }
    g.restore();
  }

  /** North arrow and scale bar, bottom left, like any drawing. */
  drawSheet() {
    const g = this.ctx; const z = this.cam.zoom;
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000]; const m = nice.find(v => v * z >= 70) ?? 2000; const px = m * z;
    const x = this.W > 820 ? 400 : 16, y = this.H - 26;
    g.save(); g.fillStyle = PAL.ink2; g.strokeStyle = PAL.ink2; g.lineWidth = 1.2;
    g.fillRect(x, y, px / 2, 4); g.strokeRect(x, y, px, 4);
    g.font = '600 10px "Spline Sans Mono", ui-monospace, monospace'; g.textBaseline = 'bottom'; g.textAlign = 'left'; g.fillText('0', x - 2, y - 3); g.textAlign = 'right'; g.fillText(`${m >= 1000 ? m / 1000 + ' km' : m + ' m'}`, x + px + 2, y - 3);
    const nx = x + px + 34, ny = y - 4;
    g.beginPath(); g.moveTo(nx, ny - 20); g.lineTo(nx + 6, ny + 2); g.lineTo(nx, ny - 3); g.lineTo(nx - 6, ny + 2); g.closePath(); g.fill();
    g.textAlign = 'center'; g.font = '800 10px Archivo, Arial, sans-serif'; g.fillText('N', nx, ny - 21);
    g.restore();
  }

  /** A roof plan for a module seen as massing: parapet line, a clerestory down a concourse, plant enclosures. */
  roofPlan(zn: Zone, top: number) {
    const z = this.cam.zoom; if (z < 0.2) return;
    const g = this.ctx; const k = Math.min(2.5, 1.2 / Math.max(z, 0.3));
    g.strokeStyle = 'rgba(244,237,223,0.55)'; g.lineWidth = 1;
    this.path(this.rectPts({ x: zn.x + k, y: zn.y + k, w: zn.w - 2 * k, h: zn.h - 2 * k }), top); g.stroke();
    if (zn.type === 'concourse') {
      const horiz = zn.w >= zn.h; const wC = Math.min(12, (horiz ? zn.h : zn.w) * 0.28);
      const r = horiz ? { x: zn.x + 8, y: zn.y + zn.h / 2 - wC / 2, w: zn.w - 16, h: wC } : { x: zn.x + zn.w / 2 - wC / 2, y: zn.y + 8, w: wC, h: zn.h - 16 };
      if (zn.mezz) { const m = horiz ? { x: r.x - 2, y: r.y - 5, w: r.w + 4, h: r.h + 10 } : { x: r.x - 5, y: r.y - 2, w: r.w + 10, h: r.h + 4 }; this.shadow(m, 5); this.poly(this.rectPts(m), 'rgba(244,237,223,0.55)', top); g.strokeStyle = 'rgba(40,36,30,0.3)'; this.path(this.rectPts(m), top); g.stroke(); }
      this.poly(this.rectPts(r), 'rgba(176,192,196,0.45)', top);
      g.strokeStyle = 'rgba(40,36,30,0.25)'; this.path(this.rectPts(r), top); g.stroke();
      if (z > 0.6) { const n = Math.floor((horiz ? r.w : r.h) / 7.5); g.beginPath(); for (let i = 1; i < n; i++) { const a = horiz ? { x: r.x + i * 7.5, y: r.y } : { x: r.x, y: r.y + i * 7.5 }, b = horiz ? { x: a.x, y: r.y + r.h } : { x: r.x + r.w, y: a.y }; const [x0, y0] = this.P(a.x, a.y, top), [x1, y1] = this.P(b.x, b.y, top); g.moveTo(x0, y0); g.lineTo(x1, y1); } g.stroke(); }
    } else if (z > 0.35) {
      const h = Math.sin(zn.x * 12.9898 + zn.y * 78.233) * 43758.5453; const kk = h - Math.floor(h);
      for (let i = 0; i < 2; i++) {
        const w = 10 + kk * 8, hh = 6 + i * 3; const x = zn.x + zn.w * (0.25 + 0.4 * i) - w / 2, y = zn.y + zn.h * (0.35 + 0.25 * ((kk + i) % 1)) - hh / 2;
        if (w < zn.w - 6 && hh < zn.h - 6) { this.poly(this.rectPts({ x, y, w, h: hh }), 'rgba(124,114,95,0.35)', top); }
      }
    }
  }

  /** Planting, apron floodlight masts and the control tower, drawn like trees on a landscape plan. */
  drawScenery(sim: Sim) {
    const g = this.ctx; const z = this.cam.zoom;
    if (z < 0.12) return;
    const sc = scenery(sim.world, sim.d);
    const [vx0, vy0] = [this.toWorld(0, 0), this.toWorld(this.W, this.H)].map(p => p) as unknown as [Pt, Pt];
    const view = { x0: vx0.x - 20, y0: vx0.y - 20, x1: vy0.x + 20, y1: vy0.y + 20 };
    const shade = ['rgba(122,133,92,0.30)', 'rgba(108,122,84,0.34)', 'rgba(140,140,98,0.28)'];
    for (let k = 0; k < 3; k++) {
      g.fillStyle = shade[k]; g.beginPath();
      for (const t of sc.trees) {
        if (Math.floor(t.k * 3) !== k || t.x < view.x0 || t.x > view.x1 || t.y < view.y0 || t.y > view.y1) continue;
        const [x, y] = this.P(t.x, t.y); const r = Math.max(1.2, t.s * 0.45 * z);
        g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2);
      }
      g.fill();
    }
    if (z > 0.5) {   // crown outlines and trunk dots, like a planting plan
      g.strokeStyle = 'rgba(78,88,58,0.35)'; g.lineWidth = 0.8; g.beginPath();
      for (const t of sc.trees) { if (t.x < view.x0 || t.x > view.x1 || t.y < view.y0 || t.y > view.y1) continue; const [x, y] = this.P(t.x, t.y); const r = t.s * 0.45 * z; g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2); }
      g.stroke();
    }
    if (z > 0.35) { g.fillStyle = PAL.ink2; for (const m of sc.masts) { const [x, y] = this.P(m.x, m.y); g.fillRect(x - 1.5, y - 1.5, 3, 3); } }
    if (sc.tower) {
      const [x, y] = this.P(sc.tower.x, sc.tower.y); const r = Math.max(4, 8 * z);
      g.fillStyle = PAL.bldgTop; g.strokeStyle = PAL.ink; g.lineWidth = 1.5;
      g.beginPath(); for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r * this.yScale; i ? g.lineTo(px, py) : g.moveTo(px, py); } g.closePath(); g.fill(); g.stroke();
      g.fillStyle = PAL.ink; g.beginPath(); g.arc(x, y, r * 0.35, 0, Math.PI * 2); g.fill();
      if (z > 0.25) this.label('TWR', { x: sc.tower.x, y: sc.tower.y + (r + 9) / z }, 0, 8, PAL.ink2, { weight: 800, spacing: 1.2 });
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
      if (z > 0.45) this.tail(f, f.x, f.y, alt * 260, 1 + alt * 0.5);
      if (f.state === 'stand' && z > 0.9 && sim.t - f.standT > 3 && f.readyT - sim.t > 6) this.turnaround(f);
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

  /** The airline's colour on the fin, so a busy apron reads by carrier. */
  tail(f: Flight, x: number, y: number, zLift: number, scale: number) {
    const g = this.ctx; const z = this.cam.zoom;
    const [sx, sy0] = this.P(x, y); const sy = sy0 - zLift * z * 0.4;
    const L = f.ac.length * scale, S = f.ac.span * scale; const k = Math.max(z, 7 / L);
    g.save(); g.translate(sx, sy); g.scale(k, k * this.yScale); g.rotate(f.ang);
    g.fillStyle = f.airline.color; g.beginPath();
    g.moveTo(-L * 0.36, 0); g.lineTo(-L * 0.47, -S * 0.17); g.lineTo(-L * 0.5, -S * 0.17); g.lineTo(-L * 0.45, 0); g.lineTo(-L * 0.5, S * 0.17); g.lineTo(-L * 0.47, S * 0.17); g.closePath(); g.fill();
    g.fillRect(-L * 0.47, -L * 0.012, L * 0.2, L * 0.024);
    g.restore();
  }
  /** Turnaround: bag carts aft, a catering truck forward, fuel under the wing, the pushback tug at the nose. */
  turnaround(f: Flight) {
    const g = this.ctx; const z = this.cam.zoom; const L = f.ac.length, S = f.ac.span;
    const dv = { x: Math.cos(f.ang), y: Math.sin(f.ang) }; const left = { x: dv.y, y: -dv.x }; const r = f.cls === 3 ? 3.6 : 2;
    const veh = (fx: number, fl: number, l: number, w: number, c: string) => {
      const p = add(add({ x: f.x, y: f.y }, mul(dv, fx)), mul(left, fl)); const [x, y] = this.P(p.x, p.y);
      g.save(); g.translate(x, y); g.scale(1, this.yScale); g.rotate(f.ang); g.fillStyle = c; g.fillRect(-l * z / 2, -w * z / 2, l * z, w * z); g.restore();
    };
    veh(L / 2 + 5, 0, 4.5, 2.2, '#B8962E');
    for (let k = 0; k < 3; k++) veh(-L * 0.22 - k * 4.2, -(r + 5), 3.4, 1.8, '#7C725F');
    veh(L * 0.32, r + 5, 7, 2.5, '#9C9483');
    veh(-L * 0.05, S * 0.3, 9, 2.6, '#B08A3A');
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
      const pts = wayPts(t); const L = polyLen(pts); const step = z > 0.4 ? 40 : 120;
      for (let s = 0; s <= L; s += step) { const p = along(pts, s).p; const [x, y] = this.P(p.x, p.y); g.fillRect(x - 0.6, y - 0.6, 1.2, 1.2); }
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
      const pts = wayPts({ a: gh.a, b: gh.b, c: gh.c });
      this.pline(pts, w + 2, gh.ok ? PAL.select : PAL.bad, 'round', 3);
      this.pline(pts, w, fill, 'round', 1.5);
      g.globalAlpha = 1;
      if (gh.c) { g.setLineDash([3, 4]); this.pline([gh.a, gh.c, gh.b], 0, 'rgba(47,93,124,0.5)', 'butt', 1); g.setLineDash([]); }
      this.ghostExtras(gh);
      this.snapRing(gh.a, !!gh.snapA); this.snapRing(gh.b, !!gh.snapB);
    } else if (gh.kind === 'round' && gh.a && gh.r) {
      g.globalAlpha = 0.85;
      this.disc(gh.a, gh.r + 1, gh.ok ? PAL.select : PAL.bad); this.disc(gh.a, gh.r, PAL.road); this.disc(gh.a, gh.r * 0.45, '#B5BD92');
      g.globalAlpha = 1;
      this.snapRing(gh.a, !!gh.snapA);
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

const hash2 = (a: number, b: number) => { const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return h - Math.floor(h); };
const pointInLake = (x: number, y: number) => { const L = SITE.lake; let c = false; for (let i = 0, j = L.length - 1; i < L.length; j = i++) if ((L[i].y > y) !== (L[j].y > y) && x < ((L[j].x - L[i].x) * (y - L[i].y)) / (L[j].y - L[i].y) + L[i].x) c = !c; return c; };
