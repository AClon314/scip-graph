import { loadElkStress, loadForce, loadGraph } from '$lib/server/loadGraph';

export async function load() {
	return {
		graph: await loadGraph(),
		elkStress: await loadElkStress(),
		forcePositions: await loadForce()
	};
}
