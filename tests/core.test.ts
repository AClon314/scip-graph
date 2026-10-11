import { describe, expect, test } from 'bun:test';
import { fromIR } from '../src/lib/core/from-ir';
import {
  buildAppVM,
  buildTree,
  layoutScreen,
  type AppState,
} from '../src/lib/core/model';
import { initUi, reduceKey, selectNode, toggleFold } from '../src/lib/core/app';
import { parseKeys, decodeKeySpec } from '../src/lib/core/keys';
import { mockLayeredGraph } from '../src/lib/ir/mock';
import { renderBuffer, renderTui } from '../src/lib/render/tui/render';

const graph = fromIR(mockLayeredGraph);

const state = (over: Partial<AppState> = {}): AppState => ({
  graph,
  fold: new Set(),
  selectedId: null,
  inputValue: '',
  focus: 'tree',
  ...over,
});

describe('fromIR', () => {
  test('maps IR nodes/edges without changing counts', () => {
    expect(graph.nodes.length).toBe(mockLayeredGraph.nodes.length);
    expect(graph.edges.length).toBe(mockLayeredGraph.edges.length);
    expect(graph.bounds.width).toBeGreaterThan(0);
    expect(graph.bounds.height).toBeGreaterThan(0);
  });

  test('carries dispatch + geometry', () => {
    const virtual = graph.edges.find((e) => e.dispatch === 'virtual');
    expect(virtual).toBeDefined();
    // 手放坐标来自 mockLayeredGraph 的 edge.points。
    expect(virtual!.points.length).toBeGreaterThanOrEqual(2);
    const node = graph.nodes.find((n) => n.file.endsWith('draggable.ts'));
    expect(node?.line).toBeGreaterThan(0);
  });
});

describe('buildTree', () => {
  test('derives file rows with symbol children', () => {
    const rows = buildTree(graph, new Set(), null);
    expect(rows.some((r) => r.kind === 'dir')).toBe(true);
    const fileRow = rows.find((r) => r.kind === 'file' && r.label === 'draggable.ts');
    expect(fileRow).toBeDefined();
    expect(fileRow!.badge).toBe('2');
    expect(rows.some((r) => r.symbolId?.includes('boundsFor'))).toBe(true);
  });

  test('fold collapses children', () => {
    const all = buildTree(graph, new Set(), null);
    const dir = all.find((r) => r.kind === 'dir' && r.label === 'gestures/');
    expect(dir).toBeDefined();
    const folded = buildTree(graph, new Set([dir!.id]), null);
    expect(folded.length).toBeLessThan(all.length);
    expect(folded.find((r) => r.id === dir!.id)!.expanded).toBe(false);
  });
});

describe('reducer', () => {
  test('tab cycles focus tree → graph → input', () => {
    let ui = initUi(state({ focus: 'tree' }));
    ui = reduceKey(ui, { type: 'tab' });
    expect(ui.app.focus).toBe('graph');
    ui = reduceKey(ui, { type: 'tab' });
    expect(ui.app.focus).toBe('input');
    ui = reduceKey(ui, { type: 'shift-tab' });
    expect(ui.app.focus).toBe('graph');
  });

  test('graph up/down moves selection', () => {
    const first = graph.nodes[0]!.id;
    let ui = initUi(state({ focus: 'graph', selectedId: first }));
    ui = reduceKey(ui, { type: 'down' });
    expect(ui.app.selectedId).toBe(graph.nodes[1]!.id);
    ui = reduceKey(ui, { type: 'up' });
    expect(ui.app.selectedId).toBe(first);
  });

  test('enter on a symbol row selects it', () => {
    let ui = initUi(state({ focus: 'tree' }));
    const cursor = ui.rows.findIndex((r) => r.kind === 'symbol');
    ui = { ...ui, treeCursor: cursor };
    const target = ui.rows[cursor]!;
    ui = reduceKey(ui, { type: 'enter' });
    expect(ui.app.selectedId).toBe(target.symbolId ?? null);
  });

  test('left/right fold and unfold a dir row', () => {
    let ui = initUi(state({ focus: 'tree' }));
    const cursor = ui.rows.findIndex((r) => r.kind === 'dir');
    const row = ui.rows[cursor]!;
    ui = { ...ui, treeCursor: cursor };
    const before = ui.rows.length;
    ui = reduceKey(ui, { type: 'left' });
    expect(ui.app.fold.has(row.id)).toBe(true);
    expect(ui.rows.length).toBeLessThan(before);
    ui = reduceKey(ui, { type: 'right' });
    expect(ui.app.fold.has(row.id)).toBe(false);
    expect(ui.rows.length).toBe(before);
  });

  test('input typing appends and backspace removes', () => {
    let ui = initUi(state({ focus: 'input' }));
    ui = reduceKey(ui, { type: 'char', ch: 'a' });
    ui = reduceKey(ui, { type: 'char', ch: 'b' });
    expect(ui.app.inputValue).toBe('ab');
    ui = reduceKey(ui, { type: 'backspace' });
    expect(ui.app.inputValue).toBe('a');
  });

  test('q quits, selectNode/toggleFold helpers work', () => {
    let ui = initUi(state({ focus: 'graph' }));
    expect(reduceKey(ui, { type: 'char', ch: 'q' }).quit).toBe(true);
    ui = selectNode(ui, graph.nodes[2]!.id);
    expect(ui.app.selectedId).toBe(graph.nodes[2]!.id);
    const dir = ui.rows.find((r) => r.kind === 'file')!;
    ui = toggleFold(ui, dir.id);
    expect(ui.app.fold.has(dir.id)).toBe(true);
  });
});

describe('keys', () => {
  test('parseKeys maps arrows/tab/enter, decodeKeySpec maps tokens', () => {
    expect(parseKeys('\x1b[B')[0]).toEqual({ type: 'down' });
    expect(parseKeys('\t')[0]).toEqual({ type: 'tab' });
    expect(decodeKeySpec('tab down text:hi')).toEqual([
      { type: 'tab' },
      { type: 'down' },
      { type: 'char', ch: 'h' },
      { type: 'char', ch: 'i' },
    ]);
  });
});

describe('tui rasterizer', () => {
  test('renders chrome + scene into a cell frame', () => {
    const ui = initUi(state({ focus: 'graph', selectedId: graph.nodes[1]!.id }));
    const layout = layoutScreen(100, 28);
    const vm = buildAppVM(ui.app);
    const frame = renderTui(vm, layout, { color: false, treeCursor: ui.treeCursor });
    expect(frame).toContain('call graph');
    expect(frame).toContain('files');
    expect(frame.split('\n').length).toBe(28);
    const buf = renderBuffer(vm, layout, { treeCursor: ui.treeCursor });
    expect(buf.cell(0, 0).ch).toBe(' ');
    expect(buf.toString({ color: false }).length).toBeGreaterThan(100);
  });
});
