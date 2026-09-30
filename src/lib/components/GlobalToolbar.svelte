<script lang="ts">
	/**
	 * Global density toolbar: layout/level switches, re-layout/fit/help, search,
	 * outline collapse toggle and the live metrics readout.
	 *
	 * Presentation only — the page owns the state and reports every action back
	 * through callback props.
	 */
	import { LEVELS, type Level } from '$lib/global/aggregate';
	import type { GlobalMetrics, LayoutMode } from '$lib/global/layout';

	let {
		layoutMode,
		elkAvailable,
		elkPrecomputeMs,
		level,
		searchCount,
		outlineCollapsed,
		sizeByDegree,
		metrics,
		onsetlayoutmode,
		onsetlevel,
		ontogglesizedegree,
		onrelayout,
		onfit,
		ontogglehelp,
		onsearch,
		ontoggleoutline
	}: {
		layoutMode: LayoutMode;
		elkAvailable: boolean;
		elkPrecomputeMs: number;
		level: Level;
		searchCount: string;
		outlineCollapsed: boolean;
		sizeByDegree: boolean;
		metrics: GlobalMetrics | null;
		onsetlayoutmode: (mode: LayoutMode) => void;
		onsetlevel: (level: Level) => void;
		ontogglesizedegree: (value: boolean) => void;
		onrelayout: () => void;
		onfit: () => void;
		ontogglehelp: () => void;
		onsearch: (event: Event) => void;
		ontoggleoutline: () => void;
	} = $props();
</script>

<div class="toolbar">
	<div class="group">
		<span class="title">layout</span>
		<button
			class:active={layoutMode === 'd3-force'}
			onclick={() => onsetlayoutmode('d3-force')}
			title="live d3-force in a Web Worker (symbol ≈ 6 s)">d3-force</button
		>
		<button
			class:active={layoutMode === 'elk-stress'}
			disabled={!elkAvailable}
			onclick={() => onsetlayoutmode('elk-stress')}
			title={elkAvailable
				? `precomputed ELK stress (symbol only, offline ${elkPrecomputeMs} ms) — instant load`
				: 'precomputed layout missing — run bun run precompute:elk'}>elk-stress</button
		>
	</div>
	<div class="group">
		<span class="title">level</span>
		{#each LEVELS as lv (lv)}
			<button class:active={level === lv} onclick={() => onsetlevel(lv)}>{lv}</button>
		{/each}
	</div>
	<div class="group">
		<label class="toggle" title="node size reflects call degree — in + out">
			<input
				type="checkbox"
				checked={sizeByDegree}
				onchange={(event) => ontogglesizedegree((event.currentTarget as HTMLInputElement).checked)}
			/>
			size by degree
		</label>
	</div>
	<div class="group">
		<button onclick={onrelayout} title="re-run d3-force live in the worker">re-layout</button>
		<button onclick={onfit} title="fit graph to view">fit</button>
		<button onclick={ontogglehelp} title="keyboard shortcuts (?)">?</button>
	</div>
	<div class="group">
		<input
			type="search"
			placeholder="search name / file / id"
			autocomplete="off"
			oninput={onsearch}
		/>
		<span class="search-count">{searchCount}</span>
	</div>
	<div class="group right">
		<button
			class="collapse-toggle"
			title={outlineCollapsed ? 'show outline' : 'hide outline'}
			aria-label={outlineCollapsed ? 'show outline' : 'hide outline'}
			aria-expanded={!outlineCollapsed}
			onclick={ontoggleoutline}
		>
			{outlineCollapsed ? '»' : '«'}
		</button>
	</div>
	{#if metrics}
		<div class="metrics">
			<b>{metrics.level}</b> · <b>{metrics.source}</b> · nodes <b>{metrics.nodes}</b> · edges
			<b>{metrics.edges}</b> · ms <b>{metrics.ms}</b> · overlap
			<b>{metrics.nodeOverlapRatio}</b> · fill <b>{metrics.fillNet}</b>
			{#if metrics.precomputeMs !== undefined}
				· precomputed <b>{metrics.precomputeMs}ms</b>
			{/if}
		</div>
	{/if}
</div>

<style>
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

	.group.right {
		margin-left: auto;
	}

	.collapse-toggle {
		min-width: 28px;
		font-size: 13px;
		line-height: 1;
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

	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	button:disabled:hover {
		border-color: #2a3340;
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

	.toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #d5dde8;
		cursor: pointer;
		user-select: none;
	}

	.toggle input {
		width: auto;
		padding: 0;
		border: none;
		background: none;
		accent-color: #ffd54a;
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
</style>
