// Content data: site, module definitions, aircraft, airlines and tuning constants.
// Kept as plain data so it can move to JSON later without code changes.
import type { Pt } from './geom';

export type Level = 0 | 1;
export const LEVELS: { id: Level; name: string; short: string; z0: number; z1: number }[] = [
  { id: 0, name: 'Ground · Arrivals & apron', short: 'G', z0: 0, z1: 9 },
  { id: 1, name: 'Level 1 · Departures', short: 'L1', z0: 9, z1: 18 },
];

export type ZoneType = 'checkin' | 'security' | 'concourse' | 'claim' | 'curb' | 'parking';
export type ShopType = 'shop' | 'food' | 'lounge';
/** Who leases a commercial lot. Core retail, sit-down dining, grab-and-go / convenience, lounges, and walk-through duty free. */
export type TenantId = 'retail' | 'dining' | 'grab' | 'lounge' | 'dutyfree';

export interface ZoneDef {
  type: ZoneType;
  label: string;
  short: string;
  key: string;            // keyboard shortcut
  terminal: boolean;      // part of the terminal building (stackable, joins by cores)
  groundOnly: boolean;
  costPerM2: number;      // build cost, $
  upkeepPerM2: number;    // $ per day
  unit: string;           // what the fit-out produces
  m2PerUnit: number;      // area per generated unit (counters, lanes, carousels, stalls)
  minW: number; minH: number;
  tierNames: [string, string];
  tierCostPerM2: number;  // upgrade cost
  blurb: string;
}

export const ZONES: Record<ZoneType, ZoneDef> = {
  checkin: {
    type: 'checkin', label: 'Check-in hall', short: 'Check-in', key: '2', terminal: true, groundOnly: false,
    costPerM2: 2600, upkeepPerM2: 0.45, unit: 'counters', m2PerUnit: 110, minW: 40, minH: 30,
    tierNames: ['Staffed counters', 'Kiosks + bag drop'], tierCostPerM2: 700,
    blurb: 'Counter islands lay out along the hall. Passengers with bags must check in.',
  },
  security: {
    type: 'security', label: 'Security checkpoint', short: 'Security', key: '3', terminal: true, groundOnly: false,
    costPerM2: 3200, upkeepPerM2: 0.6, unit: 'lanes', m2PerUnit: 260, minW: 30, minH: 30,
    tierNames: ['Standard lanes', 'CT scanners'], tierCostPerM2: 1400,
    blurb: 'The landside / airside membrane. Each lane needs 3 screeners.',
  },
  concourse: {
    type: 'concourse', label: 'Concourse', short: 'Concourse', key: '5', terminal: true, groundOnly: false,
    costPerM2: 3100, upkeepPerM2: 0.48, unit: 'gates', m2PerUnit: 0, minW: 40, minH: 24,
    tierNames: ['Standard fit-out', 'Flagship dining & lounges'], tierCostPerM2: 800,
    blurb: 'Gates grow on any side beside a taxiway, each with a holdroom behind it. A spine runs down the middle; shops, restaurants and lounges fill what is left.',
  },
  claim: {
    type: 'claim', label: 'Baggage claim', short: 'Claim', key: '7', terminal: true, groundOnly: false,
    costPerM2: 2400, upkeepPerM2: 0.4, unit: 'carousels', m2PerUnit: 1000, minW: 40, minH: 30,
    tierNames: ['Flat carousels', 'Sloped carousels'], tierCostPerM2: 600,
    blurb: 'Carousels scale with area. Each carousel serves one arriving flight at a time.',
  },
  curb: {
    type: 'curb', label: 'Curb frontage', short: 'Curb', key: '6', terminal: false, groundOnly: true,
    costPerM2: 600, upkeepPerM2: 0.1, unit: 'car bays', m2PerUnit: 0, minW: 60, minH: 20,
    tierNames: ['Single curb', 'Split taxi / rideshare'], tierCostPerM2: 250,
    blurb: 'Drop-off and pickup bays. The access road routes itself from the highway.',
  },
  parking: {
    type: 'parking', label: 'Surface parking', short: 'Parking', key: '7', terminal: false, groundOnly: true,
    costPerM2: 140, upkeepPerM2: 0.03, unit: 'stalls', m2PerUnit: 28, minW: 40, minH: 40,
    tierNames: ['Surface lot', 'Lot + shuttle'], tierCostPerM2: 40,
    blurb: 'Long-stay parking. Far lots mean long walks with luggage.',
  },
};

// ---------------------------------------------------------------- Site
export interface SiteDef {
  code: string; name: string; region: string; coords: string; elev: string;
  width: number; height: number;
  buildable: { x: number; y: number; w: number; h: number };
  lake: Pt[];
  highwayY: number;
  cityX: number;
  windFrom: number;      // prevailing wind direction, degrees true (from)
  windSpread: number;    // daily swing, degrees
  windSpeed: number;     // knots, mean
  population: number;    // catchment population, year 1
  growth: number;        // per year
}

export const SITE: SiteDef = {
  code: 'LKS', name: 'Lakeshore Regional', region: 'Lakeshore, fictional Upper Midwest',
  coords: '43.1172° N 89.4486° W', elev: 'ELEV 862 FT',
  width: 9000, height: 6400,
  buildable: { x: 900, y: 500, w: 6900, h: 4900 },
  lake: [
    { x: 0, y: 0 }, { x: 2300, y: 0 }, { x: 2050, y: 420 }, { x: 1500, y: 700 }, { x: 1120, y: 1300 },
    { x: 760, y: 2200 }, { x: 520, y: 3300 }, { x: 0, y: 3600 },
  ],
  highwayY: 5700,
  cityX: 7900,
  windFrom: 250, windSpread: 55, windSpeed: 13,
  population: 1_400_000, growth: 0.028,
};

// ---------------------------------------------------------------- Aircraft classes
// Four classes drive runway length, runway width, taxiway width, gate spacing and apron depth.
export type Cls = 0 | 1 | 2 | 3;
export interface AcClass {
  cls: Cls; key: string; name: string; example: string; seats: number; length: number; span: number;
  minRunway: number; rwyWidth: number; gateSpacing: number; apronDepth: number; turn: number; minRoll: number;
}
export const CLASSES: AcClass[] = [
  { cls: 0, key: 'TP', name: 'Turboprop', example: 'ATR 72', seats: 70, length: 27, span: 27, minRunway: 1200, rwyWidth: 30, gateSpacing: 34, apronDepth: 70, turn: 30, minRoll: 500 },
  { cls: 1, key: 'RJ', name: 'Regional jet', example: 'E175', seats: 88, length: 32, span: 26, minRunway: 1600, rwyWidth: 30, gateSpacing: 38, apronDepth: 76, turn: 35, minRoll: 750 },
  { cls: 2, key: 'NB', name: 'Narrow-body', example: 'A320', seats: 180, length: 38, span: 36, minRunway: 2100, rwyWidth: 45, gateSpacing: 48, apronDepth: 95, turn: 45, minRoll: 1100 },
  { cls: 3, key: 'SJ', name: 'Super-jumbo', example: 'A380', seats: 520, length: 73, span: 80, minRunway: 3000, rwyWidth: 60, gateSpacing: 84, apronDepth: 130, turn: 95, minRoll: 1700 },
];
/** Largest class a runway of this length can serve, or -1. */
export const rwyClass = (len: number): Cls | -1 => (len >= 3000 ? 3 : len >= 2100 ? 2 : len >= 1600 ? 1 : len >= 1200 ? 0 : -1);

export const TAXI_CLASSES = [
  { cls: 2, name: 'Standard', note: 'up to A320', width: 23, costPerM: 9000 },
  { cls: 3, name: 'Code F', note: 'all aircraft incl. A380', width: 36, costPerM: 15000 },
];
export const ROAD_LANES = [
  { lanes: 2, name: '2 lanes', width: 9, costPerM: 3500 },
  { lanes: 4, name: '4 lanes', width: 16, costPerM: 6500 },
];
export const WALK = { width: 4, costPerM: 900 };

export interface Airline {
  id: string; name: string; iata: string; share: number; elasticity: number; model: string; color: string;   // tail livery
  mix: Partial<Record<Cls, number>>; downgrade: boolean;
}
export const AIRLINES: Airline[] = [
  { id: 'meridian', name: 'Meridian Air', iata: 'MR', share: 0.42, elasticity: 0.45, model: 'Network', mix: { 2: 0.8, 1: 0.2 }, downgrade: true, color: '#2F4E78' },
  { id: 'larkspur', name: 'Larkspur', iata: 'LK', share: 0.30, elasticity: 1.15, model: 'Low-cost', mix: { 2: 1 }, downgrade: false, color: '#8A6BB0' },
  { id: 'northline', name: 'Northline Regional', iata: 'NL', share: 0.18, elasticity: 0.6, model: 'Regional', mix: { 0: 0.45, 1: 0.55 }, downgrade: true, color: '#3E8A7A' },
  { id: 'polaris', name: 'Polaris Long-Haul', iata: 'PX', share: 0.10, elasticity: 0.5, model: 'Long-haul', mix: { 3: 1 }, downgrade: false, color: '#C2852E' },
];

// ---------------------------------------------------------------- Tuning
export const TUNE = {
  // demand
  tripsPerCapita: 0.8,          // one-way departing trips per resident per year
  refSlotPrice: 2500,            // $ per movement where price factor = 1
  // runway / airfield
  runwayClear: 150,              // no buildings within this distance of centreline
  minRunway: 1000,
  parallelTaxiOffset: 190,
  separationMin: 2.0,            // minutes between movements on one runway
  dependentSpacing: 760,         // parallels closer than this are dependent
  crosswindLimit: 20,            // knots
  // terminal processing (minutes per passenger per server)
  checkinTime: [2.4, 1.5],
  securityTime: [0.55, 0.38],
  curbDropTime: 1.4,
  curbPickTime: 2.0,
  screenersPerLane: 3,
  bagsPerHandlerPerMin: 0.9,
  walkSpeed: 75,                 // m/min
  carSpeed: 700,                 // m/min
  taxiSpeed: 380,                // m/min
  // tolerances (minutes) before passengers get irritated
  tolerance: { curb: 6, checkin: 12, security: 10, claim: 14, gate: 0 },
  // concessions: airport's take per visit, minutes spent, people a unit holds at once
  shops: {
    // m2: floor area per customer at capacity, so a lot's capacity follows its size
    shop: { take: 16, min: [8, 18], m2: 10, label: 'Shop' },
    food: { take: 12, min: [15, 30], m2: 7.5, label: 'Restaurant' },
    lounge: { take: 40, min: [25, 50], m2: 15, label: 'Lounge' },
  } as Record<ShopType, { take: number; min: [number, number]; m2: number; label: string }>,
  premiumShare: 0.14,
  // economy
  startMoney: 420_000_000,
  runwayCostPerM2: 930,          // $ per m² of runway pavement
  wagePerDay: 310,
  paxFee: 9,
  retailPerMin: 0.32,
  parkingPerStay: 58,
  curbFeePerCar: 3,
};

// ---------------------------------------------------------------- Frontage and terminal sites (v0.8)
// Curbs grow wherever a road runs along a terminal face. ACRP Report 40 (Airport Curbside and Terminal Area
// Roadway Operations, 2010) puts a curbside sidewalk plus loading lane at roughly 20–25 m from building face to the
// first through lane; anything from minGap to maxGap is accepted so roads don't have to be drawn exactly.
export const FRONTAGE = {
  minGap: 8,               // m, building face to road edge: below this there's no room for a curb
  maxGap: 45,              // m: beyond this the road isn't fronting the building any more
  ideal: 20,               // m: the road tool's guide line sits this far out (plus half the road)
  minLen: 30,              // m of shared frontage before a curb appears
  ramp: 60,                // m of ramp either end of an upper deck
  snap: 40,                // m: the road tool snaps to a frontage guide within this distance
};
export const SITES = {
  minW: 80, minH: 60,      // smallest terminal site, m
  reach: 120,              // m: a module can be placed this far outside its terminal's site; the site then grows
  pad: 20,                 // m of site margin kept around a terminal's modules
};
/** Three levels of detail. The map switches between them with zoom; buttons and keys pick one directly. */
export type Lod = 'airfield' | 'landside' | 'terminal';
export const LOD = {
  airfieldBelow: 0.3,      // zoom below which the map reads as the airfield diagram
  terminalAbove: 1.1,      // zoom above which, over a terminal, the map opens that terminal
  leaveTerminalBelow: 0.55,
};

// ---------------------------------------------------------------- Concourse commerce (v0.7)
// Footfall, visibility and dwell scores per lot, tenants bidding for lots, walk-through duty free.
export const COMMERCE = {
  // Footfall: departing passengers counted as they cross the spine, in bins along the concourse's long axis.
  binM: 4,                 // bin length, m
  spareRef: 45,            // spare minutes before boarding at which a passer counts as one full shopper
  spareMin: 0.1,           // weight floor: someone running for the gate still sees the shopfront
  spareCap: 2,             // weight cap: very early passengers count at most twice
  boardLead: 20,           // boarding starts this many minutes before departure (sim.board uses readyT - 20)
  memory: 0.5,             // share of the running count kept when a day folds in, so scores move over 2–3 days
  dwellLo: 25, dwellHi: 75, // spare minutes that score 0 and 1 on dwell
  // Visibility: how much of the spine sees a shopfront. Game tuning; retail planners commonly design for
  // shopfronts readable 30–60 m down a pier, and within the forward cone of a walking passenger.
  sightM: 60,              // a shopfront reads from this far down the spine, m
  coneDeg: 60,             // half-angle of the forward cone a walker scans
  besideScore: 0.35,       // a front beside you, outside that cone, partly registers
  straightScore: 0.75,     // visibility of a front midway down a straight run; the hub face adds hubBonus on top
  hubBonus: 0.35,          // lot that faces passengers stepping out of security
  hubReach: 18,            // m either side of the security exit that count as the hub face
  cornerPenalty: 0.25,     // lot tucked into the end of the spine
  cornerM: 8,
  // Shoppers' first choice: share who want food (vs retail) with under / over 45 spare minutes. Game tuning, in line with
  // ACRP Report 54's observation that food and beverage takes roughly half of concession sales.
  wantFood: [0.35, 0.55] as [number, number],
  wantLounge: 0.35,        // premium passengers with 40+ spare minutes who head for a lounge
  // Bidding. Weights are game tuning; the brief follows ACRP Report 54 (Resource Manual for Airport In-Terminal
  // Concessions, 2011): convenience retail near security, dining with apron views and near gate clusters,
  // grab-and-go close to remote gates, lounges away from the main flow.
  minBid: 0.25,            // a lot nobody bids this much for stays vacant
  relet: 0.15,             // a challenger must out-bid the sitting tenant by this share to take the lot
  jitter: 0.06,            // stable per-lot noise so equal lots don't all go the same way
  neighbour: 0.1,          // penalty for the same format as the lot next door, so a pier gets a mix
  gateReach: 60,           // m: gates within this distance of a lot count as its gate cluster
  nearSecurityM: 150,      // m from the security exit over which "near security" fades to zero
  loungeMinDepth: 12, loungeMinArea: 300,
  loungePerGates: 10,      // one lounge per this many gates (plus one with the premium fit-out)
  // Rent. ACRP Report 54: concession agreements usually pay the greater of a minimum annual guarantee (MAG)
  // and a percentage of gross sales. Base MAG per m² per day is game tuning, scaled by the lot's score.
  rentPerM2Day: { retail: 1.6, dining: 1.3, grab: 2.0, lounge: 0.8, dutyfree: 2.2 } as Record<TenantId, number>,
  rentFloor: 0.2,          // MAG = base × area × (rentFloor + score)
  // Walk-through duty free at the security exit. Arthur D. Little's airport retail work puts penetration of
  // a walk-through store at about 60% of the passengers routed through it, against well under half for a
  // conventional storefront.
  dfCapture: 0.6,          // share of passers who stop and browse
  dfTake: 9,               // airport's take per browsing passenger, $ (game tuning: concession fee on an average basket)
  dfBrowse: [4, 10] as [number, number],   // minutes a browser spends
  dfWalk: 1.2,             // minutes the serpentine path adds even for those who don't stop
  dfHurry: 25,             // spare minutes below which a passenger is in a hurry
  dfHurrySat: 5,           // satisfaction a hurried passenger loses to the detour
  dfLen: 36,               // store length along the spine, m
  dfDepth: 18,             // store depth from the security wall when it fronts a long side, m
};
/** How each tenant format shows up in each depth class: [4–8 m, 8–15 m, over 15 m]. null: doesn't fit. */
export const TENANTS: Record<TenantId, { label: string; type: ShopType; kinds: [string | null, string | null, string | null] }> = {
  retail: { label: 'Core retail', type: 'shop', kinds: ['Kiosk', 'Shop', 'Flagship store'] },
  dining: { label: 'Sit-down food', type: 'food', kinds: [null, 'Café', 'Restaurant'] },
  grab: { label: 'Grab-and-go', type: 'food', kinds: ['Grab-and-go', 'Convenience', 'Food hall'] },
  lounge: { label: 'Lounge', type: 'lounge', kinds: [null, 'Lounge', 'Lounge'] },
  dutyfree: { label: 'Walk-through duty free', type: 'shop', kinds: ['Duty free', 'Duty free', 'Duty free'] },
};

export const PAL = {
  ground: '#E6DBC3',
  groundDeep: '#DED1B6',
  lake: '#D3D2C3',
  lakeEdge: '#C4C2B1',
  grass: '#E1D6BC',
  pave: '#B9AD96',
  paveLight: '#C9BEA8',
  paveLine: '#D9CFBA',
  road: '#A49E92',
  roadEdge: '#8C8576',
  roadLine: '#ECE5D4',
  walk: '#F4EDDF',
  walkEdge: '#AFA38A',
  bldg: '#958A76',
  bldgSide: '#7C725F',
  bldgTop: '#A39885',
  bldgGhost: 'rgba(125,114,95,0.18)',
  runway: '#28241E',
  ink: '#28241E',
  ink2: '#6D6454',
  ink3: '#998F7C',
  warn: '#C2852E',
  bad: '#B0472B',
  ok: '#5E7A55',
  select: '#2F5D7C',
  night: 'rgb(30,34,58)',
};
