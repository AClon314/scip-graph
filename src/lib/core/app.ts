/**
 * 交互逻辑：框架无关的纯 reducer。
 *
 * TUI 的 raw-mode 循环与 GUI 的事件处理都调它 —— 「交互」也是共享的，
 * 不只是「渲染」。本文件不 import 任何终端 / DOM / 框架。
 */

import { buildAppVM, type AppState, type Focus, type TreeRow } from './model';
import type { Key } from './keys';

export interface UiState {
  app: AppState;
  /** 当前可见的 tree rows（fold 变化后重算）。 */
  rows: TreeRow[];
  treeCursor: number;
  /** 最近操作回显。 */
  message: string;
  quit: boolean;
}

const FOCUS_ORDER: Focus[] = ['tree', 'graph', 'input'];
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function initUi(app: AppState): UiState {
  const rows = buildAppVM(app).rows;
  const i = rows.findIndex((r) => r.symbolId === app.selectedId);
  return { app, rows, treeCursor: i < 0 ? 0 : i, message: '', quit: false };
}

export function reduceKey(ui: UiState, key: Key): UiState {
  const app: AppState = { ...ui.app, fold: new Set(ui.app.fold) };
  let treeCursor = ui.treeCursor;
  let message = ui.message;
  let quit = ui.quit;

  const nodes = app.graph.nodes;
  const nodeIdx = Math.max(
    0,
    nodes.findIndex((n) => n.id === app.selectedId),
  );
  const cycleFocus = (step: number) =>
    (app.focus = FOCUS_ORDER[(FOCUS_ORDER.indexOf(app.focus) + step + 3) % 3]!);
  const row = () => ui.rows[treeCursor];

  switch (key.type) {
    case 'tab':
      cycleFocus(1);
      break;
    case 'shift-tab':
      cycleFocus(2);
      break;
    case 'up':
      if (app.focus === 'tree') treeCursor = clamp(treeCursor - 1, 0, ui.rows.length - 1);
      else if (app.focus === 'graph' && nodes.length > 0)
        app.selectedId = nodes[clamp(nodeIdx - 1, 0, nodes.length - 1)]!.id;
      break;
    case 'down':
      if (app.focus === 'tree') treeCursor = clamp(treeCursor + 1, 0, ui.rows.length - 1);
      else if (app.focus === 'graph' && nodes.length > 0)
        app.selectedId = nodes[clamp(nodeIdx + 1, 0, nodes.length - 1)]!.id;
      break;
    case 'left': {
      const r = row();
      if (app.focus === 'tree' && r?.hasChildren && r.expanded) app.fold.add(r.id);
      break;
    }
    case 'right': {
      const r = row();
      if (app.focus === 'tree' && r?.hasChildren && !r.expanded) app.fold.delete(r.id);
      break;
    }
    case 'enter': {
      const r = row();
      if (app.focus === 'tree' && r) {
        if (r.symbolId) {
          app.selectedId = r.symbolId;
          message = `selected ${r.symbolId}`;
        } else if (app.fold.has(r.id)) {
          app.fold.delete(r.id);
        } else {
          app.fold.add(r.id);
        }
      } else if (app.focus === 'graph') message = `selected ${app.selectedId}`;
      else if (app.focus === 'input') message = `run: ${app.inputValue}`;
      break;
    }
    case 'backspace':
      if (app.focus === 'input') app.inputValue = app.inputValue.slice(0, -1);
      break;
    case 'esc':
      app.focus = 'graph';
      break;
    case 'ctrl-c':
      quit = true;
      break;
    case 'char':
      if (app.focus === 'input') app.inputValue += key.ch;
      else if (key.ch === 'q' || key.ch === 'Q') quit = true;
      else if (key.ch === '/') app.focus = 'input';
      else if (key.ch === 't') app.focus = 'tree';
      else if (key.ch === 'g') app.focus = 'graph';
      break;
  }

  const rows = buildAppVM(app).rows;
  return {
    app,
    rows,
    treeCursor: clamp(treeCursor, 0, Math.max(0, rows.length - 1)),
    message,
    quit,
  };
}

/** 选中某个节点（供 GUI 鼠标点击直接调用，绕过 key reducer）。 */
export function selectNode(ui: UiState, id: string): UiState {
  const app: AppState = { ...ui.app, selectedId: id };
  const rows = buildAppVM(app).rows;
  return { ...ui, app, rows, message: `selected ${id}` };
}

/** 折叠 / 展开某个 tree 行（供 GUI 点击调用）。 */
export function toggleFold(ui: UiState, id: string): UiState {
  const fold = new Set(ui.app.fold);
  if (fold.has(id)) fold.delete(id);
  else fold.add(id);
  const app: AppState = { ...ui.app, fold };
  return { ...ui, app, rows: buildAppVM(app).rows };
}
