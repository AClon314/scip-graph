<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { SgNode } from '$lib/graph/schema';
	import {
		buildGraphIndex,
		columnsState,
		DEFAULT_OPTIONS,
		DISPATCH_MODES,
		expand,
		SORT_MODES,
		sortColumns,
		type LocalColumn,
		type LocalGraph,
		type LocalItem,
		type LocalLink,
		type LocalOptions,
		type SortMode
	} from '$lib/local/model';
	import { createRenderer, type FocusInfo, type Renderer } from '$lib/local/render';
	import { jumpToSource } from '$lib/local/jump';
	import { isEditorConfigured, resolveEditorUrl } from '$lib/editor';
	import ShortcutHelp from '$lib/components/ShortcutHelp.svelte';

	const DEFAULT_CENTER = 'src/lib/components/areas/CodeArea.svelte:86';
	const DEFAULT_STATUS =
		'click a node to re-center · shift-click / ⊕ / “multi” to add or remove from focus · ctrl+wheel zooms · wheel scrolls a column · right-click / j jumps';

	type LocalCounts = {
		left1: number;
		left2: number;
		right1: number;
		right2: number;
		edges: number;
		invalid: number;
		unreachable: number;
	};

	type LocalDebugApi = {
		setCenter(ids: string | string[]): boolean;
		state(): {
			center: string[];
			left: string[];
			right: string[];
			left1: string[];
			left2: string[];
			right1: string[];
			right2: string[];
			sort: SortMode;
			options: LocalOptions;
			counts: LocalCounts;
		};
		setSort(mode: string): boolean;
		toggle(name: string): boolean;
		reveal(target: string): boolean;
		focus(): FocusInfo | null;
		setFocus(target: string | null): boolean;
		moveFocus(dir: 'up' | 'down' | 'left' | 'right'): FocusInfo | null;
		editorUrl(nodeOrId: SgNode | string): string | null;
		hops(enabled?: boolean): boolean;
		detail(): Array<{
			key: string;
			items: Array<{
				id: string;
				name: string;
				file: string;
				line: number;
				unreachable: boolean;
				members: string[];
				connectLine: number;
			}>;
		}>;
		nodes(): Map<string, SgNode>;
		renderer: Renderer | null;
	};

	type WindowWithDebug = Window & {
		__local?: LocalDebugApi;
		__local_ready?: boolean;
	};

	let { data } = $props();

	const graph: LocalGraph | null = $derived.by(() =>
		data.graph ? buildGraphIndex(data.graph) : null
	);

	let centerIds = $state<string[]>([]);
	let options = $state<LocalOptions>({ ...DEFAULT_OPTIONS });
	let columns = $state.raw<LocalColumn[]>([]);
	let edges = $state.raw<LocalLink[]>([]);
	let counts = $state<LocalCounts>({
		left1: 0,
		left2: 0,
		right1: 0,
		right2: 0,
		edges: 0,
		invalid: 0,
		unreachable: 0
	});
	let statusText = $state(DEFAULT_STATUS);
	let addValue = $state('');
	let multiMode = $state(false);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let shell = $state<HTMLDivElement | null>(null);
	let renderer: Renderer | null = null;
	let hoveredItem: LocalItem | null = null;
	let focusedItem: LocalItem | null = null;
	let toast = $state('');
	let showHelp = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;

	const chips = $derived(
		centerIds.map((id) => ({ id, node: graph ? (graph.nodesById.get(id) ?? null) : null }))
	);

	function validIds(ids: readonly string[]): string[] {
		if (!graph) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const raw of ids) {
			const id = String(raw).trim();
			if (!id || seen.has(id)) continue;
			if (!graph.nodesById.has(id)) continue;
			seen.add(id);
			out.push(id);
		}
		return out;
	}

	function parseIdsFromUrl(): string[] | null {
		const raw = page.url.searchParams.get('ids') ?? page.url.searchParams.get('id');
		if (!raw) return null;
		return raw.split(',');
	}

	function readSelection(): string[] | null {
		try {
			const raw = localStorage.getItem('gpen.scip.selection');
			if (!raw) return null;
			const parsed = JSON.parse(raw) as { ids?: unknown };
			return Array.isArray(parsed?.ids) ? (parsed.ids as string[]) : null;
		} catch {
			return null;
		}
	}

	function resolveInitialCenter(): string[] {
		for (const source of [parseIdsFromUrl(), readSelection(), [DEFAULT_CENTER]]) {
			if (!source) continue;
			const ids = validIds(source);
			if (ids.length) return ids;
		}
		return validIds([DEFAULT_CENTER]);
	}

	function writeCenter(): void {
		try {
			localStorage.setItem('gpen.scip.center', JSON.stringify({ ids: centerIds, ts: Date.now() }));
		} catch {
			/* storage may be unavailable */
		}
	}

	function updateCounts(): void {
		const s = columnsState(columns);
		let invalid = 0;
		for (const e of edges) if (!e.valid) invalid++;
		let unreachable = 0;
		for (const c of columns) for (const i of c.items) if (i.unreachable) unreachable++;
		counts = {
			left1: s.left1.length,
			left2: s.left2.length,
			right1: s.right1.length,
			right2: s.right2.length,
			edges: edges.length,
			invalid,
			unreachable
		};
	}

	function rebuild(keepScroll = false): void {
		if (!graph) return;
		const res = expand(graph, centerIds, options);
		columns = sortColumns(res.columns, options);
		edges = res.edges;
		if (!keepScroll) renderer?.resetScroll();
		renderer?.setData({ columns, edges });
		writeCenter();
		updateCounts();
	}

	function setCenter(ids: ArrayLike<string> | string, keepScroll = false): boolean {
		const list = typeof ids === 'string' ? [ids] : Array.from(ids);
		const next = validIds(list);
		if (!next.length) return false;
		centerIds = next;
		rebuild(keepScroll);
		return true;
	}

	function toggleCenter(id: string): boolean {
		if (!graph || !graph.nodesById.has(id)) return false;
		if (centerIds.includes(id)) {
			if (centerIds.length <= 1) return false;
			return setCenter(centerIds.filter((x) => x !== id));
		}
		return setCenter([...centerIds, id]);
	}

	function setSort(mode: string): boolean {
		if (!SORT_MODES.includes(mode as SortMode)) return false;
		options.sort = mode as SortMode;
		rebuild(true);
		return true;
	}

	const OPTION_ALIASES: Record<string, keyof LocalOptions | 'dispatch' | 'sort'> = {
		stdlib: 'hideStdlib',
		external: 'hideStdlib',
		hide_external: 'hideStdlib',
		unreachable: 'hideUnreachable',
		passthrough: 'collapsePassThrough',
		pass_through: 'collapsePassThrough',
		tree: 'treeMode',
		graph: 'treeMode',
		percall: 'perCallArrows',
		callsites: 'perCallArrows',
		file: 'showFile',
		nodefile: 'showFile'
	};

	function toggle(name: string): boolean {
		const key = OPTION_ALIASES[name] ?? (name as keyof LocalOptions);
		if (key === 'dispatch') {
			const i = DISPATCH_MODES.indexOf(options.dispatch);
			options.dispatch = DISPATCH_MODES[(i + 1) % DISPATCH_MODES.length];
		} else if (key === 'sort') {
			const i = SORT_MODES.indexOf(options.sort);
			options.sort = SORT_MODES[(i + 1) % SORT_MODES.length];
			rebuild(true);
			return true;
		} else if (key in options) {
			const k = key as boolean | 'dispatch' | 'sort';
			// toggle boolean flags only
			const current = options[k as keyof LocalOptions];
			if (typeof current !== 'boolean') return false;
			(options as unknown as Record<string, unknown>)[key] = !current;
		} else {
			return false;
		}
		const keep = key === 'dispatch' || key === 'hideUnreachable' || key === 'collapsePassThrough';
		rebuild(keep);
		return true;
	}

	function onOptionChange(key: keyof LocalOptions): void {
		if (key === 'hops') return; // pure rendering toggle; no relayout
		rebuild(key === 'showFile' || key === 'perCallArrows');
	}

	function onNodeClick(item: LocalItem, ev: MouseEvent, info: { plus: boolean }): void {
		const multi = info.plus || ev.shiftKey || ev.ctrlKey || ev.metaKey || multiMode;
		if (multi) {
			toggleCenter(item.id);
			return;
		}
		setCenter([item.id]);
	}

	function describeItem(item: LocalItem): string {
		const members =
			item.members && item.members.size
				? [...item.members].map((id) => graph?.nodesById.get(id)?.name || id)
				: [];
		const memberNote =
			members.length > 1 ? `  ↔ ${members.join(', ')}` : members.length === 1 ? `  ↔ ${members[0]}` : '';
		const unreachable = item.unreachable ? '  [unreachable]' : '';
		return `${item.node.name}  ${item.node.file}:${item.node.line}  (${item.node.kind}, w=${item.node.weight})${memberNote}${unreachable}`;
	}

	function onNodeHover(item: LocalItem | null): void {
		hoveredItem = item;
		if (!item) {
			updateStatusDefault();
			return;
		}
		statusText = `${describeItem(item)}  · j jumps`;
	}

	function updateStatusDefault(): void {
		statusText = DEFAULT_STATUS;
	}

	function addFromInput(): void {
		const raw = addValue.trim();
		if (!raw) return;
		const id = raw.replace(/^#/, '');
		if (!graph || !graph.nodesById.has(id)) {
			statusText = `unknown node id: ${id}`;
			return;
		}
		addValue = '';
		toggleCenter(id);
	}

	function resetView(): void {
		centerIds = validIds([DEFAULT_CENTER]);
		options = { ...DEFAULT_OPTIONS };
		rebuild();
	}

	function showToast(message: string, ms = 4200): void {
		toast = message;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), ms);
	}

	function setHops(on: boolean): void {
		if (options.hops === on) {
			showToast(`hops already ${on ? 'on' : 'off'}`);
			return;
		}
		options.hops = on;
		showToast(`hops ${on ? 'on' : 'off'} — semicircles where visible edges cross`);
	}

	function findNode(target: string): SgNode | null {
		if (!graph) return null;
		const t = target.trim();
		if (!t) return null;
		const direct = graph.nodesById.get(t);
		if (direct) return direct;
		const m = t.match(/^(.*):(\d+)\s*$/);
		if (m) {
			const file = m[1];
			const line = Number(m[2]);
			const exact = graph.nodes.find((n) => n.file === file && n.line === line);
			if (exact) return exact;
		}
		return graph.nodes.find((n) => n.file === t) ?? null;
	}

	function focusStatus(item: LocalItem): string {
		return `focus: ${describeItem(item)}  · enter re-centers · shift+enter adds/removes · j jumps`;
	}

	function moveFocus(dir: 'up' | 'down' | 'left' | 'right'): void {
		const it = renderer?.moveFocus(dir) ?? null;
		focusedItem = it;
		if (it) statusText = focusStatus(it);
	}

	/** Reveal/highlight a node by id or `file:line` (also `?focus=` and `scip-graph:focus`). */
	function reveal(target: string): boolean {
		const node = findNode(target);
		if (!node) {
			showToast(`reveal: no node matched “${target}”`);
			return false;
		}
		setCenter([node.id]);
		renderer?.setFocus(`C\u0000${node.id}`);
		const it = columns.find((c) => c.key === 'C')?.items.find((i) => i.id === node.id) ?? null;
		focusedItem = it;
		statusText = it ? `revealed: ${describeItem(it)}` : `revealed: ${node.name}  ${node.file}:${node.line}`;
		showToast(`revealed ${node.name} · ${node.file}:${node.line}`);
		return true;
	}

	function jumpNode(item: LocalItem | null): void {
		if (!item) {
			showToast('nothing focused to jump to — use arrow keys to focus a node');
			return;
		}
		const req = jumpToSource(item.node);
		if (isEditorConfigured() && req.editorUrl) {
			statusText = `open → ${req.editorUrl}`;
			showToast(`open in editor → ${req.editorUrl}`);
		} else {
			statusText = `no editor configured · jump → ${req.file}:${req.line} (set PUBLIC_SCIP_GRAPH_EDITOR)`;
			showToast(`no editor configured — ${req.file}:${req.line}. Set PUBLIC_SCIP_GRAPH_EDITOR.`);
		}
	}

	onMount(() => {
		if (!graph || !canvas) return;

		renderer = createRenderer(
			canvas,
			() => columns,
			() => options
		);
		renderer.setHandlers({
			onClick: onNodeClick,
			onHover: onNodeHover,
			onBackground: () => updateStatusDefault()
		});

		const fit = (): void => {
			if (!shell) return;
			const top = shell.getBoundingClientRect().top;
			shell.style.height = `${Math.max(360, window.innerHeight - top - 20)}px`;
			renderer?.resize();
		};
		fit();
		window.addEventListener('resize', fit);

		const onContextMenu = (ev: MouseEvent): void => {
			if (!canvas || !renderer) return;
			const rect = canvas.getBoundingClientRect();
			const hit = renderer.hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
			if (!hit) return;
			ev.preventDefault();
			jumpNode(hit.item);
		};

		const isTyping = (el: EventTarget | null): boolean => {
			const node = el as HTMLElement | null;
			if (!node) return false;
			const tag = node.tagName;
			return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
		};

		const onKeyDown = (ev: KeyboardEvent): void => {
			if (ev.key === 'Escape') {
				renderer?.clearFocus();
				focusedItem = null;
				showHelp = false;
				updateStatusDefault();
				return;
			}
			if (isTyping(ev.target)) return;
			switch (ev.key) {
				case 'ArrowUp':
					ev.preventDefault();
					moveFocus('up');
					break;
				case 'ArrowDown':
					ev.preventDefault();
					moveFocus('down');
					break;
				case 'ArrowLeft':
					ev.preventDefault();
					moveFocus('left');
					break;
				case 'ArrowRight':
					ev.preventDefault();
					moveFocus('right');
					break;
				case 'Enter':
					ev.preventDefault();
					if (focusedItem) {
						if (ev.shiftKey) toggleCenter(focusedItem.id);
						else setCenter([focusedItem.id]);
					}
					break;
				case '+':
				case '=':
					ev.preventDefault();
					setHops(true);
					break;
				case '-':
				case '_':
					ev.preventDefault();
					setHops(false);
					break;
				case 'j':
					ev.preventDefault();
					jumpNode(focusedItem ?? hoveredItem);
					break;
				case '/':
					ev.preventDefault();
					searchInput?.focus();
					searchInput?.select();
					break;
				case '?':
					ev.preventDefault();
					showHelp = !showHelp;
					break;
			}
		};

		const onFocusEvent = (ev: Event): void => {
			const detail = (ev as CustomEvent<unknown>).detail;
			let target: string | null = null;
			if (typeof detail === 'string') target = detail;
			else if (detail && typeof detail === 'object') {
				const d = detail as { id?: unknown; file?: unknown; line?: unknown };
				if (typeof d.id === 'string') target = d.id;
				else if (typeof d.file === 'string' && typeof d.line === 'number') target = `${d.file}:${d.line}`;
			}
			if (target) reveal(target);
		};

		canvas.addEventListener('contextmenu', onContextMenu);
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('scip-graph:focus', onFocusEvent);

		centerIds = resolveInitialCenter();
		rebuild();
		updateStatusDefault();
		renderer.start();

		const focusParam = page.url.searchParams.get('focus');
		if (focusParam) reveal(focusParam);

		const api: LocalDebugApi = {
			setCenter(ids: string | string[]): boolean {
				return setCenter(Array.isArray(ids) ? ids : [ids]);
			},
			setSort,
			toggle,
			reveal,
			focus() {
				return renderer?.focusInfo() ?? null;
			},
			setFocus(target: string | null): boolean {
				if (target === null) {
					renderer?.clearFocus();
					focusedItem = null;
					return true;
				}
				const node = findNode(target);
				if (!node) return false;
				renderer?.setFocus(`C\u0000${node.id}`);
				focusedItem = renderer?.getFocused() ?? null;
				return true;
			},
			moveFocus(dir: 'up' | 'down' | 'left' | 'right') {
				const it = renderer?.moveFocus(dir) ?? null;
				focusedItem = it;
				return renderer?.focusInfo() ?? null;
			},
			editorUrl(nodeOrId: SgNode | string): string | null {
				const node = typeof nodeOrId === 'string' ? findNode(nodeOrId) : nodeOrId;
				return node ? resolveEditorUrl(node) : null;
			},
			hops(enabled?: boolean): boolean {
				setHops(typeof enabled === 'boolean' ? enabled : !options.hops);
				return options.hops;
			},
			state() {
				return {
					center: [...centerIds],
					...columnsState(columns),
					sort: options.sort,
					options: { ...options },
					counts: { ...counts }
				};
			},
			detail() {
				return columns.map((c) => ({
					key: c.key,
					items: c.items.map((it) => ({
						id: it.id,
						name: it.node.name,
						file: it.node.file,
						line: it.node.line,
						unreachable: it.unreachable,
						members: it.members ? [...it.members] : [],
						connectLine: it.connectLine
					}))
				}));
			},
			nodes: () => graph.nodesById,
			renderer
		};
		const w = window as WindowWithDebug;
		w.__local = api;
		w.__local_ready = true;

		return () => {
			window.removeEventListener('resize', fit);
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('scip-graph:focus', onFocusEvent);
			canvas?.removeEventListener('contextmenu', onContextMenu);
			if (toastTimer) clearTimeout(toastTimer);
			renderer?.stop();
			renderer = null;
		};
	});
</script>

<svelte:head>
	<title>scip-graph · local butterfly</title>
</svelte:head>

<div class="local-app" bind:this={shell}>
	<header class="bar">
		<a class="back" href="/global" title="back to the global overview">← Global</a>
		<strong class="title">Local · butterfly</strong>

		<span class="group">
			<span class="lbl">focus</span>
			<span class="chips">
				{#each chips as chip (chip.id)}
					<span class="chip" title={chip.id}>
						<button class="chipName" onclick={() => setCenter([chip.id])}>
							{chip.node ? chip.node.name : chip.id}
						</button>
						<button
							class="chipX"
							title="remove from focus"
							disabled={centerIds.length <= 1}
							onclick={() => toggleCenter(chip.id)}>×</button
						>
					</span>
				{/each}
			</span>
			<input
				class="addInput"
				type="text"
				placeholder="add node id…"
				spellcheck="false"
				bind:value={addValue}
				bind:this={searchInput}
				onkeydown={(e) => {
					if (e.key === 'Enter') addFromInput();
				}}
			/>
			<button class="btn" title="add node to the focus set" onclick={addFromInput}>+</button>
		</span>

		<label class="group">
			<span class="lbl">sort</span>
			<select class="sel" bind:value={options.sort} onchange={() => rebuild(true)}>
				<option value="alpha">alphabetical</option>
				<option value="line">call-site line</option>
				<option value="mincross">min-crossing</option>
			</select>
		</label>

		<label class="group">
			<span class="lbl">dispatch</span>
			<select
				class="sel"
				title="yes = static+self (definitely called), maybe = virtual (uncertain), no = hide all edges"
				bind:value={options.dispatch}
				onchange={() => rebuild(true)}
			>
				<option value="all">all</option>
				<option value="yes">yes (static)</option>
				<option value="maybe">maybe (virtual)</option>
				<option value="no">no</option>
			</select>
		</label>

		<label class="group chk">
			<input type="checkbox" bind:checked={options.hideStdlib} onchange={() => onOptionChange('hideStdlib')} />
			hide stdlib/external
		</label>
		<label class="group chk">
			<input
				type="checkbox"
				bind:checked={options.hideUnreachable}
				onchange={() => onOptionChange('hideUnreachable')}
			/>
			hide unreachable
		</label>
		<label class="group chk">
			<input
				type="checkbox"
				bind:checked={options.collapsePassThrough}
				onchange={() => onOptionChange('collapsePassThrough')}
			/>
			collapse pass-through
		</label>
		<label class="group chk">
			<input type="checkbox" bind:checked={options.treeMode} onchange={() => onOptionChange('treeMode')} />
			tree mode
		</label>
		<label class="group chk">
			<input
				type="checkbox"
				bind:checked={options.perCallArrows}
				onchange={() => onOptionChange('perCallArrows')}
			/>
			per-call arrows + lines
		</label>
		<label class="group chk">
			<input type="checkbox" bind:checked={options.showFile} onchange={() => onOptionChange('showFile')} />
			name + file
		</label>
		<label class="group chk">
			<input type="checkbox" bind:checked={options.hops} onchange={() => onOptionChange('hops')} />
			hops on crossings
		</label>
		<label class="group chk">
			<input type="checkbox" bind:checked={multiMode} />
			multi (click = add/remove)
		</label>
		<button class="btn" title="reset focus and options" onclick={resetView}>reset</button>
		<button class="btn" title="keyboard shortcuts (press ?)" onclick={() => (showHelp = !showHelp)}>?</button>
	</header>

	<main class="stageWrap">
		{#if graph}
			<canvas bind:this={canvas}></canvas>
			<div class="legend">
				<span><i class="sw static"></i>static</span>
				<span><i class="sw virtual"></i>virtual (maybe)</span>
				<span><i class="sw self"></i>self</span>
				<span><i class="sw faded"></i>hidden neighbour</span>
			</div>
		{:else}
			<p class="empty">
				No graph loaded. Run
				<code>bun run derive -- --scip &lt;index.json&gt; --out static/graph.json</code>
				then reload.
			</p>
		{/if}
	</main>

	<footer class="foot">
		<span class="counts">
			focus {centerIds.length} · callers {counts.left1 + counts.left2} (L1 {counts.left1}/L2 {counts.left2}) ·
			callees {counts.right1 + counts.right2} (R1 {counts.right1}/R2 {counts.right2}) · edges {counts.edges}{counts.invalid
				? ` (${counts.invalid} filtered)`
				: ''}{counts.unreachable ? ` · ${counts.unreachable} unreachable` : ''}
		</span>
		<span class="status">{statusText}</span>
	</footer>

	{#if toast}
		<div class="toast" role="status" aria-live="polite">{toast}</div>
	{/if}

	{#if showHelp}
		<ShortcutHelp onclose={() => (showHelp = false)} />
	{/if}
</div>

<style>
	.local-app {
		display: grid;
		grid-template-rows: auto 1fr auto;
		height: calc(100dvh - 8rem);
		min-height: 360px;
		margin: -1.25rem;
		background: #0e1116;
		color: #d9e2ee;
		font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
		overflow: hidden;
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6ch 1.4ch;
		padding: 0.6lh 1.2ch;
		background: #141a22;
		border-bottom: 1px solid #232c38;
	}

	.title {
		color: #b98cff;
		letter-spacing: 0.02em;
	}

	.back {
		color: #7eaeec;
		text-decoration: none;
		border: 1px solid #232c38;
		border-radius: 5px;
		padding: 0.2lh 0.8ch;
	}

	.back:hover {
		border-color: #7eaeec;
	}

	.group {
		display: inline-flex;
		align-items: center;
		gap: 0.6ch;
	}

	.lbl {
		color: #8493a8;
		text-transform: uppercase;
		font-size: 10px;
		letter-spacing: 0.08em;
	}

	.chk {
		color: #8493a8;
		white-space: nowrap;
	}

	.chk input {
		accent-color: #b98cff;
	}

	.sel,
	.addInput,
	.btn {
		background: #0f141b;
		color: #d9e2ee;
		border: 1px solid #232c38;
		border-radius: 5px;
		padding: 0.25lh 0.8ch;
		font: inherit;
	}

	.addInput {
		width: 34ch;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
	}

	.btn {
		cursor: pointer;
	}

	.btn:hover {
		border-color: #b98cff;
		color: #fff;
	}

	.chips {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.5ch;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		background: rgba(185, 140, 255, 0.14);
		border: 1px solid rgba(185, 140, 255, 0.4);
		border-radius: 999px;
		overflow: hidden;
	}

	.chipName,
	.chipX {
		background: none;
		border: none;
		color: #e2d5ff;
		font: inherit;
		cursor: pointer;
		padding: 0.15lh 0.7ch;
	}

	.chipName:hover {
		background: rgba(185, 140, 255, 0.2);
	}

	.chipX {
		border-left: 1px solid rgba(185, 140, 255, 0.3);
		color: #ffb4c8;
	}

	.chipX:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.stageWrap {
		position: relative;
		min-height: 0;
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}

	.legend {
		position: absolute;
		left: 1.5ch;
		bottom: 1lh;
		display: flex;
		gap: 1.5ch;
		color: #8493a8;
		font-size: 11px;
		pointer-events: none;
	}

	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 0.5ch;
	}

	.sw {
		width: 14px;
		height: 3px;
		border-radius: 2px;
		display: inline-block;
	}

	.sw.static {
		background: #7eaeec;
	}

	.sw.virtual {
		background: #f0b25c;
	}

	.sw.self {
		background: #88dca4;
	}

	.sw.faded {
		background: linear-gradient(90deg, transparent, #7eaeec);
	}

	.foot {
		display: flex;
		gap: 2ch;
		align-items: baseline;
		padding: 0.5lh 1.2ch;
		background: #141a22;
		border-top: 1px solid #232c38;
		font-size: 12px;
		white-space: nowrap;
		overflow: hidden;
	}

	.counts {
		color: #8493a8;
		flex: 0 0 auto;
	}

	.status {
		color: #aebcd0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	.empty {
		color: #8493a8;
		padding: 1.5rem;
	}

	.empty code {
		background: #0f141b;
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
	}

	.toast {
		position: absolute;
		right: 1.6ch;
		bottom: 5.5lh;
		max-width: 62ch;
		padding: 0.5lh 1.2ch;
		background: rgba(20, 26, 34, 0.96);
		border: 1px solid #b98cff;
		border-radius: 7px;
		color: #e2d5ff;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
		z-index: 20;
		pointer-events: none;
	}
</style>
