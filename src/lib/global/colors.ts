/**
 * Colour + coordinate helpers for the global density canvas.
 *
 * Extracted verbatim from the global page so both the renderer and the
 * interaction layer share one definition. Pure functions only.
 */

import type { AggNode, Level } from './aggregate';

/** Stable FNV-1a hue for a string (0..359). */
export function hashHue(str: string): number {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) % 360;
}

/** Colour bucket: symbol nodes group by their first three path segments. */
export function colorKey(node: AggNode, level: Level): string {
	if (level !== 'symbol') return node.id;
	const file = node.id.slice(0, node.id.lastIndexOf(':'));
	return file.split('/').slice(0, 3).join('/');
}

export function nodeFill(node: AggNode, level: Level, alpha = 1): string {
	const hue = hashHue(colorKey(node, level));
	return `hsla(${hue}, 62%, 58%, ${alpha})`;
}

export function edgeScreenWidth(calls: number): number {
	return Math.min(4, 0.6 + Math.log2(1 + calls) * 0.7);
}
