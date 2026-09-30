<script lang="ts">
	import type { SgGraph } from '$lib/graph/schema';

	let { view, graph }: { view: string; graph: SgGraph | null } = $props();
</script>

<h1>{view}</h1>
<p class="subtitle">Placeholder view — the canvas visualization is added in a later step.</p>

{#if graph}
	<section class="counts">
		<div class="count">
			<span class="value">{graph.nodes.length.toLocaleString()}</span>
			<span class="label">nodes</span>
		</div>
		<div class="count">
			<span class="value">{graph.edges.length.toLocaleString()}</span>
			<span class="label">edges</span>
		</div>
		<div class="count">
			<span class="value">{graph.stats.svelte_nodes.toLocaleString()}</span>
			<span class="label">.svelte nodes</span>
		</div>
		<div class="count">
			<span class="value">{graph.stats.virtual_edges.toLocaleString()}</span>
			<span class="label">virtual edges</span>
		</div>
	</section>

	<details>
		<summary>Stats ({graph.schema})</summary>
		<ul>
			<li>self loops: {graph.stats.self_loops}</li>
			<li>svelte edges: {graph.stats.svelte_edges}</li>
			<li>call sites: {graph.stats.call_sites}</li>
			<li>
				kinds:
				{Object.entries(graph.stats.kinds)
					.map(([kind, count]) => `${kind} ${count}`)
					.join(', ')}
			</li>
		</ul>
	</details>
{:else}
	<p class="empty">
		No graph loaded. Run
		<code>bun run derive -- --scip &lt;index.json&gt; --out static/graph.json</code>
		then reload. You can override the path with the <code>SCIP_GRAPH_FILE</code> environment
		variable.
	</p>
{/if}

<style>
	h1 {
		margin: 0 0 0.25rem;
	}
	.subtitle {
		margin-top: 0;
		color: #6b7382;
	}
	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 1rem 0;
	}
	.count {
		display: flex;
		flex-direction: column;
		min-width: 7rem;
		padding: 0.75rem 1rem;
		background: #fff;
		border: 1px solid #d8dce3;
		border-radius: 8px;
	}
	.value {
		font-size: 1.5rem;
		font-weight: 700;
	}
	.label {
		color: #6b7382;
		font-size: 0.85rem;
	}
	code {
		background: #eef0f4;
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
	}
	.empty {
		color: #6b7382;
	}
</style>
