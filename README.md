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
node scripts/satellites.mjs # satellite concourses and people movers
node scripts/piers.mjs      # piers at any angle and round or polygonal hubs
node scripts/aprons.mjs     # self-laid aprons and taxilanes, and reshaping by grips
node scripts/curves.mjs     # bent piers: stands, interiors and walking routes round a curve
node scripts/stress.mjs   # 14 days with mid-day cuts and an A380 build-out
node scripts/growth.mjs   # every growth facility, international flights and the AirTrain
npm test                  # all ten sims
```

CI runs the type-check, build and all ten sims on every push and pull request. Every merge to `main` deploys the game to GitHub Pages.

There is no server. The build is one self-contained HTML file (~840 KB), with three.js (pinned, 0.170.0) bundled in for the 3D view.

## Controls

| Action | Input |
| --- | --- |
| Tools | `V` select · `1` runway · `2` taxiway · `N` new terminal · `3` hall (check-in over bag claim) · `4` security · `5` concourse · `6` satellite concourse · `9` pier at any angle · `0` round or polygonal hub · `I` passport control · `R` road · `G` roundabout · `7` curb · `8` parking · `S` sidewalk · `B` bus station · `U` rideshare · `K` rental cars · `O` hotel · `M` AirTrain · `X` demolish |
| Pan / zoom | drag empty space (or Shift-drag, right-drag) · scroll wheel · pinch on touch · in 3D: drag to orbit, right-drag to pan, scroll to zoom |
| Detail | `A` airfield · `L` landside · `Enter` (or double-click a terminal) open a terminal · `Esc` step back out · zooming moves between them too |
| Levels | `[` Ground · `]` Level 1 |
| View | `T` 3D view · `H` queue and road-congestion heatmap · `C` commercial heatmap (footfall and revenue per lot) |
| Time | `Space` pause · speed buttons 1× / 4× / 16× / 60× (game minutes per second) |
| Edit | `Ctrl`+`Z` undo · `Ctrl`+`Shift`+`Z` redo · with the Pier tool set to "A path", click each corner and press `Enter` · drag a selected module to move it, or one of its grips to stretch, swing, resize, (the filled middle grip on a pier) bend or (the diamond grips on a pier end) taper it (everything follows as you drag; `Esc` puts it back) · drag a selected road's middle handle to bend it, or an end handle to move it · `Del` demolish · inspector `−`/`+` nudges unit counts · click a lot inside a concourse to see its scores |

## What's in the alpha (v0.26)

- **Interiors that stop at the building's own spaces (v0.26):** the pieces of a building now plan round the halls, food courts and gardens it keeps where they meet.
  - **Fit-out gives way.** No holdroom seating, counter or restroom of either piece stands in a junction space, and the spine and moving walkways break off at its edge and start again beyond it. The space reads as one room.
  - **Lots front the space.** A shop lot within 9 m of a hall, food court or garden is seen across it, so it scores higher for visibility. On a food court, food tenants bid more for it; on a hall, food and retail; beside a garden, sit-down food, as for an apron window.
  - **Courtyards in 3D.** A courtyard is a lawn with trees in the 3D view.
  - Tables and names of these spaces show only for the open terminal.


- **Halls, gardens and courtyards where a building's pieces meet (v0.25):** the third step of the new foundation, and the first part of planning a building's inside as a whole.
  - **Junction spaces.** Where two pieces of a building run into each other, the overlap and a few metres round it are kept clear as one open space that belongs to the building, not to either piece. By size it is a winter garden (under 400 m²), a food court (400–1,500 m²) or a hall with planting in the middle and seating round it (over 1,500 m², or where three pieces meet).
  - **Planted corners.** The floor the rounded outline adds in an inside corner joins the junction space next to it, or becomes a small garden of its own.
  - **Courtyards.** A hole enclosed by the building (four concourses round a square, a triangle between three piers) is a courtyard garden, open to the sky.
  - Only a crossing counts: a concourse lengthened by drawing another over its end is just more concourse, and a round corner hall keeps its own middle.
  - No shop lot stands in any of these spaces, so the way through a junction is open.
  - Shown in the plan view at landside and terminal zoom, with trees, tables and a name. A building of one piece has none and is unchanged.


- **Stands follow the whole building (v0.24):** the second step of the new foundation. On a building made of several pieces, stands are laid along the building's one merged outline, not along each piece's own walls.
  - **Round corners and past junctions.** Stands run on round the eased ends of piers and past the filled-in corners where pieces meet, in one sweep, with one taxilane behind them. There is no wedge of dead apron where two pieces join.
  - **They fan and close up.** Each stand takes as much wall as it needs for its wings to clear its neighbours': less than a spacing round an outside curve, more round an inside one, and none where an inside corner is too tight. Each aircraft stands on the centreline of its own wedge.
  - **No two stands share ground.** A stand is refused if it would overlap any other stand of the building (two piers facing each other across a narrow gap get one row, not two), come too close to another arm of the building, or cross a road, another building or the runway strip.
  - **Mixed sizes.** Each stand is sized for the piece its gate is in, so an A380 pier on an A320 concourse has big stands along the pier and small ones along the concourse.
  - **Drawn taxiways still count.** Where a taxiway is drawn along a stretch of wall, the stands on that stretch reach out to it and use it as their taxilane, sized down to fit if it is close. Stands next to them on a self-laid taxilane are linked straight out to the same taxiway.
  - **Landside stays landside.** A straight wall that security or a hall stands against gets no stands along its whole length.
  - A stand or two left in a pocket with no way out to the airfield is dropped.
  - A building of one piece (like the starter airport's concourse) is laid out exactly as before.


- **One building, one outline (v0.23):** the first step of a new foundation. A terminal's airside is no longer drawn as a pile of separate pieces.
  - **Pieces blend.** Every concourse, pier and hub of a building is merged into one outline. Where pieces meet, the inside corner is filled in with a 16 m radius; outside corners are eased with a 5 m radius. Nothing is clipped where one piece runs into another, and no piece shows its own edge inside the building.
  - **One name.** A building of several pieces has one name and one gate letter, with its gates numbered in one run and its gate and lot totals shown once.
  - **One roof.** In 3D a building of several pieces has a single roof to the same rounded outline.
  - **Whatever your shapes add up to.** The outline is computed from the shapes you put down, so anything that makes a shape (a pier, a path, a hub, and later a free-drawn area or a cut-out courtyard) blends into the building by itself.
  - What does not follow the outline yet: stands and aprons still run along each piece's own walls, interiors are still laid out piece by piece, and halls and security are not part of it. Those are the next steps.


- **Draw a terminal as a line (v0.22):** the Pier tool has a second way of drawing.
  - **A path.** Set the tool to "A path", click where the building starts, then click each corner in turn. Click the last corner again, or press `Enter`, to build it. `Backspace` takes the last corner back and `Esc` gives up. Each leg can run at any angle (5° steps) and is 60 m long at least.
  - **One building.** Every leg is a pier and every corner a small round hall that the two legs run into, so the whole path is one building by the usual rule that shapes which overlap merge. Start it inside a concourse and it is part of that terminal. Start another path from anywhere along the first and you have a Y or an X.
  - **You see it as you draw.** The path stands in the world while you draw it, with its stands, taxilanes and gate count, like everything else since v0.19. It is paid for and built in one step, and one undo takes it all back.
  - Afterwards each leg is an ordinary pier: stretch it, swing it, bend it or taper it by its grips.
- **The "cannot place this" message can be read.** It was red text on a red bar; it is now light text on the red bar.


- **Tapered piers (v0.21):** a pier or satellite can be wider at one end than the other, so it can be a wedge, a fan or a finger that narrows to its tip.
  - **The end grips.** A selected pier or satellite has a diamond grip on a corner of each end. Drag one off the centreline and that end gets wider; drag it in and it gets narrower. The other end keeps its width and the centreline stays where it is, so the pier tapers evenly from one end to the other. An end can be from 24 to 160 m wide. Pull an end back to the other end's width and it is a plain pier again.
  - **It works with everything else.** A tapered pier can also be bent, stretched, swung and moved, and the side grips widen it as a whole, keeping its taper. Like every grip, the building follows as you drag, one drag is one undo step, and `Esc` puts it back.
  - **Stands** are square to each wall, so on a tapered pier the two rows splay apart slightly towards the wide end.
  - **Inside,** the layout is that of a pier of the middle width, squeezed towards the narrow end and stretched towards the wide one: holdrooms, spine and shop lots all get shallower or deeper with the building.
  - It is drawn as a wedge in the plan, and in 3D as a row of short lengths stepping in width.


- **Bent piers (v0.20):** a pier or satellite can be bent into a curve, so terminals no longer have to be made of straight bars.
  - **The bend grip.** A selected pier or satellite has a filled grip in its middle. Pull it sideways and the pier bends into an arc; both ends stay exactly where they are. Pull it back to the line between the ends and the pier is straight again. Like every grip, the building and everything on it follow as you drag, one drag is one undo step, and `Esc` puts it back.
  - **How far it bends.** The inner wall keeps a radius people can walk and furniture can follow: the centreline radius is at least one and a half times the width, and at least 30 m more than half the width (a 50 m pier bends no tighter than a 75 m radius). The grip stops there.
  - **Stands follow the curve.** Each stand is square to its own piece of wall. On the outside of the bend aircraft fan out, so they stand closer together along the wall and the outside gets more gates; on the inside they close up, so each needs more wall and the inside gets fewer. Spacing is set where the wings are, and on the inside also where the tails meet. Where the inside is too tight for a taxilane behind the tails (under a 30 m radius) it gets no stands, and the inspector says so.
  - **Curved aprons and taxilanes.** The apron is the band the stands sweep; the taxilane runs round behind their tails and joins the lanes at the pier's ends, round its tip, and on to the airfield, as on a straight pier.
  - **Inside.** The interior is laid out as for a straight concourse as long as the arc, then carried onto it: holdrooms behind the gates (meeting halfway between doors, since doors are not evenly spaced on a curve), the spine, shop lots either side, restroom cores. Footfall is counted round the bend. People walk along the centreline, so nobody cuts across outside the building.
  - **Everything else still works on it.** A bent pier drawn out of a concourse is part of that building; a pier or hub drawn into a bent pier joins it; one that stands apart links by people mover. It stretches and swings by its ends and widens about its centreline, keeping its bend. It is drawn curved in the plan and as a row of short straight lengths in 3D.
  - Bending costs the floor area it adds (a 500 m pier bent 120 m is 574 m round the bend).


- **Shapes you can pull about, and aprons that lay themselves (v0.19):** building is now a matter of drawing a shape and pulling it until it looks right, with everything that depends on it following as you drag.
  - **Stands lay themselves.** Every open side of a concourse, pier or hub lays its own apron: stands nose-in on the usual grid, a taxilane along their tails, and a link to the nearest taxiway, taxilane or runway within 400 m. No taxiway has to be drawn alongside. A round hub is ringed with aircraft; a pier has stands down both sides and round its tip; a runway and one concourse are already a working airfield.
    - Stand depth is the nose-in gap, the aircraft, then the taxilane's clearance to an object: 22.5 m for code C aircraft and 47.5 m for code F (ICAO Annex 14, Table 3-1, as quoted in secondary sources). That comes to 69 m for A320 stands and 129 m for A380 stands.
    - First come, first served: a stand needs its whole cell clear of other buildings, of aprons already laid, of roads and sidewalks (drawn, or laid by a hall, car park or facility for itself), and of the runway strip. The landside is laid first, so no taxilane crosses a forecourt, a lot's sidewalk or a facility's drive. A side that security or a hall stands against is landside and gets none.
    - Taxilanes on neighbouring sides meet at the corner and the corner is paved. Where a building is too narrow for a stand on its end, the lanes on its two long sides meet round that end. A loose end runs straight on, straight out, or on a little and then out or round the end of the building, whichever is shortest. Joining a runway directly counts two and a half times its length, so a taxiway wins when one is near.
    - A taxiway drawn parallel to a side still takes that side over, as before, with deeper stands if it is farther out.
    - A self-laid apron gives way: build or draw a road across it and the stands there go. Stands can still be switched off one by one.
  - **Grips.** Select a building and it shows its handles.
    - A pier or satellite has a round grip on each end: drag one and the far end stays put while the near end follows the cursor, so the pier stretches and swings in one move (5° steps). Square grips on its sides set the width, 30 to 120 m.
    - A hub has one grip on its rim: it sets the diameter, and turns a polygonal hub.
    - Every upright module (hall, security, concourse, car park, curb and the rest) has a square grip on each edge: drag it and that edge moves while the opposite one stays. The baggage claim under a hall follows its check-in.
    - Growing costs the extra floor area; shrinking gives 40% back. One drag is one undo step. `Esc` puts it back.
  - **Everything follows as you drag.** While a grip or a building is dragged, and while a new concourse, pier, hub or hall is being drawn, the shape itself is in the world: its gates, aprons, taxilanes, shop lots, people mover and forecourt are rebuilt every frame under the cursor, before you let go. The clock stands still meanwhile. If the cursor goes somewhere the shape cannot, it stays at the last place that fits and the outline turns red with the reason. This is in the plan view; in 3D a drag still shows an outline.
  - **New terminal is an empty site.** The New terminal tool now allocates the land and nothing else, so the terminal is yours to shape. The one-drag starter layout is still there as an option on the tool.
  - **Fixed:** an angled pier now reads its neighbours in its own frame, so its entry and its windowless walls are where they really are; where one building runs into another no shop lot stands in the overlap, so a pier drawn into a concourse has an open mouth; a hub with two stands on a facet now gives both a holdroom.


- **Round and polygonal hubs (v0.18):** the halls where piers and concourses meet.
  - **Hub tool (`0`).** Drag out from the centre. Choose Round, Hexagon or Octagon, from 60 to 400 m across; a polygon turns so a facet faces the way you drag.
  - **It merges like everything else.** Overlap a concourse, a pier or security and the hub becomes part of that building. Start piers inside it and they join too, at any angle, so a hub with piers fanning out of it is one terminal. A hub that touches nothing links itself by people mover.
  - **Inside, a hub is an atrium with shops round it.** A ring of lots lines the wall, 8–16 m deep, with tenants bidding for them like any concourse lot; every shopfront faces the atrium. No lot is carved where another building runs in: that stretch of wall is the way through. A hub under about 60 m is all atrium.
  - **Gates.** Each facet has gates, with a holdroom band along that facet and the lots behind. A round hub offers twelve gate facets, a polygon one per side. Since v0.19 the stands lay themselves round the hub; a taxiway drawn parallel to a facet takes that facet over.
  - **Drawn as what it is:** in the plan a round or faceted hall with a glazed lantern over the atrium and roof ribs; in 3D a drum (or prism) with the lantern on top.
  - A hub can be moved, inspected and demolished like any module.


- **Piers at any angle, and buildings that merge (v0.17):** the foundation for terminals that are not made of upright boxes.
  - **Pier tool (`9`).** Drag a line from where the pier starts to where it ends. It can run at any angle (it snaps to 5° steps), any length from 60 m, in a width of 40, 50 or 60 m.
  - **Shapes merge.** Start the pier inside a concourse and it becomes part of that building: people walk straight through where the two overlap, with no door to line up. Two piers drawn into the same end make a fork. A pier that touches nothing is a satellite and links itself by people mover, like any other.
  - **Gates follow the angle.** Gates, stands, aprons and jet bridges grow at the pier's angle (by themselves since v0.19, or along a taxiway drawn parallel to a side). Where a pier runs into a building, only the part of each face that is actually covered loses its gates: the pier keeps gates along the rest of its length, and the concourse keeps gates either side of where the pier joins.
  - **Inside, a pier is a full concourse:** holdrooms behind its gates, a spine, shops and restaurants bidding for lots, footfall counted along its own length. It is laid out as an upright building and turned into place.
  - It can be moved (it keeps its angle), inspected and demolished like any module, in the plan and in 3D.


- **Satellite concourses on a people mover (v0.16):** the first step towards airports shaped like Tampa, Orlando, Denver or Atlanta, where the gates stand out on the airfield away from the terminal.
  - **Satellite tool (`6`).** Drag a concourse anywhere on the airfield. It needs no terminal site and does not have to touch anything.
  - **It links itself.** A concourse that touches no terminal looks for the nearest concourse that already belongs to one, within 1,800 m, and joins it with an airside people mover: a station in each and a ride between them. It then counts as part of that terminal: its gates take that terminal's flights, and its passengers use that terminal's check-in, security and baggage claim. Nothing is drawn by hand, and if you move either building the link follows.
  - **Chains and stars.** A second satellite links to whichever linked concourse is nearest, so satellites in a row chain outward (Denver, Atlanta) and satellites around a terminal each get their own line (Tampa, Orlando).
  - **In the plan** the mover is a dashed twin line with its length, and a shuttle running back and forth. It is in a tunnel, so it crosses taxiways and aprons freely; in 3D only a station pavilion shows on each roof.
  - **The ride** is eight times walking pace with a 1.5 minute average wait (planning figures from ACRP Report 37), and it does not count as walking for a passenger's mood. A mover costs upkeep by its length.
  - Gates grow on a satellite exactly as on any concourse: on every side with a parallel taxiway at the right distance. The schedule fills a terminal's nearest gates first, so a satellite fills up as the airport gets busy.
  - Out of reach, a lone concourse is still a closed terminal of its own, and the design check now says how far it can be.


- **A terminal in one drag (v0.15):**
  - **New terminal lays out the whole terminal.** Drag the terminal's rectangle and a complete starter terminal appears inside it as you drag: a concourse along the edge that faces the airfield, security behind it, and the hall (check-in over baggage claim) on the far, landside edge. The game reads which edge is airside from the nearest taxiway (or runway, if there is no taxiway yet). Release and it is built; the pieces can then be moved, resized or demolished like any others.
  - **From bare ground, five gestures make a working airport:** a runway, a taxiway, the terminal, and two roads. Gates grow where the concourse faces the taxiway and the hall lays its own forecourt to the road. In the test this flies 27 flights on its first day with no one missing a flight.
  - **A second terminal hires its own staff.** Laying out a terminal when one is already open hires 10 check-in agents and 12 screeners for it, so the first terminal's queues do not double overnight. You are told, and Operations still sets the totals.
  - The tool has a switch for an **Empty site**, for laying a terminal out by hand as before. A rectangle too small for a full layout (under 160 × 180 m) is allocated empty.
  - It costs what its modules cost: about $250M for a terminal the size of the starter one.


- **A starter airport that shows how it works, and links that find the road (v0.14):**
  - **The starter airport is rebuilt** on the hall and its self-laid forecourt. Only the approach is drawn by hand: two roads up from State Route 12, a roundabout on each, and Terminal Drive between them. The frontage road, the departures deck and its two ramps, the curbs, the car park's drives and its sidewalk are all generated. A new game (or **Load sample**) shows the whole system working; a saved game keeps the airport it has.
  - **Links turn a corner.** A forecourt link used to need a road straight ahead of it. If there is none, it now comes straight out from the frontage and turns once towards the nearest road. So a road that stops short of the terminal, or runs past off to one side, still gets connected.
  - **Reach is 360 m** (was 320 m), measured from the hall's open face.
  - **A new hall opens with a sensible number of check-in counters:** about one per 500 m², instead of every counter the floor could hold. The inspector's − and + still change it.


- **The road divides for the upper deck, and a version stamp (v0.13):**
  - **Ramps that split and rejoin.** Where a hall lays its own forecourt, the departures deck no longer sits on the road as a slab. On each side, a ramp leaves the approach road about 120 m before the corner, sweeps round inside it while it climbs, and lands on the deck in front of the hall; the ground road carries on round the corner underneath to the arrivals curb. The same happens in reverse on the way out, so the road visibly divides and comes back together. It is generated with the forecourt and moves with it.
  - **Cars take the right branch.** Cars dropping off at departures go up the ramp and leave by the other one; cars for arrivals, the car park and everything else keep to the ground road. In 3D, cars climb with the ramp.
  - A ramp is a merge, not a junction: no stop bars or turn arrows where it leaves and rejoins, and it does not slow the road the way a crossroads does.
  - A frontage road you draw by hand keeps its straight ramps along the road, as before.
  - **Version stamp.** The title block in the corner of the map now shows the version you are playing (`AIRSIDE v0.13.0`), taken from the build.


- **One hall, and a forecourt that lays itself (v0.12):** getting a road, check-in and baggage claim to line up was the hardest part of building a terminal. It no longer needs lining up.
  - **The hall.** Check-in and baggage claim are one building now: the **Hall** tool (`3`) places check-in on Level 1 with baggage claim directly under it on Ground, in one drag. The two move together and are demolished together. Separate check-in and claim modules in older saves keep working.
  - **The forecourt.** If no road runs along the hall's face, and any road (or State Route 12) is within reach of it (360 m since v0.14), the hall lays its own forecourt: a four-lane frontage road at the right distance from its open face, with a link from each end down to that road. Because departures sit over arrivals, it splits by itself into an upper departures deck and a lower arrivals road, each with its curb. So: build the hall, draw any road nearby, and the terminal has a working two-level curbside. Move the hall or the road and the forecourt follows.
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
| `src/gates.ts` | Gate slots on each side of a concourse: along a drawn taxiway, or on an apron the side lays for itself, with its taxilane and link to the airfield |
| `src/shell.ts` | A building as one outline: every concourse piece merged and its corners rounded (clipper-lib) |
| `src/shapes.ts` | Turned rectangles, bent bars and hubs: outlines, overlaps, the straight frame a bent pier is laid out on, and the grips that reshape them |
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
- Shapes so far are piers at any angle, straight or bent into one arc, of even width or tapering evenly from one end to the other, and regular hubs (round, six or eight sides). There are no S-curves, free-drawn outlines or ellipses yet, and a pier cannot bulge in the middle. Halls, security and concourses built inside a terminal site stay upright, straight and of even width (their edges move, but they do not turn, bend or taper). Where buildings overlap, both roofs are drawn.
- Junction spaces raise the value of the lots round them but have no trade of their own yet: a food court has no counters in it, and passengers do not sit or dwell there. A gate whose holdroom fell in a hall keeps its capacity but has no seats drawn. Halls, food courts and gardens under the roof are not shown in 3D or in the tilted plan view; courtyards are shown in 3D.
- The merged outline carries the stands, but interiors, selection and the tilted plan view still work on the separate pieces, so a rounded corner can show a sliver of floor with nothing planned on it, a gate at a filled-in junction can have its door a few metres from its holdroom, roof glazing lines of two pieces cross at a junction, and the Operations panel still counts pieces as concourses. Halls and security keep their own square outlines.
- On a building of several pieces a gate is named by where it is along its wall, so its name can change when that piece is reshaped, and gates switched off before v0.24 on such buildings may now refer to a different stand. The inspector's side-by-side gate list is empty for such pieces. A one-piece building keeps its gate names.
- A path of piers is separate pieces that happen to touch: moving or reshaping one leg does not carry its neighbours along, so a leg pulled away from its corner hall stops being part of the building until it is put back. Each leg and corner hall is its own concourse with its own gate letter. A path may cross itself or another building's apron; nothing stops it but the usual placement rules for each piece.
- On a tapered pier the interior is not re-planned for the width at each point: it is the middle-width layout scaled across, so at a narrow end the holdrooms, spine and lots are all shallower than the planning rules would make them, and a lot's kind (kiosk, shop, restaurant) is chosen from its depth at the middle width. On a bent and tapered pier the stand spacing along a curved wall is set from the wall's radius half way along.
- On a bent pier: shop lots keep straight walls (each is short), so on a tight bend neighbouring lots meet at a slight angle; the 3D model is a row of short straight lengths, and its opened-up interior is not drawn (it shows as a closed building); the starter guides for drawing a taxiway do not follow a curved wall, since a straight taxiway cannot run parallel to one. A taxiway cannot be curved to follow a bent pier: its stands are always self-laid.
- Self-laid aprons are simple: one depth per building (its aircraft size), stands square to each side, straight taxilanes with one bend at most in a link. A link does not find its way round an obstacle, cross a road, or join two aprons across a gap wider than 400 m; then the design check says the apron is cut off and a drawn taxiway is the fix. Where two buildings make an inside corner, the one built first takes the corner. A car park or facility beside a pier can cut an apron off with the sidewalk or drive it lays for itself. A side with a taxiway drawn along only part of it gets drawn-taxiway gates on that part and none on the rest. Self-laid aprons and taxilanes cost nothing to build.
- Dragging rebuilds the whole layout each frame: a few milliseconds on a small airport, about 30 on one with fifteen buildings and 150 gates, so very large airports will drag less smoothly. The 3D view does not rebuild live. Grips are in the plan only.
- A people mover is a single shuttle link between two concourses, always in a tunnel, with no landside leg: it does not yet run from a landside terminal building to an airside hall with security in between, loop through several stations, or carry bags (arriving bags still appear at the terminal's claim).
- The starter layout (an option on New terminal, off by default) is one shape: a concourse bar, security and the hall in a line. It does not size itself to demand or add a car park.
- Sound has no volume control beyond on and off, and no per-vehicle sounds (cars, the AirTrain, announcements).
- Curves are for roads only: taxiways and sidewalks are still straight. A curve has one bend (no S-curves in one piece), and curbs do not grow along curved roads. Lanes, gaps and brake lights are how traffic is drawn: the sim still moves each car along the centreline and slows it by how full the road is, so cars do not yet yield turn by turn at a junction or roundabout (a roundabout's benefit is modelled as road capacity). The IN and OUT drives of a car park are both two-way underneath.
- The AirTrain is a people mover inside the airport. It does not run to the city, and trains are drawn on a timetable rather than carrying the riders you see.
- Hotels, rental centres and rideshare lots work by numbers: guests and rental staff aren't simulated as people.
- Unlocks depend on the best day's departures only. Weather and offers are light: no de-icing, diversions or negotiation yet.
- Adding a second terminal splits the same check-in agents and screeners across both, so queues grow until you hire more in Operations.
- Terminal sites are rectangles. A pier that reaches far out grows its site's bounding box rather than an L or T shape.
- A forecourt is laid along one straight face of the hall. Its links run straight out, straight on, or out and round one corner to the nearest road; they do not yet find a way round a building in between or pick a one-way loop, and it links to the nearest road even if that road goes nowhere (the design check then reports the curb has no road to State Route 12). A hand-drawn frontage road must still be parallel to the face to grow a curb. Cars reach the upper deck by its ramps, but drive under it in the plan view. The curved ramps need a link at least 45 m long that comes straight out from the frontage; otherwise the deck keeps a straight ramp. The ground road under a ramp is still drawn in the plan.
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
