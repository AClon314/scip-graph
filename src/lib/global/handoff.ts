/**
 * Global → Local handoff: resolve any mix of symbol / file / dir ids to a
 * de-duplicated symbol list and persist it for the Local view.
 *
 * The symbol→file / symbol→dir indexes are built once per graph and reused by
 * `toSymbolIds`; the animation + navigation stay on the page (they touch the
 * live view transform).
 */

import type { SgGraph } from '$lib/graph/schema';

export const HANDOFF_KEY = 'gpen.scip.selection';
export const HANDOFF_MAX_IDS = 64;

export type SymbolMaps = {
	allSymbolIds: Set<string>;
	symbolsByFile: Map<string, string[]>;
	symbolsByDir: Map<string, string[]>;
};

/** Index symbol ids by file and by every directory prefix (once per graph). */
export function buildSymbolMaps(source: SgGraph): SymbolMaps {
	const allSymbolIds = new Set<string>();
	const symbolsByFile = new Map<string, string[]>();
	const symbolsByDir = new Map<string, string[]>();
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
	return { allSymbolIds, symbolsByFile, symbolsByDir };
}

/** Resolve any mix of symbol / file / dir ids to a de-duplicated symbol list. */
export function toSymbolIds(ids: readonly string[], maps: SymbolMaps): string[] {
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
		if (maps.allSymbolIds.has(id)) push([id]);
		else if (maps.symbolsByFile.has(id)) push(maps.symbolsByFile.get(id));
		else push(maps.symbolsByDir.get(id));
	}
	return out;
}

/** Cap the handoff at {@link HANDOFF_MAX_IDS} (the query string carries the rest). */
export function capHandoff(symbols: readonly string[]): string[] {
	return symbols.length > HANDOFF_MAX_IDS ? symbols.slice(0, HANDOFF_MAX_IDS) : [...symbols];
}

/** Persist the selection for the Local view (best-effort; storage may be unavailable). */
export function persistHandoff(ids: readonly string[]): void {
	try {
		localStorage.setItem(HANDOFF_KEY, JSON.stringify({ ids, ts: Date.now() }));
	} catch {
		/* storage unavailable — the query string still carries the ids */
	}
}
