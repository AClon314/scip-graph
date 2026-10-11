/**
 * TUI 光栅化：把共享 view model 画进字符格。
 *
 * `paintScene` 是 TUI 与 opentui 自定义 Renderable 共用的「画图」逻辑；
 * `renderBuffer` / `renderTui` 则在它外面加 chrome（面板/树/状态/输入）。
 */

import {
  KIND_COLOR,
  sceneProjector,
  type AppVM,
  type CellRect,
  type GraphScene,
  type ScreenLayout,
} from '../../core/model';
import { CellBuffer } from './cell';

/** 把 graph scene 画进任意 CellBuffer/rect。 */
export function paintScene(buf: CellBuffer, scene: GraphScene, rect: CellRect): void {
  const proj = sceneProjector(scene, rect);
  for (const e of scene.edges) {
    const fg = e.dimmed
      ? KIND_COLOR.dim
      : e.dashed
        ? (KIND_COLOR.edgeVirtual ?? '#bb9af7')
        : e.dispatch === 'self'
          ? (KIND_COLOR.accent ?? '#f7768e')
          : KIND_COLOR.edge;
    buf.polyline(e.points.map(proj), fg);
  }
  for (const n of scene.nodes) {
    const a = proj({ x: n.x, y: n.y });
    const b = proj({ x: n.x + n.width, y: n.y + n.height });
    const w = Math.max(3, b.col - a.col + 1);
    const h = Math.max(1, b.row - a.row + 1);
    const fg = n.dimmed ? KIND_COLOR.dim : n.color;
    if (h >= 3 && w >= 6) {
      buf.box({ col: a.col, row: a.row, width: w, height: h }, { fg });
      const label = n.label.length > w - 4 ? n.label.slice(0, w - 5) + '…' : n.label;
      buf.text(a.row + Math.floor(h / 2), a.col + 2, label, fg);
    } else {
      const label = n.label.length > w ? n.label.slice(0, w - 1) + '…' : n.label;
      buf.text(a.row, a.col, label, fg);
    }
    if (n.selected) buf.text(a.row - 1, a.col, '▼', KIND_COLOR.accent);
  }
}

/** 把共享 view model 光栅化到字符格。这就是「TUI 渲染器」。 */
export function renderBuffer(
  vm: AppVM,
  layout: ScreenLayout,
  opts: { treeCursor?: number; message?: string } = {},
): CellBuffer {
  const buf = new CellBuffer(layout.cols, layout.rows);
  const focusBorder = (on: boolean) => (on ? KIND_COLOR.accent : KIND_COLOR.edge);

  // --- header ---
  let col = 1;
  for (const seg of vm.title) {
    buf.text(0, col, seg.text, seg.color);
    col += seg.text.length;
  }

  // --- 左：file tree ---
  const t = layout.tree;
  buf.box(t, { fg: focusBorder(vm.focus === 'tree'), title: 'files', titleColor: KIND_COLOR.file });
  const maxRows = Math.max(0, t.height - 2);
  vm.rows.slice(0, maxRows).forEach((row, i) => {
    const r = t.row + 1 + i;
    const cursor = opts.treeCursor === i && vm.focus === 'tree';
    const prefix = '│ '.repeat(row.depth);
    const marker = row.hasChildren ? (row.expanded ? 'v ' : '> ') : '─ ';
    const badge = row.badge ?? '';
    const room = t.width - 3 - prefix.length - marker.length - (badge ? badge.length + 1 : 0);
    const label = row.label.length > room ? row.label.slice(0, Math.max(1, room - 1)) + '…' : row.label;
    const fg = cursor
      ? KIND_COLOR.accent
      : row.dimmed
        ? KIND_COLOR.dim
        : row.kind === 'dir'
          ? (KIND_COLOR.dir ?? '#7dcfff')
          : row.kind === 'file'
            ? (KIND_COLOR.file ?? '#c0caf5')
            : KIND_COLOR.function;
    if (cursor) buf.set(r, t.col, '▌', KIND_COLOR.accent);
    buf.text(r, t.col + 1, prefix + marker + label, fg);
    if (row.badge) buf.text(r, t.col + t.width - 2 - row.badge.length, row.badge, KIND_COLOR.dim);
  });
  if (vm.rows.length > maxRows && maxRows > 0) {
    buf.text(t.row + t.height - 1, t.col + 2, ` … +${vm.rows.length - maxRows}`, KIND_COLOR.dim);
  }

  // --- 右：call graph ---
  const g = layout.graph;
  buf.box(g, { fg: focusBorder(vm.focus === 'graph'), title: 'call graph', titleColor: KIND_COLOR.file });
  paintScene(buf, vm.scene, g);

  // --- legend（画在 graph 内）---
  const l = layout.legend;
  if (l.width >= 6 && l.height >= 3 && l.col + l.width <= layout.cols && l.row + l.height <= layout.rows) {
    buf.box(l, { fg: KIND_COLOR.edge, title: 'legend', titleColor: KIND_COLOR.file });
    vm.legend.forEach((item, i) => {
      const r = l.row + 1 + i;
      buf.set(r, l.col + 2, '■', item.color);
      buf.text(r, l.col + 4, item.label, KIND_COLOR.file);
    });
  }

  // --- status ---
  const s = layout.status;
  const segments = opts.message ? [{ text: opts.message, color: KIND_COLOR.accent }] : vm.status;
  let sc = 1;
  for (const seg of segments) {
    buf.text(s.row, sc, seg.text, seg.color);
    sc += seg.text.length;
  }
  buf.text(s.row, s.col + s.width - 12, `focus: ${vm.focus}`, KIND_COLOR.dim);

  // --- input ---
  const inp = layout.input;
  buf.text(inp.row, 1, '>', vm.focus === 'input' ? KIND_COLOR.accent : KIND_COLOR.dim);
  if (vm.input.value) {
    buf.text(inp.row, 3, vm.input.value, KIND_COLOR.file);
    buf.set(inp.row, 3 + vm.input.value.length, '█', KIND_COLOR.accent);
  } else {
    buf.text(inp.row, 3, vm.input.placeholder, KIND_COLOR.dim);
    buf.set(inp.row, 3 + vm.input.placeholder.length, '█', KIND_COLOR.accent);
  }

  return buf;
}

/** 便捷：直接得到整帧字符串。 */
export function renderTui(
  vm: AppVM,
  layout: ScreenLayout,
  opts: { color?: boolean; treeCursor?: number; message?: string } = {},
): string {
  const { color, ...rest } = opts;
  return renderBuffer(vm, layout, rest).toString({ color });
}
