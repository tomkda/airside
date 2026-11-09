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
node scripts/shot.cjs out.png <camX> <camY> <zoom> ["js using g = window.__game"]   # needs playwright; GL3D=1 for shots of the 3D view
```

Healthy results:
- simtest shows Terminal 1 open, 0 missed passengers and leased lots growing week to week. Security in the sample runs close to capacity, so other seeds can miss some passengers in week 3; that predates v0.7.
- terminals.mjs shows 0 stranded passengers, and its frontage check shows curbs at 20 m and 42 m, none at 82 m (Terminal 1 closes), and curbs again when the road comes back.
- stress.mjs strands passengers on purpose on the days it cuts walkways or moves check-in. That is expected.

## Architecture

- **One file out.** scripts/build.mjs bundles src/ with esbuild into a single HTML page. There is no server. three.js (pinned 0.170.0) is the only runtime dependency and is bundled in; it is used by render3d.ts alone.
- **The sim never touches the DOM.** config, geom, net, world, gates, bands, commerce, frontage, layout and sim are pure logic.
  - render.ts (plan) and render3d.ts (3D, three.js) read sim state and never write it.
  - ui.ts owns input and panels.
  - Keep this split: sim and world may be ported to Godot/C# later.
- **World vs derived.** `World` (world.ts) is the saved, player-built state: zones, runways, ways and terminal sites. `derive(world)` rebuilds everything else after any edit:
  - generated curbs and upper decks (frontage.ts); `d.zones` is the world's zones plus these, and is what the sim and renderers iterate
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
- **Terminal sites** (v0.8): `world.sites` are allocated with New terminal; each module carries `site`.
  - A terminal is a site plus the modules on it. A module with no site joins the site of whatever it connects to on foot.
  - The UI places terminal modules only in the open terminal, then calls `fitSite()` so the site grows to fit.
- **Levels of detail** (v0.8): `ren.lod` is `airfield`, `landside` or `terminal`, and `ren.focus` is the open site.
  - ui.ts switches them by zoom (`LOD` in config.ts) or explicitly. Each tool declares its level.
  - render.ts and render3d.ts decide what to draw from them. The sim doesn't know about them.
- **Frontage** (frontage.ts, v0.8): a road parallel to a check-in, claim or security face within `FRONTAGE.minGap`–`maxGap` grows a curb.
  - The curb is a Zone with a negative id and an `auto` tag, rebuilt on every derive and never saved.
  - L1 departures over L0 arrivals on the same road make a `dep` curb at L1, an `arr` curb at L0 and a `DeckSpan`.
  - Roads are split at curb ends so cars can pull in. The sim prefers `dep` curbs for drop-off and `arr` for pickup.
- **Concourse commerce** (commerce.ts, v0.7):
  - bands.ts carves lots and scores what the plan decides: visibility from the spine, closeness to the security exit, the gate cluster nearby.
  - The sim counts departing passengers along each concourse's long axis in 4 m bins, weighted by spare minutes (`sim.flowDay`). At day end the count folds into `zone.flow`, so it is saved.
  - `letLots()` runs inside `derive()`: each tenant format bids for each lot it fits; a sitting tenant (`zone.tenants`, written by the sim at day end) keeps its lot unless out-bid by `COMMERCE.relet`.
  - Walk-through duty free (`zone.dutyFree`) adds a `dutyfree` step after security for every departing passenger in the terminal.
  - All tuning lives in `COMMERCE` and `TENANTS` (config.ts).
- **Gates** (gates.ts): any concourse side with a parallel taxiway within reach gets gate slots on a fixed grid.
  - Reach runs from one stand depth to max(150 m, two stand depths + 40 m).
  - Gates are downsized if the taxiway is close.
  - The player toggles individual slots. Switched-off slot keys (`n0`, `e2`, …) live in `zone.off`.
- **Concourse interiors** (bands.ts): the concourse width is a budget.
  - **Holdroom band** behind each run of gates, sized by the ACRP load rule and at least 9 m deep.
  - **Spine:** 9 m wide, or 13.4 m with moving walkways on arms over 300 m.
  - **Commercial lots** either side of the spine, sized by depth: under 4 m is seating only; 4–8 m kiosks; 8–15 m shops and cafés; over 15 m restaurants, flagship stores and lounges.
  - **Restroom cores** about every 160 m.
  - Window lots sit on ungated exterior walls. Tenants bid for lots (commerce.ts) and the best-scoring lots lease first.
- **Other fit-outs** (layout.ts): check-in, security, claim and curb. Each module faces the module it touches upstream.
- **Terminals:** zones joined on foot form a terminal. It opens only when check-in, security, a concourse with working gates and bag claim connect, with a road-served curb. Only open terminals get flights. Each airline has a home terminal.
- **Saves** go to localStorage under `airport-builder-alpha-v3`. Don't rename the key. Any schema change needs a step in `migrateWorld()` (world.ts). v0.8 added `sites`; old saves get one site per group of touching terminal modules.
- **Debug handle:** `window.__game = { sim, ren, ui, ctl }`.

## Conventions

- One version per pull request. Bump `version` in package.json and the README heading's feature list. Update known gaps. Describe changes in plain language.
- Before opening a PR, run check, build and all three sims. Take a screenshot of anything visual.
- Use real planning numbers (ACRP, IATA, ACI) where they exist, and cite them in a comment where the constant lives.
- The owner is an architect. Plan language (frontage, bands, holdrooms, cores) is welcome; game-design jargon less so.

## Roadmap

Foundation (v0.8): three levels of detail, terminal sites, roads and terminals adapting to each other (curbs, two-level frontage roads, snapping), and a 3D view. Next in that direction: parking lots that lay their own sidewalk to the curb, gates and holdrooms that respond to the taxiway and apron as you drag them, curbs on angled frontages, and moving modules in 3D.

The concourse interiors plan has four phases.

1. **Done in v0.6:** one concourse type, with band carving in rectangles.
2. **Done in v0.7:** simulated footfall past each lot, visibility and dwell scores, tenants bidding for lots by score (with rent and overnight re-letting), walk-through duty free at the security exit, and a commercial heatmap.
3. **Next:** compound arm-and-hub concourse shapes (X, Y and T piers), and satellites with a people mover.
4. Mezzanine lounges; tenant growth, merges and pop-ups; day-parting; disruption surges.

Other known gaps:
- Construction is instant.
- Departing bags aren't simulated.
- Aircraft don't hold for each other on taxiways.
- Shortening a runway leaves an old end stub.
- Angled exits always follow the prevailing wind.
