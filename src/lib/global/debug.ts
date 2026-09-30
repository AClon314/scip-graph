/**
 * `window.__global` debug handle.
 *
 * The method surface is part of the project contract (see
 * `docs/polish-global.md` / `docs/global-ux.md` / `docs/phase6-acceleration.md`),
 * so it is constructed here in one place and the page only supplies the live
 * accessors. `labels` / `nodeIds` / `positions` are derived from the current
 * aggregation.
 */

import type { Aggregation, Level } from './aggregate';
import type { GlobalMetrics, LayoutMode } from './layout';

export type GlobalPosition = { id: string; x: number; y: number; w: number; h: number };
export type GlobalScreenPos = { x: number; y: number; hw: number; hh: number; k: number } | null;

export type GlobalDebugApi = {
	setLevel: (
		next: Level,
		options?: { keepSelection?: boolean }
	) => Promise<GlobalMetrics | undefined>;
	setLayoutMode: (mode: LayoutMode) => Promise<GlobalMetrics | undefined>;
	select: (ids: string[]) => string[];
	selection: () => string[];
	metrics: () => GlobalMetrics | null;
	relayout: (forceLive?: boolean) => Promise<GlobalMetrics | undefined>;
	layout: () => LayoutMode;
	elkAvailable: () => boolean;
	fit: () => void;
	focus: (id: string) => Promise<boolean>;
	center: (id: string) => boolean;
	openLocal: (ids?: string[]) => void;
	level: () => Level;
	labels: () => Array<{ id: string; name?: string; label: string }>;
	nodeIds: () => string[];
	positions: () => GlobalPosition[];
	screenPos: (id: string) => GlobalScreenPos;
};

export type GlobalDebugDeps = Omit<
	GlobalDebugApi,
	'labels' | 'nodeIds' | 'positions'
> & {
	/** Current aggregation (rebuilt on every relayout). */
	agg: () => Aggregation | null;
};

/** Build the documented handle from the page's live accessors. */
export function createGlobalDebug(deps: GlobalDebugDeps): GlobalDebugApi {
	return {
		setLevel: deps.setLevel,
		setLayoutMode: deps.setLayoutMode,
		select: deps.select,
		selection: deps.selection,
		metrics: deps.metrics,
		relayout: deps.relayout,
		layout: deps.layout,
		elkAvailable: deps.elkAvailable,
		fit: deps.fit,
		focus: deps.focus,
		center: deps.center,
		openLocal: deps.openLocal,
		level: deps.level,
		labels: () => (deps.agg()?.nodes ?? []).map((n) => ({ id: n.id, name: n.name, label: n.label })),
		nodeIds: () => (deps.agg()?.nodes ?? []).map((n) => n.id),
		positions: () =>
			(deps.agg()?.nodes ?? []).map((n) => ({
				id: n.id,
				x: n.x ?? 0,
				y: n.y ?? 0,
				w: n.hw * 2,
				h: n.hh * 2
			})),
		screenPos: deps.screenPos
	};
}
