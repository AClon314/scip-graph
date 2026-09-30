/**
 * In-place re-aggregation for the "size by degree" toggle.
 *
 * Toggling must not trigger a full relayout when positions already exist: this
 * re-aggregates with the new rectangle sizes, copies the previous positions
 * back, re-runs the deterministic rect separation (so `nodeOverlapRatio === 0`
 * still holds after rects grow/shrink) and re-derives the metrics. Returns
 * `null` when the node set changed and the caller must fall back to `relayout`.
 */

import type { SgGraph } from '$lib/graph/schema';
import { aggregate, type Aggregation, type Level } from './aggregate';
import { computeMetrics, type GraphMetrics } from './metrics';
import { separateRects } from './rect-separation';

export type SizeReaggregation = { agg: Aggregation; metrics: GraphMetrics };

export function reaggregateForSize(
	graph: SgGraph,
	level: Level,
	sizeByDegree: boolean,
	prev: ReadonlyMap<string, { x: number; y: number }>
): SizeReaggregation | null {
	const agg = aggregate(graph, level, { sizeByDegree });
	if (prev.size !== agg.nodes.length) return null;
	for (const node of agg.nodes) {
		const p = prev.get(node.id);
		if (p) {
			node.x = p.x;
			node.y = p.y;
		}
	}
	const rects = agg.nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0, hw: n.hw, hh: n.hh }));
	separateRects(rects);
	agg.nodes.forEach((n, i) => {
		n.x = rects[i].x;
		n.y = rects[i].y;
	});
	return { agg, metrics: computeMetrics(rects) };
}
