<script lang="ts">
	/**
	 * Global density view — Svelte 5 / TS port of
	 * `tmp/scip-graph-viewer/view-a/app.js`.
	 *
	 * The main thread aggregates levels, renders to canvas and handles
	 * pan/zoom/search/box-select. d3-force runs inside `layout.worker.ts`.
	 *
	 * The heavy lifting now lives in focused modules: canvas rendering
	 * (`$lib/global/render`), geometry (`$lib/global/geometry`), the layout
	 * worker + precomputed-layout helpers (`$lib/global/layout`), the Global→Local
	 * handoff (`$lib/global/handoff`), arrow-key navigation (`$lib/global/keyboard`)
	 * and the pointer/pinch gesture machine (`$lib/global/pointer`). The toolbar
	 * and shortcut overlay are components under `$lib/components`.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { SgGraph } from '$lib/graph/schema';
	import OutlineTree from '$lib/components/OutlineTree.svelte';
	import GlobalToolbar from '$lib/components/GlobalToolbar.svelte';
	import GlobalHelp from '$lib/components/GlobalHelp.svelte';
	import {
		aggregate,
		levelIdSets,
		LEVELS,
		type AggNode,
		type Aggregation,
		type Level
	} from '$lib/global/aggregate';
	import type { ElkStressLayout } from '$lib/global/elk-stress';
	import type { ForceLayout } from '$lib/global/force-cache';
	import { jumpToSource } from '$lib/global/jump';
	import {
		TICKS,
		PARAMS,
		createLayoutWorker,
		covers,
		applyPositions,
		applyPrecomputed,
		type GlobalMetrics,
		type LayoutMode,
		type LayoutWorker,
		type PositionMap
	} from '$lib/global/layout';
	import {
		boxSelectIds,
		computeFit,
		hitTest,
		selectionBounds,
		worldToScreen,
		zoomAround,
		zoomToBounds,
		type Box
	} from '$lib/global/geometry';
	import {
		HANDOFF_KEY,
		buildSymbolMaps,
		capHandoff,
		persistHandoff,
		toSymbolIds,
		type SymbolMaps
	} from '$lib/global/handoff';
	import {
		nearestInDirection,
		nearestToCenter,
		type Direction
	} from '$lib/global/keyboard';
	import { createPointerController } from '$lib/global/pointer';
	import { drawScene } from '$lib/global/render';
	import { writeSelectionToUrl } from '$lib/global/selection-url';
	import { countSelectionNeighbors } from '$lib/global/neighbors';
	import { reaggregateForSize } from '$lib/global/size-mode';
	import { applyBootstrapSelection } from '$lib/global/preselect';
	import { handleGlobalKey } from '$lib/global/keys';
	import { animateSelection } from '$lib/global/handoff-anim';
	import './global.css';
	import { createGlobalDebug, type GlobalDebugApi } from '$lib/global/debug';
	import { handleSplitterDrag } from '$lib/global/splitter';
	import { matchNodes } from '$lib/global/search';
	import { tooltipFor, type Tooltip } from '$lib/global/tooltip';

	let {
		data
	}: {
		data: {
			graph: SgGraph | null;
			elkStress: ElkStressLayout | null;
			forcePositions: ForceLayout | null;
		};
	} = $props();

	const OUTLINE_WIDTH_KEY = 'gpen.scip.outlineWidth';
	const OUTLINE_MIN_W = 200;
	const OUTLINE_MAX_W = 760;
	/** Persisted toggle: scale node rects by call degree (default on). */
	const SIZE_BY_DEGREE_KEY = 'gpen.scip.sizeByDegree';

	// --- non-reactive scene state (canvas render loop) -----------------------
	let graph = $state.raw<SgGraph | null>(null);
	let agg: Aggregation | null = null;
	let nodeById = new Map<string, AggNode>();
	let selection = new Set<string>();
	let searchMatches: Set<string> | null = null;
	let searchQuery = '';
	let hoverId: string | null = null;
	const view = { k: 1, tx: 0, ty: 0 };
	let seed = 1;
	let layoutToken = 0;
	let lastTooltipKey = '';
	/** 0..1 pulse used while a selection is elevated before navigating. */
	let elevate = 0;
	let navigating = false;
	/** Symbol→file / symbol→dir index used by the Global→Local handoff. */
	let symbolMaps: SymbolMaps = {
		allSymbolIds: new Set(),
		symbolsByFile: new Map(),
		symbolsByDir: new Map()
	};
	/** Precomputed layouts keyed by symbol id (null when absent). */
	let elkPositions: PositionMap | null = null;
	let forcePositions: PositionMap | null = null;

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let ctx: CanvasRenderingContext2D | null = null;
	let worker: LayoutWorker | null = null;
	let pointer: ReturnType<typeof createPointerController> | null = null;

	// --- reactive UI state ---------------------------------------------------
	let level = $state<Level>('dir');
	let layoutMode = $state<LayoutMode>('d3-force');
	let metrics = $state<GlobalMetrics | null>(null);
	const elkAvailable = $derived(data.elkStress !== null);
	const elkPrecomputeMs = $derived(data.elkStress?.ms ?? 0);
	let status = $state<string | null>(null);
	let toast = $state<string | null>(null);
	let selectionCount = $state(0);
	let searchCount = $state('');
	let tooltip = $state<Tooltip | null>(null);
	let selBox = $state<Box | null>(null);
	let panning = $state(false);
	let selecting = $state(false);
	let outlineCollapsed = $state(false);
	/** Sidebar width in px (drag the splitter to resize; persisted below). */
	let outlineWidth = $state(300);
	/** Size node rectangles by call degree (in + out); persisted to localStorage. */
	let sizeByDegree = $state(true);
	/** Suppresses URL writes while bootstrap applies a persisted selection. */
	let suppressUrlSync = false;
	/** Node-id sets per level, used to resolve a persisted selection's level. */
	let idsByLevel: Record<Level, Set<string>> | null = null;
	let helpOpen = $state(false);
	/** Reactive mirror of the canvas selection for the outline sidebar. */
	let selectedKeys = $state<string[]>([]);

	/**
	 * Distinct callers/callees of the current selection, computed from the live
	 * aggregation so it is correct at dir/file/symbol. `callers` are sources of
	 * incoming edges whose target is selected (source unselected); `callees` are
	 * targets of outgoing edges whose source is selected (target unselected).
	 */
	const selectionNeighbors = $derived.by(() => {
		// Read `level` so the derived re-runs whenever the aggregation is rebuilt
		// for a new level, even when the selected ids are unchanged (keepSelection).
		void level;
		return countSelectionNeighbors(agg, selectedKeys);
	});

	// -------------------------------------------------------------------------
	// helpers
	// -------------------------------------------------------------------------
	function setStatus(text: string | null) {
		status = text;
	}

	function showToast(text: string) {
		toast = text;
		setTimeout(() => {
			if (toast === text) toast = null;
		}, 2500);
	}

	// -------------------------------------------------------------------------
	// layout
	// -------------------------------------------------------------------------
	async function setLevel(
		next: Level,
		{ keepSelection = false } = {}
	): Promise<GlobalMetrics | undefined> {
		if (!LEVELS.includes(next)) throw new Error(`unknown level ${next}`);
		if (!keepSelection) selection.clear();
		// elk-stress is symbol-only; any other level falls back to live d3-force.
		if (layoutMode === 'elk-stress' && next !== 'symbol') layoutMode = 'd3-force';
		level = next;
		updateSelectionUi();
		return relayout();
	}

	/** Switch between the live worker layout and the precomputed offline layout. */
	async function setLayoutMode(mode: LayoutMode): Promise<GlobalMetrics | undefined> {
		if (mode === 'elk-stress' && !elkAvailable) return metrics ?? undefined;
		layoutMode = mode;
		if (mode === 'elk-stress' && level !== 'symbol') return setLevel('symbol');
		return relayout();
	}

	function updateSelectionUi() {
		selectionCount = selection.size;
		selectedKeys = [...selection];
		syncSelectionUrl();
	}

	async function relayout(forceLive = false): Promise<GlobalMetrics | undefined> {
		if (!graph) return;
		const token = ++layoutToken;
		agg = aggregate(graph, level, { sizeByDegree });
		nodeById = new Map(agg.nodes.map((n) => [n.id, n]));
		if (layoutMode === 'elk-stress' && level === 'symbol' && elkPositions && covers(elkPositions, agg)) {
			// Precomputed positions: no worker round-trip, no 6 s wait.
			metrics = applyPrecomputed(
				agg,
				elkPositions,
				'elk-stress',
				data.elkStress?.cleanupPasses ?? 0,
				data.elkStress?.ms
			);
			if (token !== layoutToken) return metrics ?? undefined;
			setStatus(null);
			fit();
			draw();
			return metrics ?? undefined;
		}
		if (layoutMode === 'elk-stress' && level === 'symbol') {
			layoutMode = 'd3-force';
			showToast('precomputed elk-stress layout is stale — run bun run precompute:elk');
		}
		// Cached offline d3-force symbol layout: instant, no worker. The explicit
		// re-layout button passes `forceLive` to force a fresh worker run.
		if (!forceLive && layoutMode === 'd3-force' && level === 'symbol' && forcePositions && covers(forcePositions, agg)) {
			metrics = applyPrecomputed(
				agg,
				forcePositions,
				'd3-force-cache',
				data.forcePositions?.cleanupPasses ?? 0,
				data.forcePositions?.ms
			);
			if (token !== layoutToken) return metrics ?? undefined;
			setStatus(null);
			fit();
			draw();
			return metrics ?? undefined;
		}
		setStatus(`computing ${level} layout in worker…`);
		await layoutForce(token);
		if (token !== layoutToken) return metrics ?? undefined;
		setStatus(null);
		fit();
		draw();
		return metrics ?? undefined;
	}

	async function layoutForce(token: number) {
		if (!agg || !worker) return;
		const res = await worker.run({
			nodes: agg.nodes.map((n) => ({ id: n.id, hw: n.hw, hh: n.hh })),
			edges: agg.edges.map((e) => ({ source: e.source, target: e.target, calls: e.calls })),
			ticks: TICKS[level] ?? 400,
			params: PARAMS[level] ?? PARAMS.symbol,
			seed: (seed = (seed * 1664525 + 1013904223) >>> 0)
		});
		if (token !== layoutToken) return;
		applyPositions(agg, new Map(res.positions.map((p) => [p.id, p])));
		metrics = {
			level,
			source: 'd3-force',
			nodes: agg.nodes.length,
			edges: agg.edges.length,
			ms: Math.round(res.ms * 100) / 100,
			nodeOverlapRatio: res.overlapRatio,
			nodeOverlapPairs: res.overlapsAfter,
			fillNet: Math.round(res.fillNet * 1e4) / 1e4,
			cleanupPasses: res.cleanupPasses,
			overlapsBeforeCleanup: res.overlapsBefore,
			overlapsAfterCleanup: res.overlapsAfter
		};
	}

	function fit() {
		if (!canvasEl || !agg || !agg.nodes.length) return;
		const next = computeFit(agg, canvasEl.clientWidth, canvasEl.clientHeight);
		view.k = next.k;
		view.tx = next.tx;
		view.ty = next.ty;
	}

	/**
	 * Re-aggregate for the current `sizeByDegree` without a full relayout: reuse
	 * the existing positions, re-separate the resized rects (keeping
	 * `nodeOverlapRatio === 0`) and refresh the metrics. Falls back to a normal
	 * `relayout()` only when no positions exist yet.
	 */
	function applySizeByDegree(): void {
		if (!graph || !agg) return;
		const prev = new Map<string, { x: number; y: number }>();
		for (const n of agg.nodes) {
			if (n.x !== undefined && n.y !== undefined) prev.set(n.id, { x: n.x, y: n.y });
		}
		const next = reaggregateForSize(graph, level, sizeByDegree, prev);
		if (!next) {
			void relayout();
			return;
		}
		agg = next.agg;
		nodeById = new Map(agg.nodes.map((n) => [n.id, n]));
		const derived = next.metrics;
		if (metrics) {
			metrics = {
				...metrics,
				level,
				nodes: agg.nodes.length,
				edges: agg.edges.length,
				nodeOverlapRatio: derived.nodeOverlapRatio,
				nodeOverlapPairs: derived.nodeOverlapPairs,
				fillNet: Math.round(derived.fillNet * 1e4) / 1e4
			};
		}
		fit();
		draw();
	}

	/** Persist and apply the size-by-degree toggle (re-aggregates in place). */
	function setSizeByDegree(value: boolean): void {
		if (value === sizeByDegree) return;
		sizeByDegree = value;
		try {
			localStorage.setItem(SIZE_BY_DEGREE_KEY, value ? '1' : '0');
		} catch {
			/* storage unavailable */
		}
		applySizeByDegree();
	}

	// -------------------------------------------------------------------------
	// rendering
	// -------------------------------------------------------------------------
	function resize() {
		if (!canvasEl) return;
		ctx = canvasEl.getContext('2d');
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const cw = canvasEl.clientWidth;
		const ch = canvasEl.clientHeight;
		canvasEl.width = Math.round(cw * dpr);
		canvasEl.height = Math.round(ch * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		draw();
	}

	function draw() {
		if (!ctx || !canvasEl) return;
		drawScene(ctx, canvasEl, {
			agg,
			nodeById,
			view,
			selection,
			searchQuery,
			searchMatches,
			hoverId,
			elevate,
			level
		});
	}

	// -------------------------------------------------------------------------
	// selection / handoff
	// -------------------------------------------------------------------------
	function select(ids: string[]): string[] {
		selection.clear();
		for (const id of ids || []) {
			if (nodeById.has(id)) selection.add(id);
		}
		updateSelectionUi();
		draw();
		return [...selection];
	}

	function selectionIds(): string[] {
		return [...selection];
	}

	/**
	 * Mirror the current selection into the URL's `selected` query param (a JSON
	 * string array). The write is skipped while bootstrap is applying a persisted
	 * selection; `writeSelectionToUrl` preserves every other query param.
	 */
	function syncSelectionUrl(): void {
		if (suppressUrlSync) return;
		writeSelectionToUrl([...selection]);
	}

	// --- focus / centering ---------------------------------------------------
	function centerOn(id: string, zoom?: number): boolean {
		const node = nodeById.get(id);
		if (!node || !canvasEl) return false;
		const cw = canvasEl.clientWidth;
		const ch = canvasEl.clientHeight;
		const k = zoom ?? Math.max(view.k, 0.6);
		view.k = k;
		view.tx = cw / 2 - (node.x ?? 0) * k;
		view.ty = ch / 2 - (node.y ?? 0) * k;
		draw();
		return true;
	}

	/** Zoom the viewport to frame the current selection (with a little padding). */
	function focusSelection(pad = 120): void {
		if (!canvasEl) return;
		const bounds = selectionBounds(selection, nodeById);
		if (!bounds) return;
		// Inflate tiny selections so a single small node is not blown up to max zoom.
		const target = zoomToBounds(
			{ ...bounds, w: Math.max(bounds.w, 240), h: Math.max(bounds.h, 160) },
			canvasEl.clientWidth,
			canvasEl.clientHeight,
			pad
		);
		view.k = target.k;
		view.tx = target.tx;
		view.ty = target.ty;
	}

	/** Select + centre a node, switching to the level that owns its id. */
	async function focus(id: string): Promise<boolean> {
		if (!id) return false;
		if (!nodeById.has(id)) {
			// Symbol ids carry a `:line` suffix; everything else is file/dir.
			const wanted: Level = id.includes(':') ? 'symbol' : 'file';
			if (level !== wanted) await setLevel(wanted);
			if (!nodeById.has(id)) return false;
		}
		select([id]);
		centerOn(id);
		return true;
	}

	async function focusSymbol(id: string): Promise<void> {
		if (!nodeById.has(id) || level !== 'symbol') await setLevel('symbol');
		await focus(id);
	}

	async function focusFile(fileId: string): Promise<void> {
		if (!nodeById.has(fileId) || level !== 'file') await setLevel('file', { keepSelection: true });
		if (nodeById.has(fileId)) {
			select([fileId]);
			centerOn(fileId);
		}
	}

	// --- Global → Local handoff ---------------------------------------------
	function hitTestAt(sx: number, sy: number): AggNode | null {
		return agg ? hitTest(agg, view, sx, sy) : null;
	}

	/** Persist the selection and navigate to Local, with a short pre-animation. */
	function openLocal(ids?: string[]): void {
		if (navigating) return;
		const symbols = toSymbolIds(ids ?? [...selection], symbolMaps);
		if (!symbols.length) return;
		const capped = capHandoff(symbols);
		persistHandoff(capped);
		navigating = true;
		void animateSelection(
			{
				view,
				selection,
				nodeById,
				canvas: canvasEl,
				draw,
				setElevate: (value) => (elevate = value)
			},
			() => {
				void goto('/local?ids=' + capped.join(','))
					.catch(() => undefined)
					.finally(() => {
						navigating = false;
					});
			}
		);
	}

	// --- keyboard navigation -------------------------------------------------
	function zoomBy(factor: number): void {
		if (!canvasEl) return;
		const next = zoomAround(view, canvasEl.clientWidth / 2, canvasEl.clientHeight / 2, factor);
		view.k = next.k;
		view.tx = next.tx;
		view.ty = next.ty;
		draw();
	}

	function fitView(): void {
		fit();
		draw();
	}

	/** Move the single selection to the nearest node in `dir` (aligned-bias). */
	function moveSelection(dir: Direction): void {
		if (!agg || !agg.nodes.length) return;
		let current: AggNode | undefined;
		if (selection.size === 1) current = nodeById.get([...selection][0]);
		if (!current) {
			current =
				nearestToCenter(agg, view, canvasEl?.clientWidth ?? 0, canvasEl?.clientHeight ?? 0) ??
				undefined;
		}
		if (!current) return;
		const best = nearestInDirection(agg, current, dir);
		if (best) {
			select([best.id]);
			centerOn(best.id, Math.max(view.k, 0.5));
		}
	}

	function focusOutlineSearch(): void {
		const input = document.getElementById('outline-search-input') as HTMLInputElement | null;
		input?.focus();
		input?.select();
	}

	function jumpCurrent(): void {
		const id = selection.size ? [...selection][0] : null;
		const node = id ? nodeById.get(id) : null;
		if (!node) {
			showToast('no selection to jump from');
			return;
		}
		const target = jumpToSource(node);
		showToast(
			target
				? `jump → ${target.file}:${target.line}:${target.column}`
				: `no source range for ${node.label}`
		);
	}

	function onKeyDown(event: KeyboardEvent): void {
		handleGlobalKey(event, {
			helpOpen: () => helpOpen,
			closeHelp: () => (helpOpen = false),
			hasSelection: () => selection.size > 0,
			clearSelection: () => {
				select([]);
				draw();
			},
			moveSelection,
			zoomBy,
			fitView,
			focusSearch: focusOutlineSearch,
			toggleHelp: () => (helpOpen = !helpOpen),
			openLocal: () => {
				if (selection.size) openLocal([...selection]);
			},
			jumpCurrent
		});
	}

	// -------------------------------------------------------------------------
	// interaction
	// -------------------------------------------------------------------------
	function showTooltip(node: AggNode, clientX: number, clientY: number) {
		if (!canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const x = clientX - rect.left + 14;
		const y = clientY - rect.top + 14;
		if (node.id === lastTooltipKey) {
			tooltip = { ...(tooltip as Tooltip), x, y };
			return;
		}
		lastTooltipKey = node.id;
		tooltip = tooltipFor(node, level, x, y);
	}

	function hideTooltip() {
		tooltip = null;
		lastTooltipKey = '';
	}

	/** Drag the tree/canvas divider; width is clamped and persisted on release. */
	function splitterOptions() {
		return {
			getWidth: () => outlineWidth,
			setWidth: (width: number) => (outlineWidth = width),
			min: OUTLINE_MIN_W,
			max: OUTLINE_MAX_W,
			storageKey: OUTLINE_WIDTH_KEY
		};
	}

	function onContextMenu(event: MouseEvent) {
		event.preventDefault();
		if (!canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const node = hitTestAt(event.clientX - rect.left, event.clientY - rect.top);
		if (!node) return;
		const target = jumpToSource(node);
		showToast(
			target
				? `jump → ${target.file}:${target.line}:${target.column}`
				: `no source range for ${node.label}`
		);
	}

	function finalizeBoxSelect(rect: Box) {
		if (!agg) return;
		select(boxSelectIds(agg, view, rect));
	}

	// -------------------------------------------------------------------------
	// search
	// -------------------------------------------------------------------------
	function onSearchInput(event: Event) {
		const q = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase();
		searchQuery = q;
		if (!q || !agg) {
			searchMatches = null;
			searchCount = '';
		} else {
			searchMatches = matchNodes(agg, level, q);
			searchCount = `${searchMatches.size} match`;
		}
		draw();
	}

	// -------------------------------------------------------------------------
	// bootstrap
	// -------------------------------------------------------------------------
	async function bootstrap() {
		const params = new URLSearchParams(location.search);
		let handoff: string[] | null = null;
		try {
			const saved = JSON.parse(localStorage.getItem(HANDOFF_KEY) || 'null');
			if (saved && Array.isArray(saved.ids) && saved.ids.length) handoff = saved.ids;
		} catch {
			/* ignore malformed handoff */
		}
		// Suppress URL writes while applying the persisted selection, then
		// normalise once at the end so a stale `selected` is never left behind.
		suppressUrlSync = true;
		try {
			await applyBootstrapSelection({
				selectedParam: params.get('selected'),
				idsParam: params.get('ids'),
				handoff,
				levelSets: idsByLevel,
				setLevel,
				selectExisting: (ids) => select(ids.filter((id) => nodeById.has(id))),
				focusSelection,
				fit,
				draw
			});
		} finally {
			suppressUrlSync = false;
		}
		syncSelectionUrl();
	}

	onMount(() => {
		graph = data.graph;
		if (graph) {
			symbolMaps = buildSymbolMaps(graph);
			idsByLevel = levelIdSets(graph);
		}
		if (data.elkStress) {
			elkPositions = new Map(data.elkStress.positions.map((p) => [p.id, p]));
		}
		if (data.forcePositions) {
			forcePositions = new Map(data.forcePositions.positions.map((p) => [p.id, p]));
		}
		try {
			const savedWidth = Number(localStorage.getItem(OUTLINE_WIDTH_KEY));
			if (
				Number.isFinite(savedWidth) &&
				savedWidth >= OUTLINE_MIN_W &&
				savedWidth <= OUTLINE_MAX_W
			) {
				outlineWidth = savedWidth;
			}
			const savedSize = localStorage.getItem(SIZE_BY_DEGREE_KEY);
			if (savedSize !== null) sizeByDegree = savedSize !== '0';
		} catch {
			/* storage unavailable */
		}
		if (!canvasEl) return;
		ctx = canvasEl.getContext('2d');

		worker = createLayoutWorker(
			new URL('../../lib/global/layout.worker.ts', import.meta.url)
		);

		pointer = createPointerController({
			canvas: () => canvasEl,
			view,
			draw,
			select: (ids) => {
				select(ids);
			},
			hitTest: hitTestAt,
			selectionSize: () => selection.size,
			showTooltip,
			hideTooltip,
			setPanning: (value) => (panning = value),
			setSelecting: (value) => (selecting = value),
			setSelBox: (box) => (selBox = box),
			setHoverId: (id) => (hoverId = id),
			finalizeBoxSelect
		});
		pointer.attach(canvasEl);

		window.addEventListener('resize', resize);
		window.addEventListener('keydown', onKeyDown);
		const resizeObserver = new ResizeObserver(() => resize());
		resizeObserver.observe(canvasEl);

		const handle = createGlobalDebug({
			setLevel,
			setLayoutMode,
			select,
			selection: selectionIds,
			metrics: () => metrics,
			relayout,
			layout: () => layoutMode,
			elkAvailable: () => elkAvailable,
			fit: () => {
				fit();
				draw();
			},
			focus: (id) => focus(id),
			center: (id) => centerOn(id),
			openLocal: (ids) => openLocal(ids),
			level: () => level,
			agg: () => agg,
			screenPos: (id) => {
				const node = nodeById.get(id);
				if (!node) return null;
				const [x, y] = worldToScreen(view, node.x ?? 0, node.y ?? 0);
				return { x, y, hw: node.hw, hh: node.hh, k: view.k };
			}
		});
		(window as unknown as { __global: GlobalDebugApi }).__global = handle;

		resize();
		void bootstrap();

		return () => {
			window.removeEventListener('resize', resize);
			window.removeEventListener('keydown', onKeyDown);
			resizeObserver.disconnect();
			pointer?.detach();
			worker?.terminate();
			worker = null;
		};
	});

	onDestroy(() => {
		worker?.terminate();
		worker = null;
	});
</script>

<svelte:head>
	<title>Global density · scip-graph</title>
</svelte:head>

<div class="workspace">
	{#if !outlineCollapsed}
		<OutlineTree
			{graph}
			width={outlineWidth}
			selected={selectedKeys}
			onselect={(ids) => {
				select(ids);
				draw();
			}}
			onfocussymbol={(id) => void focusSymbol(id)}
			onfocusfile={(id) => void focusFile(id)}
			onopenlocal={(ids) => openLocal(ids)}
		/>
		<div
			class="splitter"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize outline"
			title="drag to resize the outline"
			onpointerdown={(event) => handleSplitterDrag(event, splitterOptions())}
		></div>
	{/if}
	<div class="stage">
		<canvas
			bind:this={canvasEl}
			class:panning
			class:selecting
			oncontextmenu={onContextMenu}
		></canvas>

		<GlobalToolbar
			{layoutMode}
			{elkAvailable}
			{elkPrecomputeMs}
			{level}
			{searchCount}
			{outlineCollapsed}
			{sizeByDegree}
			{metrics}
			onsetlayoutmode={(mode) => void setLayoutMode(mode)}
			onsetlevel={(lv) => void setLevel(lv)}
			ontogglesizedegree={setSizeByDegree}
			onrelayout={() => void relayout(true)}
			onfit={() => {
				fit();
				draw();
			}}
			ontogglehelp={() => (helpOpen = !helpOpen)}
			onsearch={onSearchInput}
			ontoggleoutline={() => (outlineCollapsed = !outlineCollapsed)}
		/>

		<div class="hint">
			tap/click select · drag pan · wheel / pinch zoom · shift+drag select · / search · arrows move · Enter → Local · j jump · ? help
		</div>

		{#if tooltip}
			<div class="tooltip" style={`left:${tooltip.x}px; top:${tooltip.y}px`}>
				<div class="tt-title">{tooltip.title}</div>
				{tooltip.body}
				{#if tooltip.muted}<span class="tt-muted">{tooltip.muted}</span>{/if}
			</div>
		{/if}

		{#if selectionCount > 0}
			<div class="sel-actions">
				<div
					class="sel-status"
					title="callers: distinct nodes outside the selection that call into it · callees: distinct nodes outside the selection it calls"
				>
					callers {selectionNeighbors.callers} · callees {selectionNeighbors.callees}{selectionCount > 1
						? ` · edges ${selectionNeighbors.edges}`
						: ''}
				</div>
				<button class="jump" onclick={() => openLocal()}>→ Local ({selectionCount})</button>
			</div>
		{/if}

		{#if status}
			<div class="status">{status}</div>
		{/if}

		{#if toast}
			<div class="toast">{toast}</div>
		{/if}

		{#if selBox}
			<div
				class="selbox"
				style={`left:${selBox.x}px; top:${selBox.y}px; width:${selBox.w}px; height:${selBox.h}px`}
			></div>
		{/if}

		{#if helpOpen}
			<GlobalHelp onclose={() => (helpOpen = false)} />
		{/if}
	</div>
</div>

