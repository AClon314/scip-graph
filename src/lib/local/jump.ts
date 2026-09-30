/**
 * Reserved helper for a future "open in editor" jump action.
 *
 * The butterfly view only knows the frozen `SgNode` (`id` = `<file>:<line>`),
 * plus an optional `SgNode.range` when the derive step recorded one. A real
 * editor bridge (VS Code `vscode://file/...`, an LSP `window/showDocument`, a
 * custom `gpen://` protocol, ...) is intentionally *not* wired here yet.
 *
 * The data path is real: `src/routes/local/+page.svelte` binds a node context
 * action (right-click / `j` on the hovered node) that resolves the target and
 * dispatches `scip-graph:jump`. A future transport can subscribe to that event
 * or replace the body of `jumpToSource` — callers do not change.
 */
import type { SgNode, SgRange } from '$lib/graph/schema';

/** A resolved jump target (1-based line/column, matching the SCIP schema). */
export type JumpRequest = {
	/** Node id, `"<file>:<line>"`. */
	id: string;
	file: string;
	line: number;
	/** Definition range when the derive step recorded one. */
	range?: SgRange;
};

/** Event name emitted on `window` for a future editor transport to consume. */
export const JUMP_EVENT = 'scip-graph:jump';

/**
 * Resolve and announce an "open in editor" request for a node.
 *
 * Uses `SgNode.range` when available (falls back to the node line), then emits
 * `scip-graph:jump` on `window`. Returns the resolved request so callers/tests
 * can assert the data path without any editor present.
 */
export function jumpToSource(node: SgNode): JumpRequest {
	const range: SgRange | undefined = node.range;
	const request: JumpRequest = {
		id: node.id,
		file: node.file,
		line: range?.start.line ?? node.line,
		...(range ? { range } : {})
	};

	if (typeof window !== 'undefined') {
		window.dispatchEvent(new CustomEvent<JumpRequest>(JUMP_EVENT, { detail: request }));
		console.info('[scip-graph] jumpToSource', request);
	}

	return request;
}
