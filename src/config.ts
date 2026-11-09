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
  id: string; name: string; iata: string; share: number; elasticity: number; model: string;
  mix: Partial<Record<Cls, number>>; downgrade: boolean;
}
export const AIRLINES: Airline[] = [
  { id: 'meridian', name: 'Meridian Air', iata: 'MR', share: 0.42, elasticity: 0.45, model: 'Network', mix: { 2: 0.8, 1: 0.2 }, downgrade: true },
  { id: 'larkspur', name: 'Larkspur', iata: 'LK', share: 0.30, elasticity: 1.15, model: 'Low-cost', mix: { 2: 1 }, downgrade: false },
  { id: 'northline', name: 'Northline Regional', iata: 'NL', share: 0.18, elasticity: 0.6, model: 'Regional', mix: { 0: 0.45, 1: 0.55 }, downgrade: true },
  { id: 'polaris', name: 'Polaris Long-Haul', iata: 'PX', share: 0.10, elasticity: 0.5, model: 'Long-haul', mix: { 3: 1 }, downgrade: false },
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
