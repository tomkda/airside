# Airside

A sandbox/tycoon airport builder for PC, prototyped in the browser. The look is a top-down airport-diagram print, with an optional 2.5D massing view.

The player draws runways, taxiways, roads and sidewalks, and blocks out terminal modules on two levels: check-in, security, concourse, bag claim, curb and parking. The game fits each module out procedurally. Aircraft, passengers, bags and cars then flow through what was built. Every failure should be fixable with staff, space or layout.

README.md has the full feature list, controls and known gaps. Keep it current.

## Commands

```
npm install
npm run check        # TypeScript type-check
npm run build        # dist/index.html, one self-contained file
npm run dev          # rebuild on save
npm run simtest      # 3 sim days on the sample airport, prints the daily report
node scripts/terminals.mjs   # multi-terminal scenarios
node scripts/stress.mjs      # 14 days with deliberate cuts and an A380 build-out
npm test             # all three sims
node scripts/shot.cjs out.png <camX> <camY> <zoom> ["js using g = window.__game"]   # needs playwright
```

Healthy results:
- simtest shows Terminal 1 open, 0 missed passengers and leased lots growing week to week.
- terminals.mjs shows 0 stranded passengers.
- stress.mjs strands passengers on purpose on the days it cuts walkways or moves check-in. That is expected.

## Architecture

- **One file out.** scripts/build.mjs bundles src/ with esbuild into a single HTML page. There are no runtime dependencies and no server.
- **The sim never touches the DOM.** config, geom, net, world, gates, bands, layout and sim are pure logic.
  - render.ts reads sim state and never writes it.
  - ui.ts owns input and panels.
  - Keep this split: sim and world may be ported to Godot/C# later.
- **World vs derived.** `World` (world.ts) is the saved, player-built state: zones, runways and ways. `derive(world)` rebuilds everything else after any edit:
  - designators
  - gates and aprons
  - the airfield, road and pedestrian graphs
  - vertical cores and crosswalks
  - terminals
  - fit-out frames
  - design-check issues
- **Networks** (net.ts): drawn segments are split into graphs at intersections. Routing uses Dijkstra and all-pairs.
  - Airfield edges carry a class. Back-taxi on a runway is allowed at ×4 cost.
  - Pedestrians move only through doors where same-level zones touch, through vertical cores, and along sidewalks.
- **Aircraft classes** (config.ts `CLASSES`): turboprop, regional jet, A320, A380. Each sets runway length, gate spacing, stand depth, seats and turnaround.
- **Gates** (gates.ts): any concourse side with a parallel taxiway within reach gets gate slots on a fixed grid.
  - Reach runs from one stand depth to max(150 m, two stand depths + 40 m).
  - Gates are downsized if the taxiway is close.
  - The player toggles individual slots. Switched-off slot keys (`n0`, `e2`, …) live in `zone.off`.
- **Concourse interiors** (bands.ts): the concourse width is a budget.
  - **Holdroom band** behind each run of gates, sized by the ACRP load rule and at least 9 m deep.
  - **Spine:** 9 m wide, or 13.4 m with moving walkways on arms over 300 m.
  - **Commercial lots** either side of the spine, sized by depth: under 4 m is seating only; 4–8 m kiosks; 8–15 m shops and cafés; over 15 m restaurants, flagship stores and lounges.
  - **Restroom cores** about every 160 m.
  - Window lots sit on ungated exterior walls. Lots nearest security lease first.
- **Other fit-outs** (layout.ts): check-in, security, claim and curb. Each module faces the module it touches upstream.
- **Terminals:** zones joined on foot form a terminal. It opens only when check-in, security, a concourse with working gates and bag claim connect, with a road-served curb. Only open terminals get flights. Each airline has a home terminal.
- **Saves** go to localStorage under `airport-builder-alpha-v3`. Don't rename the key. Any schema change needs a step in `migrateWorld()` (world.ts).
- **Debug handle:** `window.__game = { sim, ren, ui, ctl }`.

## Conventions

- One version per pull request. Bump `version` in package.json and the README heading's feature list. Update known gaps. Describe changes in plain language.
- Before opening a PR, run check, build and all three sims. Take a screenshot of anything visual.
- Use real planning numbers (ACRP, IATA, ACI) where they exist, and cite them in a comment where the constant lives.
- The owner is an architect. Plan language (frontage, bands, holdrooms, cores) is welcome; game-design jargon less so.

## Roadmap

The concourse interiors plan has four phases.

1. **Done in v0.6:** one concourse type, with band carving in rectangles.
2. **Next:**
   - simulated footfall past each lot
   - visibility and dwell scores
   - tenants bidding for lots by score
   - walk-through duty free at the first node after security
   - a commercial heatmap view
3. Compound arm-and-hub concourse shapes (X, Y and T piers), and satellites with a people mover.
4. Mezzanine lounges; tenant growth, merges and pop-ups; day-parting; disruption surges.

Other known gaps:
- Construction is instant.
- Departing bags aren't simulated.
- Aircraft don't hold for each other on taxiways.
- Shortening a runway leaves an old end stub.
- Angled exits always follow the prevailing wind.
