/**
 * Search matching for the global density view.
 *
 * Symbol nodes match on id / name / kind; dir/file nodes on their id. The
 * page keeps the debounce-free input handler and rendering.
 */

import type { Aggregation, Level } from './aggregate';

export function matchNodes(agg: Aggregation, level: Level, query: string): Set<string> {
	const q = query.toLowerCase();
	const matches = new Set<string>();
	for (const node of agg.nodes) {
		const hay =
			level === 'symbol' ? `${node.id} ${node.name ?? ''} ${node.kind ?? ''}` : node.id;
		if (hay.toLowerCase().includes(q)) matches.add(node.id);
	}
	return matches;
}
