// DOM UI and input. Translates player gestures into world edits; reads sim state for panels.
import { Pt, Rect, snap, sub, dist, clamp, area, rad, projT, lerpPt, inRect, norm, dot, pointInPoly } from './geom';
import { ZONES, ZoneType, Level, TUNE, SITE, LEVELS, CLASSES, Cls, TAXI_CLASSES, ROAD_LANES, WALK, rwyClass, COMMERCE, TENANTS, TenantId, Lod, LOD, SITES, FRONTAGE } from './config';
import { Sim, DAY_START, DAY_END, revTotal } from './sim';
import { GateSlot, slotAt, SIDE_NAMES, standDepth, sideReach } from './gates';
import { holdDepth, spineWidth, depthClass } from './bands';
import { Renderer, Sel } from './render';
import {
  World, Zone, Way, WayKind, canPlaceZone, canPlaceRunway, canPlaceWay, crosswind, windSamples, runwayUsable, segDistWay,
  designators, runwayCost, runwayWidth, wayWidth, wayCostPerM, wayName, autoConnectors, followRunwayEnd, WaySpec, Runway, rwyClassLabel,
  Site, siteOf, fitSite, isTerminalModule, inBuildable, padRect,
} from './world';
import { rectsOverlap, rectSegDist } from './geom';

export type Tool = 'select' | 'runway' | WayKind | ZoneType | 'demolish' | 'site';
type Hit = { kind: 'zone'; zone: Zone; lot?: string } | { kind: 'runway'; id: number } | { kind: 'way'; way: Way } | { kind: 'gate'; slot: GateSlot } | { kind: 'site'; site: Site } | null;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
export const money = (n: number) => {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${Math.round(a)}`;
};
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// Each tool belongs to the level of detail where it makes sense; picking it moves the map to that level.
const TOOLS: { id: Tool; label: string; key: string; icon: string; group?: string; lod?: Lod }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: '<path d="M4 3l9 5-4 1-2 4z"/>' },
  { id: 'runway', label: 'Runway', key: '1', group: 'Airfield', lod: 'airfield', icon: '<path d="M2 13L14 3" stroke-width="3"/>' },
  { id: 'taxi', label: 'Taxiway', key: '2', lod: 'airfield', icon: '<path d="M2 12h7l5-8" stroke-width="2.2"/>' },
  { id: 'site', label: 'New terminal', key: 'N', group: 'Terminal', icon: '<rect x="2" y="3" width="12" height="10" stroke-dasharray="2 1.5"/><path d="M8 5.5v5M5.5 8h5"/>' },
  { id: 'checkin', label: 'Check-in', key: '3', lod: 'terminal', icon: '<rect x="2" y="5" width="12" height="7"/><path d="M4 8h8"/>' },
  { id: 'security', label: 'Security', key: '4', lod: 'terminal', icon: '<rect x="2" y="4" width="12" height="9"/><path d="M5 4v9M8 4v9M11 4v9"/>' },
  { id: 'concourse', label: 'Concourse', key: '5', lod: 'terminal', icon: '<rect x="2" y="6" width="12" height="7"/><path d="M2 9.5h12M4 6V3M8 6V3M12 6V3M6 9.5v3.5M10 9.5v3.5"/>' },
  { id: 'claim', label: 'Bag claim', key: '6', lod: 'terminal', icon: '<rect x="2" y="4" width="12" height="9"/><rect x="4" y="7" width="8" height="3" rx="1.5"/>' },
  { id: 'road', label: 'Road', key: 'R', group: 'Landside', lod: 'landside', icon: '<path d="M2 5h12M2 11h12" stroke-width="1.6"/><path d="M3 8h2M7 8h2M11 8h2"/>' },
  { id: 'curb', label: 'Curb', key: '7', lod: 'landside', icon: '<path d="M2 6h12M2 11h12"/><path d="M5 8.5h2M9 8.5h2"/>' },
  { id: 'parking', label: 'Parking', key: '8', lod: 'landside', icon: '<rect x="2" y="3" width="12" height="10"/><path d="M6 11V6h2.5a1.5 1.5 0 010 3H6"/>' },
  { id: 'walk', label: 'Sidewalk', key: 'S', lod: 'landside', icon: '<path d="M2 9h12" stroke-width="3.5" stroke-opacity=".35"/><path d="M2 7h12M2 11h12"/>' },
  { id: 'demolish', label: 'Demolish', key: 'X', icon: '<path d="M4 4l8 8M12 4l-8 8"/>' },
];
const isWay = (t: Tool): t is WayKind => t === 'taxi' || t === 'road' || t === 'walk';

export interface Controls { speed: number; paused: boolean; save(): void; loadSample(): void; clearSite(): void }

export class UI {
  tool: Tool = 'select';
  tab: 'inspect' | 'ops' | 'report' = 'ops';
  opt = { taxi: 2, lanes: 2, conc: 2 as Cls, auto: 1 };
  private drag: null | {
    mode: 'pan' | 'runway' | 'zone' | 'move' | 'way' | 'extend' | 'site'; sx: number; sy: number; start: Pt; snapStart?: boolean;
    cam?: Pt; zone?: Zone; off?: Pt; moved?: boolean;
    rw?: Runway; end?: 'a' | 'b'; orig?: { a: Pt; b: Pt }; extras?: WaySpec[];
    pend?: { a: Pt; b: Pt; ok: boolean; cost: number; delta: number; follow: ReturnType<typeof followRunwayEnd> | null };
  } = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; zoom: number; mid: Pt; cam: Pt } | null = null;
  private lastPanel = 0;
  private confirmClear = 0;
  private click3d: Pt | null = null;

  constructor(public sim: Sim, public ren: Renderer, public ctl: Controls) {
    this.buildChrome();
    this.bindInput();
    this.setTool('select');
    this.setLevel(1);
    this.refresh(true);
  }

  get world(): World { return this.sim.world; }

  // ------------------------------------------------------------ chrome
  buildChrome() {
    $('#tools').innerHTML = TOOLS.map(t => `${t.group ? `<span class="group">${t.group}</span>` : ''}
      <button class="tool" data-tool="${t.id}" title="${t.label} (${t.key})" aria-label="${t.label}">
        <svg viewBox="0 0 16 16" aria-hidden="true">${t.icon}</svg><span>${t.label}</span><kbd>${t.key}</kbd>
      </button>`).join('');
    $('#tools').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('[data-tool]') as HTMLElement | null;
      if (b) this.setTool(b.dataset.tool as Tool);
    });
    $('#toolopts').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('[data-opt]') as HTMLElement | null; if (!b) return;
      const [k, v] = b.dataset.opt!.split(':');
      (this.opt as Record<string, number>)[k] = Number(v);
      this.renderToolOpts(); this.hint(this.toolHint());
    });
    $('#levels').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (!b) return;
      if (b.dataset.level) this.setLevel(Number(b.dataset.level) as Level);
      if (b.id === 'view3d') this.set3d(!this.ren.mode3d);
      if (b.dataset.lod) this.goLod(b.dataset.lod as Lod);
      if (b.id === 'heat') this.setHeat(this.ren.overlay ? null : 'queues');
      if (b.id === 'commerce') this.setHeat(this.ren.commerce ? null : 'commerce');
    });
    $('#speed').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (!b) return;
      if (b.dataset.speed === '0') this.ctl.paused = !this.ctl.paused;
      else { this.ctl.speed = Number(b.dataset.speed); this.ctl.paused = false; }
      this.syncSpeed();
    });
    document.querySelectorAll<HTMLElement>('#tabs [data-tab]').forEach(b => b.addEventListener('click', () => { this.tab = b.dataset.tab as UI['tab']; this.refresh(true); }));
    $('#panelToggle').addEventListener('click', () => document.body.classList.toggle('panel-open'));
    $('#checkToggle').addEventListener('click', () => document.body.classList.toggle('check-open'));
    this.syncSpeed();
    this.ren.canvas.addEventListener('dblclick', e => {
      const h = this.hitTest(this.wpt(e as unknown as PointerEvent), true);
      const st = h?.kind === 'site' ? h.site : h?.kind === 'zone' ? siteOf(this.world, h.zone) : undefined;
      if (st) this.openTerminal(st);
    });
  }

  // ------------------------------------------------------------ levels of detail
  /** Pick a level of detail directly (buttons, keys): the camera frames what that level is about. */
  goLod(l: Lod) {
    if (l === 'terminal') {
      const st = this.pickSite();
      if (st) this.openTerminal(st); else { this.setTool('site'); this.toast('No terminal yet: draw one with New terminal (N).', 'warn'); }
      return;
    }
    if (!this.ren.mode3d) {
      const cam = this.ren.cam;
      if (l === 'airfield') { this.focusAirport(); this.ren.cam.zoom = Math.min(this.ren.cam.zoom, LOD.airfieldBelow - 0.02); }
      else if (cam.zoom < LOD.airfieldBelow || cam.zoom > LOD.terminalAbove) cam.zoom = 0.6;
    }
    this.setLod(l, null);
  }
  setLod(l: Lod, focus: number | null) {
    this.ren.lod = l; this.ren.focus = l === 'terminal' ? focus : null;
    document.querySelectorAll<HTMLElement>('#levels [data-lod]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lod === l)));
    document.querySelectorAll<HTMLElement>('.tool').forEach(b => {
      const t = TOOLS.find(x => x.id === b.dataset.tool);
      b.classList.toggle('other-lod', !!t?.lod && t.lod !== l);
    });
    const lv = document.querySelector('#levels .levels') as HTMLElement | null; if (lv) lv.hidden = l === 'airfield';
    if (l === 'airfield' && this.ren.level !== 1) this.setLevel(1);
    this.hint(this.toolHint());
  }
  /** The site to open: the selected one, else the one at the middle of the view, else the first. */
  pickSite(): Site | undefined {
    const sites = this.world.sites ?? [];
    const sel = this.ren.selected;
    if (sel?.kind === 'site') return sites.find(s => s.id === sel.id);
    if (sel?.kind === 'zone') { const z = this.sim.d.zones.find(q => q.id === sel.id); const st = z && siteOf(this.world, z); if (st) return st; }
    const c = { x: this.ren.cam.x, y: this.ren.cam.y };
    return sites.find(s => inRect(c, s, 60)) ?? [...sites].sort((a, b) => dist(c, center4(a)) - dist(c, center4(b)))[0];
  }
  /** Open a terminal: frame its site and show its fit-out; everything else steps back. */
  openTerminal(st: Site) {
    this.setLod('terminal', st.id);
    if (!this.ren.mode3d) {
      const zoom = clamp(Math.min((this.ren.W * 0.6) / (st.w + 80), (this.ren.H * 0.75) / (st.h + 80)), LOD.terminalAbove + 0.05, 4);
      this.ren.cam = { x: st.x + st.w / 2 + (this.ren.W > 820 ? 110 / zoom : 0), y: st.y + st.h / 2, zoom };
    } else this.ren.r3?.frame(st);
    this.select({ kind: 'site', site: st });
  }
  /** Zooming moves between levels of detail: out to the airfield, in through the landside to a terminal. */
  autoLod() {
    if (this.ren.mode3d) return;
    const z = this.ren.cam.zoom; const l = this.ren.lod;
    if (l === 'terminal') {
      if (z < LOD.leaveTerminalBelow) this.setLod(z < LOD.airfieldBelow ? 'airfield' : 'landside', null);
      return;
    }
    if (z < LOD.airfieldBelow) { if (l !== 'airfield') this.setLod('airfield', null); return; }
    if (l !== 'landside') this.setLod('landside', null);
    if (z > LOD.terminalAbove) {
      const c = { x: this.ren.cam.x, y: this.ren.cam.y };
      const st = (this.world.sites ?? []).find(s => inRect(c, s, 40));
      if (st) this.setLod('terminal', st.id);
    }
  }

  set3d(on: boolean) {
    this.ren.set3d(on);
    this.ren.setOrbitLeft(this.tool === 'select');
    $('#view3d').setAttribute('aria-pressed', String(on));
    if (!on) this.autoLod();
    this.hint(this.toolHint());
  }

  syncSpeed() {
    document.querySelectorAll<HTMLElement>('#speed button').forEach(b => {
      const s = Number(b.dataset.speed);
      b.setAttribute('aria-pressed', String(s === 0 ? this.ctl.paused : !this.ctl.paused && s === this.ctl.speed));
    });
  }

  renderToolOpts() {
    const t = this.tool; const el = $('#toolopts');
    const seg = (key: string, cur: number, items: [number, string][]) =>
      `<div class="seg">${items.map(([v, l]) => `<button data-opt="${key}:${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
    let html = '';
    if (t === 'taxi') html = `<span class="label">Taxiway</span>${seg('taxi', this.opt.taxi, TAXI_CLASSES.map(c => [c.cls, `${c.name}<span class="opt-note"> · ${c.note}</span>`]))}<span class="label">Runway links</span>${seg('auto', this.opt.auto, [[1, 'Auto'], [0, 'Manual']])}`;
    else if (t === 'select' && this.ren.selected?.kind === 'runway') html = `<span class="label">Extending</span>${seg('auto', this.opt.auto, [[1, 'Stretch parallel taxiways'], [0, 'Runway only']])}`;
    else if (t === 'road') html = `<span class="label">Road</span>${seg('lanes', this.opt.lanes, ROAD_LANES.map(c => [c.lanes, c.name]))}`;
    else if (t === 'concourse') html = `<span class="label">Gates sized for</span>${seg('conc', this.opt.conc, CLASSES.map(c => [c.cls, c.example]))}`;
    el.innerHTML = html; el.hidden = !html;
  }

  setTool(t: Tool) {
    // terminal modules are laid out inside an open terminal; the other tools move the map to their level
    const want = TOOLS.find(x => x.id === t)?.lod;
    if (want === 'terminal' && this.ren.lod !== 'terminal') {
      const st = this.pickSite();
      if (!st) { t = 'site'; this.toast('Start with New terminal: allocate its site, then lay out its modules inside.', 'warn'); }
      else this.openTerminal(st);
    } else if (want && want !== 'terminal' && this.ren.lod !== want) this.setLod(want, null);
    this.tool = t;
    document.querySelectorAll<HTMLElement>('.tool').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
    const groundOnly = ZONES[t as ZoneType]?.groundOnly || t === 'road' || t === 'walk' || t === 'taxi' || t === 'runway';
    if (groundOnly && this.ren.level !== 0 && t !== 'runway' && t !== 'taxi') this.setLevel(0);
    this.ren.ghost = null; this.ren.cursor = null;
    this.renderToolOpts();
    this.ren.showGuides = t === 'taxi' || t === 'concourse';
    this.ren.showFront = t === 'road';
    this.ren.setOrbitLeft(t === 'select');
    this.hint(this.toolHint());
    this.ren.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
  }

  /** One heatmap at a time: queues and road traffic (H), or footfall and revenue per lot (C). */
  setHeat(m: 'queues' | 'commerce' | null) {
    this.ren.overlay = m === 'queues'; this.ren.commerce = m === 'commerce';
    $('#heat').setAttribute('aria-pressed', String(this.ren.overlay));
    $('#commerce').setAttribute('aria-pressed', String(this.ren.commerce));
  }

  setLevel(l: Level) {
    this.ren.level = l;
    document.querySelectorAll<HTMLElement>('#levels [data-level]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.level) === l)));
    if ((ZONES[this.tool as ZoneType]?.groundOnly || this.tool === 'road' || this.tool === 'walk') && l !== 0) this.setTool('select');
  }

  toolHint(): string {
    const t = this.tool;
    if (t === 'select') { if (this.ren.selected?.kind === 'runway') return 'Drag either end of the runway to extend or shorten it'; if (this.ren.mode3d) return 'Drag to orbit · right-drag to pan · scroll to zoom · click to inspect · T for plan'; return matchMedia('(pointer: coarse)').matches ? 'Drag to pan · pinch to zoom · tap to inspect' : 'Drag to pan · scroll to zoom · click to inspect · drag a module to move it'; }
    if (t === 'runway') return 'Drag to draw a runway · 1,200 m turboprop · 1,600 m E175 · 2,100 m A320 · 3,000 m A380';
    if (t === 'taxi') return `Drag to draw a taxiway · snaps to runways, aprons and other taxiways${this.opt.auto ? ' · drawn beside a runway, it links itself with end stubs and rapid exits' : ''}`;
    if (t === 'road') return `Drag to draw a road (for cars) · run it along a terminal face, ${FRONTAGE.minGap}–${FRONTAGE.maxGap} m out, and a curb grows there; where departures sit over arrivals it becomes a two-level road · snaps to the dashed guides`;
    if (t === 'site') return `Drag to allocate a terminal site (at least ${SITES.minW} × ${SITES.minH} m) · then lay out check-in, security, a concourse and bag claim inside it · the site grows to fit`;
    if (t === 'walk') return 'Drag to draw a sidewalk (for people) · links ground-level modules, curbs and lots · can cross roads';
    if (t === 'demolish') return 'Click anything to demolish it (40% refund)';
    if (t === 'concourse') return `Concourse on ${LEVELS[this.ren.level].short} · drag a rectangle · sides with a parallel taxiway ${standDepth(this.opt.conc)}–${sideReach(this.opt.conc)} m out grow gates (dashed guides); the rest of the width becomes shops, restaurants and lounges`;
    const d = ZONES[t];
    return `${d.label} on ${LEVELS[this.ren.level].short} · drag a rectangle · ${d.blurb}`;
  }

  hint(text: string, bad = false) { const h = $('#hint'); h.textContent = text; h.classList.toggle('bad', bad); }

  toast(text: string, kind: 'info' | 'warn' | 'bad' = 'info') {
    const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = text;
    $('#toasts').prepend(el);
    setTimeout(() => el.classList.add('out'), 4200); setTimeout(() => el.remove(), 4800);
  }

  // ------------------------------------------------------------ input
  bindInput() {
    const c = this.ren.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => { e.preventDefault(); if (this.ren.mode3d) return; this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    c.addEventListener('pointerdown', e => this.down(e));
    c.addEventListener('pointermove', e => this.move(e));
    c.addEventListener('pointerup', e => this.up(e));
    c.addEventListener('pointerleave', () => { if (!this.drag) this.ren.cursor = null; });
    c.addEventListener('pointercancel', e => { this.pointers.delete(e.pointerId); this.drag = null; this.pinch = null; this.ren.ghost = null; });
    window.addEventListener('keydown', e => this.key(e));
  }

  zoomAt(sx: number, sy: number, f: number) {
    const cam = this.ren.cam;
    const before = this.ren.toWorld(sx, sy);
    cam.zoom = clamp(cam.zoom * f, 0.06, 8);
    const after = this.ren.toWorld(sx, sy);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
    this.autoLod();
  }

  floorZ() {
    if (this.ren.mode3d) return (this.tool in ZONES && !ZONES[this.tool as ZoneType].groundOnly) || (this.tool === 'select' && this.ren.lod === 'terminal') ? LEVELS[this.ren.level].z0 : 0;
    return this.ren.tilt > 0.02 && !isWay(this.tool) && this.tool !== 'runway' ? LEVELS[this.ren.level].z1 : 0;
  }
  wpt(e: PointerEvent): Pt { return this.ren.toWorld(e.offsetX, e.offsetY, this.floorZ()); }

  hitTest(p: Pt, sitesOnly = false): Hit {
    const lod = this.ren.lod;
    const L = lod === 'terminal' ? this.ren.level : 1;
    const zs = this.sim.d.zones;
    const site = (this.world.sites ?? []).find(s => inRect(p, s));
    // away from the terminal level, a terminal reads as one thing: its site
    if (sitesOnly || (lod !== 'terminal' && site && !zs.some(z => !ZONES[z.type].terminal && inRect(p, z)))) {
      if (site) return { kind: 'site', site };
      const z = [...zs].reverse().find(q => isTerminalModule(q) && inRect(p, q));
      const st = z && siteOf(this.world, z); if (st) return { kind: 'site', site: st };
      if (sitesOnly) return null;
    }
    const inFocus = (z: Zone) => lod !== 'terminal' || this.ren.focus === null || siteOf(this.world, z)?.id === this.ren.focus || this.sim.d.termOf.get(z.id)?.site?.id === this.ren.focus;
    const z1 = [...zs].reverse().find(z => z.level === L && ZONES[z.type].terminal && inRect(p, z) && inFocus(z));
    if (z1) {
      // inside a concourse, a click on a commercial lot picks that lot (its scores show in the inspector)
      const lot = z1.type === 'concourse' ? (this.sim.d.shops.get(z1.id) ?? []).find(sh => pointInPoly(p, sh.pts)) : undefined;
      return { kind: 'zone', zone: z1, lot: lot?.key };
    }
    const sl = slotAt(this.sim.d.gateSlots, p);
    if (sl) return { kind: 'gate', slot: sl };
    const tol = 8 / this.ren.cam.zoom;
    const w = [...this.world.ways].reverse().find(w => segDistWay(p, w) < Math.max(wayWidth(w.kind, w.cls, w.lanes) / 2, tol));
    if (w) return { kind: 'way', way: w };
    const z2 = [...zs].reverse().find(z => !ZONES[z.type].terminal && inRect(p, z));
    if (z2) return { kind: 'zone', zone: z2 };
    const rw = this.world.runways.find(r => segDistWay(p, r) < Math.max(30, 10 / this.ren.cam.zoom));
    if (rw) return { kind: 'runway', id: rw.id };
    return null;
  }
  hitToSel(h: Hit): Sel | null {
    return !h ? null : h.kind === 'zone' ? { kind: 'zone', id: h.zone.id, key: h.lot } : h.kind === 'runway' ? { kind: 'runway', id: h.id }
      : h.kind === 'gate' ? { kind: 'gate', id: h.slot.zone.id, key: h.slot.key } : h.kind === 'site' ? { kind: 'site', id: h.site.id } : { kind: 'way', id: h.way.id };
  }

  /** Snap a point for drawing: existing endpoints first, then runways, aprons, the highway, zone edges; else the grid. */
  snapFor(kind: WayKind | 'runway', p: Pt): { p: Pt; snapped: boolean } {
    const tol = 14 / this.ren.cam.zoom;
    let best: { p: Pt; d: number; pri: number } | null = null;
    const consider = (q: Pt, pri: number, within = tol) => {
      const d = dist(p, q);
      if (d <= within && (!best || pri > best.pri || (pri === best.pri && d < best.d))) best = { p: { x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 }, d, pri };
    };
    const onSeg = (a: Pt, b: Pt) => lerpPt(a, b, clamp(projT(p, a, b), 0, 1));
    const edgePt = (r: Rect): Pt => {
      if (!inRect(p, r)) return { x: clamp(p.x, r.x, r.x + r.w), y: clamp(p.y, r.y, r.y + r.h) };
      const dl = p.x - r.x, dr = r.x + r.w - p.x, dt = p.y - r.y, db = r.y + r.h - p.y; const m = Math.min(dl, dr, dt, db);
      return m === dl ? { x: r.x, y: p.y } : m === dr ? { x: r.x + r.w, y: p.y } : m === dt ? { x: p.x, y: r.y } : { x: p.x, y: r.y + r.h };
    };
    if (kind !== 'runway') for (const w of this.world.ways) if (w.kind === kind) { consider(w.a, 4); consider(w.b, 4); consider(onSeg(w.a, w.b), 1); }
    if (kind === 'taxi') {
      for (const r of this.world.runways) { consider(r.a, 4); consider(r.b, 4); consider(onSeg(r.a, r.b), 2); }
      for (const gd of this.sim.d.gateGuides) {
        const a = { x: gd.a.x + gd.out.x * gd.ideal, y: gd.a.y + gd.out.y * gd.ideal }, b = { x: gd.b.x + gd.out.x * gd.ideal, y: gd.b.y + gd.out.y * gd.ideal };
        consider(a, 3); consider(b, 3); consider(onSeg(a, b), 3);
      }
      for (const ap of this.sim.d.aprons) {
        if (inRect(p, ap.rect, tol)) consider(onSeg(ap.laneA, ap.laneB), 3);
        consider(ap.laneA, 3); consider(ap.laneB, 3);
      }
    }
    if (kind === 'road') {
      consider({ x: clamp(p.x, 0, SITE.width), y: SITE.highwayY }, 2);
      for (const z of this.world.zones) if (z.type === 'curb' || z.type === 'parking') consider(edgePt(z), 3);
      // frontage guides: the line a road should follow to grow a curb along a terminal face
      const off = FRONTAGE.ideal + (this.opt.lanes >= 4 ? 8 : 4.5);
      for (const gd of this.sim.d.frontGuides) {
        const a = { x: gd.a.x + gd.out.x * off, y: gd.a.y + gd.out.y * off }, b = { x: gd.b.x + gd.out.x * off, y: gd.b.y + gd.out.y * off };
        const ext = (q: Pt, r: Pt, k: number) => ({ x: q.x + (q.x - r.x) / (dist(q, r) || 1) * k, y: q.y + (q.y - r.y) / (dist(q, r) || 1) * k });
        const a2 = ext(a, b, FRONTAGE.ramp), b2 = ext(b, a, FRONTAGE.ramp);
        if (segDistWay(p, { a: a2, b: b2 }) < FRONTAGE.snap + 200) {
          // snap sideways onto the guide line, anywhere along it (roads usually run past the building)
          const al = norm(sub(b, a)); const q = { x: a.x + al.x * dot(sub(p, a), al), y: a.y + al.y * dot(sub(p, a), al) };
          consider({ x: q.x, y: q.y }, 3, FRONTAGE.snap / 2);
        }
      }
    }
    if (kind === 'walk') for (const z of this.world.zones) if (z.level === 0) consider(edgePt(z), 3);
    if (best) return { p: (best as { p: Pt }).p, snapped: true };
    return { p: { x: snap(p.x, 10), y: snap(p.y, 10) }, snapped: false };
  }

  down(e: PointerEvent) {
    // in 3D the orbit controls own drags with Select; build tools still draw on the ground plane
    if (this.ren.mode3d && (this.tool === 'select' || e.button !== 0)) {
      if (e.button === 0) this.click3d = { x: e.offsetX, y: e.offsetY };
      return;
    }
    this.ren.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = null; this.ren.ghost = null;
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.ren.cam.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam: { x: this.ren.cam.x, y: this.ren.cam.y } };
      return;
    }
    const p = this.wpt(e);
    const base = { sx: e.offsetX, sy: e.offsetY, start: p };
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) { this.drag = { mode: 'pan', ...base, cam: { x: this.ren.cam.x, y: this.ren.cam.y } }; return; }
    const t = this.tool;
    if (t === 'runway') { const s = this.snapFor('runway', p); this.drag = { mode: 'runway', ...base, start: s.p }; return; }
    if (isWay(t)) { const s = this.snapFor(t, p); this.drag = { mode: 'way', ...base, start: s.p, snapStart: s.snapped }; return; }
    if (t in ZONES) { this.drag = { mode: 'zone', ...base, start: this.magnet(p, ZONES[t as ZoneType].groundOnly ? 0 : this.ren.level) }; return; }
    if (t === 'site') { this.drag = { mode: 'site', ...base, start: { x: snap(p.x, 10), y: snap(p.y, 10) } }; return; }
    if (t === 'select' && this.ren.selected?.kind === 'runway') {
      const rw = this.world.runways.find(r => r.id === this.ren.selected!.id);
      const end = rw && this.runwayEndAt(rw, e.offsetX, e.offsetY);
      if (rw && end) { this.drag = { mode: 'extend', ...base, rw, end, orig: { a: { ...rw.a }, b: { ...rw.b } } }; return; }
    }
    const hit = this.hitTest(p);
    if (t === 'demolish') { if (hit) this.demolish(hit); return; }
    this.select(hit);
    if (hit?.kind === 'zone' && !hit.zone.auto) {
      const z = hit.zone;
      this.drag = { mode: 'move', ...base, zone: z, off: sub(p, { x: z.x, y: z.y }), moved: false };
    } else this.drag = { mode: 'pan', ...base, cam: { x: this.ren.cam.x, y: this.ren.cam.y } };
  }

  move(e: PointerEvent) {
    if (this.ren.mode3d && !this.drag) {
      if (this.tool !== 'select') { const p = this.wpt(e); if (isWay(this.tool)) { const s = this.snapFor(this.tool, p); this.ren.cursor = s.snapped ? s.p : null; } }
      return;
    }
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const cam = this.ren.cam;
      cam.zoom = clamp(this.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d, 0.06, 8);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      cam.x = this.pinch.cam.x - (mid.x - this.pinch.mid.x) / cam.zoom;
      cam.y = this.pinch.cam.y - (mid.y - this.pinch.mid.y) / (cam.zoom * this.ren.yScale);
      return;
    }
    const p = this.wpt(e);
    const dr = this.drag;
    if (!dr) {
      if (this.tool === 'select' || this.tool === 'demolish') {
        const sr = this.ren.selected?.kind === 'runway' && this.tool === 'select' ? this.world.runways.find(r => r.id === this.ren.selected!.id) : undefined;
        const onEnd = !!(sr && this.runwayEndAt(sr, e.offsetX, e.offsetY));
        this.ren.canvas.style.cursor = onEnd ? 'grab' : 'default';
        this.ren.hover = onEnd ? null : this.hitToSel(this.hitTest(p));
      }
      else if (isWay(this.tool)) { const s = this.snapFor(this.tool, p); this.ren.cursor = s.snapped ? s.p : null; }
      return;
    }
    if (dr.mode === 'pan') {
      const cam = this.ren.cam;
      cam.x = dr.cam!.x - (e.offsetX - dr.sx) / cam.zoom;
      cam.y = dr.cam!.y - (e.offsetY - dr.sy) / (cam.zoom * this.ren.yScale);
      return;
    }
    if (dr.mode === 'site') {
      const q = { x: snap(p.x, 10), y: snap(p.y, 10) };
      const r = { x: Math.min(dr.start.x, q.x), y: Math.min(dr.start.y, q.y), w: Math.abs(q.x - dr.start.x), h: Math.abs(q.y - dr.start.y) };
      const chk = this.canPlaceSite(r);
      this.ren.ghost = { kind: 'zone', rect: r, ok: chk.ok };
      this.hint(chk.ok ? `New terminal site · ${n0(r.w)} × ${n0(r.h)} m · release to allocate (free) · then lay out its modules inside` : chk.reason!, !chk.ok);
      return;
    }
    if (dr.mode === 'extend' && dr.rw && dr.orig && dr.end) {
      const fixed = dr.end === 'a' ? dr.orig.b : dr.orig.a, moving = dr.end === 'a' ? dr.orig.a : dr.orig.b;
      const dir = norm(sub(moving, fixed));
      const s2 = Math.max(TUNE.minRunway, snap(dot(sub(p, fixed), dir), 50));
      const ne = { x: Math.round(fixed.x + dir.x * s2), y: Math.round(fixed.y + dir.y * s2) };
      const a = dr.end === 'a' ? ne : fixed, b = dr.end === 'a' ? fixed : ne;
      const chk = canPlaceRunway(this.world, a, b, dr.rw.id);
      const delta = runwayCost(a, b) - runwayCost(dr.orig.a, dr.orig.b);
      const follow = this.opt.auto ? followRunwayEnd(this.world, fixed, moving, ne, this.sim.d.aprons) : null;
      const cost = Math.max(0, delta) + (follow?.cost ?? 0);
      const ok = chk.ok && this.sim.canAfford(cost);
      dr.pend = { a, b, ok, cost, delta, follow };
      const extras = [...(follow?.moves.map(m => ({ a: m.end === 'a' ? m.way.b : m.way.a, b: m.to, cls: m.way.cls })) ?? []), ...(follow?.adds ?? [])];
      this.ren.ghost = { kind: 'runway', a, b, ok, extras };
      const len = dist(a, b), was = dist(dr.orig.a, dr.orig.b);
      const sign = len >= was ? '+' : '−';
      const money2 = delta >= 0 ? money(cost) : `${money(-delta * 0.4)} back`;
      const tw = follow && follow.moves.length ? ` · stretches ${follow.moves.length} taxiway${follow.moves.length > 1 ? 's' : ''}` : '';
      this.hint(chk.ok ? (ok ? `Runway ${designators(a, b)} · ${n0(len)} m (${sign}${n0(Math.abs(len - was))} m) · ${rwyClassLabel(len)}${tw} · ${money2}` : `Not enough money: ${money(cost)}`) : chk.reason!, !ok);
      return;
    }
    if (dr.mode === 'runway') {
      const { a, b } = this.angled(dr.start, p, 50);
      const chk = canPlaceRunway(this.world, a, b);
      const cost = runwayCost(a, b);
      const ok = chk.ok && this.sim.canAfford(cost);
      this.ren.ghost = { kind: 'runway', a, b, ok };
      const len = dist(a, b); const c = rwyClass(len);
      const cls = c < 0 ? 'too short for airline service' : `up to ${CLASSES[c].example} · ${runwayWidth(len)} m wide`;
      const cov = this.coverageWith(designators(a, b));
      this.hint(chk.ok ? (ok ? `Runway ${designators(a, b)} · ${n0(len)} m · ${cls} · wind coverage ${Math.round(cov * 100)}% · ${money(cost)}` : `Not enough money: ${money(cost)}`) : chk.reason!, !ok);
      return;
    }
    if (dr.mode === 'way') {
      const kind = this.tool as WayKind;
      const s = this.snapFor(kind, p);
      const b = s.snapped ? s.p : this.angled(dr.start, p, 10).b;
      const cls = kind === 'taxi' ? this.opt.taxi : 0, lanes = kind === 'road' ? this.opt.lanes : 0;
      const chk = canPlaceWay(this.world, kind, dr.start, b, this.sim.d.aprons);
      const cost = dist(dr.start, b) * wayCostPerM(kind, cls, lanes);
      const extras = kind === 'taxi' && this.opt.auto && chk.ok ? autoConnectors(this.world, { a: dr.start, b, cls }, this.sim.d.aprons) : [];
      const xcost = extras.reduce((t, x) => t + dist(x.a, x.b) * wayCostPerM('taxi', cls, 0), 0);
      const ok = chk.ok && this.sim.canAfford(cost + xcost);
      dr.extras = extras;
      this.ren.ghost = { kind: 'way', a: dr.start, b, ok, way: { kind, cls, lanes }, snapA: dr.snapStart, snapB: s.snapped, extras };
      const what = kind === 'taxi' ? `${TAXI_CLASSES[cls === 3 ? 1 : 0].name} taxiway` : kind === 'road' ? `${lanes}-lane road` : 'Sidewalk';
      const xs = extras.length ? ` + ${extras.length} runway link${extras.length > 1 ? 's' : ''}` : '';
      this.hint(chk.ok ? (ok ? `${what} · ${n0(dist(dr.start, b))} m${xs} · ${money(cost + xcost)}${s.snapped ? ' · connects here' : ''}` : `Not enough money: ${money(cost + xcost)}`) : chk.reason!, !ok);
      return;
    }
    if (dr.mode === 'zone') {
      const t = this.tool as ZoneType;
      const level = ZONES[t].groundOnly ? 0 : this.ren.level;
      const q = this.magnet(p, level);
      const r = { x: Math.min(dr.start.x, q.x), y: Math.min(dr.start.y, q.y), w: Math.abs(q.x - dr.start.x), h: Math.abs(q.y - dr.start.y) };
      const chk = this.placeModule(r, t, level, -1);
      const cost = area(r) * ZONES[t].costPerM2;
      const ok = chk.ok && this.sim.canAfford(cost);
      this.ren.ghost = { kind: 'zone', rect: r, ok };
      this.hint(chk.ok ? (ok ? `${ZONES[t].label} · ${n0(r.w)} × ${n0(r.h)} m · ${this.estimateUnits(t, r)} · ${money(cost)}` : `Not enough money: ${money(cost)}`) : chk.reason!, !ok);
      return;
    }
    if (dr.mode === 'move' && dr.zone) {
      const z = dr.zone;
      if (!dr.moved && Math.hypot(e.offsetX - dr.sx, e.offsetY - dr.sy) < 5) return;
      dr.moved = true;
      const r = this.magnetMove({ x: p.x - dr.off!.x, y: p.y - dr.off!.y, w: z.w, h: z.h }, z.level, z.id);
      const chk = this.placeModule(r, z.type, z.level, z.id);
      this.ren.ghost = { kind: 'zone', rect: r, ok: chk.ok };
      this.hint(chk.ok ? `Move ${ZONES[z.type].short} · release to place (free) · reconnect paths afterwards` : chk.reason!, !chk.ok);
    }
  }

  up(e: PointerEvent) {
    if (this.click3d) {
      const c = this.click3d; this.click3d = null;
      if (Math.hypot(e.offsetX - c.x, e.offsetY - c.y) < 5) { const h = this.hitTest(this.wpt(e)); this.select(h); }
      return;
    }
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
    const dr = this.drag; this.drag = null;
    if (!dr) return;
    const g = this.ren.ghost; this.ren.ghost = null;
    if (dr.mode === 'runway' && g?.a && g.b) {
      if (g.ok) this.buildRunway(g.a, g.b);
      else if (dist(g.a, g.b) > 50) this.toast(canPlaceRunway(this.world, g.a, g.b).reason ?? 'Not enough money', 'bad');
    } else if (dr.mode === 'way' && g?.a && g.b && g.way) {
      if (g.ok) this.buildWay(g.way.kind, g.a, g.b, g.way.cls, g.way.lanes, dr.extras ?? []);
      else if (dist(g.a, g.b) > 10) this.toast(canPlaceWay(this.world, g.way.kind, g.a, g.b, this.sim.d.aprons).reason ?? 'Not enough money', 'bad');
    } else if (dr.mode === 'extend' && dr.rw && dr.pend) {
      const pd = dr.pend;
      if (pd.ok && (pd.a.x !== dr.orig!.a.x || pd.a.y !== dr.orig!.a.y || pd.b.x !== dr.orig!.b.x || pd.b.y !== dr.orig!.b.y)) {
        dr.rw.a = pd.a; dr.rw.b = pd.b;
        if (pd.delta >= 0) this.sim.spend(pd.cost); else { if (this.sim.moneyOn) this.sim.money += -pd.delta * 0.4; this.sim.spend(pd.follow?.cost ?? 0); }
        for (const m of pd.follow?.moves ?? []) m.way[m.end] = m.to;
        for (const x of pd.follow?.adds ?? []) this.world.ways.push({ id: this.world.nextId++, kind: 'taxi', a: x.a, b: x.b, cls: x.cls, lanes: 0 });
        this.changed();
        const r = this.sim.d.runways.find(q => q.rw.id === dr.rw!.id);
        if (r) this.toast(`Runway ${r.labels.join('/')} is now ${n0(r.length)} m · ${rwyClassLabel(r.length)}`);
      } else if (!pd.ok) this.toast(canPlaceRunway(this.world, pd.a, pd.b, dr.rw.id).reason ?? 'Not enough money', 'bad');
    } else if (dr.mode === 'zone' && g?.rect) {
      const t = this.tool as ZoneType;
      if (g.ok) this.buildZone(t, g.rect);
      else if (g.rect.w > 5 || g.rect.h > 5) this.toast(this.placeModule(g.rect, t, ZONES[t].groundOnly ? 0 : this.ren.level, -1).reason ?? 'Not enough money', 'bad');
    } else if (dr.mode === 'site' && g?.rect) {
      if (g.ok) this.buildSite(g.rect);
      else if (g.rect.w > 5 || g.rect.h > 5) this.toast(this.canPlaceSite(g.rect).reason ?? '', 'bad');
    } else if (dr.mode === 'move' && dr.zone && dr.moved && g?.rect) {
      if (g.ok) {
        dr.zone.x = g.rect.x; dr.zone.y = g.rect.y;
        const st = siteOf(this.world, dr.zone); if (st && isTerminalModule(dr.zone)) { dr.zone.site = st.id; fitSite(this.world, st); }
        this.changed();
      }
      else this.toast('Cannot move there: ' + (this.placeModule(g.rect, dr.zone.type, dr.zone.level, dr.zone.id).reason ?? ''), 'bad');
    }
    this.hint(this.toolHint());
  }

  key(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const k = e.key;
    const t = TOOLS.find(x => x.key.toLowerCase() === k.toLowerCase());
    if (t) { this.setTool(t.id); return; }
    if (k === 'Escape') {
      if (this.ren.lod === 'terminal' && this.tool === 'select') { this.goLod('landside'); return; }
      this.setTool('select'); this.select(null);
    }
    else if (k === 'Enter') this.goLod('terminal');
    else if (k === 'a' || k === 'A') this.goLod('airfield');
    else if (k === 'l' || k === 'L') this.goLod('landside');
    else if (k === ' ') { e.preventDefault(); this.ctl.paused = !this.ctl.paused; this.syncSpeed(); }
    else if (k === '[' || k === 'PageDown') this.setLevel(0);
    else if (k === ']' || k === 'PageUp') this.setLevel(1);
    else if (k === 't' || k === 'T') this.set3d(!this.ren.mode3d);
    else if (k === 'h' || k === 'H') this.setHeat(this.ren.overlay ? null : 'queues');
    else if (k === 'c' || k === 'C') this.setHeat(this.ren.commerce ? null : 'commerce');
    else if (k === '+' || k === '=') this.zoomAt(this.ren.W / 2, this.ren.H / 2, 1.25);
    else if (k === '-') this.zoomAt(this.ren.W / 2, this.ren.H / 2, 0.8);
    else if ((k === 'Delete' || k === 'Backspace') && this.ren.selected) this.demolish(this.selHit(this.ren.selected));
  }

  selHit(s: Sel): Hit {
    if (s.kind === 'zone') { const z = this.sim.d.zones.find(q => q.id === s.id); return z ? { kind: 'zone', zone: z } : null; }
    if (s.kind === 'site') { const st = this.world.sites?.find(q => q.id === s.id); return st ? { kind: 'site', site: st } : null; }
    if (s.kind === 'way') { const w = this.world.ways.find(q => q.id === s.id); return w ? { kind: 'way', way: w } : null; }
    if (s.kind === 'gate') { const sl = this.sim.d.gateSlots.find(q => q.zone.id === s.id && q.key === s.key); return sl ? { kind: 'gate', slot: sl } : null; }
    return { kind: 'runway', id: s.id };
  }

  angled(a: Pt, p: Pt, step: number) {
    const v = sub(p, a); const L = snap(Math.hypot(v.x, v.y), step);
    const ang = snap(Math.atan2(v.y, v.x), rad(15));
    return { a, b: { x: Math.round(a.x + Math.cos(ang) * L), y: Math.round(a.y + Math.sin(ang) * L) } };
  }

  coverageWith(des: string) {
    const h = (Number(des.slice(0, 2)) * 10) % 360;
    const hs = [h, ...this.sim.d.runways.map(r => r.heading)];
    const ws = windSamples();
    return ws.filter(w => hs.some(x => crosswind(x, w) <= TUNE.crosswindLimit)).length / ws.length;
  }

  estimateUnits(t: ZoneType, r: Rect) {
    const d = ZONES[t];
    if (t === 'concourse') {
      const C = CLASSES[this.opt.conc]; const long = Math.max(r.w, r.h), wide = Math.min(r.w, r.h);
      const sw = spineWidth(long), hd = holdDepth(this.opt.conc);
      const one = (wide - sw) / 2 - hd, none = (wide - sw) / 2;
      return `${Math.floor(long / C.gateSpacing)} ${C.example} gates per long side · ${Math.round(sw * 10) / 10} m spine · behind gates: ${one < 1.5 ? 'no room for shops' : `${Math.round(one)} m, ${depthClass(one)}`} · ungated side: ${Math.round(none)} m, ${depthClass(none)}`;
    }
    if (t === 'curb') return `${Math.floor(Math.max(r.w, r.h) / 9) * 2} car bays`;
    return `${Math.max(1, Math.floor(area(r) / d.m2PerUnit))} ${d.unit}`;
  }

  // ------------------------------------------------------------ forgiving placement
  /** Snap a drawn corner to the edges of nearby modules (any level) so modules meet flush; otherwise to the 10 m grid. */
  magnet(p: Pt, level: Level): Pt {
    const tol = Math.max(6, 12 / this.ren.cam.zoom);
    const xs: number[] = [], ys: number[] = [];
    for (const z of this.world.zones) { if (z.level !== level && !isTerminalModule(z)) continue; xs.push(z.x, z.x + z.w); ys.push(z.y, z.y + z.h); }
    for (const st of this.world.sites ?? []) { xs.push(st.x, st.x + st.w); ys.push(st.y, st.y + st.h); }
    const near = (v: number, cs: number[]) => cs.reduce((m, c) => (Math.abs(c - v) < Math.abs(m - v) ? c : m), Infinity);
    const nx = near(p.x, xs), ny = near(p.y, ys);
    return { x: Math.abs(nx - p.x) <= tol ? nx : snap(p.x, 10), y: Math.abs(ny - p.y) <= tol ? ny : snap(p.y, 10) };
  }
  /** Moving a module: whichever of its edges is closest to a neighbour's edge snaps flush. */
  magnetMove(r: Rect, level: Level, ignore: number): Rect {
    const tol = Math.max(6, 12 / this.ren.cam.zoom);
    let dx = snap(r.x, 10) - r.x, dy = snap(r.y, 10) - r.y, bx = tol + 1, by = tol + 1;
    for (const z of this.world.zones) {
      if (z.id === ignore || (z.level !== level && !isTerminalModule(z))) continue;
      for (const [a, c] of [[r.x, z.x], [r.x, z.x + z.w], [r.x + r.w, z.x], [r.x + r.w, z.x + z.w]]) if (Math.abs(c - a) < bx) { bx = Math.abs(c - a); dx = c - a; }
      for (const [a, c] of [[r.y, z.y], [r.y, z.y + z.h], [r.y + r.h, z.y], [r.y + r.h, z.y + z.h]]) if (Math.abs(c - a) < by) { by = Math.abs(c - a); dy = c - a; }
    }
    return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
  }
  /** Placement for modules: the usual rules, plus terminal modules go in the open terminal (whose site then grows). */
  placeModule(r: Rect, t: ZoneType, level: Level, ignore: number) {
    const chk = canPlaceZone(this.world, r, t, level, ignore, this.sim.d.aprons);
    if (!chk.ok || !TERMINAL_TOOLS.has(t)) return chk;
    const mine = ignore >= 0 ? this.world.zones.find(z => z.id === ignore) : undefined;
    const st = mine ? siteOf(this.world, mine) : this.world.sites?.find(s => s.id === this.ren.focus);
    if (!st) return { ok: false, reason: 'Open a terminal first (double-click it), or allocate one with New terminal (N)' };
    if (!rectsOverlap(r, padRect(st, SITES.reach))) return { ok: false, reason: `Too far from ${this.siteName(st)}: keep modules within ${SITES.reach} m of its site, or start a New terminal` };
    const other = (this.world.sites ?? []).find(o => o.id !== st.id && rectsOverlap(r, o));
    if (other) return { ok: false, reason: `That is ${this.siteName(other)}'s site` };
    return chk;
  }
  canPlaceSite(r: Rect) {
    if (r.w < SITES.minW || r.h < SITES.minH) return { ok: false, reason: `A terminal site needs at least ${SITES.minW} × ${SITES.minH} m` };
    if (!inBuildable(r)) return { ok: false, reason: 'Outside the airport boundary or in the lake' };
    for (const rw of this.world.runways) if (rectSegDist(r, rw.a, rw.b) < TUNE.runwayClear) return { ok: false, reason: 'Inside the runway safety strip (150 m)' };
    for (const o of this.world.sites ?? []) if (rectsOverlap(r, o)) return { ok: false, reason: `Overlaps ${this.siteName(o)}'s site` };
    for (const w of this.world.ways) if (w.kind === 'taxi' && rectSegDist(r, w.a, w.b) === 0) return { ok: false, reason: 'Crosses a taxiway' };
    return { ok: true };
  }
  siteName(st: Site) { return this.sim.d.terminals.find(t => t.site?.id === st.id)?.name ?? 'that terminal'; }

  buildSite(r: Rect) {
    const st: Site = { id: this.world.nextId++, ...r };
    (this.world.sites ??= []).push(st);
    // modules already standing on the land join it
    for (const z of this.world.zones) if (isTerminalModule(z) && z.site === undefined && inRect(center4(z), st)) z.site = st.id;
    this.changed();
    this.openTerminal(st);
    this.setTool('checkin');
    this.toast(`${this.siteName(st)} allocated. Lay out check-in, security, a concourse and bag claim inside it; run a road along its face for a curb.`);
  }

  // ------------------------------------------------------------ edits
  changed() { this.sim.relayout(); this.refresh(true); this.ctl.save(); }

  buildRunway(a: Pt, b: Pt) {
    const cost = runwayCost(a, b);
    this.sim.spend(cost);
    const id = this.world.nextId++;
    this.world.runways.push({ id, a, b });
    this.changed();
    const r = this.sim.d.runways.find(x => x.rw.id === id)!;
    this.select({ kind: 'runway', id });
    this.toast(`Runway ${r.labels.join('/')} built · ${n0(r.length)} m · ${money(cost)}. Connect it with taxiways.`);
  }

  buildWay(kind: WayKind, a: Pt, b: Pt, cls: number, lanes: number, extras: WaySpec[] = []) {
    let cost = dist(a, b) * wayCostPerM(kind, cls, lanes);
    this.world.ways.push({ id: this.world.nextId++, kind, a, b, cls, lanes });
    for (const x of extras) { this.world.ways.push({ id: this.world.nextId++, kind: 'taxi', a: x.a, b: x.b, cls: x.cls, lanes: 0 }); cost += dist(x.a, x.b) * wayCostPerM('taxi', x.cls, 0); }
    this.sim.spend(cost);
    this.changed();
    if (extras.length) this.toast(`Taxiway linked to the runway with ${extras.length} connector${extras.length > 1 ? 's' : ''} · ${money(cost)}`);
  }

  runwayEndAt(rw: Runway, sx: number, sy: number): 'a' | 'b' | null {
    for (const end of ['a', 'b'] as const) {
      const [x, y] = this.ren.P(rw[end].x, rw[end].y);
      if (Math.hypot(x - sx, y - sy) < 18) return end;
    }
    return null;
  }

  buildZone(t: ZoneType, r: Rect) {
    const cost = area(r) * ZONES[t].costPerM2;
    this.sim.spend(cost);
    const z: Zone = { id: this.world.nextId++, type: t, level: ZONES[t].groundOnly ? 0 : this.ren.level, ...r, tier: 0 };
    if (t === 'concourse') z.cls = this.opt.conc;
    if (TERMINAL_TOOLS.has(t)) {
      const st = this.world.sites?.find(s => s.id === this.ren.focus) ?? siteOf(this.world, z);
      if (st) { z.site = st.id; this.world.zones.push(z); fitSite(this.world, st); } else this.world.zones.push(z);
    } else this.world.zones.push(z);
    this.changed();
    const u = this.sim.d.units.get(z.id);
    this.select({ kind: 'zone', zone: z });
    this.toast(`${ZONES[t].label} built · ${u?.count ?? 0} ${ZONES[t].unit} · ${money(cost)}`);
  }

  demolish(h: Hit) {
    if (!h) return;
    if (h.kind === 'gate') { this.toggleGate(h.slot, false); return; }
    if (h.kind === 'zone' && h.zone.auto) { this.toast('This curb grows from the road beside the terminal. Move or remove the road to change it.', 'warn'); return; }
    let refund = 0, what = '';
    if (h.kind === 'site') {
      const st = h.site; const mine = this.world.zones.filter(z => z.site === st.id || (z.site === undefined && isTerminalModule(z) && inRect(center4(z), st)));
      refund = mine.reduce((t, z) => t + area(z) * ZONES[z.type].costPerM2 * 0.4, 0); what = this.siteName(st);
      this.world.zones = this.world.zones.filter(z => !mine.includes(z));
      this.world.sites = (this.world.sites ?? []).filter(s => s !== st);
      if (this.ren.focus === st.id) this.setLod('landside', null);
    } else if (h.kind === 'zone') {
      const z = h.zone; refund = area(z) * ZONES[z.type].costPerM2 * 0.4; what = ZONES[z.type].label;
      this.world.zones = this.world.zones.filter(q => q !== z);
    } else if (h.kind === 'way') {
      const w = h.way; refund = dist(w.a, w.b) * wayCostPerM(w.kind, w.cls, w.lanes) * 0.4; what = wayName(w.kind);
      this.world.ways = this.world.ways.filter(q => q !== w);
    } else {
      const r = this.world.runways.find(q => q.id === h.id)!; refund = runwayCost(r.a, r.b) * 0.4; what = 'Runway';
      this.world.runways = this.world.runways.filter(q => q.id !== h.id);
    }
    if (this.sim.moneyOn) this.sim.money += refund;
    if (h.kind !== 'way') this.toast(`${what} demolished · ${money(refund)} back`, 'warn');
    this.ren.selected = null; this.ren.hover = null;
    this.changed();
  }

  toggleGate(sl: GateSlot, on: boolean) {
    const z = sl.zone; const off = new Set(z.off ?? []);
    if (on) off.delete(sl.key); else off.add(sl.key);
    z.off = [...off];
    this.changed();
    this.toast(on ? 'Gate added' : 'Gate removed', on ? 'info' : 'warn');
  }

  select(h: Hit) {
    this.ren.selected = this.hitToSel(h);
    if (h) this.tab = 'inspect';
    this.renderToolOpts(); this.hint(this.toolHint());
    this.refresh(true);
  }

  // ------------------------------------------------------------ per-frame HUD
  hud() {
    const s = this.sim;
    $('#clock').textContent = s.clock();
    $('#date').textContent = `Year ${s.year} · Week ${s.week}`;
    ($('#dayfill') as HTMLElement).style.width = `${clamp((s.t - DAY_START) / (DAY_END - DAY_START), 0, 1) * 100}%`;
    const w = s.wind;
    ($('#windArrow') as HTMLElement).style.transform = `rotate(${(w.from + 180) % 360}deg)`;
    const ends = s.usableRunways().filter(r => r.cls >= 0).map(r => s.landingFromA(r) ? r.labels[0] : r.labels[1]);
    $('#windText').textContent = `${String(Math.round(w.from)).padStart(3, '0')}° ${Math.round(w.kt)} kt`;
    $('#rwyText').textContent = s.d.runways.length ? (ends.length ? `Landing ${ends.join(', ')}` : 'All runways closed: crosswind') : 'No runway';
    $('#rwyText').classList.toggle('bad', !!s.d.runways.length && !ends.length);
    $('#money').textContent = s.moneyOn ? money(s.money) : 'Sandbox';
    $('#money').classList.toggle('bad', s.moneyOn && s.money < 0);
    const live = s.pax.filter(p => p.stage !== 'done').length;
    const stuck = s.pax.filter(p => p.stage === 'stuck').length;
    $('#live').textContent = `${n0(live)} in terminal${stuck ? ` · ${n0(stuck)} stranded` : ''} · ${s.flights.filter(f => ['approach', 'roll', 'taxiIn', 'waitGate', 'stand', 'taxiOut', 'holdDep', 'takeoff'].includes(f.state)).length} aircraft`;
    $('#live').classList.toggle('bad', stuck > 0);
    if (performance.now() - this.lastPanel > 400) { this.lastPanel = performance.now(); this.refresh(false); }
  }

  // ------------------------------------------------------------ panels
  refresh(force: boolean) {
    const active = document.activeElement as HTMLElement | null;
    if (!force && active && active.closest('#panelBody') && active.tagName === 'INPUT') { this.liveNumbers(); this.renderCheck(); return; }
    document.querySelectorAll<HTMLElement>('#tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === this.tab)));
    const body = $('#panelBody');
    const scroll = body.scrollTop;
    body.innerHTML = this.tab === 'inspect' ? this.inspectHTML() : this.tab === 'ops' ? this.opsHTML() : this.reportHTML();
    body.scrollTop = scroll;
    this.bindPanel();
    if (this.tab === 'report') this.drawHistory();
    this.renderCheck();
  }

  liveNumbers() {
    const el = document.getElementById('demandLive');
    if (el) el.textContent = `${n0(this.sim.demandAt(this.sim.slotPrice).reduce((s, q) => s + q.n, 0))} flights/day`;
    const pr = document.getElementById('priceOut'); if (pr) pr.textContent = money(this.sim.slotPrice);
    for (const k of ['agents', 'screeners', 'handlers'] as const) { const o = document.getElementById(`out-${k}`); if (o) o.textContent = this.staffText(k); }
  }

  renderCheck() {
    const issues = this.sim.d.issues;
    const errs = issues.filter(i => i.level === 'error').length, warns = issues.filter(i => i.level === 'warn').length;
    $('#checkCount').textContent = errs ? `${errs} to fix` : warns ? `${warns} warning${warns > 1 ? 's' : ''}` : 'OK';
    $('#checkToggle').className = errs ? 'bad' : warns ? 'warn' : 'ok';
    const html = issues.map(i => `<li class="${i.level}">${esc(i.text)}</li>`).join('');
    const list = $('#checkList'); if (list.innerHTML !== html) list.innerHTML = html;
  }

  staffText(k: 'agents' | 'screeners' | 'handlers') {
    const procs = [...this.sim.procs.values()];
    if (k === 'agents') { const c = procs.filter(p => p.type === 'checkin'); return `${c.reduce((a, p) => a + p.servers, 0)} of ${c.reduce((a, p) => a + p.maxServers, 0)} counters open`; }
    if (k === 'screeners') { const c = procs.filter(p => p.type === 'security'); return `${c.reduce((a, p) => a + p.servers, 0)} of ${c.reduce((a, p) => a + p.maxServers, 0)} lanes open`; }
    return `${(this.sim.staff.handlers * TUNE.bagsPerHandlerPerMin * 0.6).toFixed(1)} arriving bags/min`;
  }

  inspectHTML(): string {
    const s = this.sim; const sel = this.ren.selected;
    if (!sel) return `<p class="muted">Click a module, runway, taxiway, road or sidewalk to inspect it. With <b>Select</b> (V), drag a module to move it.</p>${this.legendHTML()}`;
    if (sel.kind === 'runway') {
      const r = s.d.runways.find(x => x.rw.id === sel.id); if (!r) return '';
      const xw = crosswind(r.heading, s.wind);
      const cov = windSamples().filter(w => runwayUsable(r, w)).length / windSamples().length;
      const usable = runwayUsable(r, s.wind);
      const ladder = CLASSES.map(c => `<li class="${r.length >= c.minRunway ? 'yes' : 'no'}"><b>${c.example}</b><span>${c.minRunway.toLocaleString()} m</span></li>`).join('');
      return `
        <h2><span class="des">${r.labels[0]}<i>/</i>${r.labels[1]}</span> Runway</h2>
        <dl class="kv">
          <dt>Length · width</dt><dd>${n0(r.length)} m · ${r.width} m</dd>
          <dt>Heading</dt><dd>${String(Math.round(r.heading)).padStart(3, '0')}° / ${String(Math.round((r.heading + 180) % 360)).padStart(3, '0')}°</dd>
          <dt>Crosswind now</dt><dd class="${usable ? '' : 'bad'}">${xw.toFixed(0)} kt ${usable ? '· open' : '· closed (limit 20 kt)'}</dd>
          <dt>Wind coverage</dt><dd>${Math.round(cov * 100)}% on its own</dd>
          <dt>Taxiway links</dt><dd class="${r.nodes.length > 2 || s.d.air.adj[r.nodeA]?.length > 1 ? '' : 'bad'}">${Math.max(0, r.nodes.length - 2 + [r.nodeA, r.nodeB].filter(n => n >= 0 && s.d.air.adj[n].length > 1).length)}</dd>
        </dl>
        <h3>Aircraft it can serve</h3><ul class="ladder">${ladder}</ul>
        <p class="muted">Drag either end on the map to extend or shorten the runway; parallel taxiways stretch with it. Planes exit onto the first connected taxiway after their landing roll.</p>
        <button class="btn danger" data-act="demolish">Demolish runway</button>`;
    }
    if (sel.kind === 'gate') {
      const sl = s.d.gateSlots.find(q => q.zone.id === sel.id && q.key === sel.key); if (!sl) return '';
      const gate = s.d.gates.find(g => g.id === sl.id);
      const fl = gate ? s.gateBusy.get(gate.id) : null;
      const next = gate ? s.flights.filter(f => f.gate.id === gate.id && (f.state === 'pending' || f.state === 'hold' || f.state === 'approach')).sort((a, b) => a.schedArr - b.schedArr)[0] : undefined;
      const C = CLASSES[sl.cls];
      return `<h2>${gate ? `<span class="des">${gate.num}</span>` : ''} ${gate ? 'Gate' : 'Removed gate'}</h2>
        <dl class="kv">
          <dt>Concourse</dt><dd>${s.d.gateLetter.get(sl.zone.id)} · ${SIDE_NAMES[sl.side].toLowerCase()} side</dd>
          <dt>Stand</dt><dd>${C.name} · ${C.example} · ${C.gateSpacing} m wide</dd>
          ${gate ? `<dt>Now</dt><dd>${fl ? `${fl.code} (${fl.ac.example})` : 'Free'}</dd><dt>Next arrival</dt><dd>${next ? `${next.code} at ${s.clock(next.schedArr)}` : '—'}</dd>
          <dt>Connected</dt><dd class="${gate.rwys[0].size ? '' : 'bad'}">${gate.rwys[0].size ? 'Taxiway route to a runway' : 'No route to a runway'}</dd>` : ''}
        </dl>
        ${gate ? `<button class="btn danger" data-act="gateOff">Remove this gate</button><p class="muted small">The stand stays marked so you can add it back. Removing gates frees apron for something else.</p>`
          : `<button class="btn" data-act="gateOn">Add a gate here</button>`}`;
    }
    if (sel.kind === 'way') {
      const w = s.world.ways.find(q => q.id === sel.id); if (!w) return '';
      const L = dist(w.a, w.b);
      if (w.kind === 'taxi') {
        const letter = s.d.taxiLetter.get(w.id) ?? '';
        const C = TAXI_CLASSES[w.cls >= 3 ? 1 : 0];
        const up = L * (TAXI_CLASSES[1].costPerM - TAXI_CLASSES[0].costPerM);
        return `<h2><span class="des">${esc(letter)}</span> Taxiway</h2>
          <dl class="kv"><dt>Length</dt><dd>${n0(L)} m</dd><dt>Class</dt><dd>${C.name} · ${C.width} m wide</dd><dt>Takes</dt><dd>${C.note}</dd></dl>
          ${w.cls < 3 ? `<button class="btn" data-act="taxiF">Widen to Code F · ${money(up)}</button>` : ''}
          <p class="muted">A380s only use routes where every taxiway is Code F.</p>
          <button class="btn danger" data-act="demolish">Demolish (${money(L * C.costPerM * 0.4)} back)</button>`;
      }
      if (w.kind === 'road') {
        const eids = s.d.road.edges.filter(e => e.ref === w.id).map(e => e.id);
        const ratio = Math.max(0, ...eids.map(e => s.edgeLoadRatio(e)));
        const cars = eids.reduce((n, e) => n + s.roadLoad[e], 0);
        const up = L * (ROAD_LANES[1].costPerM - ROAD_LANES[0].costPerM);
        return `<h2>Road <span class="lvl">${w.lanes} lanes</span></h2>
          <dl class="kv"><dt>Length</dt><dd>${n0(L)} m</dd><dt>Cars on it</dt><dd>${n0(cars)}</dd>
            <dt>Traffic</dt><dd class="${ratio > 1 ? 'bad' : ''}">${ratio < 0.5 ? 'Free-flowing' : ratio < 1 ? 'Slowing' : 'Jammed'}</dd></dl>
          ${w.lanes < 4 ? `<button class="btn" data-act="lanes4">Widen to 4 lanes · ${money(up)}</button>` : ''}
          <p class="muted">Press <kbd>H</kbd> to see congestion on every road.</p>
          <button class="btn danger" data-act="demolish">Demolish (${money(L * wayCostPerM('road', 0, w.lanes) * 0.4)} back)</button>`;
      }
      const walkers = s.pax.filter(p => p.stage === 'walk' && p.level === 0 && segDistWay(p, w) < 4).length;
      return `<h2>Sidewalk</h2>
        <dl class="kv"><dt>Length</dt><dd>${n0(L)} m · ${WALK.width} m wide</dd><dt>People on it</dt><dd>${walkers}</dd></dl>
        <p class="muted">Sidewalks link ground-level modules, curbs and lots. Upper-level modules connect through cores.</p>
        <button class="btn danger" data-act="demolish">Demolish (${money(L * WALK.costPerM * 0.4)} back)</button>`;
    }
    if (sel.kind === 'site') return this.siteHTML(sel.id);
    const z = s.d.zones.find(q => q.id === sel.id); if (!z) return '';
    const def = ZONES[z.type]; const u = s.d.units.get(z.id) ?? { max: 0, count: 0 };
    const proc = s.procs.get(z.id);
    let stats = '';
    if (proc && (z.type === 'checkin' || z.type === 'security')) {
      const svc = z.type === 'checkin' ? TUNE.checkinTime[z.tier] : TUNE.securityTime[z.tier];
      const tol = TUNE.tolerance[z.type];
      stats = `
        <dt>Open now</dt><dd>${proc.servers} of ${proc.maxServers} ${def.unit}</dd>
        <dt>Throughput</dt><dd>${n0(proc.servers * 60 / svc)} pax/hr</dd>
        <dt>In line</dt><dd>${proc.queue.length} people</dd>
        <dt>Recent wait</dt><dd class="${proc.recentWait > tol ? 'bad' : ''}">${proc.recentWait.toFixed(1)} min <span class="muted">(tolerance ${tol})</span></dd>`;
      if (proc.servers < proc.maxServers && proc.queue.length > proc.servers * 3) stats += `<dt></dt><dd class="bad">Add staff in Operations to open more ${def.unit}.</dd>`;
    } else if (proc && z.type === 'claim') {
      stats = `<dt>Carousels busy</dt><dd>${proc.carousels?.filter(Boolean).length ?? 0} of ${u.count}</dd><dt>Waiting for bags</dt><dd>${s.pax.filter(p => p.stage === 'waitBag' && p.proc === proc).length} people</dd>`;
    } else if (proc && z.type === 'curb') {
      const q = proc.cars?.filter(c => c.stage === 'queue').length ?? 0;
      const deck = z.auto ? { dep: 'Departures curb on the upper deck: drop-offs', arr: 'Arrivals curb under the upper deck: pickups', both: 'Drop-offs and pickups' }[z.auto.deck] : '';
      stats = (z.auto ? `<dt>Grown by</dt><dd>the road ${n0(z.auto.gap)} m off the ${ZONES[this.sim.d.zones.find(m => m.id === z.auto!.module)?.type ?? 'checkin'].short.toLowerCase()} face · ${deck}</dd>` : '') + `<dt>Bays in use</dt><dd>${proc.bays?.filter(Boolean).length ?? 0} of ${u.count}</dd><dt>Cars queuing</dt><dd class="${q > 8 ? 'bad' : ''}">${q}</dd>
        <dt>Road access</dt><dd class="${s.d.roadOK.has(z.id) ? '' : 'bad'}">${s.d.roadOK.has(z.id) ? 'Connected' : 'None: draw a road to its edge'}</dd>`;
    } else if (z.type === 'parking') {
      stats = `<dt>Stalls used</dt><dd>${n0(s.lotUsed)} of ${n0(s.lotCapacity())} (all lots)</dd>
        <dt>Road access</dt><dd class="${s.d.roadOK.has(z.id) ? '' : 'bad'}">${s.d.roadOK.has(z.id) ? 'Connected' : 'None: draw a road to its edge'}</dd>`;
    } else if (z.type === 'concourse') {
      const gates = s.d.gates.filter(g => g.zone.id === z.id);
      const occ = gates.filter(g => s.gateBusy.get(g.id)).length;
      const waiting = s.pax.filter(p => p.stage === 'dwell' && p.flight.gate.zone.id === z.id).length;
      const usable = CLASSES.filter(c => gates.some(g => s.d.gateUsable(g, c.cls))).map(c => c.example);
      const B = s.d.budgets.get(z.id);
      const list = s.d.shops.get(z.id) ?? [];
      const open = list.filter(sh => s.leased(sh));
      const day = s.shopDay.get(z.id) ?? { visits: 0, rev: 0 };
      const inNow = list.reduce((n, sh) => n + (s.shopLoad.get(sh) ?? 0), 0);
      const kinds = Object.entries(B?.kinds ?? {}).sort((p, q) => q[1] - p[1]).map(([k, n]) => `${n} ${k.toLowerCase()}${n > 1 && !k.endsWith('go') ? (k.endsWith('é') ? 's' : k.endsWith('s') ? '' : 's') : ''}`).join(' · ');
      const tot = B ? B.hold + B.spine + B.commerce : 1;
      const pct = (x: number) => `${Math.round((100 * x) / Math.max(1, tot))}%`;
      const bar = B ? `<div class="budget" title="Holdrooms · spine · commercial">
          <i class="b-hold" style="flex:${B.hold}"></i><i class="b-spine" style="flex:${B.spine}"></i><i class="b-shop" style="flex:${B.commerce}"></i></div>` : '';
      stats = `<dt>Gates in use</dt><dd>${occ} of ${gates.length}</dd>
        <dt>At the gates</dt><dd class="${B && waiting > B.seats ? 'bad' : ''}">${waiting} people · ${n0(B?.seats ?? 0)} seats</dd>
        <dt>Serving now</dt><dd class="${usable.length || !gates.length ? '' : 'bad'}">${usable.length ? usable.join(', ') : gates.length ? 'Nothing: its terminal is closed or no runway connects' : 'No gates: shops and seating only'}</dd>
        ${B ? `<dt>Space</dt><dd>${bar}<span class="small"><i class="chip-s hold"></i>Holdrooms ${pct(B.hold)}<br><i class="chip-s spine"></i>Spine ${pct(B.spine)}${B.walkways ? ', with moving walkways' : ''}<br><i class="chip-s food"></i>Commercial ${pct(B.commerce)}</span></dd>
        <dt>Cross-section</dt><dd class="small">${n0(B.width)} m wide: ${Math.round(B.spineW * 10) / 10} m spine; ${Math.round(B.depthA)} m and ${Math.round(B.depthB)} m of commercial depth either side</dd>` : ''}
        <dt>Lots</dt><dd>${open.length} of ${list.length} leased${B?.window ? ` · ${B.window} with apron views` : ''}${kinds ? `<br><span class="muted small">${kinds}</span>` : ''}</dd>
        <dt>Customers now</dt><dd>${inNow}</dd>
        <dt>Today so far</dt><dd>${n0(day.visits)} visits · ${money(day.rev)}</dd>
        ${this.dutyFreeHTML(z)}
        <dt></dt><dd class="muted small">Every gate claims ${Math.round(holdDepth(z.cls ?? 2))} m of holdroom behind its frontage. Remove gates on a side to free that wall for window restaurants and lounges; widen the concourse to fit both.</dd>
        ${this.lotHTML(z, sel.key)}`;
    }
    const upCost = area(z) * def.tierCostPerM2;
    const clsSeg = z.type === 'concourse' ? `<div class="tier"><span class="label">Gates sized for</span><div class="seg">${CLASSES.map(c =>
      `<button data-act="cls${c.cls}" aria-pressed="${(z.cls ?? 2) === c.cls}">${c.example}</button>`).join('')}</div>
      <span class="muted small">${CLASSES[z.cls ?? 2].gateSpacing} m per gate · taxiway ${standDepth(z.cls ?? 2)}–${sideReach(z.cls ?? 2)} m from the building. Bigger gates fit fewer per side; a closer taxiway gets smaller gates.</span></div>` : '';
    return `
      <h2>${def.label} <span class="lvl">${LEVELS[z.level].short}</span></h2>
      <p class="muted">${def.blurb}</p>
      <dl class="kv">
        <dt>Size</dt><dd>${n0(z.w)} × ${n0(z.h)} m · ${n0(area(z))} m²</dd>
        ${(() => { const T = s.d.termOf.get(z.id); return T ? `<dt>Terminal</dt><dd class="${T.active ? '' : 'bad'}">${T.name} · ${T.active ? 'open' : 'closed'}</dd>` : ''; })()}
        ${z.type === 'concourse' ? this.gateSidesHTML(z) : ''}
        ${u.max && z.type !== 'concourse' && !z.auto ? `<dt>${z.type === 'claim' ? 'Carousels built' : def.unit[0].toUpperCase() + def.unit.slice(1)}</dt><dd>
          <span class="stepper"><button class="step" data-act="units-" aria-label="Fewer">−</button><b>${u.count}</b><button class="step" data-act="units+" aria-label="More">+</button></span>
          <span class="muted">of ${u.max} that fit</span></dd>` : ''}
        ${stats}
      </dl>
      ${clsSeg}
      ${z.auto ? `<p class="muted small">This curb belongs to the road beside the terminal: move the road or the building and it follows; remove the road and it goes.</p>` : `<div class="tier">
        <span class="label">Fit-out</span>
        <div class="seg">
          <button data-act="tier0" aria-pressed="${z.tier === 0}">${def.tierNames[0]}</button>
          <button data-act="tier1" aria-pressed="${z.tier === 1}">${def.tierNames[1]}${z.tier === 0 ? ` · ${money(upCost)}` : ''}</button>
        </div>
      </div>
      <button class="btn danger" data-act="demolish">Demolish (${money(area(z) * def.costPerM2 * 0.4)} back)</button>`}`;
  }

  /** Walk-through duty free: only where the concourse's entry wall is shared with security. */
  dutyFreeHTML(z: Zone) {
    const B = this.sim.d.budgets.get(z.id); if (!B) return '';
    if (!B.dutyFreeOK) return `<dt>Duty free</dt><dd class="muted small">Walk-through duty free needs security opening straight into this concourse.</dd>`;
    const sh = (this.sim.d.shops.get(z.id) ?? []).find(q => q.tenant === 'dutyfree');
    const L = sh ? this.sim.lotDay.get(sh.id) : undefined;
    const now = L && L.passed ? `<br><span class="small">Today: ${n0(L.passed)} walked through · ${n0(L.visits)} bought (${Math.round((100 * L.visits) / L.passed)}%) · ${money(L.rev)}</span>` : '';
    return `<dt>Duty free</dt><dd><div class="seg"><button data-act="df0" aria-pressed="${!z.dutyFree}">Off</button><button data-act="df1" aria-pressed="${!!z.dutyFree}">Walk-through</button></div>
      <span class="muted small">Every departing passenger winds through a store at the security exit. About ${Math.round(COMMERCE.dfCapture * 100)}% stop to shop (Arthur D. Little). It earns more, but adds ${COMMERCE.dfWalk} min to every walk and irritates people with under ${COMMERCE.dfHurry} min to spare.</span>${now}</dd>`;
  }

  /** The selected lot's scores, bids and money; or a prompt to pick one. */
  lotHTML(z: Zone, key?: string) {
    const s = this.sim; const list = s.d.shops.get(z.id) ?? [];
    const sh = key ? list.find(q => q.key === key) : undefined;
    if (!sh) return `<dt>Lot</dt><dd class="muted small">Click a lot to see its footfall, visibility and dwell scores, and what each tenant would bid. Press <kbd>C</kbd> for the commercial heatmap.</dd>`;
    const bar = (v: number, txt: string) => `<span class="sbar"><i style="width:${Math.round(clamp(v, 0, 1) * 100)}%"></i></span> <span class="small">${txt}</span>`;
    const L = s.lotDay.get(sh.id) ?? { visits: 0, rev: 0, passed: 0 }; const P = s.lotPrev.get(sh.id);
    const leased = s.leased(sh);
    const bids = sh.tenant === 'dutyfree' ? '' : (Object.entries(sh.bids) as [TenantId, number][]).sort((p, q) => q[1] - p[1])
      .map(([t, v]) => `<dt class="small">${TENANTS[t].label}${t === sh.tenant ? ' ✓' : ''}</dt><dd>${bar(v, v.toFixed(2))}</dd>`).join('');
    return `</dl><h3>Lot ${esc(sh.key)} · ${esc(sh.kind)}${leased ? '' : ' <span class="muted">(for lease)</span>'}</h3><dl class="kv">
      <dt>Size</dt><dd>${n0(sh.frontage)} m frontage × ${n0(sh.depth)} m deep · ${n0(sh.area)} m² · ${sh.tenant === 'dutyfree' ? 'walk-through store' : depthClass(sh.depth)}${sh.window ? ' · apron view' : ''}</dd>
      <dt>Footfall</dt><dd>${bar(sh.footScore, `${n0(sh.foot)} a day, weighted by time to spare${sh.measured ? '' : ' (estimated from the plan until passengers are counted)'}`)}</dd>
      <dt>Visibility</dt><dd>${bar(sh.vis, `${Math.round(sh.vis * 100)}% of the spine sees it`)}</dd>
      <dt>Dwell</dt><dd>${bar(sh.dwellScore, `${n0(sh.dwell)} min to spare, on average`)}</dd>
      <dt>Position</dt><dd class="small">${n0(sh.near * 100)}% near security · ${n0(sh.gateScore * 100)}% gate cluster · ${n0(sh.far * 100)}% out along the pier</dd>
      ${bids ? `<dt>Bids</dt><dd class="muted small">What each format would pay for this lot. A sitting tenant stays unless out-bid by ${Math.round(COMMERCE.relet * 100)}%; lots re-let overnight.</dd>${bids}` : ''}
      <dt>Rent</dt><dd>${money(sh.rent)}/day minimum guarantee${leased ? '' : ' if let'}</dd>
      <dt>Revenue</dt><dd>${money(L.rev)} today (${n0(L.visits)} customers)${P ? ` · ${money(P.rev)} yesterday` : ''}</dd>`;
  }

  /** A terminal as a whole: what it has, why it's closed, and the way in. */
  siteHTML(id: number) {
    const s = this.sim; const st = this.world.sites?.find(q => q.id === id); if (!st) return '';
    const T = s.d.terminals.find(t => t.site?.id === id);
    const zs = T?.zones ?? [];
    const by = (t: ZoneType) => zs.filter(z => z.type === t);
    const curbs = s.d.zones.filter(z => z.type === 'curb' && zs.some(m => z.auto?.module === m.id));
    const decks = curbs.some(c => c.auto?.deck === 'dep');
    const row = (t: ZoneType, label: string) => `<dt>${label}</dt><dd class="${by(t).length ? '' : 'muted'}">${by(t).length ? by(t).map(z => `${n0(z.w)} × ${n0(z.h)} m ${LEVELS[z.level].short}`).join(' · ') : 'none yet'}</dd>`;
    return `<h2>${T?.name ?? 'Terminal'} <span class="lvl">${T?.active ? 'open' : 'closed'}</span></h2>
      <dl class="kv">
        <dt>Site</dt><dd>${n0(st.w)} × ${n0(st.h)} m · grows as you add modules</dd>
        ${T && !T.active ? `<dt>Status</dt><dd class="bad">${esc(T.problems.join('; '))}</dd>` : ''}
        ${row('checkin', 'Check-in')}${row('security', 'Security')}${row('concourse', 'Concourses')}${row('claim', 'Bag claim')}
        <dt>Gates</dt><dd>${T?.gates ?? 0}</dd>
        <dt>Curbs</dt><dd class="${curbs.length ? '' : 'muted'}">${curbs.length ? `${curbs.length} grown by roads${decks ? ' · two-level frontage road (departures above, arrivals below)' : ''}` : 'none: run a road along the landside face'}</dd>
      </dl>
      <button class="btn" data-act="open">Open terminal (Enter)</button>
      <p class="muted small">Inside, lay out check-in, security, concourses and bag claim; modules snap flush to each other. Double-click any terminal on the map to open it; Esc steps back out.</p>
      <button class="btn danger" data-act="demolish">Demolish terminal and its modules</button>`;
  }

  gateSidesHTML(z: Zone) {
    const s = this.sim; const zc = z.cls ?? 2;
    const rows = s.d.gateGuides.filter(g => g.zone.id === z.id).map(g => {
      const n = s.d.gateSlots.filter(sl => sl.zone.id === z.id && sl.side === g.side);
      const on = n.filter(sl => sl.on).length;
      const txt = n.length ? `${on} of ${n.length} gates · ${CLASSES[g.cls ?? zc].example} · taxiway ${Math.round(g.d ?? 0)} m out`
        : g.note ? g.note : `no taxiway: draw one ${standDepth(zc)}–${sideReach(zc)} m out`;
      return `<dt>${SIDE_NAMES[g.side]}</dt><dd class="${n.length ? '' : 'muted'}">${txt}</dd>`;
    }).join('');
    return `${rows}<dt></dt><dd class="muted small">Click a gate on the apron to remove it, or a dashed stand to add it back.</dd>`;
  }

  legendHTML() {
    return `<h3>Reading the map</h3>
      <ul class="legend">
        <li><i class="dot n"></i>Passenger, content</li>
        <li><i class="dot w"></i>Irritated: waiting past tolerance</li>
        <li><i class="dot b"></i>Angry: long wait or long walk</li>
        <li><i class="dot b ring"></i>Stranded: no route to their next step</li>
        <li><i class="sw road"></i>Road (cars)</li>
        <li><i class="sw walk"></i>Sidewalk (people)</li>
        <li><i class="sw taxi"></i>Taxiway (aircraft), lettered</li>
        <li><i class="sq"></i>Vertical core (stairs, escalators, lifts)</li>
        <li><i class="chip-s shop"></i><i class="chip-s food"></i><i class="chip-s lounge"></i><i class="chip-s df"></i>Shop · food · lounge · duty free; dashed = for lease</li>
        <li><i class="chip-s ramp"></i>Commercial heatmap (C): footfall per lot, revenue labels, flow along the spine</li>
        <li><i class="sw miss"></i>Missing connection</li>
      </ul>
      <h3>Keys</h3>
      <p class="muted keys"><kbd>A</kbd> airfield · <kbd>L</kbd> landside · <kbd>Enter</kbd> open terminal · <kbd>Esc</kbd> step out · <kbd>N</kbd> new terminal · <kbd>Space</kbd> pause · <kbd>[</kbd> <kbd>]</kbd> level · <kbd>T</kbd> 3D · <kbd>H</kbd> queues and traffic · <kbd>C</kbd> commerce · <kbd>Del</kbd> demolish · <kbd>Shift</kbd>-drag pan</p>`;
  }

  opsHTML(): string {
    const s = this.sim; const p = s.plan;
    const dem = s.demandAt(s.slotPrice).reduce((a, q) => a + q.n, 0);
    const limitText: Record<string, string> = {
      'Demand': 'Airlines want no more flights at this price.',
      'Gates': 'More flights want in, but gates are full. Run taxiways along more sides of your concourses, or add one.',
      'Runway capacity': 'The runway is the bottleneck in peak hours.',
      'Aircraft size': 'Some airlines fly aircraft your runway, taxiways or gates cannot take.',
      'No runway': 'Build a runway first.', 'No gates': 'Build a concourse first.',
      'No connected gates': 'No terminal is open yet. See Terminals below.',
    };
    const fleet = (a: typeof p.byAirline[0]['airline']) => Object.keys(a.mix).map(c => CLASS_EX(Number(c))).reverse().join(' · ');
    const rows = p.byAirline.map(b => `<tr><td>${esc(b.airline.name)}<span class="muted small">${esc(b.airline.model)}</span></td><td>${fleet(b.airline)}</td><td>${b.requested}</td><td class="${b.scheduled < b.requested ? 'bad' : ''}">${b.scheduled}</td></tr>`).join('');
    const sj = p.wantsSJ ? `<p class="note">Polaris wants ${p.wantsSJ} A380 flight${p.wantsSJ > 1 ? 's' : ''} a day. It needs a 3,000 m runway, Code F taxiways the whole way, and a concourse with A380 gates.</p>` : '';
    const staffRow = (k: 'agents' | 'screeners' | 'handlers', label: string, max: number) => `
      <div class="slider">
        <label for="staff-${k}">${label} <b>${s.staff[k]}</b></label>
        <input type="range" id="staff-${k}" min="0" max="${max}" step="1" value="${s.staff[k]}">
        <span class="muted" id="out-${k}">${this.staffText(k)}</span>
      </div>`;
    const terms = s.d.terminals.map(T => `<li class="${T.active ? 'open' : 'closed'}">
        <b>T${T.id}</b><div><span class="tname">${T.name} · ${T.active ? 'Open' : 'Closed'}</span>
        <span class="muted small">${T.gateAreas} concourse${T.gateAreas === 1 ? '' : 's'} · ${T.gates} gates · ${T.shops} lots</span>
        ${T.active ? (() => { const ps = [...s.procs.values()].filter(p => s.d.termOf.get(p.zone.id) === T);
          const f = (t: string) => { const q = ps.filter(p => p.type === t); return `${q.reduce((a, p) => a + p.servers, 0)}/${q.reduce((a, p) => a + p.maxServers, 0)}`; };
          return `<span class="muted small">Staffed: check-in ${f('checkin')} desks · security ${f('security')} lanes</span>`; })() : ''}
        ${T.active ? '' : `<span class="why">${esc(T.problems.join('; '))}</span>`}</div></li>`).join('');
    return `
      <h2>Terminals</h2>
      ${terms ? `<ul class="terms">${terms}</ul>` : '<p class="muted">No terminal yet. Connect check-in, security, a concourse and baggage claim, with a curb served by a road.</p>'}
      <p class="muted small">A terminal opens when check-in, security, a concourse with working gates and baggage claim connect on foot, with a road-served curb. Only open terminals get flights.</p>
      <h2>Airlines and slots</h2>
      <div class="slider">
        <label for="price">Slot fee per movement <b id="priceOut">${money(s.slotPrice)}</b></label>
        <input type="range" id="price" min="500" max="8000" step="100" value="${s.slotPrice}">
        <span class="muted">At this fee airlines want <b id="demandLive">${n0(dem)} flights/day</b>. Applies from the next schedule.</span>
      </div>
      <div class="funnel">
        <div><b>${p.demand}</b><span>wanted</span></div>
        <div><b>${p.scheduled}</b><span>scheduled</span></div>
        <div><b>${p.rejectedGates + p.rejectedRunway + p.rejectedAircraft}</b><span>turned away</span></div>
      </div>
      <p class="limit"><span class="label">Limit today</span> ${esc(p.limit)}. ${limitText[p.limit] ?? ''}</p>
      <table class="tbl"><thead><tr><th>Airline</th><th>Fleet</th><th>Asked</th><th>Got</th></tr></thead><tbody>${rows}</tbody></table>
      ${sj}
      <p class="muted small">Catchment ${n0(s.population)} people, growing ${(SITE.growth * 100).toFixed(1)}% a year. Reputation ${(s.rep * 100).toFixed(0)} raises demand and load factors.</p>

      <h2>Staff on shift</h2>
      ${staffRow('agents', 'Check-in agents', 200)}
      ${staffRow('screeners', 'Security screeners', 240)}
      ${staffRow('handlers', 'Baggage handlers', 160)}
      <p class="muted small">${money(TUNE.wagePerDay)} per person per day.</p>

      <h2>Game</h2>
      <label class="check"><input type="checkbox" id="moneyOn" ${s.moneyOn ? 'checked' : ''}> Money on (tycoon). Off = sandbox.</label>
      <div class="row">
        <button class="btn" data-act="sample">Load sample airport</button>
        <button class="btn danger" data-act="clear">${this.confirmClear > performance.now() ? 'Click again to clear' : 'Clear site'}</button>
      </div>`;
  }

  reportHTML(): string {
    const s = this.sim; const r = s.history[s.history.length - 1];
    const log = s.log.slice(0, 14).map(l => `<li class="${l.kind}"><time>${l.t}</time>${esc(l.text)}</li>`).join('') || '<li class="muted">Nothing unusual yet today.</li>';
    if (!r) return `<p class="muted">The first report arrives when today closes at midnight. Speed up time with the controls at the top.</p><h3>Today</h3><ul class="log">${log}</ul>`;
    const st = r.stats;
    const bar = (k: 'curb' | 'checkin' | 'security' | 'claim', label: string) => {
      const w = st.waits[k]; const avg = w.n ? w.sum / w.n : 0; const tol = TUNE.tolerance[k];
      const pct = clamp(avg / (tol * 2), 0, 1) * 100, mx = clamp(w.max / (tol * 2), 0, 1) * 100;
      return `<div class="wait"><span>${label}</span><div class="track"><i style="left:50%" class="tol"></i><b style="width:${pct}%" class="${avg > tol ? 'over' : ''}"></b><em style="left:${mx}%"></em></div><span class="num">${avg.toFixed(1)} · ${w.max.toFixed(0)} max</span></div>`;
    };
    const rev = st.rev; const revT = revTotal(rev); const cost = st.cost.staff + st.cost.upkeep;
    return `
      <h2>${r.label}</h2>
      <div class="kpis">
        <div><b>${r.sat.toFixed(0)}</b><span>satisfaction</span></div>
        <div><b>${Math.round(r.onTime * 100)}%</b><span>on time</span></div>
        <div><b class="${st.missed ? 'bad' : ''}">${n0(st.missed)}</b><span>missed flights</span></div>
        <div><b class="${st.stranded ? 'bad' : ''}">${n0(st.stranded)}</b><span>stranded</span></div>
        <div><b>${n0(st.paxDep + st.paxArr)}</b><span>passengers</span></div>
        <div><b class="${st.cancelled ? 'bad' : ''}">${st.flights} / ${st.cancelled}</b><span>flown / cancelled</span></div>
      </div>
      <h3>Waits, minutes (avg · max; tick = tolerance)</h3>
      ${bar('curb', 'Curb')}${bar('checkin', 'Check-in')}${bar('security', 'Security')}${bar('claim', 'Bag claim')}
      <h3>Money per day ${r.periodDays > 1 ? `<span class="muted">× ${r.periodDays} days this period</span>` : ''}</h3>
      <dl class="kv money">
        <dt>Slot fees</dt><dd>${money(rev.slots)}</dd><dt>Passenger charges</dt><dd>${money(rev.pax)}</dd>
        <dt>Shops</dt><dd>${money(rev.shops)}</dd><dt>Restaurants</dt><dd>${money(rev.food)}</dd><dt>Lounges</dt><dd>${money(rev.lounges)}</dd>${rev.dutyfree ? `<dt>Duty free</dt><dd>${money(rev.dutyfree)}</dd>` : ""}${rev.rent ? `<dt>Rent guarantees</dt><dd>${money(rev.rent)}</dd>` : ""}<dt>Parking</dt><dd>${money(rev.parking)}</dd><dt>Curb access</dt><dd>${money(rev.curb)}</dd>
        <dt>Staff</dt><dd>−${money(st.cost.staff)}</dd><dt>Upkeep</dt><dd>−${money(st.cost.upkeep)}</dd>
        <dt><b>Profit</b></dt><dd><b class="${r.profit < 0 ? 'bad' : ''}">${money(revT - cost)}</b></dd>
      </dl>
      <h3>Satisfaction and profit over time</h3>
      <canvas id="hist" width="300" height="100" aria-label="Satisfaction and profit history"></canvas>
      <h3>Today so far</h3><ul class="log">${log}</ul>`;
  }

  drawHistory() {
    const c = document.getElementById('hist') as HTMLCanvasElement | null; if (!c) return;
    const dpr = Math.min(2, devicePixelRatio || 1); const W = c.clientWidth || 300, H = 100;
    c.width = W * dpr; c.height = H * dpr; const g = c.getContext('2d')!; g.scale(dpr, dpr);
    const h = this.sim.history.slice(-40); if (!h.length) return;
    g.strokeStyle = '#CDBFA4'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, (H - 16) / 2 + 3.5); g.lineTo(W, (H - 16) / 2 + 3.5); g.stroke();
    const xs = (i: number) => (h.length === 1 ? W / 2 : (i / (h.length - 1)) * (W - 8) + 4);
    const line = (vals: number[], lo: number, hi: number, col: string) => {
      const Y = (v: number) => H - 16 - ((v - lo) / (hi - lo || 1)) * (H - 22);
      g.strokeStyle = col; g.lineWidth = 1.6; g.beginPath();
      vals.forEach((v, i) => (i ? g.lineTo(xs(i), Y(v)) : g.moveTo(xs(i), Y(v)))); g.stroke();
      g.fillStyle = col; g.beginPath(); g.arc(xs(vals.length - 1), Y(vals[vals.length - 1]), 2.5, 0, Math.PI * 2); g.fill();
    };
    line(h.map(r => r.sat), 0, 100, '#28241E');
    const pr = h.map(r => r.profit); const m = Math.max(1, ...pr.map(Math.abs));
    line(pr, -m, m, '#C2852E');
    g.font = '500 10px "IBM Plex Mono", monospace'; g.fillStyle = '#6D6454'; g.fillText('— satisfaction', 4, H - 2); g.fillStyle = '#9A6A23'; g.fillText('— profit / day', 110, H - 2);
  }

  bindPanel() {
    const s = this.sim; const body = $('#panelBody');
    body.querySelectorAll<HTMLElement>('[data-act]').forEach(b => b.addEventListener('click', () => this.act(b.dataset.act!)));
    const price = document.getElementById('price') as HTMLInputElement | null;
    price?.addEventListener('input', () => { s.slotPrice = Number(price.value); this.liveNumbers(); });
    price?.addEventListener('change', () => this.ctl.save());
    for (const k of ['agents', 'screeners', 'handlers'] as const) {
      const el = document.getElementById(`staff-${k}`) as HTMLInputElement | null;
      el?.addEventListener('input', () => {
        s.staff[k] = Number(el.value); s.allocateStaff();
        const lab = el.previousElementSibling?.querySelector('b'); if (lab) lab.textContent = el.value;
        this.liveNumbers();
      });
      el?.addEventListener('change', () => this.ctl.save());
    }
    const mo = document.getElementById('moneyOn') as HTMLInputElement | null;
    mo?.addEventListener('change', () => { s.moneyOn = mo.checked; this.ctl.save(); });
  }

  act(a: string) {
    const s = this.sim; const sel = this.ren.selected;
    const z = sel?.kind === 'zone' ? s.world.zones.find(q => q.id === sel.id) : undefined;
    const w = sel?.kind === 'way' ? s.world.ways.find(q => q.id === sel.id) : undefined;
    const pay = (cost: number) => { if (!s.canAfford(cost)) { this.toast(`That costs ${money(cost)}`, 'bad'); return false; } s.spend(cost); return true; };
    if (a === 'demolish' && sel) this.demolish(this.selHit(sel));
    else if (a === 'open' && sel?.kind === 'site') { const st = this.world.sites?.find(q => q.id === sel.id); if (st) this.openTerminal(st); }
    else if ((a === 'units-' || a === 'units+') && z) {
      const u = s.d.units.get(z.id)!; z.units = clamp(u.count + (a === 'units+' ? 1 : -1), 1, u.max); this.changed();
    } else if (a === 'tier1' && z && z.tier === 0) {
      if (!pay(area(z) * ZONES[z.type].tierCostPerM2)) return;
      z.tier = 1; this.toast(`${ZONES[z.type].short} upgraded: ${ZONES[z.type].tierNames[1]}`); this.changed();
    } else if (a === 'tier0' && z && z.tier === 1) { z.tier = 0; this.changed(); }
    else if ((a === 'df0' || a === 'df1') && z && z.type === 'concourse') {
      z.dutyFree = a === 'df1'; this.changed();
      this.toast(z.dutyFree ? 'Walk-through duty free opens at the security exit' : 'Duty free closed: the security exit opens straight onto the spine');
    }
    else if (a.startsWith('cls') && z) {
      const c = Number(a.slice(3)) as Cls; const cur = (z.cls ?? 2) as number;
      if (c > cur && !pay((c - cur) * area(z) * 350)) return;
      z.cls = c; z.units = undefined; this.changed();
      this.toast(`Gates resized for ${CLASSES[c].example}: ${s.d.units.get(z.id)?.count ?? 0} gates`);
    } else if (a === 'taxiF' && w && w.cls < 3) {
      if (!pay(dist(w.a, w.b) * (TAXI_CLASSES[1].costPerM - TAXI_CLASSES[0].costPerM))) return;
      w.cls = 3; this.changed();
    } else if (a === 'lanes4' && w && w.lanes < 4) {
      if (!pay(dist(w.a, w.b) * (ROAD_LANES[1].costPerM - ROAD_LANES[0].costPerM))) return;
      w.lanes = 4; this.changed();
    }
    else if ((a === 'gateOff' || a === 'gateOn') && sel?.kind === 'gate') {
      const sl = s.d.gateSlots.find(q => q.zone.id === sel.id && q.key === sel.key);
      if (sl) { this.toggleGate(sl, a === 'gateOn'); this.ren.selected = { ...sel }; this.refresh(true); }
    }
    else if (a === 'sample') this.ctl.loadSample();
    else if (a === 'clear') {
      if (this.confirmClear > performance.now()) { this.confirmClear = 0; this.ctl.clearSite(); }
      else { this.confirmClear = performance.now() + 4000; this.refresh(true); }
    }
  }

  focusAirport() {
    const zs = this.world.zones; const rs = this.world.runways;
    if (!zs.length && !rs.length) { this.ren.cam = { x: SITE.width / 2, y: SITE.height / 2 - 400, zoom: Math.min(this.ren.W / SITE.width, this.ren.H / SITE.height) * 1.05 }; return; }
    const pts: Pt[] = [...zs.flatMap(z => [{ x: z.x, y: z.y }, { x: z.x + z.w, y: z.y + z.h }]), ...rs.flatMap(r => [r.a, r.b])];
    const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x));
    const y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
    const zoom = clamp(Math.min((this.ren.W * 0.62) / (x1 - x0 + 400), (this.ren.H * 0.7) / (y1 - y0 + 400)), 0.08, 2);
    this.ren.cam = { x: (x0 + x1) / 2 + (this.ren.W > 820 ? 120 / zoom : 0), y: (y0 + y1) / 2, zoom };
    if (this.ren.mode3d) this.ren.r3?.enterFrom(this.ren.cam.x, this.ren.cam.y, zoom);
    this.autoLod();
  }
}

const CLASS_EX = (c: number) => CLASSES[c].example;
const TERMINAL_TOOLS = new Set<ZoneType>(['checkin', 'security', 'concourse', 'claim']);
const center4 = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
