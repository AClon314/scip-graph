/**
 * Selector resolution.
 *
 * Order (ambiguous hits are never silently resolved):
 *   1. `file:line` — exact node id;
 *   2. `file` — every node in that file (supports `*` / `?` globs);
 *   3. `name` — exact match, then case-insensitive substring.
 */

import {
  SelectorError,
  describeNode,
  getNode,
  type GraphIndex,
  type NodeSummary,
} from './graph';
import type { SgNode } from '../graph/schema';

/** Does the query contain glob metacharacters (`*` / `?` only)? */
export function hasGlobMagic(query: string): boolean {
  return /[*?]/.test(query);
}

/** glob → RegExp: `*` does not cross `/`, `**` does, `?` matches one non-`/` char. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      source += '.*';
      index += 1;
      if (glob[index + 1] === '/') index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Resolve a selector → node ids (sorted by file/line). Throws `SelectorError`
 * with `invalid` / `not-found` / `ambiguous`.
 */
export function resolveSelector(graph: GraphIndex, selector: string): string[] {
  const query = typeof selector === 'string' ? selector.trim() : '';
  if (query === '') throw new SelectorError('invalid', query, [], '选择器为空');
  if (graph.nodeById.has(query)) return [query];
  const byFile = resolveByFile(graph, query);
  if (byFile) return byFile;
  return resolveByName(graph, query);
}

function resolveByFile(graph: GraphIndex, query: string): string[] | null {
  const exact = graph.nodes.filter((node) => node.file === query);
  if (exact.length > 0) return sortNodes(exact, (node) => node.file).map((node) => node.id);
  if (!hasGlobMagic(query)) return null;
  const pattern = globToRegExp(query);
  const matched = graph.nodes.filter((node) => pattern.test(node.file));
  if (matched.length === 0) return null;
  return sortNodes(matched, (node) => node.file).map((node) => node.id);
}

function resolveByName(graph: GraphIndex, query: string): string[] {
  const exactIds = graph.nameIndex.get(query) ?? [];
  if (exactIds.length === 1) return exactIds;
  if (exactIds.length > 1) throw ambiguousError(graph, query, exactIds, '精确');
  const lower = query.toLowerCase();
  const substring = graph.nodes.filter((node) => node.name.toLowerCase().includes(lower));
  if (substring.length === 0) {
    throw new SelectorError('not-found', query, [], `选择器 "${query}" 没有命中任何节点`);
  }
  const ids = sortNodes(substring, (node) => node.name).map((node) => node.id);
  if (ids.length > 1) throw ambiguousError(graph, query, ids, '子串');
  return ids;
}

function sortNodes(nodes: SgNode[], keyOf: (node: SgNode) => string): SgNode[] {
  return [...nodes].sort(
    (left, right) =>
      keyOf(left).localeCompare(keyOf(right)) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.id.localeCompare(right.id),
  );
}

function ambiguousError(
  graph: GraphIndex,
  query: string,
  ids: string[],
  mode: string,
): SelectorError {
  const candidates: NodeSummary[] = ids.map((id) => describeNode(getNode(graph, id)));
  const listed = candidates.map((item) => `${item.name} (${item.file}:${item.line})`);
  return new SelectorError(
    'ambiguous',
    query,
    candidates,
    `选择器 "${query}"（${mode}匹配）有歧义，命中 ${ids.length} 个：${listed.join(' | ')}`,
  );
}
