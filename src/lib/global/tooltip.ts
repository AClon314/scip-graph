/**
 * Tooltip content for the global density canvas.
 *
 * Symbol nodes show the representative member; dir/file nodes summarise the
 * group. Pure content builder so the page only owns positioning + the
 * "same node → move only" optimisation.
 */

import type { AggNode, Level } from './aggregate';

export type Tooltip = { x: number; y: number; title: string; body: string; muted?: string };

export function tooltipFor(node: AggNode, level: Level, x: number, y: number): Tooltip {
	if (level === 'symbol') {
		const member = node.members[0];
		return {
			x,
			y,
			title: member?.name ?? node.name ?? node.label,
			body:
				`${member?.file ?? node.file}:${member?.line ?? node.line}\n` +
				`kind ${member?.kind ?? node.kind} · degree ${node.degree}` +
				`${member?.svelte ? ' · .svelte' : ''}`
		};
	}
	const samples = node.members
		.slice(0, 4)
		.map((m) => m.name)
		.join(', ');
	return {
		x,
		y,
		title: node.id,
		body: `${node.weight} symbols · ${node.intraCalls} intra-group calls · degree ${node.degree}`,
		muted: `${samples}${node.members.length > 4 ? '…' : ''}`
	};
}
