/**
 * Preselection resolution for the global view bootstrap.
 *
 * Precedence: the `selected` JSON query param → the legacy `?ids=` param →
 * the localStorage handoff. `selected` resolves its own level from the graph's
 * node-id sets; the other two always target the symbol level (existing
 * behaviour). The caller wraps this in URL-sync suppression and normalises the
 * URL afterwards.
 */

import type { Level } from './aggregate';
import { chooseLevel, parseSelectedParam } from './selection-url';

export type BootstrapDeps = {
	selectedParam: string | null;
	idsParam: string | null;
	/** Ids restored from the localStorage handoff, or null. */
	handoff: string[] | null;
	levelSets: Record<Level, Set<string>> | null;
	setLevel: (level: Level) => Promise<unknown>;
	/** Select the subset of `ids` that exist at the current level. */
	selectExisting: (ids: readonly string[]) => void;
	focusSelection: () => void;
	fit: () => void;
	draw: () => void;
};

/** Apply the persisted selection, switching to the level that owns it. */
export async function applyBootstrapSelection(deps: BootstrapDeps): Promise<void> {
	let preselected: string[] | null = null;
	let fromSelected = false;
	if (deps.selectedParam !== null) {
		fromSelected = true;
		preselected = parseSelectedParam(deps.selectedParam);
	} else if (deps.idsParam) {
		preselected = deps.idsParam.split(',').filter(Boolean);
	} else if (deps.handoff && deps.handoff.length) {
		preselected = deps.handoff;
	}

	if (preselected && preselected.length) {
		const target: Level = fromSelected ? chooseLevel(preselected, deps.levelSets) : 'symbol';
		await deps.setLevel(target);
		deps.selectExisting(preselected);
		if (fromSelected) deps.focusSelection();
		else deps.fit();
		deps.draw();
	} else {
		await deps.setLevel('dir');
	}
}
