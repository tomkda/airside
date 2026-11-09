// A starter airport so the alpha opens in a working state: one complete terminal.
// Departures on L1: check-in -> security -> concourse (gates on the airside wall, shops behind them).
// Arrivals on Ground: claim sits under the gates and check-in so cores form.
// v0.8: no curb is drawn. The frontage road runs 20 m off the building face, so curbs grow by themselves:
// a departures curb on an upper deck beside check-in, and an arrivals curb below it beside baggage claim.
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
  z('checkin', 1, 2880, 2810, 340, 60, 40);
  z('claim', 0, 2950, 2650, 200, 220, 4);
  z('parking', 0, 2880, 3010, 340, 180, undefined, undefined, false);
  w.sites!.push({ id: site, ...padRect(bboxOf(w.zones.filter(q => q.site === site)), SITES.pad) });

  // Roads: a loop from State Route 12 along the terminal face (4 lanes, 20 m off the building), The lot lays its own access drive (v0.10).
  way('road', 2780, 5700, 2780, 2898, 0, 4);
  way('road', 2780, 2898, 3320, 2898, 0, 4);
  way('road', 3320, 2898, 3320, 5700, 0, 4);
  way('road', 2780, 2955, 3320, 2955, 0, 2);
  // v0.11: a roundabout on each approach, joined by a curved link road, so a driver who misses the terminal can
  // come round again. Both sit on the approach roads and cut them back to the ring by themselves.
  w.rounds!.push({ id: w.nextId++, x: 2780, y: 3320, size: 1 }, { id: w.nextId++, x: 3320, y: 3320, size: 0 });
  w.ways.push({ id: w.nextId++, kind: 'road', a: { x: 2780, y: 3320 }, b: { x: 3320, y: 3320 }, c: { x: 3050, y: 3440 }, cls: 0, lanes: 2 });

  // No sidewalk is drawn: the lot lays its own to the arrivals curb (v0.9), with crosswalks over both roads.
  return w;
}
