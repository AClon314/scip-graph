<h1>scip-graph</h1>
<p>Two views over a SCIP-derived call graph.</p>
<ul>
	<li><a href="/global">Global</a> — density overview of the whole graph.</li>
	<li><a href="/local">Local</a> — butterfly view focused on a function.</li>
</ul>
<p class="hint">
	Derive a graph first: <code>bun run derive -- --scip &lt;index.json&gt; --out static/graph.json</code>
</p>

<style>
	h1 {
		margin-top: 0;
	}
	.hint code {
		background: #eef0f4;
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
	}
</style>
