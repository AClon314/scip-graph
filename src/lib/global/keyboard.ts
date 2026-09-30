/**
 * Keyboard helpers for the global density view.
 *
 * Pure geometry only: which node is the nearest neighbour of the current
 * selection in a screen-space direction (aligned-bias), and whether an event
 * target is a text field (so shortcuts don't hijack typing).
 */

import type { AggNode, Aggregation } from './aggregate';
import { worldToScreen, type View } from './geometry';

export type Direction = 'left' | 'right' | 'up' | 'down';

export function isTypingTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/** Node nearest the screen centre (used to seed arrow navigation). */
export function nearestToCenter(
	agg: Aggregation,
	view: View,
	cw: number,
	ch: number
): AggNode | null {
	const cx = cw / 2;
	const cy = ch / 2;
	let best = Infinity;
	let found: AggNode | null = null;
	for (const node of agg.nodes) {
		const [sx, sy] = worldToScreen(view, node.x ?? 0, node.y ?? 0);
		const d = (sx - cx) ** 2 + (sy - cy) ** 2;
		if (d < best) {
			best = d;
			found = node;
		}
	}
	return found;
}

/** Nearest node in `dir` from `current` (primary distance + 2.2× cross-axis). */
export function nearestInDirection(
	agg: Aggregation,
	current: AggNode,
	dir: Direction
): AggNode | null {
	const cx = current.x ?? 0;
	const cy = current.y ?? 0;
	let best: AggNode | null = null;
	let bestScore = Infinity;
	for (const node of agg.nodes) {
		if (node === current) continue;
		const dx = (node.x ?? 0) - cx;
		const dy = (node.y ?? 0) - cy;
		let primary: number;
		let cross: number;
		if (dir === 'right') {
			if (dx <= 0.5) continue;
			primary = dx;
			cross = Math.abs(dy);
		} else if (dir === 'left') {
			if (dx >= -0.5) continue;
			primary = -dx;
			cross = Math.abs(dy);
		} else if (dir === 'down') {
			if (dy <= 0.5) continue;
			primary = dy;
			cross = Math.abs(dx);
		} else {
			if (dy >= -0.5) continue;
			primary = -dy;
			cross = Math.abs(dx);
		}
		const score = primary + cross * 2.2;
		if (score < bestScore) {
			bestScore = score;
			best = node;
		}
	}
	return best;
}
