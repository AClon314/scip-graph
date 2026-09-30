<script lang="ts">
	/**
	 * Outline sidebar (`repo → dir → file → symbol`) for the global density
	 * view. Renders a filterable, collapsible tree; leaves focus the canvas and
	 * every non-leaf can hand its symbol set off to the Local view.
	 *
	 * The component is stateless with respect to the graph (rebuilt when the
	 * `graph` prop changes) and reports interactions through callback props so
	 * the page owns selection and routing.
	 */
	import { tick } from 'svelte';
	import type { SgGraph } from '$lib/graph/schema';
	import {
		ancestorsOfSymbol,
		buildOutline,
		collectSymbolIds,
		filterOutline,
		indexOutline,
		visibleRows,
		type OutlineNode
	} from '$lib/graph/outline';

	let {
		graph = null,
		selected = [],
		onselect,
		onfocussymbol,
		onfocusfile,
		onopenlocal
	}: {
		graph?: SgGraph | null;
		selected?: string[];
		onselect?: (ids: string[]) => void;
		onfocussymbol?: (id: string) => void;
		onfocusfile?: (id: string) => void;
		onopenlocal?: (ids: string[]) => void;
	} = $props();

	let query = $state('');
	let expanded = $state<Set<string>>(new Set());

	let root = $derived(graph ? buildOutline(graph) : null);
	let index = $derived(root ? indexOutline(root) : null);
	let filtered = $derived(root ? filterOutline(root, query) : null);
	let tree = $derived(filtered?.tree ?? null);
	let matches = $derived(filtered?.matches ?? 0);
	let rows = $derived(
		tree ? visibleRows(tree, expanded, query.trim().length > 0) : []
	);
	let selectedSet = $derived(new Set(selected));

	let selectedAncestors = $derived.by(() => {
		const out = new Set<string>();
		if (!index) return out;
		for (const id of selected) {
			for (const ancestor of ancestorsOfSymbol(index, id)) out.add(ancestor);
		}
		return out;
	});

	// Start with the repo and its immediate children revealed.
	let lastRoot: OutlineNode | null = null;
	$effect(() => {
		if (root && root !== lastRoot) {
			lastRoot = root;
			const next = new Set<string>([root.id]);
			for (const child of root.children) next.add(child.id);
			expanded = next;
		}
	});

	// Reveal the ancestors of a canvas/box selection.
	$effect(() => {
		const ids = selected;
		if (!ids.length || !index) return;
		let next = expanded;
		let changed = false;
		for (const id of ids) {
			for (const ancestor of ancestorsOfSymbol(index, id)) {
				if (!next.has(ancestor)) {
					if (!changed) {
						next = new Set(next);
						changed = true;
					}
					next.add(ancestor);
				}
			}
		}
		if (changed) expanded = next;
	});

	// Keep a single selected symbol visible in the list.
	$effect(() => {
		if (selected.length !== 1) return;
		const node = index?.symbolById.get(selected[0]);
		if (!node) return;
		const id = `outline-row-${node.id}`;
		void tick().then(() => {
			document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
		});
	});

	function toggle(node: OutlineNode) {
		const next = new Set(expanded);
		if (next.has(node.id)) next.delete(node.id);
		else next.add(node.id);
		expanded = next;
	}

	function allIds(node: OutlineNode, out = new Set<string>()): Set<string> {
		out.add(node.id);
		for (const child of node.children) allIds(child, out);
		return out;
	}

	function onRowClick(node: OutlineNode) {
		if (node.kind === 'symbol') {
			const id = node.symbol?.id ?? node.path;
			if (onfocussymbol) onfocussymbol(id);
			else onselect?.([id]);
			return;
		}
		if (node.kind === 'file' && onfocusfile) onfocusfile(node.path);
		toggle(node);
	}

	function openLocal(node: OutlineNode) {
		const ids = collectSymbolIds(node);
		if (ids.length) onopenlocal?.(ids);
	}

	function onFilterKey(event: KeyboardEvent) {
		const input = event.currentTarget as HTMLInputElement;
		if (event.key === 'Enter') {
			event.preventDefault();
			if (selected.length) {
				onopenlocal?.(selected);
				return;
			}
			const first = rows.find((row) => row.node.kind === 'symbol');
			if (first?.node.symbol) {
				onselect?.([first.node.symbol.id]);
				onopenlocal?.([first.node.symbol.id]);
			}
		} else if (event.key === 'Escape') {
			event.preventDefault();
			query = '';
			input.blur();
		}
	}
</script>

<aside class="outline" aria-label="Repository outline">
	<div class="head">
		<input
			id="outline-search-input"
			class="filter"
			type="search"
			placeholder="filter dir / file / symbol"
			autocomplete="off"
			bind:value={query}
			onkeydown={onFilterKey}
		/>
		<button class="tool" title="expand all" onclick={() => tree && (expanded = allIds(tree))}>
			+
		</button>
		<button
			class="tool"
			title="collapse all"
			onclick={() => (expanded = new Set(root ? [root.id] : []))}>−</button
		>
	</div>
	<div class="meta">
		{#if query.trim()}
			<span>{matches} match{matches === 1 ? '' : 'es'}</span>
		{:else if root}
			<span>{root.count} symbols</span>
		{/if}
	</div>
	<div class="rows" role="tree">
		{#each rows as row (row.node.id)}
			<div
				id={`outline-row-${row.node.id}`}
				class="row kind-{row.node.kind}"
				class:selected={row.node.kind === 'symbol' && row.node.symbol
					? selectedSet.has(row.node.symbol.id)
					: false}
				class:ancestor={row.node.kind !== 'symbol' && selectedAncestors.has(row.node.id)}
				style={`padding-left:${6 + row.depth * 13}px`}
				role="treeitem"
				aria-selected={row.node.kind === 'symbol' && row.node.symbol
					? selectedSet.has(row.node.symbol.id)
					: selectedAncestors.has(row.node.id)}
				aria-expanded={row.node.children.length
					? expanded.has(row.node.id) || query.trim().length > 0
					: undefined}
				tabindex="-1"
				onclick={() => onRowClick(row.node)}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						onRowClick(row.node);
					}
				}}
			>
				<span class="twisty">
					{#if row.node.children.length}
						{expanded.has(row.node.id) || query.trim() ? '▾' : '▸'}
					{:else}
						·
					{/if}
				</span>
				<span class="label" title={row.node.path}>{row.node.label}</span>
				{#if row.node.kind === 'symbol' && row.node.symbol}
					<span class="line">:{row.node.symbol.line}</span>
				{/if}
				<span class="count">{row.node.count}</span>
				{#if row.node.kind !== 'repo' && row.node.count > 0}
					<button
						class="open"
						title={`open ${row.node.count} symbol(s) in Local`}
						onclick={(event) => {
							event.stopPropagation();
							openLocal(row.node);
						}}>Local</button
					>
				{/if}
			</div>
		{:else}
			<p class="empty">No graph loaded.</p>
		{/each}
		{#if query.trim() && rows.length === 0}
			<p class="empty">No matches.</p>
		{/if}
	</div>
</aside>

<style>
	.outline {
		display: flex;
		flex-direction: column;
		width: 300px;
		min-width: 220px;
		height: calc(100vh - 150px);
		min-height: 480px;
		overflow: hidden;
		color: #d5dde8;
		background: #0e1116;
		border: 1px solid #2a3340;
		border-radius: 10px;
		font: 12px / 1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px;
		border-bottom: 1px solid #2a3340;
	}

	.filter {
		flex: 1;
		min-width: 0;
		font: inherit;
		color: #d5dde8;
		background: #171c24;
		border: 1px solid #2a3340;
		border-radius: 6px;
		padding: 4px 8px;
	}

	.filter:focus {
		outline: 1px solid #ffd54a;
	}

	.tool {
		font: inherit;
		width: 24px;
		height: 24px;
		color: #d5dde8;
		background: #212a36;
		border: 1px solid #2a3340;
		border-radius: 6px;
		cursor: pointer;
	}

	.tool:hover {
		border-color: #ffd54a;
	}

	.meta {
		padding: 4px 10px;
		color: #8b98a8;
		border-bottom: 1px solid #1c2530;
	}

	.rows {
		flex: 1;
		overflow: auto;
		padding: 4px 0 12px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 8px;
		cursor: pointer;
		white-space: nowrap;
	}

	.row:hover {
		background: #1a2029;
	}

	.row.selected {
		background: #3a2f0a;
		box-shadow: inset 2px 0 0 #ffd54a;
	}

	.row.ancestor {
		box-shadow: inset 2px 0 0 #6f5a1a;
	}

	.kind-repo > .label {
		color: #ffd54a;
		font-weight: 700;
	}

	.kind-dir > .label {
		color: #9fd0e8;
	}

	.kind-file > .label {
		color: #cfe0ef;
	}

	.kind-symbol > .label {
		color: #b9c4d2;
	}

	.twisty {
		width: 1ch;
		color: #8b98a8;
	}

	.label {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.line {
		color: #6f7b8a;
	}

	.count {
		margin-left: auto;
		padding: 0 4px;
		color: #6f7b8a;
		font-size: 11px;
	}

	.open {
		font: inherit;
		font-size: 10px;
		padding: 1px 5px;
		color: #1a1a1a;
		background: #ffd54a;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		opacity: 0.35;
	}

	.row:hover .open,
	.row.selected .open {
		opacity: 1;
	}

	.empty {
		padding: 12px;
		color: #8b98a8;
	}
</style>
