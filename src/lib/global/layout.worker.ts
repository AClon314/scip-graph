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
import {
  bboxOf,
  countOverlaps,
  radiusOf,
  separateRects,
  unionArea,
} from './rect-separation';

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

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  const box = bboxOf(simNodes);
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
