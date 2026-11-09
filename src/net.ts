// Generic line networks. Player-drawn segments are split wherever they cross or T into each other,
// producing a graph that aircraft, cars and pedestrians route on.
import { Pt, dist, segDist, projT, segIntersection } from './geom';

/** `ow`: one-way, travelled from a to b only (v0.11). */
export interface NSeg { a: Pt; b: Pt; kind: string; cls: number; ref: number; lanes?: number; ow?: boolean }
export interface Edge { id: number; u: number; v: number; len: number; kind: string; cls: number; ref: number; lanes: number; ow: boolean }
export interface Net { nodes: Pt[]; edges: Edge[]; adj: number[][] }
export interface DJ { dist: Float64Array; prev: Int32Array }

export function buildNet(segs: NSeg[], tol = 4): Net {
  const nodes: Pt[] = [];
  const add = (p: Pt) => {
    for (let i = 0; i < nodes.length; i++) {
      const q = nodes[i];
      if (Math.abs(q.x - p.x) <= tol && Math.abs(q.y - p.y) <= tol && dist(q, p) <= tol) return i;
    }
    nodes.push({ x: p.x, y: p.y });
    return nodes.length - 1;
  };
  const marks = segs.map(s => [{ t: 0, n: add(s.a) }, { t: 1, n: add(s.b) }]);
  const tee = (S: NSeg, si: number, O: NSeg) => {
    for (const e of [O.a, O.b]) {
      const t = projT(e, S.a, S.b);
      if (t > 1e-4 && t < 1 - 1e-4 && segDist(e, S.a, S.b) <= tol) marks[si].push({ t, n: add(e) });
    }
  };
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const A = segs[i], B = segs[j];
    if (Math.max(A.a.x, A.b.x) + tol < Math.min(B.a.x, B.b.x) || Math.max(B.a.x, B.b.x) + tol < Math.min(A.a.x, A.b.x) ||
        Math.max(A.a.y, A.b.y) + tol < Math.min(B.a.y, B.b.y) || Math.max(B.a.y, B.b.y) + tol < Math.min(A.a.y, A.b.y)) continue;
    const x = segIntersection(A.a, A.b, B.a, B.b);
    if (x) { const n = add(x); marks[i].push({ t: projT(x, A.a, A.b), n }); marks[j].push({ t: projT(x, B.a, B.b), n }); }
    tee(A, i, B); tee(B, j, A);
  }
  const edges: Edge[] = [];
  const adj: number[][] = nodes.map(() => []);
  segs.forEach((s, i) => {
    const m = marks[i].sort((p, q) => p.t - q.t);
    for (let k = 1; k < m.length; k++) {
      const u = m[k - 1].n, v = m[k].n;
      if (u === v) continue;
      const id = edges.length;
      edges.push({ id, u, v, len: dist(nodes[u], nodes[v]), kind: s.kind, cls: s.cls, ref: s.ref, lanes: s.lanes ?? 1, ow: !!s.ow });
      adj[u].push(id); adj[v].push(id);
    }
  });
  return { nodes, edges, adj };
}

export function nearestNode(net: Net, p: Pt, max = Infinity): number {
  let best = -1, bd = max;
  net.nodes.forEach((q, i) => { const d = dist(p, q); if (d <= bd) { bd = d; best = i; } });
  return best;
}

/**
 * Shortest paths from a set of sources. `ok` filters edges (e.g. by aircraft class).
 * `dir` says how one-way edges count: 0 ignores them, 1 is travel away from the sources, -1 travel towards them.
 */
export function dijkstra(net: Net, sources: { n: number; c: number }[], ok: (e: Edge) => boolean = () => true, w: (e: Edge) => number = e => e.len, dir: -1 | 0 | 1 = 0): DJ {
  const N = net.nodes.length;
  const d = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap: [number, number][] = [];
  const push = (c: number, n: number) => {
    heap.push([c, n]); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0]; const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  for (const s of sources) if (s.n >= 0 && s.c < d[s.n]) { d[s.n] = s.c; push(s.c, s.n); }
  while (heap.length) {
    const [c, u] = pop();
    if (c > d[u]) continue;
    for (const eid of net.adj[u]) {
      const e = net.edges[eid];
      if (!ok(e)) continue;
      if (e.ow && dir && (dir === 1 ? e.u !== u : e.v !== u)) continue;
      const v = e.u === u ? e.v : e.u;
      const nc = c + w(e);
      if (nc < d[v]) { d[v] = nc; prev[v] = eid; push(nc, v); }
    }
  }
  return { dist: d, prev };
}

/** Follow prev pointers from `from` back to the Dijkstra source. */
export function trace(net: Net, dj: DJ, from: number): { nodes: number[]; eids: number[] } {
  const nodes = [from], eids: number[] = [];
  let x = from, guard = 0;
  while (dj.prev[x] >= 0 && guard++ < 10000) {
    const e = net.edges[dj.prev[x]];
    eids.push(e.id);
    x = e.u === x ? e.v : e.u;
    nodes.push(x);
  }
  return { nodes, eids };
}

/** All-pairs shortest paths (Floyd–Warshall) for small graphs. */
export function allPairs(N: number, edges: [number, number, number][]) {
  const D = new Float64Array(N * N).fill(Infinity);
  const nxt = new Int32Array(N * N).fill(-1);
  for (let i = 0; i < N; i++) { D[i * N + i] = 0; nxt[i * N + i] = i; }
  for (const [u, v, w] of edges) if (w < D[u * N + v]) { D[u * N + v] = w; D[v * N + u] = w; nxt[u * N + v] = v; nxt[v * N + u] = u; }
  for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) {
    const dik = D[i * N + k]; if (dik === Infinity) continue;
    for (let j = 0; j < N; j++) {
      const c = dik + D[k * N + j];
      if (c < D[i * N + j]) { D[i * N + j] = c; nxt[i * N + j] = nxt[i * N + k]; }
    }
  }
  return { D, nxt };
}
