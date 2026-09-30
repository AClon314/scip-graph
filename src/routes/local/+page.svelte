<script lang="ts">
	import GraphSummary from '$lib/components/GraphSummary.svelte';

	let { data } = $props();
</script>

<GraphSummary view="Local" graph={data.graph} />
