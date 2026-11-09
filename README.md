# Airside — airport builder, browser alpha

Phase 1 vertical slice from the design doc. You draw runways, block out terminal modules on two levels, and the game fits them out procedurally. Aircraft, passengers, bags and cars then flow through what you built. Lines grow, moods sour, and every failure can be fixed with staff, space or layout.

## Run it

```
npm install
npm run build        # writes dist/index.html; open it in any browser
npm run dev          # rebuilds on every save
npm run check        # TypeScript type-check
npm run simtest      # headless: runs 3 sim days and prints the daily report
node scripts/stress.mjs   # 14 days with mid-day cuts and an A380 build-out
npm test                  # all three sims
```

CI runs the type-check, build and all three sims on every push and pull request. Every merge to `main` deploys the game to GitHub Pages.

There is no server. The build is one self-contained HTML file (~750 KB), with three.js (pinned, 0.170.0) bundled in for the 3D view.

## Controls

| Action | Input |
| --- | --- |
| Tools | `V` select · `1` runway · `2` taxiway · `N` new terminal · `3` check-in · `4` security · `5` concourse · `6` bag claim · `R` road · `7` curb · `8` parking · `S` sidewalk · `X` demolish |
| Pan / zoom | drag empty space (or Shift-drag, right-drag) · scroll wheel · pinch on touch · in 3D: drag to orbit, right-drag to pan, scroll to zoom |
| Detail | `A` airfield · `L` landside · `Enter` (or double-click a terminal) open a terminal · `Esc` step back out · zooming moves between them too |
| Levels | `[` Ground · `]` Level 1 |
| View | `T` 3D view · `H` queue and road-congestion heatmap · `C` commercial heatmap (footfall and revenue per lot) |
| Time | `Space` pause · speed buttons 1× / 4× / 16× / 60× (game minutes per second) |
| Edit | drag a selected module to move it · `Del` demolish · inspector `−`/`+` nudges unit counts · click a lot inside a concourse to see its scores |

## What's in the alpha (v0.8)

- **Three levels of detail (v0.8):** the map has three readings, and zooming moves between them.
  - **Airfield:** runways, taxiways, aprons and aircraft, with each terminal as one block on its site. Zoom out past 0.3, or press `A`.
  - **Landside:** roads, curbs, decks, parking and cars, with terminals as labelled modules. This is the middle zoom, or `L`.
  - **Terminal:** one terminal opened up, with its fit-out, lots and passengers; everything outside its site steps back. Double-click a terminal, press `Enter`, or zoom in over it. `Esc` steps back out.
  - Each tool belongs to a level. Picking it moves the map there: terminal modules open the nearest terminal, roads go to landside, runways to the airfield.
- **New terminal first (v0.8):** a terminal starts as a site. Draw it with New terminal (`N`), which is free and just allocates the land. The map then opens it and hands you check-in. Modules placed in an open terminal belong to it, and its site grows to fit them (up to 120 m beyond its edge); a module can't go on another terminal's site. Demolishing a terminal removes its site and modules together. Old saves get a site around each existing terminal.
- **Roads and terminals adapt to each other (v0.8, `src/frontage.ts`):**
  - **Curbs grow by themselves.** Run a road along a terminal's landside face, anywhere from 8 to 45 m out, and a curb fills the gap. Move the road or the building and the curb follows; take the road away and the curb goes. The road tool shows a dashed "ROAD HERE → CURB" guide 20 m out (the curb depth ACRP Report 40 suggests) and snaps to it from up to 20 m away, so roads don't need to be drawn exactly.
  - **Two-level frontage roads.** Where check-in on Level 1 sits over baggage claim on Ground along the same road, that stretch becomes an upper deck with ramps at each end. The departures curb is on the deck beside check-in and the arrivals curb is underneath beside claim. Drop-offs use the deck and pickups the lower curb, so departing passengers step straight into check-in.
  - **Modules snap flush.** Drawing or moving a module snaps its edges to nearby modules on any level (within ~12 px), so check-in can stack exactly over claim and a concourse can butt against security without pixel-hunting.
  - Hand-drawn curbs still work, for frontages a road can't reach.
- **3D view (v0.8, `src/render3d.ts`):** `T` toggles a true 3D view of the same sim, built with three.js.
  - Drag to orbit, right-drag to pan, scroll to zoom. Click to inspect; build tools draw on the ground or the current floor.
  - Terminals are massing blocks. The open terminal shows glass walls with its floor plate, counters, lanes and lots inside.
  - The upper deck stands on columns with ramps down to the road. Aircraft, cars and passengers move live, with sun shadows and night falling.
- **Starting staff (v0.8):** 18 screeners (six lanes) instead of 15. With upstairs drop-off, departing passengers reach security sooner, and five lanes left the sample's peak with missed flights.

- **Concourse commerce (v0.7, `src/commerce.ts`):** Phase 2 of the concourse interiors plan. Tenants now choose lots by what the plan and the passengers give them.
  - **Footfall:** the sim counts every departing passenger who walks past each lot's frontage, weighted by their spare time before boarding (45 spare minutes counts as one shopper; someone running for the gate counts for a tenth). Counts carry over from day to day, so a lot's footfall settles over two or three days. Until a concourse has been counted, lots use an estimate from the plan: the seats of the gates whose way from security runs past them.
  - **Visibility:** how much of the spine can see the shopfront, within a walker's forward cone and 60 m. Lots on a straight run score well; the hub face opposite the security exit scores highest; lots tucked into the spine's ends score low.
  - **Dwell:** the average spare minutes of the people walking past.
  - **Tenants bid for lots.** Core retail bids for busy, visible fronts near security; sit-down food for apron views and gate clusters; grab-and-go and convenience for the far gates; lounges for deep, quiet lots (one per ~10 gates, plus one with the premium fit-out). Every format except lounges needs traffic, so dead stretches stay vacant. The best bid wins; a sitting tenant keeps its lot unless out-bid by 15%. Rent is a minimum guarantee that follows the winning score, and each lot pays the greater of that and its sales share (the structure ACRP Report 54 describes). Lots re-let overnight as scores change, so adding or removing gates moves the tenants after the passengers, with a note in the log. The best-scoring lots lease first.
  - **Walk-through duty free:** a toggle in the inspector of any concourse that security opens straight into. The stretch in front of the security exit becomes one store that every departing passenger winds through. About 60% stop to shop (Arthur D. Little's figure for walk-through stores). It earns well, but adds 1.2 minutes to every walk and costs satisfaction for anyone with under 25 minutes to spare.
  - **Commercial heatmap (`C`):** lots shaded by footfall, labelled with their revenue, and today's flow drawn along the spine. Click a lot to see its footfall, visibility, dwell, position, each format's bid, its rent and its revenue.
  - Shoppers first decide what they want (food if they have time, otherwise a browse; a lounge for some premium passengers), then pick a lot on their way, with visible fronts drawing them in.

- **Four aircraft classes:** turboprop (ATR 72), regional jet (E175), narrow-body (A320), super-jumbo (A380). Each sets the runway length it needs (1,200 / 1,600 / 2,100 / 3,000 m), gate spacing, apron depth, seats and turnaround. Runway width follows its class.
- **Airfield you build:** runways (15° snapping, self-numbering with L/C/R parallels) and taxiways drawn segment by segment. Taxiways snap to runway ends and centrelines, apron taxilanes and each other. Standard taxiways take up to A320; Code F takes A380s. Taxiways are lettered automatically, like an airport diagram. Aircraft route over this network: landing roll to the first connected exit, taxi to the gate, back-taxi on the runway if that's the only way. Hot spots are flagged where a route crosses a runway.
- **Auto-connect (v0.3):** a taxiway drawn beside a runway (90–450 m off, within ~5° of parallel) links itself: stubs at the thresholds or at the taxiway's ends, plus exits every ~650 m. Exits past the landing roll are 30° rapid exits for the prevailing landing direction; the rest are square. Switch to Manual in the taxiway tool options.
- **Radiused junctions:** every taxiway, taxilane and runway junction gets fillets sized to the taxiway class, and painted centrelines follow the turns.
- **Extend runways:** select a runway and drag either end along its axis. You pay for the added pavement (or get 40% back when shortening). Parallel taxiways that ended at the old threshold stretch with it and get a new end stub.
- **One concourse type (v0.6, `src/bands.ts`):** gate areas and concourses are merged. A concourse's width is a budget, carved from the frontage inward:
  - a **holdroom band** behind every run of gates, sized by the ACRP load rule (80% of seats; 60% seated at 1.4 m², 40% standing at 0.9 m²; podium and boarding lane), never under 9 m;
  - a **spine** down the long axis, 9 m wide, or 13.4 m with two moving walkways on arms over 300 m;
  - **commercial lots** in whatever is left either side of the spine, sized by depth: under 4 m seating only, 4–8 m kiosks and grab-and-go, 8–15 m shops and cafés, over 15 m restaurants, flagship stores and lounges;
  - **restroom cores** about every 160 m of spine.
  Lots on an ungated exterior wall get apron views. Each lot's capacity follows its floor area. Remove gates on a side and that wall frees up for window restaurants; widen the concourse to keep both. Who leases which lot is decided by bidding (v0.7, above). A concourse with no taxiway beside it is all shops and seating, and works as a connector. Old saves convert automatically.
- **Gates on every side (v0.5):** each side of a concourse grows gates when a taxiway runs parallel to it within reach (one stand depth to max(150 m, two stand depths + 40 m)). A dashed guide shows the ideal line, and taxiways snap to it. If the taxiway is closer than the area's gate size needs, that side gets the largest gates that fit. Gates sit on a fixed grid per side, so adding or extending taxiways never shuffles them. Click a gate to remove it; click its dashed stand to add it back.
- **Interior layouts (`src/layout.ts`):** check-in islands with bag belts, queue mazes and kiosks (frontal counters in shallow halls); banked security lanes with divest, X-ray, body scanner and recompose; baggage claim with a greeters' hall, bag-service office and long carousels fed from the back wall, one carousel per three gates by default, with unbuilt positions shown dashed; concourses are carved by `src/bands.ts` (above). Each module faces the module it touches upstream. Desks, lanes and carousels open centre-out as you staff them.
- **Terminals:** modules joined by doors or cores form one terminal (sidewalks don't merge terminals). A terminal opens only when check-in, security, a concourse with working gates and baggage claim are all connected, with a road-served curb. Closed terminals get no flights and are outlined in rust with the reason. Each terminal can have several concourses; each airline has a home terminal; staff are split by each terminal's passengers.
- **Gate sizes:** choose the gate size when you build a concourse or in its inspector.
- **Roads (cars) and sidewalks (people)** are separate networks with distinct styling. Roads join State Route 12, curbs and lots, come in 2 or 4 lanes, and slow down as they fill (press `H`). Sidewalks link ground-level modules, curbs and lots; zebra crossings appear where they cross roads.
- **Real walking routes:** passengers move only through doors where modules touch, vertical cores where L1 and Ground overlap (or where L1 meets the curb), and sidewalks. A module with no route strands people: they are ringed in red, counted in the report, and miss their flights.
- **Design check:** per-module walking checks, road access for every curb and lot, taxiway links for every apron, gate-size vs runway/taxiway mismatches, all with dashed red markers on the map.
- **Demand and money:** four airlines with different fleets and price sensitivity. Network and regional carriers downgrade aircraft if yours can't take theirs; Polaris (A380) and Larkspur (A320) don't. Slot fee slider, gate and runway capacity limits, reputation, money on/off.
- **Terminal flows:** check-in, security, gates, bag claim, curb pickup and parking, with staffing sliders and queue heatmaps.
- **Time:** one live day stands in for 7 calendar days in years 1–3, then 14, then 28. The city grows each year.
- **Persistence:** autosaves to the browser after every change and every day.

## Code map

| File | Role |
| --- | --- |
| `src/config.ts` | Content data: modules, aircraft, airlines, site, tuning, palette |
| `src/geom.ts` | Geometry helpers and seeded RNG |
| `src/net.ts` | Generic line networks: split drawn segments into graphs; Dijkstra, all-pairs routing |
| `src/gates.ts` | Gate slots on each side of a concourse, sized by taxiway clearance |
| `src/frontage.ts` | Roads meeting terminals: curbs grown in the gap, two-level frontage roads, road guides |
| `src/render3d.ts` | 3D view (three.js): orbit camera, massing, decks, opened terminal, moving aircraft, cars and people |
| `src/bands.ts` | Concourse interiors: holdroom bands, spine, commercial lots and their visibility, restroom cores, the duty-free store |
| `src/commerce.ts` | Lot scores (footfall, visibility, dwell) and tenant bidding, rent, re-letting |
| `src/layout.ts` | Fit-out plans for check-in, security, claim and curbs |
| `src/world.ts` | World model plus everything derived from it: designators, classes, gates, aprons, the airfield / road / pedestrian networks, cores, fit-out frames, placement rules, design check |
| `src/sim.ts` | Simulation core (no DOM). Demand → schedule → aircraft taxi routing, passenger walking routes, cars with congestion, bags, processors, economy |
| `src/render.ts` | Canvas renderer: plan view and oblique 2.5D, cutaway levels, night lighting |
| `src/ui.ts` | Tools, input, inspector, operations and report panels |
| `src/main.ts` | Boot, save/load, frame loop |
| `src/sample.ts` | The starter airport |

The sim never reads the renderer, and the renderer never writes the sim. That split is what makes a later port of `sim.ts` + `world.ts` to Godot/C# a translation rather than a rewrite.

## Known gaps (next up, per the roadmap)

- Construction is instant; no build time or disruption yet.
- Terminal sites are rectangles. A pier that reaches far out grows its site's bounding box rather than an L or T shape.
- Curbs grow only where a road is parallel to a straight building face. Curved or angled frontages still need a hand-drawn curb. Cars reach the upper deck by its ramps, but drive under it in the plan until they pull in.
- In 3D, modules are drawn and selected, but not moved by dragging (switch to plan with `T` to move one). Labels in 3D are terminal names only.
- Roads are two-way with no one-way loops or signal timing; sidewalks are ground-level only (no elevated walkways yet). Parking lots don't lay their own sidewalk to the curb yet.
- Departing bags are not simulated (arriving bags are).
- Staff is a flat level all day; no shift curves.
- One region and site; no international, transfer, rail, garages, rideshare lots or rental cars yet.
- Aircraft don't yet hold for each other on taxiways, so queues at runway ends overlap visually.
- Concourse commerce is per rectangle: footfall is counted along each concourse's long axis only, and visibility doesn't yet see round corners into a neighbouring concourse. Compound X, Y and T piers come in Phase 3.
- Tenants don't merge lots, grow, or change with the time of day yet (Phase 4). Duty free is one store per concourse, and only where security opens straight into it.
- The sample airport's schedule fills the western gates first, so the eastern half of Concourse A sees little footfall and stays mostly vacant. That is the bidding working, but it can look empty.
