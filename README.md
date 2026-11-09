# Airside — airport builder, browser alpha

Phase 1 vertical slice from the design doc. You draw runways, block out terminal modules on two levels, and the game fits them out procedurally. Aircraft, passengers, bags and cars then flow through what you built. Lines grow, moods sour, and every failure can be fixed with staff, space or layout.

## Run it

```
npm install
npm run build        # writes dist/index.html; open it in any browser
npm run dev          # rebuilds on every save
npm run check        # TypeScript type-check
npm run simtest      # headless: runs 3 sim days and prints the daily report
node scripts/roads.mjs     # curves, roundabouts and one-way loops
node scripts/halls.mjs     # stacked halls and self-laid forecourts
node scripts/stress.mjs   # 14 days with mid-day cuts and an A380 build-out
node scripts/growth.mjs   # every growth facility, international flights and the AirTrain
npm test                  # all six sims
```

CI runs the type-check, build and all six sims on every push and pull request. Every merge to `main` deploys the game to GitHub Pages.

There is no server. The build is one self-contained HTML file (~840 KB), with three.js (pinned, 0.170.0) bundled in for the 3D view.

## Controls

| Action | Input |
| --- | --- |
| Tools | `V` select · `1` runway · `2` taxiway · `N` new terminal · `3` hall (check-in over bag claim) · `4` security · `5` concourse · `I` passport control · `R` road · `G` roundabout · `7` curb · `8` parking · `S` sidewalk · `B` bus station · `U` rideshare · `K` rental cars · `O` hotel · `M` AirTrain · `X` demolish |
| Pan / zoom | drag empty space (or Shift-drag, right-drag) · scroll wheel · pinch on touch · in 3D: drag to orbit, right-drag to pan, scroll to zoom |
| Detail | `A` airfield · `L` landside · `Enter` (or double-click a terminal) open a terminal · `Esc` step back out · zooming moves between them too |
| Levels | `[` Ground · `]` Level 1 |
| View | `T` 3D view · `H` queue and road-congestion heatmap · `C` commercial heatmap (footfall and revenue per lot) |
| Time | `Space` pause · speed buttons 1× / 4× / 16× / 60× (game minutes per second) |
| Edit | `Ctrl`+`Z` undo · `Ctrl`+`Shift`+`Z` redo · drag a selected module to move it · drag a selected road's middle handle to bend it, or an end handle to move it · `Del` demolish · inspector `−`/`+` nudges unit counts · click a lot inside a concourse to see its scores |

## What's in the alpha (v0.12)

- **One hall, and a forecourt that lays itself (v0.12):** getting a road, check-in and baggage claim to line up was the hardest part of building a terminal. It no longer needs lining up.
  - **The hall.** Check-in and baggage claim are one building now: the **Hall** tool (`3`) places check-in on Level 1 with baggage claim directly under it on Ground, in one drag. The two move together and are demolished together. Separate check-in and claim modules in older saves keep working.
  - **The forecourt.** If no road runs along the hall's face, and any road (or State Route 12) is within 320 m of it, the hall lays its own forecourt: a four-lane frontage road at the right distance from its open face, with a link from each end down to that road. Because departures sit over arrivals, it splits by itself into an upper departures deck and a lower arrivals road, each with its curb. So: build the hall, draw any road nearby, and the terminal has a working two-level curbside. Move the hall or the road and the forecourt follows.
  - A road you draw along the face yourself still becomes the curb, exactly as before, and then the hall lays nothing.
  - Car parks, rental centres and bus stations connect their drives to a forecourt as they do to any road.

- **Traffic that reads as traffic, and sound (v0.12):**
  - **Cars keep to their lanes.** Every car drives on the right, in a lane (two each way on a four-lane road, all lanes on a one-way road, both lanes of a large roundabout), and takes corners as curves instead of pivoting on the junction. This is how cars are drawn, in the plan and in 3D; the sim's numbers are unchanged.
  - **Cars hold a gap.** Cars on the same stretch of road queue behind the one in front, a car length and two metres apart, so a slow road shows as a line of cars with brake lights instead of cars sitting on top of each other. In the roads test, cars drawn within 3 m of each other fall by about 98%.
  - **Cars close up.** Zoomed in, cars have body colours, glass, brake lights and, after dark, headlight beams. Cars waiting for a curb bay wait in the kerb lane.
  - **Sound.** A thud when you build and a crumble when you demolish, a tick for tools, a chime for goals and unlocks, a two-note "no" when something can't be placed, a jet's roar on takeoff and landing (louder the nearer you are looking), and a quiet bed of air and terminal murmur that follows how busy the airport is. It is all synthesised in the page, so there are still no files to load. The **♪** button in the view bar turns it off; the choice is remembered.


- **Roads you can shape (v0.11):** curves, roundabouts and one-way roads, all built the same forgiving way as everything else.
  - **Curves.** The road tool has a Straight / Curve switch. A curve started from the end of a road leaves in line with it; on open ground it sweeps round a corner. Select any road afterwards and drag its middle handle to bend it, or an end handle to move that end; drag the handle back onto the line (or press Straighten) and it is straight again. The tightest curve allowed is a 14 m radius, which a bus can still make.
  - **Roundabouts.** Click to place one, Compact (36 m, one lane round) or Large (56 m, two lanes). Drop it on a crossroads, on the end of a road or anywhere along one: every road that reaches it is cut back to the ring and joins it, with a flared entry, a splitter island and a yield line. Draw a new road towards one and it aims for the centre. Traffic goes round anticlockwise and never waits for a signal, so the roads leading in hold more cars than they would at a crossroads or T, where traffic stops and starts.
  - **One-way roads.** Draw one-way in the direction you drag, or switch any road in the inspector and reverse it. Lane arrows are painted along it and the left edge line turns yellow. A forecourt can be a one-way loop: in up one side, along the terminal face, out down the other. Cars only ever drive with the arrows, and a place counts as road-served only if cars can get in from State Route 12 and back out. A loop that leads nowhere is flagged in the design check.
  - **Drawn properly.** Each road is now one smooth path between junctions, so kerbs, edge lines, lane dashes and medians follow a curve without breaks, in the plan and in 3D. Avenue trees and street lamps follow the curve too, and each roundabout gets a planted island with a paved truck apron round it.
  - **Fixed:** stop bars and turn arrows at junctions were painted on the side of the road that leaves the junction. They are now on the approach side.
  - The starter airport has a roundabout on each approach road and a curved link between them.


- **The airport grows, and growth unlocks what it needs (v0.10):** eight facilities unlock by the best day's departures, each with the reason it is needed. The Report tab lists them with progress, locked tools are greyed with their threshold, and an unlock stamps across the map. Sandbox mode (money off) has everything from the start.

  | Departures in a day | Unlocks | What it does |
  | --- | --- | --- |
  | 3,000 | Bus station | 8% of passengers come and go by bus, with no car at the curb; +5% demand |
  | 3,300 | Rideshare pickup | 20% of arriving parties meet their ride here instead of at the curb; $4 a pickup; +2% demand |
  | 3,500 | Parking decks | stack up to 6 decks on any lot to make a garage; +2% demand |
  | 3,700 | Rental car centre | 7% of arriving parties rent a car; $46 concession each; +3% demand |
  | 3,900 | Concourse mezzanine | a floor over the spine: one more lounge, double lounge capacity |
  | 4,100 | Airport hotel | eight floors of rooms; $60 to the airport per room night; +4% demand |
  | 4,300 | International flights | Aurora International asks for routes; passport control takes them |
  | 4,600 | AirTrain | stations link into a line; people ride at 8× walking pace; +6% demand |

- **Everything on the landside connects itself (v0.10, `src/frontage.ts`):** place a lot, garage, rideshare lot, rental centre, bus station, hotel or AirTrain station and it lays what it needs.
  - **An access drive** to the nearest road within 300 m, turning one corner if the road isn't straight ahead. Car parks, garages and rental centres get separate IN and OUT drives with a gate plaza.
  - **A sidewalk** to the nearest way in: the arrivals curb, a ground-floor hall, or an AirTrain station. Routes are square, not diagonal.
  - **AirTrain stations** join into the shortest line that links them all, on an elevated guideway with trains shuttling. A garage too far to walk works once it has a station.
  - A facility that can't connect is outlined in red, and the design check says why.
- **Roads worth looking at (v0.10, `src/roads.ts`):**
  - **Junctions** have curved kerbs, stop bars and turn arrows, and markings stop short of the crossing.
  - **Four-lane roads** carry a planted median with trees; every road has a grass verge and edge lines.
  - **State Route 12** is a six-lane highway with a centre barrier, and each road that meets it gets a pair of slip ramps.
  - **The curbside** is a proper cross-section: sidewalk, two pull-in lanes with bay marks, a planted island with zebra crossings, then the through lanes, painted DEPARTURES or ARRIVALS.
  - **Car parks** show every parked car in its bay; garages show a ramp helix and their deck count.
- **International flights and passport control (v0.10):** a terminal with passport control between a concourse and bag claim takes Aurora International. Arriving international passengers queue at the booths (staffed by passport officers, a new slider in Operations) before bag claim. International departures pay a higher passenger charge and spend half as much again in the shops.
- **Undo and redo (v0.10):** `Ctrl`+`Z` takes back any build, move or demolition, with its money; `Ctrl`+`Shift`+`Z` redoes it. Fifty steps.
- **Weather (v0.10):** most days are clear; some bring rain, fog or snow. Each cuts how many movements an hour the runways take (85%, 60%, 70%), shows in the header, and falls across the map in both views.
- **Airline offers (v0.10):** now and then an airline that is happy here proposes a deal in Operations: more flights for a lower slot fee, or a crew base with a signing bonus and a punctuality clause. Accept or decline.
- **The plan reads like a drawing (v0.10):** buildings, garages and hotels cast soft shadows; aprons show slab joints; the countryside has field parcels and the lake has depth rings; a scale bar and north arrow sit bottom left.
- **3D (v0.10):** garages as stacked decks with cars on the roof, a striped hotel tower, rental and bus canopies, the AirTrain on pylons with a moving train, the mezzanine storey, junction curves, medians, gate booths, and the curbside island and sidewalk.

- **A detailed 3D model (v0.9, `src/render3d.ts`, `src/models3d.ts`):** the 3D view now reads as a presentation model rather than blocks.
  - **Buildings:** each module has a dark plinth, a glazed band with mullions every 7.5 m and a white roof slab with a slight overhang. A glazed clerestory runs down each concourse's spine, and plant enclosures sit on the other roofs. Departures and arrivals curbs get canopies on slender columns.
  - **Aircraft:** modelled by class (turboprop with propellers, E175, A320, and an A380 with its double deck and four engines). Tails carry airline colours: Meridian navy, Larkspur violet, Northline teal, Polaris amber. Aircraft in motion flash a red beacon.
  - **Jet bridges:** a fixed link and rotunda stand off each gate. The tunnel docks at the forward door when an aircraft is on stand, and sits retracted otherwise.
  - **Turnarounds:** while an aircraft is being turned, a pushback tug waits at the nose, bag carts and a belt loader work the hold, a catering truck serves the forward galley, and a fuel truck stands under the wing.
  - **Painted markings:**
    - runways: threshold bars, designators, aiming points, touchdown zones, edge lines and centreline
    - taxiways: yellow centrelines and edges
    - stands: lead-in lines, stop bars and boundaries
    - roads: lane lines, with zebra crossings where sidewalks cross
    - parking: marked bays
  - **Landscape:** model trees line every road and the highway, groves dot the countryside, and the city has street trees. Planting clears itself from anything you build. A control tower stands beside the first terminal. Parked cars fill the lots as occupancy rises.
  - **Night:** glazing glows warm, runway edge and taxiway centreline lights come on, apron floodlight masts and street lamps light the ground, cars run headlights, and the sky goes to dusk blue.
  - New modules rise out of the ground into place.
- **The plan reads richer too (v0.9):**
  - a planting plan along roads and in the countryside
  - the control tower symbol (TWR) and apron floodlight masts
  - roof plans on buildings outside the open terminal: parapet line, concourse clerestory with mullions, plant enclosures
  - airline colours on tails
  - turnaround vehicles around aircraft on stand
- **Goals and an airport rating (v0.9, `src/goals.ts`):**
  - **Milestones:** eleven, each with a grant, for example: open a terminal, build a two-level frontage road, lease 40 lots, open duty free, reach satisfaction 88, welcome an A380, $250k profit in a day.
  - **Next goal:** the header shows it with a progress bar, and clicking it opens the full list in the Report tab.
  - **Celebration:** reaching a goal stamps across the map, toasts and pays the grant.
  - **Star rating:** a header rating (0.5–5) weighs satisfaction, on-time running, how much demand you could take, and missed flights. Goals are saved.
- **Feedback as you build (v0.9):**
  - New modules and curbs pulse as they appear, and what you spend floats up from where you built it.
  - A road that grows a curb says so ("+ 2 curbs"), and one that makes a two-level frontage road says that too.
- **Parking lots lay their own sidewalk (v0.9):** a lot that no sidewalk reaches lays one to the nearest ground-level curb (the arrivals curb if there is one). It goes straight or round one corner, never through a building, an apron or the airfield, and crosswalks appear where it crosses roads. The sample airport has no hand-drawn sidewalk now.

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
| `src/frontage.ts` | Roads meeting terminals: curbs grown in the gap, two-level frontage roads, road guides; access drives, sidewalks and the AirTrain line that facilities lay for themselves |
| `src/ways.ts` | Roads as drawn: curves cut into chords, one-way roads, roundabouts and how roads are cut back to their rings |
| `src/traffic.ts` | Where each car is drawn: its lane, rounded corners, the gap to the car in front, brake lights |
| `src/sound.ts` | Synthesised sound (Web Audio): building, feedback, jets, ambience |
| `src/roads.ts` | Road geometry from the road graph: smooth paths, junction curves, roundabout entries, slip ramps, stop bars, arrows, medians, gate plazas |
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
- Sound has no volume control beyond on and off, and no per-vehicle sounds (cars, the AirTrain, announcements).
- Curves are for roads only: taxiways and sidewalks are still straight. A curve has one bend (no S-curves in one piece), and curbs do not grow along curved roads. Lanes, gaps and brake lights are how traffic is drawn: the sim still moves each car along the centreline and slows it by how full the road is, so cars do not yet yield turn by turn at a junction or roundabout (a roundabout's benefit is modelled as road capacity). The IN and OUT drives of a car park are both two-way underneath.
- The AirTrain is a people mover inside the airport. It does not run to the city, and trains are drawn on a timetable rather than carrying the riders you see.
- Hotels, rental centres and rideshare lots work by numbers: guests and rental staff aren't simulated as people.
- Unlocks depend on the best day's departures only. Weather and offers are light: no de-icing, diversions or negotiation yet.
- Adding a second terminal splits the same check-in agents and screeners across both, so queues grow until you hire more in Operations.
- Terminal sites are rectangles. A pier that reaches far out grows its site's bounding box rather than an L or T shape.
- A forecourt is laid along one straight face of the hall and its links run straight out (or straight on) to the nearest road; it does not yet find its way round obstacles or pick a one-way loop, and it links to the nearest road even if that road goes nowhere (the design check then reports the curb has no road to State Route 12). A hand-drawn frontage road must still be parallel to the face to grow a curb. Cars reach the upper deck by its ramps, but drive under it in the plan view.
- In 3D, modules are drawn and selected, but not moved by dragging (switch to plan with `T` to move one). Labels in 3D are terminal names only.
- No signal timing at junctions; sidewalks are ground-level only (no elevated walkways yet), and they cannot cross a roundabout.
- Lot sidewalks go straight or round one corner; a lot boxed in by buildings still needs a hand-drawn one.
- The 3D view is heavier than the plan: a few thousand trees and instanced vehicles. On a slow laptop, use the plan for building and 3D for looking.
- Departing bags are not simulated (arriving bags are).
- Staff is a flat level all day; no shift curves.
- One region and site; no international, transfer, rail, garages, rideshare lots or rental cars yet.
- Aircraft don't yet hold for each other on taxiways, so queues at runway ends overlap visually.
- Concourse commerce is per rectangle: footfall is counted along each concourse's long axis only, and visibility doesn't yet see round corners into a neighbouring concourse. Compound X, Y and T piers come in Phase 3.
- Tenants don't merge lots, grow, or change with the time of day yet (Phase 4). Duty free is one store per concourse, and only where security opens straight into it.
- The sample airport's schedule fills the western gates first, so the eastern half of Concourse A sees little footfall and stays mostly vacant. That is the bidding working, but it can look empty.
