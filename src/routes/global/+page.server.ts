import { loadGraph } from '$lib/server/loadGraph';

export async function load() {
	return { graph: await loadGraph() };
}
