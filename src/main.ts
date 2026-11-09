// Boot, save/load and the frame loop.
import { Sim } from './sim';
import { Renderer } from './render';
import { UI, money } from './ui';
import { World, newWorld, migrateWorld } from './world';
import { sampleWorld } from './sample';

const KEY = 'airport-builder-alpha-v3';
interface Save { world: World; staff: Sim['staff']; slotPrice: number; moneyOn: boolean; money: number; calDays: number; rep: number }

type Hot = { data?: Save; ready?: (fn: (d: Save | Record<string, never>) => void) => void; snapshot?: (fn: () => Save) => void };
const hot = (window as unknown as { claude?: { hot?: Hot } }).claude?.hot;

function readSave(): Save | null {
  try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) as Save : null; } catch { return null; }
}

function start(restored: Save | null) {
  const saved = restored ?? readSave();
  const world = saved?.world?.ways ? migrateWorld(saved.world) : sampleWorld();
  const sim = new Sim(world, 7);
  if (saved) {
    sim.staff = saved.staff; sim.slotPrice = saved.slotPrice; sim.moneyOn = saved.moneyOn;
    sim.money = saved.money; sim.calDays = saved.calDays; sim.rep = saved.rep;
    sim.relayout(); sim.startDay();
  }
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const ren = new Renderer(canvas);
  ren.resize();

  const snapshot = (): Save => ({ world: sim.world, staff: sim.staff, slotPrice: sim.slotPrice, moneyOn: sim.moneyOn, money: sim.money, calDays: sim.calDays, rep: sim.rep });
  const ctl = {
    speed: 4, paused: false,
    save() { try { localStorage.setItem(KEY, JSON.stringify(snapshot())); } catch { /* storage unavailable: play on */ } },
    loadSample() { reset(sampleWorld()); ui.toast('Sample airport loaded'); },
    clearSite() { reset(newWorld()); ui.toast('Site cleared. Draw a runway to begin.'); ui.setTool('runway'); },
  };
  function reset(w: World) {
    sim.world = w; sim.money = 420_000_000; sim.calDays = 0; sim.day = 0; sim.rep = 1; sim.history = []; sim.log = [];
    sim.relayout(); sim.startDay();
    ren.selected = null; ui.focusAirport(); ui.refresh(true); ctl.save();
  }
  const ui = new UI(sim, ren, ctl);
  ui.focusAirport();
  hot?.snapshot?.(snapshot);

  sim.onDayEnd = r => {
    const s = r.stats;
    ui.toast(`${r.label} closed · ${s.paxDep + s.paxArr} pax · satisfaction ${r.sat.toFixed(0)} · ${money(r.profit)}/day${r.periodDays > 1 ? ` × ${r.periodDays}` : ''}`, r.sat < 60 || s.missed > 20 ? 'warn' : 'info');
    if (sim.moneyOn && sim.money < 0) ui.toast('The airport is in debt. Cut costs or raise slot fees.', 'bad');
    ctl.save();
    if (ui.tab === 'report') ui.refresh(true);
  };

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!ctl.paused) {
      let left = ctl.speed * dt;               // speed = sim minutes per real second
      while (left > 0) { const st = Math.min(0.25, left); sim.step(st); left -= st; }
    }
    ren.draw(sim);
    ui.hud();
    requestAnimationFrame(frame);
  };
  window.addEventListener('resize', () => ren.resize());
  requestAnimationFrame(frame);
  (window as unknown as { __game: unknown }).__game = { sim, ren, ui, ctl };
}

const boot = () => {
  const go = () => { if (hot?.ready) hot.ready(d => start((d as Save)?.world ? d as Save : null)); else start(null); };
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts?.ready) Promise.race([fonts.ready, new Promise(r => setTimeout(r, 1500))]).then(go); else go();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
