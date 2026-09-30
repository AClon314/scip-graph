/**
 * Shared d3-force simulation builder for the global symbol layout.
 *
 * `layout.worker.ts` (live browser run) and `scripts/precompute-force.ts`
 * (offline `bun run precompute:force`) must produce byte-identical positions,
 * so the seeded phyllotaxis start, link / charge / collide / center forces and
 * the deterministic PRNG live here once and are imported by both.
 *
 * Types are re-exported from `layout.worker.ts` to keep the worker's public
 * request/params surface unchanged.
 */

import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum
} from 'd3-force';
import { radiusOf } from './rect-separation';

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

/** Node datum used by the simulation (position + drawn half-extents). */
export interface SimNode extends SimulationNodeDatum {
	id: string;
	hw: number;
	hh: number;
	radius: number;
	x: number;
	y: number;
	vx: number;
	vy: number;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
	calls: number;
}

/** Deterministic PRNG used for the seeded start positions. */
export function mulberry32(a: number): () => number {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Build the stopped simulation with the shared forces and seeded spiral start.
 * Callers tick it themselves (`sim.tick(...)`).
 */
export function buildSimulation(
	nodes: readonly LayoutNodeInput[],
	edges: readonly LayoutEdgeInput[],
	params: LayoutParams | undefined,
	seed: number
): { sim: ReturnType<typeof forceSimulation<SimNode>>; simNodes: SimNode[] } {
	const rnd = mulberry32(seed);
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
			vy: 0
		};
	});
	const byId = new Map(simNodes.map((node) => [node.id, node]));
	const links: SimLink[] = edges.map((edge) => ({
		source: byId.get(edge.source) as SimNode,
		target: byId.get(edge.target) as SimNode,
		calls: edge.calls
	}));

	const p = params || {};
	const sim = forceSimulation<SimNode>(simNodes)
		.force(
			'link',
			forceLink<SimNode, SimLink>(links)
				.id((d) => d.id)
				.distance(p.linkDistance ?? 80)
				.strength(p.linkStrength ?? 0.15)
		)
		.force(
			'charge',
			forceManyBody<SimNode>()
				.strength(p.charge ?? -40)
				.distanceMax(p.chargeDistanceMax ?? 600)
		)
		.force(
			'collide',
			forceCollide<SimNode>((d) => d.radius)
				.strength(p.collideStrength ?? 1)
				.iterations(p.collideIterations ?? 4)
		)
		.force('center', forceCenter<SimNode>(0, 0))
		.stop();

	return { sim, simNodes };
}
