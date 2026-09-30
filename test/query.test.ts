import { describe, expect, test } from 'bun:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SgEdge, SgGraph, SgNode, SgStats } from '../src/lib/graph/schema';
import {
  buildGraph,
  EXIT,
  SelectorError,
  type GraphIndex,
} from '../src/lib/query/graph';
import { globToRegExp, resolveSelector } from '../src/lib/query/select';
import { traverse } from '../src/lib/query/reach';
import { refsOf } from '../src/lib/query/refs';
import {
  buildBreakdown,
  classifyBoundary,
  collectBoundaries,
  filterBoundaries,
  symbolDisplayName,
} from '../src/lib/query/boundaries';
import { toDot, toMermaid } from '../src/lib/query/export';
import { runCli } from '../src/lib/query/cli';

const node = (id: string, name: string, file: string, line: number): SgNode => ({
  id,
  kind: 'Function',
  name,
  file,
  line,
  weight: 2,
  svelte: false,
});

const edge = (from: string, to: string, dispatch: SgEdge['dispatch']): SgEdge => ({
  from,
  to,
  dispatch,
  confidence: 1,
  calls: 1,
  sites: [{ file: from.split(':')[0], line: 10, column: 2 }],
});

const stats: SgStats = {
  nodes: 3,
  edges: 3,
  self_loops: 0,
  svelte_nodes: 0,
  svelte_edges: 0,
  virtual_edges: 1,
  call_sites: 3,
  kinds: { Function: 3 },
};

const graphData: SgGraph = {
  schema: 'gpen-scip-graph/1',
  source: {},
  nodes: [node('a.ts:1', 'foo', 'a.ts', 1), node('a.ts:2', 'bar', 'a.ts', 2), node('b.ts:1', 'baz', 'b.ts', 1)],
  edges: [edge('a.ts:1', 'a.ts:2', 'static'), edge('a.ts:2', 'b.ts:1', 'virtual'), edge('b.ts:1', 'a.ts:1', 'static')],
  stats,
};

const graph: GraphIndex = buildGraph(graphData, 'memory.json');

describe('selectors', () => {
  test('exact id, file and glob', () => {
    expect(resolveSelector(graph, 'a.ts:1')).toEqual(['a.ts:1']);
    expect(resolveSelector(graph, 'a.ts')).toEqual(['a.ts:1', 'a.ts:2']);
    expect(resolveSelector(graph, '*.ts')).toEqual(['a.ts:1', 'a.ts:2', 'b.ts:1']);
  });

  test('name exact then substring, ambiguous raises', () => {
    expect(resolveSelector(graph, 'foo')).toEqual(['a.ts:1']);
    expect(resolveSelector(graph, 'ar')).toEqual(['a.ts:2']); // unique substring (bar)
    expect(() => resolveSelector(graph, 'ba')).toThrow(SelectorError); // bar + baz
    expect(() => resolveSelector(graph, 'nope')).toThrow(SelectorError);
  });

  test('glob does not cross slash', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/x/a.ts')).toBe(true);
  });
});

describe('reachability', () => {
  test('depth 0 only root; cycle terminates', () => {
    const zero = traverse(graph, { start: ['a.ts:1'], direction: 'callees', depth: 0 });
    expect(zero.nodes.map((n) => n.id)).toEqual(['a.ts:1']);
    const deep = traverse(graph, { start: ['a.ts:1'], direction: 'callees', depth: 10 });
    expect(deep.nodes.map((n) => n.id).sort()).toEqual(['a.ts:1', 'a.ts:2', 'b.ts:1']);
  });

  test('callers direction', () => {
    const callers = traverse(graph, { start: ['b.ts:1'], direction: 'callers', depth: 1 });
    expect(callers.nodes.map((n) => n.id).sort()).toEqual(['a.ts:2', 'b.ts:1']);
  });
});

describe('refs', () => {
  test('incoming and outgoing sites', () => {
    const refs = refsOf(graph, 'a.ts:1');
    expect(refs.count).toBe(2);
    expect(refs.incoming[0].other.id).toBe('b.ts:1');
    expect(refs.outgoing[0].other.id).toBe('a.ts:2');
  });
});

describe('boundaries', () => {
  const index = {
    documents: [
      {
        relative_path: 'a.ts',
        occurrences: [
          { range: [0, 0, 3], symbol: 'local 1', symbol_roles: 1 }, // local definition
          { range: [5, 0, 3], symbol: 'local 1', syntax_kind: 15 }, // resolves local -> excluded
          { range: [6, 0, 3], symbol: 'local 2', syntax_kind: 15 }, // unresolved local
          {
            range: [7, 0, 3],
            symbol: 'scip-typescript npm typescript 6.0.3 lib/`lib.dom.d.ts`/Document#createElement().',
            syntax_kind: 15,
          },
          { range: [8, 0, 3], symbol: 'scip-typescript npm svelte 5.0.0 $state.', syntax_kind: 15 },
          { range: [9, 0, 3], symbol: 'scip-typescript npm lodash 4.0.0 foo().', syntax_kind: 15 },
          { range: [10, 0, 3], symbol: 'other-pkg npm bar 1.0 baz().', syntax_kind: 15 },
          { range: [11, 0, 3], symbol: 'local 3', symbol_roles: 0 }, // not a call
        ],
      },
    ],
  };

  test('symbol display + classification', () => {
    expect(symbolDisplayName('scip-typescript npm typescript 6.0.3 lib/`lib.dom.d.ts`/Document#createElement().')).toBe(
      'Document#createElement',
    );
    expect(classifyBoundary('$state', 'scip-typescript npm svelte 5.0.0 $state.')).toBe('runes');
    expect(
      classifyBoundary(
        'Document#createElement',
        'scip-typescript npm typescript 6.0.3 lib/`lib.dom.d.ts`/Document#createElement().',
      ),
    ).toBe('builtins');
    expect(classifyBoundary('foo', 'scip-typescript npm lodash 4.0.0 foo().')).toBe('node_modules');
    expect(classifyBoundary('baz', 'other-pkg npm bar 1.0 baz().')).toBe('unclassified');
  });

  test('collect and filter', () => {
    const data = collectBoundaries(index);
    expect(data.count).toBe(5);
    const kinds = data.results.map((r) => r.kind);
    expect(kinds).toContain('runes');
    expect(kinds).toContain('builtins');
    expect(kinds).toContain('node_modules');
    expect(kinds).toContain('unclassified');
    const filtered = filterBoundaries(data, { symbol: 'state' });
    expect(filtered.count).toBe(1);
    expect(filtered.breakdown?.byKind).toEqual({ runes: 1 });
    const limited = filterBoundaries(data, { limit: 2 });
    expect(limited.results).toHaveLength(2);
    expect(limited.count).toBe(5);
  });

  test('breakdown top callees deterministic', () => {
    const breakdown = buildBreakdown([
      { file: 'a', line: 1, column: 0, callee: 'x', symbol: 's', kind: 'runes' },
      { file: 'a', line: 2, column: 0, callee: 'x', symbol: 's', kind: 'runes' },
      { file: 'a', line: 3, column: 0, callee: 'y', symbol: 's', kind: 'builtins' },
    ]);
    expect(breakdown.byKind).toEqual({ runes: 2, builtins: 1 });
    expect(breakdown.topCallees[0]).toEqual({ name: 'x', count: 2 });
  });
});

describe('export', () => {
  test('mermaid and dot structure', () => {
    const ids = ['a.ts:1', 'a.ts:2'];
    const edges = [graphData.edges[0]];
    const mermaid = toMermaid(graph, ids, edges);
    expect(mermaid.startsWith('```mermaid\nflowchart LR\n')).toBe(true);
    expect(mermaid.endsWith('```')).toBe(true);
    expect(mermaid).toContain('-->');
    const dot = toDot(graph, ids, edges);
    expect(dot.startsWith('digraph scip {')).toBe(true);
    expect(dot.endsWith('}')).toBe(true);
  });
});

describe('cli exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scip-graph-test-'));
  const graphPath = join(dir, 'graph.json');
  writeFileSync(graphPath, JSON.stringify(graphData));

  const capture = (argv: string[]): number => {
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    (process.stdout as { write: unknown }).write = () => true;
    (process.stderr as { write: unknown }).write = () => true;
    try {
      return runCli(argv);
    } finally {
      (process.stdout as { write: unknown }).write = out;
      (process.stderr as { write: unknown }).write = err;
    }
  };

  test('ok / selector / usage / missing', () => {
    expect(capture(['callers', 'foo', '--graph', graphPath, '--json'])).toBe(EXIT.OK);
    expect(capture(['callers', 'nope', '--graph', graphPath])).toBe(EXIT.SELECTOR);
    expect(capture(['callers', 'a.ts:1', '--depth', '-1', '--graph', graphPath])).toBe(EXIT.USAGE);
    expect(capture(['refs', 'a.ts', '--graph', graphPath])).toBe(EXIT.USAGE);
    expect(capture(['frobnicate'])).toBe(EXIT.USAGE);
    expect(capture(['boundaries', '--index', join(dir, 'missing.json'), '--json'])).toBe(EXIT.MISSING);
  });
});
