// A starter airport so the alpha opens in a working state: one complete terminal.
// Departures on L1: check-in -> security -> concourse (gates on the airside wall, shops behind them).
// Arrivals on Ground: claim sits under the gates and check-in so cores form, and opens onto the curb.
import { World, WayKind, newWorld, autoConnectors } from './world';
import { ZoneType, Level, Cls } from './config';

export function sampleWorld(): World {
  const w = newWorld();
  const z = (type: ZoneType, level: Level, x: number, y: number, ww: number, h: number, units?: number, cls?: Cls) =>
    w.zones.push({ id: w.nextId++, type, level, x, y, w: ww, h, tier: 0, units, cls });
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
  z('curb', 0, 2830, 2870, 440, 30);
  z('parking', 0, 2880, 3010, 340, 180);

  // Roads: a loop from State Route 12 through the curb, with a lot access road.
  way('road', 2780, 5700, 2780, 2885, 0, 4);
  way('road', 2780, 2885, 2830, 2885, 0, 4);
  way('road', 3270, 2885, 3320, 2885, 0, 4);
  way('road', 3320, 2885, 3320, 5700, 0, 4);
  way('road', 2780, 2955, 3320, 2955, 0, 2);
  way('road', 2950, 2955, 2950, 3010, 0, 2);

  // Sidewalk from the lot to the curb, crossing the service road.
  way('walk', 3150, 3010, 3150, 2900, 0, 0);
  return w;
}
