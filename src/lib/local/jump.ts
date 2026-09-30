/**
 * "Open in editor" bridge for the local butterfly view.
 *
 * The local view only knows the frozen `SgNode` (`id` = `<file>:<line>`) plus
 * an optional `SgNode.range`. `jumpToSource` resolves that into a 1-based
 * request, emits `scip-graph:jump` on `window`, and — when an editor transport
 * is configured via `PUBLIC_SCIP_GRAPH_EDITOR` — calls {@link openInEditor}.
 *
 * The `scip-graph:jump` event fires in both cases, so third-party listeners can
 * still react when no built-in editor is configured.
 */
import type { SgNode, SgRange } from '$lib/graph/schema';
import { isEditorConfigured, openInEditor, resolveEditorUrl } from '$lib/editor';

/** A resolved jump target (1-based line/column, matching the SCIP schema). */
export type JumpRequest = {
	/** Node id, `"<file>:<line>"`. */
	id: string;
	file: string;
	line: number;
	/** 1-based column (range start when recorded, else `1`). */
	column: number;
	/** Definition range when the derive step recorded one. */
	range?: SgRange;
	/** Resolved editor URL when an editor is configured, else `null`. */
	editorUrl: string | null;
};

/** Event name emitted on `window` for any editor transport to consume. */
export const JUMP_EVENT = 'scip-graph:jump';

/** Event name an editor can dispatch to reveal/highlight a node. */
export const FOCUS_EVENT = 'scip-graph:focus';

/** Resolve a node into a jump request without side effects. */
export function resolveJump(node: SgNode): JumpRequest {
	const range: SgRange | undefined = node.range;
	return {
		id: node.id,
		file: node.file,
		line: range?.start.line ?? node.line,
		column: range?.start.column ?? 1,
		...(range ? { range } : {}),
		editorUrl: resolveEditorUrl(node)
	};
}

/**
 * Resolve and announce an "open in editor" request for a node.
 *
 * Uses `SgNode.range` when available (falls back to the node line), emits
 * `scip-graph:jump` on `window`, and calls {@link openInEditor} when an editor
 * is configured. Returns the resolved request so callers/tests can assert the
 * data path without any editor present.
 */
export function jumpToSource(node: SgNode): JumpRequest {
	const request = resolveJump(node);

	if (typeof window !== 'undefined') {
		window.dispatchEvent(new CustomEvent<JumpRequest>(JUMP_EVENT, { detail: request }));
		if (isEditorConfigured()) {
			openInEditor(node);
		} else {
			console.info('[scip-graph] jumpToSource: no editor configured', request);
		}
	}

	return request;
}
