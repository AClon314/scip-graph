/**
 * Layout worker for the global density view.
 *
 * Faithful TypeScript port of `view-a/src/worker.js`, loaded as a *module*
 * Web Worker:
 *
 *   new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
 *
 * Runs d3-force (forceLink + forceManyBody + forceCollide + forceCenter)
 * entirely off the main thread, then applies a deterministic Gauss-Seidel
 * rect-separation cleanup pass so that the drawn, weight-scaled node
 * rectangles never overlap.
 *
 * Message in:  { token, nodes:[{id,hw,hh}], edges:[{source,target,calls}],
 *                ticks, params:{ linkDistance, linkStrength, charge,
 *                chargeDistanceMax, collideStrength, collideIterations }, seed }
 * Message out: { token, positions:[{id,x,y}], ms, cleanupPasses,
 *                overlapsBefore, overlapsAfter, overlapRatio, fillNet }
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

export type LayoutNodeInput = { id: string; hw: number; hh: number };
export type LayoutEdgeInput = { source: string; target: string; calls: number };

export type LayoutParams = {
  linkDistance?: number;
  linkStrength?: number;
  charge?: number;
  chargeDistanceMax?: number;
  collideStrength?: number;
  collideIterations?: number;
};

export type LayoutRequest = {
  token: number;
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
  ticks: number;
  params?: LayoutParams;
  seed?: number;
};

export type LayoutResponse = {
  token: number;
  positions: { id: string; x: number; y: number }[];
  ms: number;
  cleanupPasses: number;
  overlapsBefore: number;
  overlapsAfter: number;
  overlapRatio: number;
  fillNet: number;
};

/** Node datum used by the simulation (position + drawn half-extents). */
interface SimNode extends SimulationNodeDatum {
  id: string;
  hw: number;
  hh: number;
  radius: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  calls: number;
}

const MARGIN = 0.6;

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact half-diagonal radius per node (circumscribed circle). */
function radiusOf(node: { hw: number; hh: number }): number {
  return Math.hypot(node.hw, node.hh) + MARGIN;
}

function countOverlaps(nodes: SimNode[]): number {
  let pairs = 0;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx < a.hw + b.hw && dy < a.hh + b.hh) pairs++;
    }
  }
  return pairs;
}

/**
 * Deterministic Gauss-Seidel rect separation on the ACTUAL drawn rectangles,
 * along the minimum-penetration axis. This targets the nodeOverlapRatio metric
 * directly (no circumscribed-circle conservatism). Fixed pair order makes it
 * reproducible. Returns the number of passes used.
 */
function separateRects(nodes: SimNode[], maxPasses = 250): number {
  const n = nodes.length;
  let pass = 0;
  for (; pass < maxPasses; pass++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        const ox = a.hw + b.hw - Math.abs(a.x - b.x);
        if (ox <= 0) continue;
        const oy = a.hh + b.hh - Math.abs(a.y - b.y);
        if (oy <= 0) continue;
        moved++;
        if (ox <= oy) {
          const sign = a.x <= b.x ? -1 : 1;
          const push = ox / 2 + 1e-3;
          a.x += sign * push;
          b.x -= sign * push;
        } else {
          const sign = a.y <= b.y ? -1 : 1;
          const push = oy / 2 + 1e-3;
          a.y += sign * push;
          b.y -= sign * push;
        }
      }
    }
    if (moved === 0) break;
  }
  return pass;
}

function bbox(nodes: SimNode[]): { lx: number; rx: number; ty: number; by: number; w: number; h: number } {
  let lx = Infinity;
  let rx = -Infinity;
  let ty = Infinity;
  let by = -Infinity;
  for (const node of nodes) {
    lx = Math.min(lx, node.x - node.hw);
    rx = Math.max(rx, node.x + node.hw);
    ty = Math.min(ty, node.y - node.hh);
    by = Math.max(by, node.y + node.hh);
  }
  return { lx, rx, ty, by, w: rx - lx, h: by - ty };
}

/** Exact union area of drawn rects (x-sweep + merged y-intervals). */
function unionArea(nodes: SimNode[]): number {
  if (!nodes.length) return 0;
  const rects = nodes.map((n) => ({
    lx: n.x - n.hw,
    rx: n.x + n.hw,
    ty: n.y - n.hh,
    by: n.y + n.hh,
  }));
  const xs = [...new Set(rects.flatMap((r) => [r.lx, r.rx]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    if (x1 <= x0) continue;
    const ys: [number, number][] = [];
    for (const r of rects) if (r.lx < x1 && r.rx > x0) ys.push([r.ty, r.by]);
    if (!ys.length) continue;
    ys.sort((a, b) => a[0] - b[0]);
    let cov = 0;
    let cy0 = ys[0][0];
    let cy1 = ys[0][1];
    for (let k = 1; k < ys.length; k++) {
      const [y0, y1] = ys[k];
      if (y0 > cy1) {
        cov += cy1 - cy0;
        cy0 = y0;
        cy1 = y1;
      } else if (y1 > cy1) {
        cy1 = y1;
      }
    }
    cov += cy1 - cy0;
    area += (x1 - x0) * cov;
  }
  return area;
}

/** Minimal shape of the worker global scope, avoiding DOM/webworker lib conflicts. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutResponse): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { token, nodes, edges, ticks, params, seed } = event.data;
  const t0 = performance.now();

  const rnd = mulberry32(seed ?? 0x9e3779b9);
  const simNodes: SimNode[] = nodes.map((meta, i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const radius = 12 * Math.sqrt(0.5 + i);
    return {
      id: meta.id,
      index: i,
      hw: meta.hw,
      hh: meta.hh,
      radius: radiusOf(meta),
      x: radius * Math.cos(angle) + (rnd() - 0.5) * 4,
      y: radius * Math.sin(angle) + (rnd() - 0.5) * 4,
      vx: 0,
      vy: 0,
    };
  });
  const byId = new Map(simNodes.map((node) => [node.id, node]));
  const links: SimLink[] = edges.map((edge) => ({
    source: byId.get(edge.source) as SimNode,
    target: byId.get(edge.target) as SimNode,
    calls: edge.calls,
  }));

  const p = params || {};
  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance(p.linkDistance ?? 80)
        .strength(p.linkStrength ?? 0.15),
    )
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength(p.charge ?? -40)
        .distanceMax(p.chargeDistanceMax ?? 600),
    )
    .force(
      'collide',
      forceCollide<SimNode>((d) => d.radius)
        .strength(p.collideStrength ?? 1)
        .iterations(p.collideIterations ?? 4),
    )
    .force('center', forceCenter<SimNode>(0, 0))
    .stop();

  for (let i = 0; i < ticks; i++) sim.tick();

  const overlapsBefore = countOverlaps(simNodes);
  const cleanupPasses = separateRects(simNodes);
  const overlapsAfter = countOverlaps(simNodes);
  const box = bbox(simNodes);
  const boxArea = box.w * box.h;
  const fillNet = boxArea > 0 ? unionArea(simNodes) / boxArea : 0;
  const pairTotal = (simNodes.length * (simNodes.length - 1)) / 2;
  const ms = performance.now() - t0;

  scope.postMessage({
    token,
    positions: simNodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
    ms,
    cleanupPasses,
    overlapsBefore,
    overlapsAfter,
    overlapRatio: pairTotal > 0 ? overlapsAfter / pairTotal : 0,
    fillNet,
  });
};
