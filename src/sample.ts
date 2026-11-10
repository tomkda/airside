// A starter airport so the alpha opens in a working state: one complete terminal.
// Departures on L1: check-in -> security -> concourse (gates on the airside wall, shops behind them).
// Arrivals on Ground: claim sits under the gates and check-in so cores form.
// v0.14: no curb and no frontage road are drawn. The hall lays its own forecourt to Terminal Drive: a departures
// curb on an upper deck, reached by ramps, and an arrivals curb on the ground road below it.
import { World, WayKind, newWorld, autoConnectors, bboxOf, padRect } from './world';
import { ZoneType, Level, Cls, SITES } from './config';

export function sampleWorld(): World {
  const w = newWorld();
  const site = w.nextId++;
  const z = (type: ZoneType, level: Level, x: number, y: number, ww: number, h: number, units?: number, cls?: Cls, onSite = true) =>
    w.zones.push({ id: w.nextId++, type, level, x, y, w: ww, h, tier: 0, units, cls, site: onSite ? site : undefined });
  const way = (kind: WayKind, ax: number, ay: number, bx: number, by: number, cls = 2, lanes = 2) =>
    w.ways.push({ id: w.nextId++, kind, a: { x: ax, y: ay }, b: { x: bx, y: by }, cls, lanes });

  w.runways.push({ id: w.nextId++, a: { x: 1900, y: 2300 }, b: { x: 4500, y: 2300 } });   // 09/27, 2,600 m: up to A320

  // Parallel taxiway A, auto-linked to the runway. The concourse faces it 130 m away, so gates appear.
  way('taxi', 1900, 2490, 4500, 2490);
  for (const c of autoConnectors(w, { a: { x: 1900, y: 2490 }, b: { x: 4500, y: 2490 }, cls: 2 }, []))
    w.ways.push({ id: w.nextId++, kind: 'taxi', a: c.a, b: c.b, cls: c.cls, lanes: 0 });

  // Terminal 1
  // 60 m wide: 9 m holdrooms on the gated north wall, a 13.4 m spine with walkways, shops and window dining south.
  z('concourse', 1, 2800, 2620, 600, 60, undefined, 2);
  z('security', 1, 2990, 2680, 120, 130, 8);
  // v0.14: one hall, check-in on Level 1 over baggage claim on Ground. It lays its own forecourt (below).
  const ci = w.nextId++, cl = w.nextId++;
  w.zones.push({ id: ci, type: 'checkin', level: 1, x: 2880, y: 2810, w: 340, h: 60, tier: 0, units: 40, site, pair: cl });
  w.zones.push({ id: cl, type: 'claim', level: 0, x: 2880, y: 2810, w: 340, h: 60, tier: 0, site, pair: ci });
  z('parking', 0, 2880, 3010, 340, 180, undefined, undefined, false);
  w.sites!.push({ id: site, ...padRect(bboxOf(w.zones.filter(q => q.site === site)), SITES.pad) });

  // Roads: only the approach is drawn. Two roads come up from State Route 12 to a roundabout each, and Terminal
  // Drive runs between the roundabouts. Nothing is drawn along the terminal: the hall lays its own two-level
  // forecourt down to Terminal Drive, with a ramp each side up to the departures deck, and the car park lays its
  // own drives and its sidewalk to the arrivals curb.
  way('road', 2780, 5700, 2780, 3230, 0, 4);
  way('road', 2780, 3230, 3320, 3230, 0, 4);
  way('road', 3320, 3230, 3320, 5700, 0, 4);
  w.rounds!.push({ id: w.nextId++, x: 2780, y: 3230, size: 1 }, { id: w.nextId++, x: 3320, y: 3230, size: 1 });

  return w;
}
