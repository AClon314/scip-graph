/**
 * Canvas renderer for the global density view.
 *
 * Extracted from the page's `draw()` so the browser-global layout code stays
 * focused on state. Pure over the supplied `Scene` snapshot: the page calls it
 * from the canvas event loop and on every interaction that changes the scene.
 */

import type { AggNode, Aggregation, Level } from './aggregate';
import { edgeScreenWidth, nodeFill } from './colors';
import { worldToScreen, type View } from './geometry';

export type Scene = {
	agg: Aggregation | null;
	nodeById: ReadonlyMap<string, AggNode>;
	view: View;
	selection: ReadonlySet<string>;
	searchQuery: string;
	searchMatches: ReadonlySet<string> | null;
	hoverId: string | null;
	elevate: number;
	level: Level;
};

export function drawScene(
	ctx: CanvasRenderingContext2D,
	canvasEl: HTMLCanvasElement,
	scene: Scene
): void {
	const { agg, nodeById, view, selection, searchQuery, searchMatches, hoverId, elevate, level } =
		scene;
	const cw = canvasEl.clientWidth;
	const ch = canvasEl.clientHeight;
	ctx.clearRect(0, 0, cw, ch);
	if (!agg) return;
	const { k } = view;

	// edges
	ctx.lineCap = 'round';
	for (const edge of agg.edges) {
		const a = nodeById.get(edge.source);
		const b = nodeById.get(edge.target);
		if (!a || !b) continue;
		const [ax, ay] = worldToScreen(view, a.x ?? 0, a.y ?? 0);
		const [bx, by] = worldToScreen(view, b.x ?? 0, b.y ?? 0);
		const active =
			selection.size > 0 && (selection.has(edge.source) || selection.has(edge.target));
		const dim =
			!!searchQuery && !searchMatches?.has(edge.source) && !searchMatches?.has(edge.target);
		if (edge.dispatch === 'virtual') ctx.strokeStyle = active ? '#ffb347' : '#7a5a2a';
		else ctx.strokeStyle = active ? '#8fbcd4' : '#42505f';
		ctx.globalAlpha = dim ? 0.05 : active ? 0.95 : 0.5;
		ctx.lineWidth = edgeScreenWidth(edge.calls);
		ctx.beginPath();
		ctx.moveTo(ax, ay);
		ctx.lineTo(bx, by);
		ctx.stroke();
	}
	ctx.globalAlpha = 1;

	// nodes
	const showLabels = agg.nodes.length <= 400 || k > 0.12;
	ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
	ctx.textBaseline = 'middle';
	for (const node of agg.nodes) {
		const [sx, sy] = worldToScreen(view, node.x ?? 0, node.y ?? 0);
		const w = node.hw * 2 * k;
		const h = node.hh * 2 * k;
		const rx = sx - w / 2;
		const ry = sy - h / 2;
		const selected = selection.has(node.id);
		const hovered = hoverId === node.id;
		const dim = !!searchQuery && !searchMatches?.has(node.id);
		ctx.globalAlpha = dim ? 0.12 : 1;
		if (selected && elevate > 0) {
			const pad = 2 + elevate * 10;
			ctx.save();
			ctx.globalAlpha = 0.15 + 0.35 * elevate;
			ctx.strokeStyle = '#ffd54a';
			ctx.lineWidth = 2 + 3 * elevate;
			ctx.shadowColor = '#ffd54a';
			ctx.shadowBlur = 16 * elevate;
			if (w < 26 || h < 8) {
				ctx.strokeRect(rx - pad, ry - pad, w + pad * 2, h + pad * 2);
			} else {
				ctx.beginPath();
				ctx.roundRect(rx - pad, ry - pad, w + pad * 2, h + pad * 2, 6);
				ctx.stroke();
			}
			ctx.restore();
		}
		ctx.fillStyle = nodeFill(node, level, selected ? 0.95 : 0.82);
		if (w < 26 || h < 8) {
			ctx.fillRect(rx, ry, w, h);
			if (selected || hovered || !dim) {
				ctx.lineWidth = selected ? 3 : hovered ? 2 : 1;
				ctx.strokeStyle = selected ? '#ffd54a' : hovered ? '#ffffff' : '#0b0f14';
				ctx.strokeRect(rx, ry, w, h);
			}
		} else {
			ctx.beginPath();
			ctx.roundRect(rx, ry, w, h, Math.min(4, w / 2, h / 2));
			ctx.fill();
			ctx.lineWidth = selected ? 3 : hovered ? 2 : 1;
			ctx.strokeStyle = selected ? '#ffd54a' : hovered ? '#ffffff' : '#0b0f14';
			ctx.stroke();
		}
		if (showLabels && w > 30 && h > 10) {
			// Symbol labels show the real function name (never the line number).
			const label = level === 'symbol' ? (node.name ?? node.label) : node.label;
			const text = String(label);
			const maxChars = Math.max(1, Math.floor((w - 8) / 6.4));
			const clipped = text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
			ctx.fillStyle = '#0b0f14';
			ctx.globalAlpha = dim ? 0.15 : 0.9;
			ctx.fillText(clipped, rx + 4, sy + 0.5);
		}
	}
	ctx.globalAlpha = 1;
}
