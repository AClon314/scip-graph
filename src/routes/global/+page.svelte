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
	import OutlineTree from '$lib/components/OutlineTree.svelte';
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
	let drag: DragState | null = null;
	let lastTooltipKey = '';
	/** 0..1 pulse used while a selection is elevated before navigating. */
	let elevate = 0;
	let navigating = false;
	/** Graph-wide symbol lookup so the Local handoff works at any level. */
	let allSymbolIds = new Set<string>();
	let symbolsByFile = new Map<string, string[]>();
	let symbolsByDir = new Map<string, string[]>();

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
	let outlineCollapsed = $state(false);
	let helpOpen = $state(false);
	/** Reactive mirror of the canvas selection for the outline sidebar. */
	let selectedKeys = $state<string[]>([]);

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
		selectedKeys = [...selection];
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
	const HANDOFF_MAX_IDS = 64;

	/** Index symbol ids by file and by every directory prefix (once per graph). */
	function buildSymbolMaps(source: SgGraph): void {
		allSymbolIds = new Set();
		symbolsByFile = new Map();
		symbolsByDir = new Map();
		for (const node of source.nodes) {
			allSymbolIds.add(node.id);
			const fileList = symbolsByFile.get(node.file);
			if (fileList) fileList.push(node.id);
			else symbolsByFile.set(node.file, [node.id]);
			const parts = node.file.split('/');
			for (let i = 1; i < parts.length; i++) {
				const dir = parts.slice(0, i).join('/');
				const list = symbolsByDir.get(dir);
				if (list) list.push(node.id);
				else symbolsByDir.set(dir, [node.id]);
			}
		}
	}

	/** Resolve any mix of symbol / file / dir ids to a de-duplicated symbol list. */
	function toSymbolIds(ids: readonly string[]): string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const push = (list: readonly string[] | undefined) => {
			if (!list) return;
			for (const id of list) {
				if (!seen.has(id)) {
					seen.add(id);
					out.push(id);
				}
			}
		};
		for (const id of ids) {
			if (allSymbolIds.has(id)) push([id]);
			else if (symbolsByFile.has(id)) push(symbolsByFile.get(id));
			else push(symbolsByDir.get(id));
		}
		return out;
	}

	function selectionBounds(): { cx: number; cy: number; w: number; h: number } | null {
		if (!agg || !selection.size) return null;
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

	function zoomToBounds(
		bounds: { cx: number; cy: number; w: number; h: number },
		pad = 90
	): { k: number; tx: number; ty: number } | null {
		if (!canvasEl) return null;
		const cw = canvasEl.clientWidth;
		const ch = canvasEl.clientHeight;
		const k = Math.max(
			0.05,
			Math.min(8, Math.min((cw - pad) / Math.max(1, bounds.w), (ch - pad) / Math.max(1, bounds.h)))
		);
		return { k, tx: cw / 2 - bounds.cx * k, ty: ch / 2 - bounds.cy * k };
	}

	/**
	 * Briefly zoom + glow the current selection so the handoff reads as a
	 * continuation rather than a jump cut. Runs `run` once the animation ends;
	 * falls back to an immediate call when there is nothing to animate.
	 */
	async function animateSelection(run: () => void): Promise<void> {
		const bounds = selectionBounds();
		const target = bounds ? zoomToBounds(bounds) : null;
		if (!target || !canvasEl) {
			run();
			return;
		}
		const start = { k: view.k, tx: view.tx, ty: view.ty };
		const dur = 240;
		const t0 = performance.now();
		await new Promise<void>((resolve) => {
			const step = (now: number) => {
				const t = Math.min(1, (now - t0) / dur);
				const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
				view.k = start.k + (target.k - start.k) * e;
				view.tx = start.tx + (target.tx - start.tx) * e;
				view.ty = start.ty + (target.ty - start.ty) * e;
				elevate = Math.sin(Math.PI * t);
				draw();
				if (t < 1) requestAnimationFrame(step);
				else {
					elevate = 0;
					draw();
					resolve();
				}
			};
			requestAnimationFrame(step);
		});
		run();
	}

	/** Persist the selection and navigate to Local, with a short pre-animation. */
	function openLocal(ids?: string[]): void {
		if (navigating) return;
		const symbols = toSymbolIds(ids ?? [...selection]);
		if (!symbols.length) return;
		const capped =
			symbols.length > HANDOFF_MAX_IDS ? symbols.slice(0, HANDOFF_MAX_IDS) : symbols;
		try {
			localStorage.setItem(HANDOFF_KEY, JSON.stringify({ ids: capped, ts: Date.now() }));
		} catch {
			/* storage unavailable — the query string still carries the ids */
		}
		navigating = true;
		void animateSelection(() => {
			void goto('/local?ids=' + capped.join(','))
				.catch(() => undefined)
				.finally(() => {
					navigating = false;
				});
		});
	}

	// --- keyboard navigation -------------------------------------------------
	function zoomBy(factor: number): void {
		if (!canvasEl) return;
		const cx = canvasEl.clientWidth / 2;
		const cy = canvasEl.clientHeight / 2;
		const k = Math.max(0.02, Math.min(40, view.k * factor));
		const wx = (cx - view.tx) / view.k;
		const wy = (cy - view.ty) / view.k;
		view.k = k;
		view.tx = cx - wx * k;
		view.ty = cy - wy * k;
		draw();
	}

	function fitView(): void {
		fit();
		draw();
	}

	/** Move the single selection to the nearest node in `dir` (aligned-bias). */
	function moveSelection(dir: 'left' | 'right' | 'up' | 'down'): void {
		if (!agg || !agg.nodes.length) return;
		let current: AggNode | undefined;
		if (selection.size === 1) current = nodeById.get([...selection][0]);
		if (!current) {
			const cx = canvasEl ? canvasEl.clientWidth / 2 : 0;
			const cy = canvasEl ? canvasEl.clientHeight / 2 : 0;
			let best = Infinity;
			for (const node of agg.nodes) {
				const [sx, sy] = worldToScreen(node.x ?? 0, node.y ?? 0);
				const d = (sx - cx) ** 2 + (sy - cy) ** 2;
				if (d < best) {
					best = d;
					current = node;
				}
			}
		}
		if (!current) return;
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
		if (best) {
			select([best.id]);
			centerOn(best.id, Math.max(view.k, 0.5));
		}
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el) return false;
		return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
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
		if (event.key === 'Escape') {
			if (helpOpen) {
				helpOpen = false;
				return;
			}
			if (isTypingTarget(event.target)) return;
			if (selection.size) {
				select([]);
				draw();
			}
			return;
		}
		if (isTypingTarget(event.target)) return;
		const key = event.key;
		if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
			event.preventDefault();
			moveSelection(
				key === 'ArrowLeft'
					? 'left'
					: key === 'ArrowRight'
						? 'right'
						: key === 'ArrowUp'
							? 'up'
							: 'down'
			);
			return;
		}
		if (key === '+' || key === '=') {
			event.preventDefault();
			zoomBy(1.2);
			return;
		}
		if (key === '-' || key === '_') {
			event.preventDefault();
			zoomBy(1 / 1.2);
			return;
		}
		if (key === '0') {
			event.preventDefault();
			fitView();
			return;
		}
		if (key === '/') {
			event.preventDefault();
			focusOutlineSearch();
			return;
		}
		if (key === '?') {
			event.preventDefault();
			helpOpen = !helpOpen;
			return;
		}
		if (key === 'Enter') {
			event.preventDefault();
			if (selection.size) openLocal([...selection]);
			return;
		}
		if (key === 'j' || key === 'J') {
			event.preventDefault();
			jumpCurrent();
		}
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
		if (graph) buildSymbolMaps(graph);
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
		window.addEventListener('keydown', onKeyDown);
		const resizeObserver = new ResizeObserver(() => resize());
		resizeObserver.observe(canvasEl);

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
			focus: (id: string) => focus(id),
			center: (id: string) => centerOn(id),
			openLocal: (ids?: string[]) => openLocal(ids),
			level: () => level,
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
			window.removeEventListener('keydown', onKeyDown);
			resizeObserver.disconnect();
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

<div class="workspace">
	{#if !outlineCollapsed}
		<OutlineTree
			{graph}
			selected={selectedKeys}
			onselect={(ids) => {
				select(ids);
				draw();
			}}
			onfocussymbol={(id) => void focusSymbol(id)}
			onfocusfile={(id) => void focusFile(id)}
			onopenlocal={(ids) => openLocal(ids)}
		/>
	{/if}
	<button
		class="outline-toggle"
		title={outlineCollapsed ? 'show outline' : 'hide outline'}
		aria-label={outlineCollapsed ? 'show outline' : 'hide outline'}
		onclick={() => (outlineCollapsed = !outlineCollapsed)}
	>
		{outlineCollapsed ? '»' : '«'}
	</button>
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
			<button onclick={() => (helpOpen = !helpOpen)} title="keyboard shortcuts (?)">?</button>
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
		drag pan · wheel zoom · shift+drag select · / search · arrows move · Enter → Local · j jump · ? help
	</div>

	{#if tooltip}
		<div class="tooltip" style={`left:${tooltip.x}px; top:${tooltip.y}px`}>
			<div class="tt-title">{tooltip.title}</div>
			{tooltip.body}
			{#if tooltip.muted}<span class="tt-muted">{tooltip.muted}</span>{/if}
		</div>
	{/if}

	{#if selectionCount > 0}
		<button class="jump" onclick={() => openLocal()}>→ Local ({selectionCount})</button>
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
		<div class="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
			<div class="help-card">
				<h3>Keyboard shortcuts</h3>
				<dl>
					<dt>← ↑ → ↓</dt><dd>move selection to nearest node</dd>
					<dt>+ / −</dt><dd>zoom in / out</dd>
					<dt>0</dt><dd>fit graph</dd>
					<dt>/</dt><dd>focus outline search</dd>
					<dt>Enter</dt><dd>open selection in Local</dd>
					<dt>j</dt><dd>jump to source</dd>
					<dt>Esc</dt><dd>clear selection / close help</dd>
					<dt>?</dt><dd>toggle this help</dd>
				</dl>
				<button onclick={() => (helpOpen = false)}>close</button>
			</div>
		</div>
	{/if}
	</div>
</div>

<style>
	:global(body) {
		background: #f6f7f9;
	}

	.workspace {
		display: flex;
		align-items: stretch;
		gap: 8px;
	}

	.workspace .stage {
		flex: 1 1 auto;
		min-width: 0;
	}

	.outline-toggle {
		align-self: flex-start;
		margin-top: 8px;
		padding: 6px 3px;
		font: inherit;
		font-size: 13px;
		line-height: 1;
		color: #8b98a8;
		background: #212a36;
		border: 1px solid #2a3340;
		border-radius: 6px;
		cursor: pointer;
	}

	.outline-toggle:hover {
		color: #ffd54a;
		border-color: #ffd54a;
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

	.help {
		position: absolute;
		inset: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #0b0f1499;
	}

	.help-card {
		min-width: 320px;
		padding: 16px 20px;
		color: #d5dde8;
		background: #171c24f2;
		border: 1px solid #2a3340;
		border-radius: 10px;
		box-shadow: 0 18px 48px #0008;
	}

	.help-card h3 {
		margin: 0 0 10px;
		color: #ffd54a;
	}

	.help-card dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 14px;
		margin: 0 0 12px;
	}

	.help-card dt {
		color: #9fd0e8;
	}

	.help-card dd {
		margin: 0;
	}
</style>
