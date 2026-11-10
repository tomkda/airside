# Airside

A sandbox/tycoon airport builder for PC, prototyped in the browser. The look is a top-down airport-diagram print, with a 3D view styled like a presentation model.

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
node scripts/growth.mjs      # every growth facility, international flights, the AirTrain
node scripts/roads.mjs       # curves, roundabouts and one-way loops
node scripts/halls.mjs       # stacked halls and self-laid forecourts
node scripts/satellites.mjs  # satellite concourses and people movers
node scripts/piers.mjs       # piers at any angle and round or polygonal hubs
node scripts/aprons.mjs      # self-laid aprons and taxilanes, and reshaping by grips (exits 1 if a check fails)
node scripts/curves.mjs      # bent and tapered piers (exits 1 if a check fails)
npm test             # all ten sims
node scripts/shot.cjs out.png <camX> <camY> <zoom> ["js using g = window.__game"]   # needs playwright; GL3D=1 for shots of the 3D view
```

Healthy results:
- simtest shows Terminal 1 open with 14 gates (12 on taxiway A and a self-laid stand at each end), 0 missed passengers and leased lots growing week to week. Security in the sample runs close to capacity, so other seeds can miss some passengers in week 3; that predates v0.7.
- terminals.mjs shows 0 stranded passengers. Its frontage check shows `G arr, L1 dep` and Terminal 1 open in every line: self-laid frontage 1 with nothing drawn, 0 with a road drawn 20 m or 42 m off the face (that road grows the curbs), and 1 again at 82 m and when the road is removed.
- growth.mjs shows 8 facilities served, the far garage served by AirTrain, 0 missed and 0 stranded, international flights scheduled, and several hundred AirTrain riders a day.
- roads.mjs shows Terminal 1 open with 0 missed, 0 stranded and 0 wrong-way cars in every scenario except the reversed loop, which must close the terminal and raise the one-way warning. Cars go round the ring wherever there is a roundabout, and far fewer cars overlap as drawn than on the centreline.
- halls.mjs shows Terminal 1 open with `G arr, L1 dep` curbs and a deck in every case but the last: a self-laid forecourt (1 frontage, 2 links, 2 ramps) on the sample and with separate check-in and claim; no forecourt where the frontage road is drawn by hand; 4 links where the road stops short and off to one side; and Terminal 1 closed with no forecourt when no road is in reach. No car uses a ramp unless it is bound for the deck. The one-rectangle terminal reports its airside edge as `n` and opens with 0 stranded.
- satellites.mjs shows Terminal 1 open with 0 missed and 0 stranded in every case (the one-satellite case hires four agents and two screeners, because its extra gates bring a thirtieth flight); one people mover per satellite (a chain when they are in a line); every flight at satellite gates and every passenger riding when the main gates are switched off; and a concourse out of reach left as a closed Terminal 2.
- piers.mjs shows Terminal 1 open with 0 missed, 0 stranded and nobody outside a building in every case; the 20° pier with 15–18 gates and its own lots (the merged case can miss some passengers in week 3 since v0.24: more gates bring more flights onto the same staff); no people mover when it is merged into the concourse and one when it stands apart; and every flight at pier gates when the main gates are switched off. With a round or hexagonal hub between the concourse and the pier it is still one terminal of 3 concourses with no people mover, the hub has 15–17 lots, and every flight still reaches the pier when the main gates are off.
- aprons.mjs ends with `all checks passed`: the sample has 14 gates and none on its landside face; a 20° pier with no taxiway drawn has stands on both sides and its tip, all reaching a runway; no two stands of that merged building are within 30 m of each other, every gate has its own name, and it keeps a junction space with no shop lot in it (the one-piece sample has none); four concourses round a square enclose one courtyard with a space at each corner; a 40 m pier (no stand on its end) and a 50 m A380 concourse still reach a runway from both sides; twelve satellites all find a way out; no generated taxilane crosses a lot's own sidewalk or drive; a round hub has twelve; a runway and one concourse alone give 26 gates linked straight to the runway; a hub 500 m from anything has stands but no way out, said once; stands give way to a road; a drawn taxiway takes its side over; every flight flies from self-laid gates with 0 missed when the main gates are off; and the grips keep the far end or the opposite edge where it was.
- curves.mjs ends with `all checks passed`: straightening a point and bending it back is exact; the bend grip leaves both ends where they are and stops at the tightest radius the width allows; a 500 m pier bent 120 m has more stands on the outside of the bend than the inside, every one reaching a runway, every lot inside the building, and is one terminal with the concourse it was drawn out of; a bend too tight has no stands on its inside; a straight pier drawn out of a bent one makes a terminal of three concourses with no people mover; a 60 m pier with a 40 m taper is 40 m wide at one end and 80 m at the other; an end grip changes one end's width and leaves the other end and the centreline alone; two legs and a corner hall drawn as a path out of the concourse are one terminal with no people mover; straight and bent tapered piers have stands on both walls that all reach a runway, with every door and lot inside and every stand outside; and with the main gates off every flight flies from the bent pier with 0 missed, 0 stranded and nobody outside a building.
- stress.mjs strands passengers on purpose on the day it moves check-in (arrivals too since v0.14, because the hall's curbs go with it), and on the days it cuts the road or the taxiway. Cutting the walkways no longer strands anyone, because the lot lays its own sidewalk (v0.9). That is expected.

## Architecture

- **One file out.** scripts/build.mjs bundles src/ with esbuild into a single HTML page. There is no server. Two runtime dependencies are bundled in: three.js (pinned 0.170.0), used by render3d.ts alone, and clipper-lib (polygon union and offsetting), used by shell.ts alone.
- **The sim never touches the DOM.** config, geom, net, ways, shapes, terminalplan, world, gates, bands, commerce, frontage, roads, scenery, goals, layout and sim are pure logic.
  - render.ts (plan) and render3d.ts (3D, three.js, with models3d.ts) read sim state and never write it. traffic.ts is pure too.
  - scenery.ts places trees, lamps, floodlight masts and the control tower from the layout (cached per derive); both renderers draw from it.
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
- **Terminal sites** (v0.8): `world.sites` are allocated with New terminal (an empty site by default since v0.19; the starter layout is an option); each module carries `site`.
  - A terminal is a site plus the modules on it. A module with no site joins the site of whatever it connects to on foot.
  - v0.15: terminalplan.ts (pure) gives a new site its starter layout: `airsideOf()` picks the edge facing the nearest taxiway or runway, `planTerminal()` returns the concourse, security and hall rectangles. ui.ts `buildSite()` builds them unless the tool is set to Empty site, and hires staff for a second terminal.
  - The UI places terminal modules only in the open terminal, then calls `fitSite()` so the site grows to fit.
- **Levels of detail** (v0.8): `ren.lod` is `airfield`, `landside` or `terminal`, and `ren.focus` is the open site.
  - ui.ts switches them by zoom (`LOD` in config.ts) or explicitly. Each tool declares its level.
  - render.ts and render3d.ts decide what to draw from them. The sim doesn't know about them.
- **Frontage** (frontage.ts, v0.8): a road parallel to a check-in, claim or security face within `FRONTAGE.minGap`–`maxGap` grows a curb.
  - The curb is a Zone with a negative id and an `auto` tag, rebuilt on every derive and never saved.
  - L1 departures over L0 arrivals on the same road make a `dep` curb at L1, an `arr` curb at L0 and a `DeckSpan`.
  - Roads are split at curb ends so cars can pull in. The sim prefers `dep` curbs for drop-off and `arr` for pickup.
  - v0.12: `autoForecourt()` runs first. A check-in hall (with whatever claim is stacked under it) that no drawn road fronts lays a frontage road at `FRONTAGE.ideal` off its best open face and a link from each end to the nearest road within `FRONTAGE.reach` (straight out, straight on, or since v0.14 out and round one corner). These are generated `Way`s with `fore: 'face' | 'link'` and ids above `FORE`; they join `d.autoRoads`, and `autoFrontage()` grows curbs and decks on the `face` one like on any road.
  - v0.13: each forecourt link that comes straight out also gets a `fore: 'ramp'` way (curved, `face` = its frontage road's id): it leaves the link and lands on the frontage line. `DeckSpan.pts/zs/ws` is the deck's whole path with height and width per point; both renderers draw the deck from it. `d.rampRefs` lists ramp ids: the sim routes only deck trips over them (`roadDJ(target, deck)`), and roads.ts and `sim.roadCap` treat a ramp's ends as merges, not junctions.
  - v0.12: a hall is a `checkin` zone on L1 and a `claim` zone on L0 with the same rectangle, each holding the other's id in `pair`. ui.ts builds, moves and demolishes them together (`placeHall`, `twin`).
  - v0.9: `autoWalks()` lays a sidewalk from any lot no sidewalk reaches to the nearest ground-level curb (`d.autoWalks`, negative ids, never saved).
- **Growth** (v0.10): `UNLOCKS` and `GROWTH` in config.ts. `sim.unlocked` and `sim.bestPax` are saved; `sim.has(id)` is true in sandbox.
  - New zone types: `passport` (a terminal module with a queue, like security), and `rideshare`, `rental`, `bus`, `hotel`, `train` on the landside. A garage is a `parking` zone with `floors`; a mezzanine is `mezz` on a concourse.
  - `autoRoads()`, `autoWalks()` and `trainLinks()` (frontage.ts) connect facilities; `d.served` lists the ones that work. All generated, never saved.
  - Arriving parties can leave by rideshare lot, rental centre or bus (the `lot` step with a different zone); departing ones can arrive by bus. AirTrain rides are fast pedestrian edges between station nodes (`p.ride`).
  - International: `Airline.intl`, `Terminal.intl`, a `passport` step before claim, `staff.officers`.
  - Weather and airline offers draw from their own seeded streams, so they never shift the main one.
- **Roads** (roads.ts, v0.10): `roadPlan(d)` turns the road graph into junction curves, ramps, stop bars, arrows, medians and gate plazas, cached per derive. Both renderers draw roads from it.
- **Drawn road shapes** (ways.ts, v0.11): a road `Way` may carry `c` (the control point of a quadratic curve) and `oneway` (a to b). `world.rounds` holds roundabouts (`size` indexes `ROUNDS` in config.ts).
  - `roadPieces()` turns every road into straight pieces for the network: curves in chords, straight roads split at curb ends, everything cut back to the ring of any roundabout it reaches, plus the ring itself (one-way, anticlockwise, ref `ringRef(id)`). `d.roadPieces` and `d.rounds` carry them.
  - Net edges have `ow`. `dijkstra()` takes a direction: the sim routes cars with -1 (towards the target), and `roadOK` needs a way in and a way out.
  - Anything that walks a road's geometry uses `wayPts()` / `waySegs()` / `wayLen()`, never `a` and `b` alone. Curbs grow along straight roads only.
  - `roadPlan` chains edges into `paths` (one polyline per run of road), and adds roundabout entries, splitter islands and yield lines. Both renderers draw from paths.
  - `sim.roadCap`: an edge that ends at a crossroads or T holds `ROADS.junctionDelay` of its length in cars; ring edges and roundabout approaches hold all of it.
- **Traffic as drawn** (traffic.ts, v0.12): `carPoses(sim)` gives each car's drawn position: offset into its lane, corners rounded, held `CAR_GAP` behind the car ahead on the same edge, with a brake flag. Pure and read-only; both renderers use it. The sim's cars still move on the centreline.
- **Sound** (sound.ts, v0.12): Web Audio synthesis, no files. Only ui.ts and main.ts call it. The preference is saved under `airside-sound`, apart from the game save.
- **Undo** (ui.ts): a JSON snapshot of the World and money per edit, 50 deep.
- **Goals** (goals.ts, v0.9): milestones with grants, checked on every relayout (which also runs at day end); `sim.goalsDone` is saved in the save (not the World). `rating()` gives the header's star rating.
- **Concourse commerce** (commerce.ts, v0.7):
  - bands.ts carves lots and scores what the plan decides: visibility from the spine, closeness to the security exit, the gate cluster nearby.
  - The sim counts departing passengers along each concourse's long axis in 4 m bins, weighted by spare minutes (`sim.flowDay`). At day end the count folds into `zone.flow`, so it is saved.
  - `letLots()` runs inside `derive()`: each tenant format bids for each lot it fits; a sitting tenant (`zone.tenants`, written by the sim at day end) keeps its lot unless out-bid by `COMMERCE.relet`.
  - Walk-through duty free (`zone.dutyFree`) adds a `dutyfree` step after security for every departing passenger in the terminal.
  - All tuning lives in `COMMERCE` and `TENANTS` (config.ts).
- **Self-laid aprons** (gates.ts `selfAprons`, v0.19): `buildGateAreas(world, runways, width, { self, keep })` runs the old pass first (sides with a drawn parallel taxiway), then every other side lays its own apron.
  - Same grid and keys as a drawn side (`n3`, `f2.0`), one `selfDepth(cls)` deep (`APRON` in config.ts: nose gap + aircraft + ICAO taxilane clearance). `Apron.self` marks them; `SideGuide.self` / `.land` say why a side has or lacks them.
  - First come, first served, in zone then side order. A slot needs its cell clear of other zones' outlines, of aprons already laid, of `keep` (drawn and forecourt roads and sidewalks, as straight pieces), of taxiways and roundabouts, on the site and out of the runway strip, and its taxilane `APRON.laneClear` from any other building. A side that security, check-in, claim or passport stands against is landside.
  - Lanes: one per run of stands. Lanes whose lines meet near both ends are joined at the corner (and the corner paved: `d.pads`). Lanes on opposite sides of a building with no stand on its end are joined round that end. Each loose end takes the cheapest of straight on, straight out, or on 30/60/100 m and then out or back across the building's end (`waysOut`). Anything still not touching a drawn taxiway or runway (a ring) takes the cheapest way out from any lane. Generated lanes go into the air net as `taxi` segments with ref `-(LANE_REF + i)` and into `d.airExtra`, which both renderers draw.
  - derive calls it three times: on the source world without `self` (what the forecourt must avoid), on the world with curbs without `self` (what `autoWalks` and `autoRoads` must avoid, exactly as before v0.19), then with `self`, with the drawn roads and sidewalks, the forecourt and those generated walks and drives all in `keep`. The landside is laid first; taxilanes never cross it. Self-laid aprons never block placement (`canPlaceZone`, `placeSeg`, `canPlaceRound` skip `a.self`): build on one and it gives way.
  - It runs every frame of a drag, so the clearance tests go through bounding boxes first. Keep it that way.
- **Grips and live edits** (v0.19):
  - shapes.ts `gripsOf(z, turns)` and `regrip(z0, grip, p, turns, limits)` are pure: edges move square to themselves with the opposite edge fixed; ends `a`/`b` of a turnable shape stretch and swing about the far end; `m` bends it (v0.20); `r` resizes (and turns) a hub. `canTurn(z)` is in world.ts. When a frame turns over, `off` keys are renamed so a switched-off gate stays on the same wall.
  - ui.ts: `beginLive` / `liveSet` / `liveDraft` / `frame` / `endLive` / `settle`. During a grip drag, a body move, or while a zone tool draws, the World itself is changed and `sim.d = derive(world)` runs once a frame (`ui.frame()` from main.ts); `ctl.hold` stops the sim and `holdScenery` freezes the trees. Letting go either keeps the change through `changed()` (one undo step) or restores it; `settle()` relays the sim if a preview was shown and not kept. Drafts are temporary zones with id `world.nextId`; `liftDraft()` takes them out before each placement check, and placement checks use `ui.aprons` (the aprons from before the drag), never `sim.d.aprons`. `changed()`, any editing key, `pointercancel`, lost capture and window blur all end a drag and put its shape back first. Plan view only.
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
- **Shapes** (shapes.ts, v0.17): a zone with `rot` is its rectangle turned about its centre (an angled pier; concourses only). x, y, w, h stay the zone's own upright frame.
  - Ask shapes.ts for the real outline: `zonePts()`, `inZone()`, `toLocal()` / `toWorld()`, `zoneBox()`, `overlapOf()`. Do not use `inRect(p, zone)` or `rectsOverlap(r, zone)` on a zone that may be turned.
  - Shapes merge: in `derive()`, turned terminal modules on one level that overlap get a pedestrian node at the overlap and count as one building (`overlapOf`), where upright ones need a shared wall.
  - `sidesOf()` (gates.ts) turns with the zone and keeps the side names of its own frame, so gate keys (`n3`) are stable. Blocking in the apron strip is by true outlines, clipped to the strip. `Apron.pts` is the true outline; `Apron.rect` its bounding box.
  - Interiors: `carveConcourse()` runs on the upright frame with the gates brought into it; shops and items are turned back. The sim counts footfall along the local axis.
  - v0.18: a zone with `sides` is a hub: a regular polygon in the circle that fits its box (24+ is round, drawn with 32 facets), turned by `rot`. `hallPts()` gives its outline; `shaped(z)` is true for anything turned or sided, and is the test to use (not `z.rot`). `sidesOf()` names its gate facets `f0.`, `f1.`… (twelve for a round hub). `carveHub()` (bands.ts) carves a ring of lots round an atrium, in world coordinates, leaving open the wall where another building runs in. `clampInto()` keeps people inside any shape. The Hub tool builds one through the same path as a pier.
  - Renderers: `Renderer.rectPts()` turns a zone (or a part of it, with `pivot`); 3D boxes carry `rot` and a pivot. The Pier tool builds a concourse with `rot` and no `site`; `canPlacePier()` lets it overlap concourses only.
- **Bent bars** (shapes.ts, v0.20): a concourse with `bend` is its rectangle bent into a circular arc. x, y, w, h (and `rot`) are the frame of the chord between its ends; `bend` is how far the middle of its centreline is pushed to its own south (north if negative), at most `maxBend(w, h)`.
  - `arcOf(z)` gives the arc; `frameOf(z)` the straight frame the interior is laid out on (as long as the arc; for anything else, the rectangle itself). `toLocal()` straightens a point into that frame and `toWorld()` bends it back, so they now mean "the zone's straight frame", and anything that compares a local point with the zone's box must use `frameOf(z)`, not `z.x` / `z.w`.
  - `zonePts()` is the bent outline (not convex). `zoneParts()` gives it as convex wedges: `overlapOf()` uses them, and anything that clips with a zone as the clip polygon must too. `heart(z)` is a point that is always inside the building (`centreOf` of a bent bar can lie outside it). `bendPath()` carries a line or outline from the frame onto the arc, cutting long edges short. `barPieces()` gives the short turned rectangles the 3D model is built from.
  - Gates (gates.ts): `sidesOf()` marks the two long walls with `curve` (the wall's y in the frame). A curved wall never has a parallel taxiway, so it always goes to `selfAprons`, which places its stands by angle: spacing at the wing radius, and on the inside of the bend also at the taxilane radius; none if that radius is under 30 m. Cells are wedges, tested one by one against other outlines (by `zoneParts`), aprons and `keep`. A run's taxilane is a polyline through the stands' tails (`Run.pts`). Each `Gate` carries its own `outward`; `apron.outward` is only the middle of a run.
  - Interiors: derive lays a bent (or turned) pier out on `frameOf(z)` with its neighbours clipped and boxed in that frame, then carries the result back: shop lots keep four corners, floors and the `spine` / `lane` lines go through `bendPath`. bands.ts makes neighbouring holdrooms meet halfway between doors when they are not one spacing apart.
  - Taper (v0.21): `taper` makes the east end that much wider than the west; `h` is the width half way along, and both walls move, so the centreline and `frameOf(z)` are unchanged. `toWorld()` scales a frame point across the building by the width at that point before bending it (`toLocal()` undoes it), so the interior, footfall and `inZone` need nothing more. `endWidths(z)` gives the two widths; an end is `END_WIDTH.min`–`.max` wide. A straight tapered bar is a convex quadrilateral whose long walls each face square off their own line (`sidesOf`); on a bent one `selfAprons` steps out from the wall along its true normal, not along the frame. Grips `ta` / `tb` set one end's width about the centreline. `barPieces()` steps the width for 3D.
  - Walking: `pedRoute` threads any leg whose two ends are in the same bent pier along its centreline (`thread`), so no one walks a chord across the outside.
  - Grips: `m` bends (ends fixed); `a` / `b` keep the bend as far as the new length allows; `n` / `s` widen about the centreline. `canTurn(z)` is a concourse with no `sides` that has no `site` or is already turned or bent.
- **Shells** (shell.ts, v0.23): the direction the building model is moving in. A building is whatever its shapes add up to: `shellsOf(zones)` unions every concourse zone on a level (Clipper), then offsets out and in by `SHELL.fillet` to fill inside corners and in and out by `SHELL.ease` to round outside ones. Each connected result is a `Shell { level, ids, rings, outer }` (`rings` are outer boundaries and holes together: fill even-odd). `d.shells` / `d.shellOf` carry them.
  - v0.24: stands walk the shell. `derive` passes every shell of two or more pieces to `buildGateAreas` as `walks`; those pieces skip the per-side logic altogether, and `selfAprons` steps along `Shell.outer` instead: a stand takes the stretch of wall that puts its wings one spacing apart, its cell is the wedge between the wall's normals at its edges, it is sized for the piece its door is in, and it is refused if the cell overlaps any other accepted cell, the building itself, another building, an apron, `keep`, a taxiway or the runway strip, or sits on a straight wall a landside module stands against. A taxiway roughly parallel along the normal within `sideReach` is the stand's lane (`drawn`, downsized to fit); such runs get no generated lane and their apron is not `self`. Keys: side letter and half-spacing index along that wall in the owner piece's frame (hubs: facet and count), so interiors, which are still per piece, find their gates. Runs go through the same join / waysOut / fallback code; a walked run of one or two stands with no way out is removed. One-piece buildings must stay byte-identical: the sample and the first eight sim scripts' one-piece cases are the check.
  - v0.25: junction spaces. `junctionsOf(shells, zones)` (shell.ts) gives each building of two or more pieces the spaces it keeps for itself, as `d.junctions`: the overlap of every two pieces that are not hubs, grown by `JUNCTION.grow`, together with the floor the shell's fillets added, clipped to the shell; each connected result is a `Junction { kind, rings, outer, area, c, ids, seeds }`, a `garden`, `food` court or `hall` by area (`JUNCTION`), and a fillet touching no overlap is a `garden`. A hole in the shell is a `court`. `seeds` are its trees and tables, on a nudged grid, the same every time. derive drops any shop lot whose centre is in one (`inJunction`); render.ts draws them over the floor in the upright plan. Nothing else reads them yet: the sim does not.
  - So far the shell is used for drawing (the plan view fills and strokes each shell once and skips its pieces' own bodies and parapets; 3D adds one roof slab), for naming (`buildGateAreas` takes `group`: pieces of one shell share a gate letter and one run of gate numbers; the plan labels a multi-piece building once), and nothing else.
  - Planned, in order: the rest of the interior planned for the whole shell (holdrooms and spines that stop at a junction space, junction spaces that trade and hold passengers); halls and security joining the shell; then the landside (a curved forecourt, decks that split and rejoin, one road renderer). New drawing tools (free-drawn areas, cut-outs) should add to or take from the shell, not add another kind of piece that everything must learn.
- **A path of piers** (ui.ts, v0.22): with `opt.pierPath` the Pier tool takes clicks, not a drag. `this.path` holds the corners so far; `pathZones(pts)` turns them into a pier a leg and a round hall (`sides: 32`, at least `HALL.minDia` across) at each corner between two legs; `pathPreview` shows them as a live draft; `pathBuild` adds them all with one `changed()`. Nothing new is saved: a path is ordinary piers and hubs that merge by overlap. `cancelDrag()` also gives up a path.
- **Satellites** (v0.16): in `derive()`, a group of touching terminal modules with no security is a satellite. Each satellite concourse links to the nearest concourse of an already-linked group within `MOVER.reach` (nearest first, so chains form): two pedestrian nodes and a fast edge, added to `vpairs` so the groups become one terminal, and to `d.trainLinks` with `apm: true`. The stations are train nodes, so `p.ride` works as on the AirTrain. Generated, never saved. The Satellite tool builds a concourse with no `site`.
- **Terminals:** zones joined on foot form a terminal. It opens only when check-in, security, a concourse with working gates and bag claim connect, with a road-served curb. Only open terminals get flights. Each airline has a home terminal.
- **Saves** go to localStorage under `airport-builder-alpha-v3`. Don't rename the key. Any schema change needs a step in `migrateWorld()` (world.ts). v0.8 added `sites`; old saves get one site per group of touching terminal modules.
- **Version stamp:** scripts/build.mjs defines `__VERSION__` from package.json; main.ts writes it into the title block.
- **The sample** (sample.ts, v0.14) draws only the approach roads, Terminal Drive and two roundabouts; its hall lays everything along the terminal. The sim scripts look roads up by these coordinates (x = 2780 and 3320, Terminal Drive at y = 3230), so change them together.
- **Debug handle:** `window.__game = { sim, ren, ui, ctl }`.

## Conventions

- One version per pull request. Bump `version` in package.json and the README heading's feature list. Update known gaps. Describe changes in plain language.
- Before opening a PR, run check, build and all the sims (`npm test`). Take a screenshot of anything visual.
- Use real planning numbers (ACRP, IATA, ACI) where they exist, and cite them in a comment where the constant lives.
- The owner is an architect. Plan language (frontage, bands, holdrooms, cores) is welcome; game-design jargon less so.

## Roadmap

Foundation (v0.8): three levels of detail, terminal sites, roads and terminals adapting to each other (curbs, two-level frontage roads, snapping), and a 3D view. v0.9: a detailed 3D model and richer plan, goals and a star rating, build feedback, and lots that lay their own sidewalks. v0.10: growth unlocks, self-connecting landside facilities, international flights, the AirTrain, proper road junctions and curbside, undo, weather and airline offers. v0.11: curved roads with bend handles, roundabouts that roads join by themselves, and one-way roads and loops. v0.25: halls, food courts, gardens and courtyards where a building's pieces meet. v0.24: stands and aprons laid along a building's merged outline. v0.23: a building's concourses merged into one rounded outline, with one name and one roof. v0.22: a terminal drawn as a line of piers with a hall at each corner. v0.21: piers that taper from one end to the other. v0.20: piers bent into an arc by a middle grip, with stands, taxilanes, interiors and walking routes that follow the curve. v0.19: aprons, taxilanes and links that lay themselves on every open side; grips that stretch, swing and resize what is built; the layout rebuilt live under the cursor; New terminal as an empty site. v0.18: round and polygonal hubs that merge with piers and concourses. v0.17: piers at any angle that merge into the building they are drawn into. v0.16: satellite concourses that link themselves to a terminal by people mover. v0.15: a terminal laid out in one drag. v0.14: the starter airport rebuilt on the hall and its forecourt, and forecourt links that turn a corner. v0.13: deck ramps that split from and rejoin the approach road, and a version stamp. v0.12: check-in and claim as one stacked hall that lays its own two-level forecourt, cars drawn in lanes with gaps and brake lights, and sound. Next, towards free-form airports (the plan first; the sim can wait): holdrooms and spines planned for the whole building, and junction spaces that trade; a curved forecourt and decks that match their roads; free-drawn areas and cut-outs; S-curves and bends on halls; interiors re-planned along a taper; taxilane links that find their way round obstacles; grips and live rebuilding in 3D; a landside-to-airside people mover with security at the far end, and people-mover loops through several stations. Also: curved taxiways and sidewalks, cars that yield turn by turn in the sim, gates and holdrooms that respond to the taxiway and apron as you drag them, and moving modules in 3D.

The concourse interiors plan has four phases.

1. **Done in v0.6:** one concourse type, with band carving in rectangles.
2. **Done in v0.7:** simulated footfall past each lot, visibility and dwell scores, tenants bidding for lots by score (with rent and overnight re-letting), walk-through duty free at the security exit, and a commercial heatmap.
3. **Done in v0.16–v0.20:** satellites with a people mover, piers at any angle, round and polygonal hubs, all merging by overlap, reshaping after building, and bent and tapered piers. **Next:** free-drawn outlines.
4. Mezzanine lounges; tenant growth, merges and pop-ups; day-parting; disruption surges.

Other known gaps:
- Construction is instant.
- Departing bags aren't simulated.
- Aircraft don't hold for each other on taxiways.
- Shortening a runway leaves an old end stub.
- Angled exits always follow the prevailing wind.
