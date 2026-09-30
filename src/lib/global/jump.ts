/**
 * Reserved helper for the future "open in editor" jump.
 *
 * The graph schema carries a 1-based definition `range` on every `SgNode`
 * (see `$lib/graph/schema`). The global view preserves that range on symbol
 * nodes (and inside each aggregate node's `members`), so the data path for
 * jump-to-source already exists end-to-end. This module is the single seam
 * where a real editor integration will be wired in later — for now it resolves
 * the target and logs it (the caller surfaces a toast).
 *
 * Future implementations might:
 *   - POST `{ file, line, column }` to a local dev endpoint, or
 *   - open `vscode://file/<abs path>:<line>:<column>`.
 */

import type { SgRange } from '$lib/graph/schema';
import type { AggNode } from '$lib/global/aggregate';

export type JumpTarget = {
  /** Repo-relative file path. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column (defaults to 1 when no range is available). */
  column: number;
  /** Definition range when known. */
  range?: SgRange;
};

/**
 * Resolve a jump target from a node. Symbol nodes carry `range`/`file`/`line`
 * directly; aggregate (dir/file) nodes fall back to their first member that has
 * a definition range. Returns `null` when no source location is known.
 */
export function jumpToSource(node: AggNode): JumpTarget | null {
  const member = node.members?.find((m) => m.range) ?? node.members?.[0];
  const range = node.range ?? member?.range;
  const file = node.file ?? member?.file;
  const line = node.line ?? member?.line;
  if (!file || line === undefined) return null;

  const target: JumpTarget = {
    file,
    line,
    column: range?.start.column ?? 1,
    ...(range ? { range } : {}),
  };

  // TODO(jump): replace with a real editor hand-off.
  console.info(`[global] jumpToSource ${target.file}:${target.line}:${target.column}`);
  return target;
}
