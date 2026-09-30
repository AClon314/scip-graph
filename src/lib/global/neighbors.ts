/**
 * Distinct selection neighbours for the global caller/callee status readout.
 *
 * Pure over the live aggregation so it is correct at dir/file/symbol:
 * `callers` are sources of incoming edges whose target is selected (source
 * unselected); `callees` are targets of outgoing edges whose source is selected
 * (target unselected). `edges` counts every crossing edge.
 */

import type { Aggregation } from './aggregate';

export type NeighborCounts = { callers: number; callees: number; edges: number };

export function countSelectionNeighbors(
	agg: Aggregation | null,
	selectedKeys: readonly string[]
): NeighborCounts {
	if (!selectedKeys.length || !agg) return { callers: 0, callees: 0, edges: 0 };
	const set = new Set(selectedKeys);
	const seenCallers = new Set<string>();
	const seenCallees = new Set<string>();
	let callers = 0;
	let callees = 0;
	let edges = 0;
	for (const e of agg.edges) {
		const srcIn = set.has(e.source);
		const dstIn = set.has(e.target);
		if (srcIn === dstIn) continue;
		edges++;
		if (dstIn) {
			if (!seenCallers.has(e.source)) {
				seenCallers.add(e.source);
				callers++;
			}
		} else if (!seenCallees.has(e.target)) {
			seenCallees.add(e.target);
			callees++;
		}
	}
	return { callers, callees, edges };
}
