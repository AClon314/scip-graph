/**
 * Editor bridge for the local view.
 *
 * `PUBLIC_SCIP_GRAPH_EDITOR` (SvelteKit / Vite public env) configures the
 * "open in editor" transport. It may be either:
 *
 *   - a bare editor name resolved against {@link EDITOR_PRESETS}
 *     (`vscode`, `cursor`, `idea`, `sublime`, ...), or
 *   - a URL template containing `{file}` / `{line}` / `{column}` placeholders,
 *     e.g. `vscode://file/{file}:{line}:{column}`.
 *
 * When it is unset (or set to a disabling value such as `none` / `off`) there
 * is no editor transport. `openInEditor` then only reports the target, and the
 * caller shows a toast while `scip-graph:jump` still fires.
 *
 * Positions are 1-based. `SgNode.range.start` wins over `SgNode.line`, and the
 * column falls back to `1` when the derive step recorded no range.
 */
import { env } from '$env/dynamic/public';
import type { SgNode, SgRange } from '$lib/graph/schema';

/** A resolved 1-based source position. */
export type EditorTarget = {
	id: string;
	file: string;
	line: number;
	column: number;
	range?: SgRange;
};

/** Outcome of {@link openInEditor}. */
export type EditorResult = {
	/** Whether a transport (URL) was configured. */
	configured: boolean;
	/** Resolved editor URL, or `null` when no editor is configured. */
	url: string | null;
	target: EditorTarget;
};

/** URL templates for well-known editors (usable as a bare env value). */
export const EDITOR_PRESETS: Record<string, string> = {
	vscode: 'vscode://file/{file}:{line}:{column}',
	code: 'vscode://file/{file}:{line}:{column}',
	'vscode-insiders': 'vscode-insiders://file/{file}:{line}:{column}',
	cursor: 'cursor://file/{file}:{line}:{column}',
	idea: 'idea://open?file={file}&line={line}',
	sublime: 'subl://open?url=file://{file}&line={line}',
	none: '',
	off: '',
	false: '',
	'0': ''
};

/** Sensible fallback when the env value is set but is not a known preset/template. */
export const DEFAULT_EDITOR_TEMPLATE = 'vscode://file/{file}:{line}:{column}';

/** Raw `PUBLIC_SCIP_GRAPH_EDITOR` value (trimmed), or `null` when unset. */
export function rawEditorConfig(): string | null {
	const raw = env.PUBLIC_SCIP_GRAPH_EDITOR?.trim();
	return raw && raw.length ? raw : null;
}

/**
 * The concrete URL template in effect, or `null` when no editor is configured.
 * Bare names map to a preset; anything containing `{` is used verbatim; any
 * other non-empty value falls back to `DEFAULT_EDITOR_TEMPLATE`.
 */
export function editorTemplate(): string | null {
	const raw = rawEditorConfig();
	if (!raw) return null;
	const preset = EDITOR_PRESETS[raw.toLowerCase()];
	if (preset !== undefined) return preset.length ? preset : null;
	return raw.includes('{') ? raw : DEFAULT_EDITOR_TEMPLATE;
}

/** Whether an editor transport is configured. */
export function isEditorConfigured(): boolean {
	return editorTemplate() !== null;
}

/** Turn a node into a 1-based file/line/column target (range wins over line). */
export function editorTarget(node: SgNode): EditorTarget {
	const range = node.range;
	return {
		id: node.id,
		file: node.file,
		line: range?.start.line ?? node.line,
		column: range?.start.column ?? 1,
		...(range ? { range } : {})
	};
}

/** Substitute `{file}` / `{line}` / `{column}` in a template. */
export function renderTemplate(template: string, target: EditorTarget): string {
	return template
		.replace(/\{file\}/g, target.file)
		.replace(/\{line\}/g, String(target.line))
		.replace(/\{column\}/g, String(target.column));
}

/** Resolve the editor URL for a node, or `null` when unconfigured. */
export function resolveEditorUrl(node: SgNode): string | null {
	const template = editorTemplate();
	if (!template) return null;
	return renderTemplate(template, editorTarget(node));
}

/**
 * Open a node in the configured editor.
 *
 * Always returns the resolved target and URL so callers (and `window.__local`)
 * can inspect the data path even when no editor is installed. Navigation is
 * best-effort: a missing/unregistered scheme is ignored.
 */
export function openInEditor(node: SgNode): EditorResult {
	const target = editorTarget(node);
	const url = resolveEditorUrl(node);
	if (typeof window !== 'undefined') {
		if (url) {
			console.info('[scip-graph] openInEditor', url);
			try {
				window.location.href = url;
			} catch (err) {
				console.warn('[scip-graph] openInEditor failed', err);
			}
		} else {
			console.info('[scip-graph] openInEditor: no editor configured', target);
		}
	}
	return { configured: url !== null, url, target };
}
