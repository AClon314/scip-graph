/**
 * `repo → dir → file → symbol` outline for the global view.
 *
 * The tree is derived from the frozen `SgGraph` (no extra indexing in the
 * derive step): directories nest by path segment, every file owns its symbol
 * leaves in line order. Each node carries the number of descendant symbols so
 * the sidebar can show a count without re-walking the tree.
 *
 * Pure data helpers only — no DOM, no Svelte — so they stay unit-testable and
 * reusable (e.g. a future query command or the CLI).
 */

import type { SgGraph, SgNode } from '$lib/graph/schema';

export type OutlineKind = 'repo' | 'dir' | 'file' | 'symbol';

export type OutlineNode = {
  /** Stable unique key: `repo:/`, `dir:<path>`, `file:<path>`, `symbol:<id>`. */
  id: string;
  kind: OutlineKind;
  /** Display name (last path segment / function name). */
  label: string;
  /** Directory path, file path or symbol id depending on `kind`. */
  path: string;
  /** Owning file path (dir/repo derive it from descendants). */
  file?: string;
  /** Descendant symbol count (1 for a symbol leaf). */
  count: number;
  children: OutlineNode[];
  /** Present on `symbol` nodes only. */
  symbol?: SgNode;
};

export type OutlineIndex = {
  byId: Map<string, OutlineNode>;
  /** child node id → parent node id. */
  parent: Map<string, string>;
  /** raw symbol id (`file:line`) → symbol outline node. */
  symbolById: Map<string, OutlineNode>;
};

export type OutlineRow = { node: OutlineNode; depth: number };

const KIND_ORDER: Record<OutlineKind, number> = { repo: 0, dir: 1, file: 2, symbol: 3 };

/** Best-effort repo label from `graph.source` (never throws on unknown shapes). */
export function repoLabelFromSource(graph: SgGraph): string {
  const source = graph.source ?? {};
  for (const key of ['repo', 'root', 'project', 'name'] as const) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return 'repo';
}

/** Build the full outline tree from the frozen graph. */
export function buildOutline(graph: SgGraph): OutlineNode {
  const root: OutlineNode = {
    id: 'repo:/',
    kind: 'repo',
    label: repoLabelFromSource(graph),
    path: '',
    count: 0,
    children: []
  };
  const dirNodes = new Map<string, OutlineNode>();
  const fileNodes = new Map<string, OutlineNode>();

  function ensureDir(dirPath: string): OutlineNode {
    if (!dirPath) return root;
    const cached = dirNodes.get(dirPath);
    if (cached) return cached;
    const slash = dirPath.lastIndexOf('/');
    const name = slash >= 0 ? dirPath.slice(slash + 1) : dirPath;
    const parent = ensureDir(slash >= 0 ? dirPath.slice(0, slash) : '');
    const node: OutlineNode = {
      id: `dir:${dirPath}`,
      kind: 'dir',
      label: name,
      path: dirPath,
      count: 0,
      children: []
    };
    parent.children.push(node);
    dirNodes.set(dirPath, node);
    return node;
  }

  for (const sym of graph.nodes) {
    const file = sym.file;
    const slash = file.lastIndexOf('/');
    const dirPath = slash >= 0 ? file.slice(0, slash) : '';
    const fileName = slash >= 0 ? file.slice(slash + 1) : file;
    const dir = ensureDir(dirPath);

    let fileNode = fileNodes.get(file);
    if (!fileNode) {
      fileNode = {
        id: `file:${file}`,
        kind: 'file',
        label: fileName,
        path: file,
        file,
        count: 0,
        children: []
      };
      dir.children.push(fileNode);
      fileNodes.set(file, fileNode);
    }

    fileNode.children.push({
      id: `symbol:${sym.id}`,
      kind: 'symbol',
      label: sym.name || sym.id,
      path: sym.id,
      file,
      count: 1,
      children: [],
      symbol: sym
    });
    fileNode.count += 1;
  }

  sortAndCount(root);
  return root;
}

/** Recursively sort (dirs → files → symbols-by-line) and fill `count`. */
function sortAndCount(node: OutlineNode): number {
  if (node.kind === 'symbol') {
    node.count = 1;
    return 1;
  }
  node.children.sort((a, b) => {
    const order = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (order) return order;
    if (a.kind === 'symbol' && b.kind === 'symbol') {
      return (a.symbol?.line ?? 0) - (b.symbol?.line ?? 0);
    }
    return a.label.localeCompare(b.label);
  });
  let count = 0;
  for (const child of node.children) count += sortAndCount(child);
  node.count = count;
  return count;
}

/** Index the tree for O(1) lookups (used by selection sync and reveal). */
export function indexOutline(root: OutlineNode): OutlineIndex {
  const byId = new Map<string, OutlineNode>();
  const parent = new Map<string, string>();
  const symbolById = new Map<string, OutlineNode>();
  const stack: OutlineNode[] = [root];
  while (stack.length) {
    const node = stack.pop() as OutlineNode;
    byId.set(node.id, node);
    if (node.kind === 'symbol' && node.symbol) symbolById.set(node.symbol.id, node);
    for (const child of node.children) {
      parent.set(child.id, node.id);
      stack.push(child);
    }
  }
  return { byId, parent, symbolById };
}

/** All symbol ids under a node (the whole file/dir subtree for non-leaves). */
export function collectSymbolIds(node: OutlineNode): string[] {
  const ids: string[] = [];
  const stack: OutlineNode[] = [node];
  while (stack.length) {
    const current = stack.pop() as OutlineNode;
    if (current.kind === 'symbol' && current.symbol) ids.push(current.symbol.id);
    else for (const child of current.children) stack.push(child);
  }
  return ids.reverse();
}

/** First symbol id in document order, or `null` for an empty subtree. */
export function firstSymbolId(node: OutlineNode): string | null {
  const stack: OutlineNode[] = [node];
  while (stack.length) {
    const current = stack.pop() as OutlineNode;
    if (current.kind === 'symbol') return current.symbol?.id ?? null;
    for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]);
  }
  return null;
}

/** Ancestor node ids for a raw symbol id, nearest (file) first. */
export function ancestorsOfSymbol(index: OutlineIndex, symbolId: string): string[] {
  const symbol = index.symbolById.get(symbolId);
  if (!symbol) return [];
  const chain: string[] = [];
  let parentId = index.parent.get(symbol.id);
  while (parentId) {
    chain.push(parentId);
    parentId = index.parent.get(parentId);
  }
  return chain;
}

/** Visible nodes for a given expanded set. `forceExpand` reveals filter hits. */
export function visibleRows(
  root: OutlineNode,
  expanded: ReadonlySet<string>,
  forceExpand = false
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (node: OutlineNode, depth: number) => {
    rows.push({ node, depth });
    if (node.children.length && (forceExpand || expanded.has(node.id))) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

export type OutlineFilterResult = { tree: OutlineNode; matches: number };

function symbolMatches(node: OutlineNode, query: string): boolean {
  const symbol = node.symbol;
  const hay = `${symbol?.name ?? ''} ${symbol?.kind ?? ''} ${node.path} ${symbol?.file ?? ''} ${
    symbol?.line ?? ''
  }`.toLowerCase();
  return hay.includes(query);
}

/**
 * Prune the tree to nodes matching `query`. A directory/file that matches on
 * path keeps its entire subtree; ancestors of symbol hits are kept so matches
 * stay reachable. `matches` counts the kept symbol leaves.
 */
export function filterOutline(root: OutlineNode, query: string): OutlineFilterResult {
  const q = query.trim().toLowerCase();
  if (!q) return { tree: root, matches: root.count };

  let matches = 0;

  const visit = (node: OutlineNode): OutlineNode | null => {
    if (node.kind === 'symbol') {
      if (symbolMatches(node, q)) {
        matches += 1;
        return node;
      }
      return null;
    }
    const selfMatch = node.kind !== 'repo' && node.path.toLowerCase().includes(q);
    if (selfMatch) {
      matches += node.count;
      return node;
    }
    const children: OutlineNode[] = [];
    for (const child of node.children) {
      const kept = visit(child);
      if (kept) children.push(kept);
    }
    if (!children.length) return null;
    let count = 0;
    for (const child of children) count += child.count;
    return { ...node, children, count };
  };

  const tree = visit(root);
  return { tree: tree ?? { ...root, children: [], count: 0 }, matches };
}
