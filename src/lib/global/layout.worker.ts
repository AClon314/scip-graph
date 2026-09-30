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
 * The simulation itself (seeded start + forces) is shared with the offline
 * `bun run precompute:force` path via `force-sim.ts`, so both produce identical
 * positions.
 *
 * Message in:  { token, nodes:[{id,hw,hh}], edges:[{source,target,calls}],
 *                ticks, params:{ linkDistance, linkStrength, charge,
 *                chargeDistanceMax, collideStrength, collideIterations }, seed }
 * Message out: { token, positions:[{id,x,y}], ms, cleanupPasses,
 *                overlapsBefore, overlapsAfter, overlapRatio, fillNet }
 */

import { buildSimulation } from './force-sim';
import type { LayoutEdgeInput, LayoutNodeInput, LayoutParams } from './force-sim';
import { bboxOf, countOverlaps, separateRects, unionArea } from './rect-separation';

export type { LayoutEdgeInput, LayoutNodeInput, LayoutParams } from './force-sim';

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

/** Minimal shape of the worker global scope, avoiding DOM/webworker lib conflicts. */
interface WorkerScope {
	onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
	postMessage(message: LayoutResponse): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<LayoutRequest>) => {
	const { token, nodes, edges, ticks, params, seed } = event.data;
	const t0 = performance.now();

	const { sim, simNodes } = buildSimulation(nodes, edges, params, seed ?? 0x9e3779b9);
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
		fillNet
	});
};
