<script lang="ts">
	/**
	 * Global density view — Svelte 5 / TS port of
	 * `tmp/scip-graph-viewer/view-a/app.js`.
	 *
	 * The main thread only aggregates levels, renders to canvas and handles
	 * pan/zoom/search/box-select. d3-force runs inside `layout.worker.ts`.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { SgGraph } from '$lib/graph/schema';
	import {
		aggregate,
		LEVELS,
		type AggNode,
		type Aggregation,
		type Level
	} from '$lib/global/aggregate';
	import { rectOf } from '$lib/global/metrics';
	import type {
		LayoutParams,
		LayoutRequest,
		LayoutResponse
	} from '$lib/global/layout.worker';
	import { jumpToSource } from '$lib/global/jump';

	let { data }: { data: { graph: SgGraph | null } } = $props();

	const TICKS: Record<Level, number> = { dir: 320, file: 450, symbol: 400 };
	const PARAMS: Record<Level, LayoutParams> = {
		dir: { linkDistance: 115, linkStrength: 0.12, charge: -70, chargeDistanceMax: 900 },
		file: { linkDistance: 90, linkStrength: 0.14, charge: -48, chargeDistanceMax: 700 },
		symbol: { linkDistance: 80, linkStrength: 0.15, charge: -40, chargeDistanceMax: 600 }
	};
	const HANDOFF_KEY = 'gpen.scip.selection';

	type GlobalMetrics = {
		level: Level;
		source: string;
		nodes: number;
		edges: number;
		ms: number;
		nodeOverlapRatio: number;
		nodeOverlapPairs: number;
		fillNet: number;
		cleanupPasses: number;
		overlapsBeforeCleanup: number;
		overlapsAfterCleanup: number;
	};

	type Tooltip = { x: number; y: number; title: string; body: string; muted?: string };
	type Box = { x: number; y: number; w: number; h: number };
	type DragState = {
		mode: 'pan' | 'select';
		startX: number;
		startY: number;
		moved: boolean;
		tx: number;
		ty: number;
		selStart: [number, number];
		rect?: Box;
	};

	// --- non-reactive scene state (canvas render loop) -----------------------
	let graph: SgGraph | null = null;
	let agg: Aggregation | null = null;
	let nodeById = new Map<string, AggNode>();
	let selection = new Set<string>();
	let searchMatches: Set<string> | null = null;
	let searchQuery = '';
	let hoverId: string | null = null;
	const view = { k: 1, tx: 0, ty: 0 };
	let seed = 1;
	let layoutToken = 0;
	let drag: DragState | null = null;
	let lastTooltipKey = '';

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let ctx: CanvasRenderingContext2D | null = null;
	let worker: Worker | null = null;
	let workerSeq = 0;
	const pending = new Map<
		number,
		{ resolve: (r: LayoutResponse) => void; reject: (e: unknown) => void }
	>();

	// --- reactive UI state ---------------------------------------------------
	let level = $state<Level>('dir');
	let metrics = $state<GlobalMetrics | null>(null);
	let status = $state<string | null>(null);
	let toast = $state<string | null>(null);
	let selectionCount = $state(0);
	let searchCount = $state('');
	let tooltip = $state<Tooltip | null>(null);
	let selBox = $state<Box | null>(null);
	let panning = $state(false);
	let selecting = $state(false);

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

	function hashHue(str: string): number {
		let h = 2166136261;
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return (h >>> 0) % 360;
	}

	function colorKey(node: AggNode): string {
		if (level !== 'symbol') return node.id;
		const file = node.id.slice(0, node.id.lastIndexOf(':'));
		return file.split('/').slice(0, 3).join('/');
	}

	function nodeFill(node: AggNode, alpha = 1): string {
		const hue = hashHue(colorKey(node));
		return `hsla(${hue}, 62%, 58%, ${alpha})`;
	}

	function worldToScreen(x: number, y: number): [number, number] {
		const { k, tx, ty } = view;
		return [x * k + tx, y * k + ty];
	}

	// -------------------------------------------------------------------------
	// worker
	// -------------------------------------------------------------------------
	function runWorker(payload: Omit<LayoutRequest, 'token'>): Promise<LayoutResponse> {
		return new Promise((resolve, reject) => {
			if (!worker) {
				reject(new Error('layout worker not ready'));
				return;
			}
			const token = ++workerSeq;
			pending.set(token, { resolve, reject });
			worker.postMessage({ token, ...payload });
		});
	}

	// -------------------------------------------------------------------------
	// layout
	// -------------------------------------------------------------------------
	async function setLevel(next: Level, { keepSelection = false } = {}): Promise<GlobalMetrics | undefined> {
		if (!LEVELS.includes(next)) throw new Error(`unknown level ${next}`);
		if (!keepSelection) selection.clear();
		level = next;
		updateSelectionUi();
		return relayout();
	}

	function updateSelectionUi() {
		selectionCount = selection.size;
	}

	async function relayout(): Promise<GlobalMetrics | undefined> {
		if (!graph) return;
		const token = ++layoutToken;
		agg = aggregate(graph, level);
		nodeById = new Map(agg.nodes.map((n) => [n.id, n]));
		setStatus(`computing ${level} layout in worker…`);
		await layoutForce(token);
		if (token !== layoutToken) return metrics ?? undefined;
		setStatus(null);
		fit();
		draw();
		return metrics ?? undefined;
	}

	function applyPositions(positions: LayoutResponse['positions']) {
		if (!agg) return;
		const pos = new Map(positions.map((p) => [p.id, p]));
		for (const node of agg.nodes) {
			const p = pos.get(node.id);
			if (p) {
				node.x = p.x;
				node.y = p.y;
			}
		}
	}

	async function layoutForce(token: number) {
		if (!agg) return;
		const res = await runWorker({
			nodes: agg.nodes.map((n) => ({ id: n.id, hw: n.hw, hh: n.hh })),
			edges: agg.edges.map((e) => ({ source: e.source, target: e.target, calls: e.calls })),
			ticks: TICKS[level] ?? 400,
			params: PARAMS[level] ?? PARAMS.symbol,
			seed: (seed = (seed * 1664525 + 1013904223) >>> 0)
		});
		if (token !== layoutToken) return;
		applyPositions(res.positions);
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
		const cw = canvasEl.clientWidth;
		const ch = canvasEl.clientHeight;
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
		view.k = k;
		view.tx = cw / 2 - ((lx + rx) / 2) * k;
		view.ty = ch / 2 - ((ty + by) / 2) * k;
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

	function edgeScreenWidth(calls: number): number {
		return Math.min(4, 0.6 + Math.log2(1 + calls) * 0.7);
	}

	function draw() {
		if (!ctx || !canvasEl) return;
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
			const [ax, ay] = worldToScreen(a.x ?? 0, a.y ?? 0);
			const [bx, by] = worldToScreen(b.x ?? 0, b.y ?? 0);
			const active =
				selection.size > 0 &&
				(selection.has(edge.source) || selection.has(edge.target));
			const dim =
				!!searchQuery &&
				!searchMatches?.has(edge.source) &&
				!searchMatches?.has(edge.target);
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
			const [sx, sy] = worldToScreen(node.x ?? 0, node.y ?? 0);
			const w = node.hw * 2 * k;
			const h = node.hh * 2 * k;
			const rx = sx - w / 2;
			const ry = sy - h / 2;
			const selected = selection.has(node.id);
			const hovered = hoverId === node.id;
			const dim = !!searchQuery && !searchMatches?.has(node.id);
			ctx.globalAlpha = dim ? 0.12 : 1;
			ctx.fillStyle = nodeFill(node, selected ? 0.95 : 0.82);
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

	function jumpToLocal() {
		const ids = [...selection];
		if (!ids.length) return;
		localStorage.setItem(HANDOFF_KEY, JSON.stringify({ ids, ts: Date.now() }));
		goto('/local?ids=' + ids.join(','));
	}

	// -------------------------------------------------------------------------
	// interaction
	// -------------------------------------------------------------------------
	function pointerPos(event: { clientX: number; clientY: number }): [number, number] {
		if (!canvasEl) return [0, 0];
		const rect = canvasEl.getBoundingClientRect();
		return [event.clientX - rect.left, event.clientY - rect.top];
	}

	function hitTest(sx: number, sy: number): AggNode | null {
		if (!agg) return null;
		const k = view.k;
		for (let i = agg.nodes.length - 1; i >= 0; i--) {
			const node = agg.nodes[i];
			const [cx, cy] = worldToScreen(node.x ?? 0, node.y ?? 0);
			if (Math.abs(sx - cx) <= node.hw * k && Math.abs(sy - cy) <= node.hh * k) return node;
		}
		return null;
	}

	function showTooltip(node: AggNode, clientX: number, clientY: number) {
		if (!canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const x = clientX - rect.left + 14;
		const y = clientY - rect.top + 14;
		const key = node.id;
		if (key === lastTooltipKey) {
			tooltip = { ...(tooltip as Tooltip), x, y };
			return;
		}
		lastTooltipKey = key;
		if (level === 'symbol') {
			const member = node.members[0];
			tooltip = {
				x,
				y,
				title: member?.name ?? node.name ?? node.label,
				body:
					`${member?.file ?? node.file}:${member?.line ?? node.line}\n` +
					`kind ${member?.kind ?? node.kind} · degree ${node.weight}` +
					`${member?.svelte ? ' · .svelte' : ''}`
			};
		} else {
			const samples = node.members
				.slice(0, 4)
				.map((m) => m.name)
				.join(', ');
			tooltip = {
				x,
				y,
				title: node.id,
				body: `${node.weight} symbols · ${node.intraCalls} intra-group calls`,
				muted: `${samples}${node.members.length > 4 ? '…' : ''}`
			};
		}
	}

	function hideTooltip() {
		tooltip = null;
		lastTooltipKey = '';
	}

	function onPointerDown(event: PointerEvent) {
		if (!canvasEl) return;
		const [x, y] = pointerPos(event);
		const mode = event.shiftKey ? 'select' : 'pan';
		drag = {
			mode,
			startX: x,
			startY: y,
			moved: false,
			tx: view.tx,
			ty: view.ty,
			selStart: [x, y]
		};
		try {
			canvasEl.setPointerCapture(event.pointerId);
		} catch {
			/* synthetic pointer events have no active pointer to capture */
		}
		panning = mode === 'pan';
		selecting = mode === 'select';
		if (mode === 'select') selBox = { x, y, w: 0, h: 0 };
	}

	function onPointerMove(event: PointerEvent) {
		const [x, y] = pointerPos(event);
		if (drag) {
			const dx = x - drag.startX;
			const dy = y - drag.startY;
			if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
			if (drag.mode === 'pan') {
				view.tx = drag.tx + dx;
				view.ty = drag.ty + dy;
				draw();
			} else {
				const x0 = Math.min(drag.selStart[0], x);
				const y0 = Math.min(drag.selStart[1], y);
				const w = Math.abs(x - drag.selStart[0]);
				const h = Math.abs(y - drag.selStart[1]);
				drag.rect = { x: x0, y: y0, w, h };
				selBox = drag.rect;
			}
			return;
		}
		const node = hitTest(x, y);
		hoverId = node ? node.id : null;
		if (node) showTooltip(node, event.clientX, event.clientY);
		else hideTooltip();
		draw();
	}

	function onPointerUp(event: PointerEvent) {
		panning = false;
		selecting = false;
		if (drag && drag.mode === 'select' && drag.rect) {
			finalizeBoxSelect(drag.rect);
		}
		if (drag && drag.mode === 'pan' && !drag.moved) {
			// plain click clears a multi-selection
			if (selection.size > 1) select([]);
		}
		selBox = null;
		drag = null;
		try {
			canvasEl?.releasePointerCapture(event.pointerId);
		} catch {
			/* pointer already released */
		}
	}

	function onPointerCancel() {
		panning = false;
		selecting = false;
		selBox = null;
		drag = null;
	}

	function onPointerLeave() {
		if (drag) return;
		hoverId = null;
		hideTooltip();
		draw();
	}

	function onDoubleClick(event: MouseEvent) {
		const [x, y] = pointerPos(event);
		const node = hitTest(x, y);
		if (node) {
			select([node.id]);
			hideTooltip();
		}
	}

	function onContextMenu(event: MouseEvent) {
		event.preventDefault();
		const [x, y] = pointerPos(event);
		const node = hitTest(x, y);
		if (!node) return;
		const target = jumpToSource(node);
		showToast(
			target
				? `jump → ${target.file}:${target.line}:${target.column}`
				: `no source range for ${node.label}`
		);
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		const [x, y] = pointerPos(event);
		const factor = Math.exp(-event.deltaY * 0.0015);
		const k = Math.max(0.02, Math.min(40, view.k * factor));
		const wx = (x - view.tx) / view.k;
		const wy = (y - view.ty) / view.k;
		view.k = k;
		view.tx = x - wx * k;
		view.ty = y - wy * k;
		draw();
	}

	function finalizeBoxSelect(rect: Box) {
		if (!agg) return;
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
			const r = rectOf({ x: node.x ?? 0, y: node.y ?? 0, hw: node.hw, hh: node.hh });
			if (r.lx < box.rx && r.rx > box.lx && r.ty < box.by && r.by > box.ty) ids.push(node.id);
		}
		select(ids);
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
			const matches = new Set<string>();
			for (const node of agg.nodes) {
				const hay =
					level === 'symbol'
						? `${node.id} ${node.name ?? ''} ${node.kind ?? ''}`
						: node.id;
				if (hay.toLowerCase().includes(q)) matches.add(node.id);
			}
			searchMatches = matches;
			searchCount = `${matches.size} match`;
		}
		draw();
	}

	// -------------------------------------------------------------------------
	// bootstrap
	// -------------------------------------------------------------------------
	async function bootstrap() {
		const params = new URLSearchParams(location.search);
		const idsParam = params.get('ids');
		let preselected: string[] | null = idsParam ? idsParam.split(',').filter(Boolean) : null;
		if (!preselected) {
			try {
				const saved = JSON.parse(localStorage.getItem(HANDOFF_KEY) || 'null');
				if (saved && Array.isArray(saved.ids) && saved.ids.length) preselected = saved.ids;
			} catch {
				/* ignore malformed handoff */
			}
		}
		await setLevel(preselected ? 'symbol' : 'dir');
		if (preselected) {
			select(preselected.filter((id) => nodeById.has(id)));
			fit();
			draw();
		}
	}

	onMount(() => {
		graph = data.graph;
		if (!canvasEl) return;
		ctx = canvasEl.getContext('2d');

		worker = new Worker(new URL('../../lib/global/layout.worker.ts', import.meta.url), {
			type: 'module'
		});
		worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
			const entry = pending.get(event.data.token);
			if (!entry) return;
			pending.delete(event.data.token);
			entry.resolve(event.data);
		};
		worker.onerror = (err) => {
			for (const entry of pending.values()) entry.reject(err);
			pending.clear();
			setStatus(`worker error: ${err.message}`);
		};

		canvasEl.addEventListener('wheel', onWheel, { passive: false });
		window.addEventListener('resize', resize);

		const handle = {
			setLevel,
			select,
			selection: selectionIds,
			metrics: () => metrics,
			relayout,
			fit: () => {
				fit();
				draw();
			},
			labels: () =>
				(agg?.nodes ?? []).map((n) => ({ id: n.id, name: n.name, label: n.label })),
			nodeIds: () => (agg?.nodes ?? []).map((n) => n.id),
			screenPos: (id: string) => {
				const node = nodeById.get(id);
				if (!node) return null;
				const [x, y] = worldToScreen(node.x ?? 0, node.y ?? 0);
				return { x, y, hw: node.hw, hh: node.hh, k: view.k };
			}
		};
		(window as unknown as { __global: typeof handle }).__global = handle;

		resize();
		void bootstrap();

		return () => {
			window.removeEventListener('resize', resize);
			canvasEl?.removeEventListener('wheel', onWheel);
			worker?.terminate();
			worker = null;
			pending.clear();
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

<div class="stage">
	<canvas
		bind:this={canvasEl}
		class:panning
		class:selecting
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerCancel}
		onpointerleave={onPointerLeave}
		ondblclick={onDoubleClick}
		oncontextmenu={onContextMenu}
	></canvas>

	<div class="toolbar">
		<div class="group">
			<span class="title">level</span>
			{#each LEVELS as lv (lv)}
				<button class:active={level === lv} onclick={() => setLevel(lv)}>{lv}</button>
			{/each}
		</div>
		<div class="group">
			<button onclick={() => relayout()} title="re-run d3-force in the worker">re-layout</button>
			<button
				onclick={() => {
					fit();
					draw();
				}}
				title="fit graph to view">fit</button
			>
		</div>
		<div class="group">
			<input
				type="search"
				placeholder="search name / file / id"
				autocomplete="off"
				oninput={onSearchInput}
			/>
			<span class="search-count">{searchCount}</span>
		</div>
		{#if metrics}
			<div class="metrics">
				<b>{metrics.level}</b> · <b>{metrics.source}</b> · nodes <b>{metrics.nodes}</b> · edges
				<b>{metrics.edges}</b> · ms <b>{metrics.ms}</b> · overlap
				<b>{metrics.nodeOverlapRatio}</b> · fill <b>{metrics.fillNet}</b>
			</div>
		{/if}
	</div>

	<div class="hint">
		drag = pan · wheel = zoom · shift+drag = box-select · dbl-click = select · right-click = jump
	</div>

	{#if tooltip}
		<div class="tooltip" style={`left:${tooltip.x}px; top:${tooltip.y}px`}>
			<div class="tt-title">{tooltip.title}</div>
			{tooltip.body}
			{#if tooltip.muted}<span class="tt-muted">{tooltip.muted}</span>{/if}
		</div>
	{/if}

	{#if selectionCount > 0}
		<button class="jump" onclick={jumpToLocal}>→ Local ({selectionCount})</button>
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
</div>

<style>
	:global(body) {
		background: #f6f7f9;
	}

	.stage {
		position: relative;
		width: 100%;
		height: calc(100vh - 150px);
		min-height: 480px;
		overflow: hidden;
		background: #0e1116;
		border: 1px solid #2a3340;
		border-radius: 10px;
		color: #d5dde8;
		font: 12px / 1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}

	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		cursor: grab;
	}

	canvas.panning {
		cursor: grabbing;
	}

	canvas.selecting {
		cursor: crosshair;
	}

	.toolbar {
		position: absolute;
		top: 10px;
		left: 10px;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 14px;
		padding: 8px 12px;
		max-width: calc(100% - 20px);
		background: #171c24cc;
		border: 1px solid #2a3340;
		border-radius: 8px;
		backdrop-filter: blur(6px);
	}

	.group {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.title {
		color: #8b98a8;
	}

	button {
		font: inherit;
		color: #d5dde8;
		background: #212a36;
		border: 1px solid #2a3340;
		border-radius: 6px;
		padding: 3px 9px;
		cursor: pointer;
	}

	button:hover {
		border-color: #ffd54a;
	}

	button.active {
		background: #ffd54a;
		color: #1a1a1a;
		border-color: #ffd54a;
	}

	input {
		font: inherit;
		color: #d5dde8;
		background: #0e1116;
		border: 1px solid #2a3340;
		border-radius: 6px;
		padding: 3px 8px;
		width: 24ch;
	}

	input:focus {
		outline: 1px solid #ffd54a;
	}

	.search-count {
		color: #8b98a8;
		min-width: 10ch;
	}

	.metrics {
		color: #8b98a8;
		white-space: nowrap;
	}

	.metrics b {
		color: #d5dde8;
	}

	.hint {
		position: absolute;
		bottom: 10px;
		left: 10px;
		padding: 4px 8px;
		color: #8b98a8;
		background: #171c24cc;
		border: 1px solid #2a3340;
		border-radius: 6px;
	}

	.tooltip {
		position: absolute;
		z-index: 5;
		max-width: 52ch;
		padding: 7px 9px;
		background: #0b0f14f2;
		border: 1px solid #2a3340;
		border-radius: 6px;
		pointer-events: none;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.tt-title {
		color: #ffd54a;
	}

	.tt-muted {
		color: #8b98a8;
	}

	.jump {
		position: absolute;
		right: 14px;
		bottom: 14px;
		padding: 8px 14px;
		font-size: 13px;
		font-weight: 700;
		color: #1a1a1a;
		background: #ffd54a;
		border-color: #ffd54a;
	}

	.status {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		padding: 10px 16px;
		color: #d5dde8;
		background: #171c24cc;
		border: 1px solid #2a3340;
		border-radius: 8px;
	}

	.toast {
		position: absolute;
		left: 50%;
		bottom: 56px;
		transform: translateX(-50%);
		padding: 6px 12px;
		color: #1a1a1a;
		background: #ffd54a;
		border-radius: 6px;
		font-weight: 700;
	}

	.selbox {
		position: absolute;
		border: 1px dashed #ffd54a;
		background: #ffd54a22;
		pointer-events: none;
	}
</style>
