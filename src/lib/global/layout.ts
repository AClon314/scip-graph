/**
 * Global layout orchestration: the live d3-force Web Worker plus the shared
 * apply/cover helpers for the precomputed (`d3-force-cache` / `elk-stress`)
 * layouts.
 *
 * The worker protocol lives in `layout.worker.ts`; this module is the
 * main-thread controller. Keeping the worker in a small class means the page no
 * longer owns the token/pending map.
 */

import type { Aggregation, Level } from './aggregate';
import { computeMetrics } from './metrics';
import { separateRects } from './rect-separation';
import type { LayoutParams, LayoutRequest, LayoutResponse } from './layout.worker';

/** Simulation ticks per level (matches the offline precompute). */
export const TICKS: Record<Level, number> = { dir: 320, file: 450, symbol: 400 };

/** Live d3-force worker (default) or precomputed offline ELK stress. */
export type LayoutMode = 'd3-force' | 'elk-stress';

/** Force tuning per level (matches the offline precompute). */
export const PARAMS: Record<Level, LayoutParams> = {
	dir: { linkDistance: 115, linkStrength: 0.12, charge: -70, chargeDistanceMax: 900 },
	file: { linkDistance: 90, linkStrength: 0.14, charge: -48, chargeDistanceMax: 700 },
	symbol: { linkDistance: 80, linkStrength: 0.15, charge: -40, chargeDistanceMax: 600 }
};

/** Metrics surfaced by the toolbar and `window.__global.metrics()`. */
export type GlobalMetrics = {
	level: Level;
	source: string;
	nodes: number;
	edges: number;
	ms: number;
	nodeOverlapRatio: number;
	nodeOverlapPairs: number;
	fillNet: number;
	cleanupPasses: number;
	overlapsBeforeCleanup: number;
	overlapsAfterCleanup: number;
	/** elk-stress / d3-force-cache only: wall time of the offline precompute. */
	precomputeMs?: number;
};

export type Position = { x: number; y: number };
export type PositionMap = ReadonlyMap<string, Position>;

export type LayoutWorker = {
	run(payload: Omit<LayoutRequest, 'token'>): Promise<LayoutResponse>;
	terminate(): void;
};

/** Spawn the module worker and multiplex responses by request token. */
export function createLayoutWorker(url: URL): LayoutWorker {
	const worker = new Worker(url, { type: 'module' });
	let seq = 0;
	const pending = new Map<
		number,
		{ resolve: (r: LayoutResponse) => void; reject: (e: unknown) => void }
	>();
	worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
		const entry = pending.get(event.data.token);
		if (!entry) return;
		pending.delete(event.data.token);
		entry.resolve(event.data);
	};
	worker.onerror = (err) => {
		for (const entry of pending.values()) entry.reject(err);
		pending.clear();
	};
	return {
		run(payload) {
			return new Promise((resolve, reject) => {
				const token = ++seq;
				pending.set(token, { resolve, reject });
				worker.postMessage({ token, ...payload });
			});
		},
		terminate() {
			worker.terminate();
			pending.clear();
		}
	};
}

/** True when every aggregate node has a matching precomputed position. */
export function covers(positions: PositionMap | null, agg: Aggregation): boolean {
	if (!positions) return false;
	if (positions.size !== agg.nodes.length) return false;
	for (const node of agg.nodes) if (!positions.has(node.id)) return false;
	return true;
}

/** Copy the positions onto the aggregate nodes. */
export function applyPositions(agg: Aggregation, positions: PositionMap): void {
	for (const node of agg.nodes) {
		const p = positions.get(node.id);
		if (p) {
			node.x = p.x;
			node.y = p.y;
		}
	}
}

/**
 * Place the current aggregate from a precomputed layout and re-derive the
 * overlap/fill metrics on the main thread (independent of the precompute's
 * numbers) so `nodeOverlapRatio === 0` is verified, not assumed.
 */
export function applyPrecomputed(
	agg: Aggregation,
	positions: PositionMap,
	source: string,
	cleanupPasses: number,
	precomputeMs: number | undefined
): GlobalMetrics {
	const t0 = performance.now();
	applyPositions(agg, positions);
	// Re-run rect separation against the *current* node sizes: the precompute
	// sized nodes for its own `sizeByDegree` mode, so loading with a different
	// size mode can reintroduce overlaps. A no-op pass when the sizes match.
	const rects = agg.nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0, hw: n.hw, hh: n.hh }));
	const extraPasses = separateRects(rects);
	agg.nodes.forEach((n, i) => {
		n.x = rects[i].x;
		n.y = rects[i].y;
	});
	const derived = computeMetrics(rects);
	return {
		level: 'symbol',
		source,
		nodes: agg.nodes.length,
		edges: agg.edges.length,
		ms: Math.round((performance.now() - t0) * 100) / 100,
		nodeOverlapRatio: derived.nodeOverlapRatio,
		nodeOverlapPairs: derived.nodeOverlapPairs,
		fillNet: Math.round(derived.fillNet * 1e4) / 1e4,
		cleanupPasses: cleanupPasses + extraPasses,
		overlapsBeforeCleanup: 0,
		overlapsAfterCleanup: derived.nodeOverlapPairs,
		precomputeMs
	};
}
