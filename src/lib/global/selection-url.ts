/**
 * URL ⇄ selection synchronisation for the global density view.
 *
 * The `selected` query param is a single JSON string array of node ids (e.g.
 * `?selected=["src/lib/history.ts:139"]`). Writing uses SvelteKit `replaceState`
 * so it never navigates or spams history, and preserves every other query
 * param. Reading is tolerant: malformed JSON simply yields no selection.
 *
 * `chooseLevel` resolves which hierarchy level owns the persisted ids so a
 * reload can restore a dir / file / symbol selection to the right level.
 */

import { replaceState } from '$app/navigation';
import { type Level } from './aggregate';

/** Prefer the more specific level when an id exists at several levels (a
 * 3-segment file path is also a dir key). */
const LEVEL_PREFERENCE: readonly Level[] = ['symbol', 'file', 'dir'];

/** Parse the `selected` query param (JSON string[]); `[]` on missing/malformed. */
export function parseSelectedParam(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
	} catch {
		/* malformed JSON — treat as no selection */
	}
	return [];
}

/** Resolve which level owns the most of the given ids (falls back to symbol). */
export function chooseLevel(ids: readonly string[], sets: Record<Level, Set<string>> | null): Level {
	if (!sets) return 'symbol';
	let best: Level = 'symbol';
	let bestCount = -1;
	for (const level of LEVEL_PREFERENCE) {
		let count = 0;
		for (const id of ids) if (sets[level].has(id)) count++;
		if (count > bestCount) {
			bestCount = count;
			best = level;
		}
	}
	return bestCount > 0 ? best : 'symbol';
}

/** Mirror the ids into the URL's `selected` param (or remove it when empty). */
export function writeSelectionToUrl(ids: readonly string[]): void {
	if (typeof location === 'undefined') return;
	const url = new URL(location.href);
	if (ids.length) url.searchParams.set('selected', JSON.stringify(ids));
	else url.searchParams.delete('selected');
	replaceState(url, {});
}
