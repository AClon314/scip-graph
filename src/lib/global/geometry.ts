/**
 * View-transform + hit-testing geometry for the global density canvas.
 *
 * Pure functions over the aggregate/layout state. The page keeps the mutable
 * `view` object; every helper here returns a fresh value so there is a single
 * place that encodes the world ↔ screen convention.
 */

import type { AggNode, Aggregation } from './aggregate';

export type View = { k: number; tx: number; ty: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Bounds = { cx: number; cy: number; w: number; h: number };

export function worldToScreen(view: View, x: number, y: number): [number, number] {
	return [x * view.k + view.tx, y * view.k + view.ty];
}

/** Fit every drawn node rect into the canvas, with a fixed 48px pad. */
export function computeFit(agg: Aggregation, cw: number, ch: number): View {
	let lx = Infinity;
	let rx = -Infinity;
	let ty = Infinity;
	let by = -Infinity;
	for (const node of agg.nodes) {
		const x = node.x ?? 0;
		const y = node.y ?? 0;
		lx = Math.min(lx, x - node.hw);
		rx = Math.max(rx, x + node.hw);
		ty = Math.min(ty, y - node.hh);
		by = Math.max(by, y + node.hh);
	}
	const w = Math.max(1, rx - lx);
	const h = Math.max(1, by - ty);
	const pad = 48;
	const k = Math.max(0.02, Math.min((cw - 2 * pad) / w, (ch - 2 * pad) / h));
	return { k, tx: cw / 2 - ((lx + rx) / 2) * k, ty: ch / 2 - ((ty + by) / 2) * k };
}

/** Topmost node whose drawn rect contains the screen point. */
export function hitTest(agg: Aggregation, view: View, sx: number, sy: number): AggNode | null {
	const k = view.k;
	for (let i = agg.nodes.length - 1; i >= 0; i--) {
		const node = agg.nodes[i];
		const [cx, cy] = worldToScreen(view, node.x ?? 0, node.y ?? 0);
		if (Math.abs(sx - cx) <= node.hw * k && Math.abs(sy - cy) <= node.hh * k) return node;
	}
	return null;
}

/** Bounding box of the selected drawn rects, or `null` when none resolve. */
export function selectionBounds(
	selection: ReadonlySet<string>,
	nodeById: ReadonlyMap<string, AggNode>
): Bounds | null {
	if (!selection.size) return null;
	let lx = Infinity;
	let rx = -Infinity;
	let ty = Infinity;
	let by = -Infinity;
	for (const id of selection) {
		const node = nodeById.get(id);
		if (!node) continue;
		const x = node.x ?? 0;
		const y = node.y ?? 0;
		lx = Math.min(lx, x - node.hw);
		rx = Math.max(rx, x + node.hw);
		ty = Math.min(ty, y - node.hh);
		by = Math.max(by, y + node.hh);
	}
	if (!Number.isFinite(lx)) return null;
	return { cx: (lx + rx) / 2, cy: (ty + by) / 2, w: rx - lx, h: ty - by };
}

/** View that frames `bounds` with `pad` px of breathing room (clamped zoom). */
export function zoomToBounds(bounds: Bounds, cw: number, ch: number, pad = 90): View {
	const k = Math.max(
		0.05,
		Math.min(8, Math.min((cw - pad) / Math.max(1, bounds.w), (ch - pad) / Math.max(1, bounds.h)))
	);
	return { k, tx: cw / 2 - bounds.cx * k, ty: ch / 2 - bounds.cy * k };
}

/** Ids of every node whose drawn rect intersects the (screen-space) box. */
export function boxSelectIds(agg: Aggregation, view: View, rect: Box): string[] {
	const { k, tx, ty } = view;
	const wx0 = (rect.x - tx) / k;
	const wy0 = (rect.y - ty) / k;
	const wx1 = (rect.x + rect.w - tx) / k;
	const wy1 = (rect.y + rect.h - ty) / k;
	const box = {
		lx: Math.min(wx0, wx1),
		rx: Math.max(wx0, wx1),
		ty: Math.min(wy0, wy1),
		by: Math.max(wy0, wy1)
	};
	const ids: string[] = [];
	for (const node of agg.nodes) {
		const x = node.x ?? 0;
		const y = node.y ?? 0;
		const lx = x - node.hw;
		const rx = x + node.hw;
		const ny = y - node.hh;
		const by = y + node.hh;
		if (lx < box.rx && rx > box.lx && ny < box.by && by > box.ty) ids.push(node.id);
	}
	return ids;
}

/** Zoom by `factor` around a screen point. */
export function zoomAround(view: View, sx: number, sy: number, factor: number): View {
	const k = Math.max(0.02, Math.min(40, view.k * factor));
	const wx = (sx - view.tx) / view.k;
	const wy = (sy - view.ty) / view.k;
	return { k, tx: sx - wx * k, ty: sy - wy * k };
}
