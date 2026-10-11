/**
 * TUI 图渲染 = orchgraph（PLAN D4）。
 *
 * orchgraph 的 `TerminalCanvas` 已经处理好多行盒子、正交路由与折角字符；这里只做：
 *   1. IR → orchgraph GraphDocument（复用 layout/orchgraph 的适配）
 *   2. ELK 布局 + 渲染 → 带 ANSI 的字符行
 *   3. 解析成「带 fg 的 cell 网格」，供 opentui 自定义 Renderable 逐格 blit
 *
 * 布局是 async，`renderSelf` 是 sync，所以在启动时先 await 出这一份只读视图。
 */

import { layoutTerminalGraph, renderTerminalCanvas } from 'orchgraph';
import { toOrchgraphDocument, type OrchgraphLayoutOptions } from '../../layout/orchgraph';
import type { VisualGraph } from '../../ir/types';

export interface OrchCell {
  ch: string;
  fg?: string;
}

export interface OrchNodeBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OrchCanvasView {
  width: number;
  height: number;
  /** [row][col]，每格是字符 + 可选前景色。 */
  cells: OrchCell[][];
  nodes: OrchNodeBox[];
}

const BASIC_FG: Record<number, string> = {
  30: '#15161e',
  31: '#f7768e',
  32: '#9ece6a',
  33: '#e0af68',
  34: '#7aa2f7',
  35: '#bb9af7',
  36: '#7dcfff',
  37: '#c0caf5',
  90: '#565f89',
};

const hex2 = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
const rgb = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** 解析 orchgraph 的 ANSI 行（只用 SGR 前景色）→ cell 网格。 */
function parseAnsi(lines: string[]): OrchCell[][] {
  const grid: OrchCell[][] = [];
  for (const line of lines) {
    const row: OrchCell[] = [];
    let fg: string | undefined;
    let i = 0;
    while (i < line.length) {
      if (line[i] === '\x1b') {
        const sgr = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
        if (sgr) {
          const codes = sgr[1]!.split(';').map(Number);
          let j = 0;
          while (j < codes.length) {
            const c = codes[j] ?? 0;
            if (c === 0 || c === 39) fg = undefined;
            else if (c === 38 && codes[j + 1] === 2) {
              fg = rgb(codes[j + 2] ?? 0, codes[j + 3] ?? 0, codes[j + 4] ?? 0);
              j += 4;
            } else if (c === 38 && codes[j + 1] === 5) {
              j += 2; // 256 色索引：忽略，退回默认前景
            } else if (BASIC_FG[c]) fg = BASIC_FG[c];
            j++;
          }
          i += sgr[0].length;
          continue;
        }
        const other = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
        i += other ? other[0].length : 1;
        continue;
      }
      const ch = line[i]!;
      row.push(fg ? { ch, fg } : { ch });
      i += 1;
    }
    grid.push(row);
  }
  return grid;
}

/** 用 orchgraph 跑一次布局 + 渲染，产出可 blit 的 cell 网格。 */
export async function buildOrchgraphView<N extends object, E extends object, G>(
  graph: VisualGraph<N, E, G>,
  opts: OrchgraphLayoutOptions & { maxNodeWidth?: number } = {},
): Promise<OrchCanvasView> {
  const doc = toOrchgraphDocument(graph, opts);
  const canvas = await layoutTerminalGraph(doc, {
    direction: doc.direction,
    spacing: opts.spacing ?? 2,
    maxNodeWidth: opts.maxNodeWidth ?? 28,
  });
  const lines = renderTerminalCanvas(canvas, { color: true });
  const cells = parseAnsi(lines);
  const width = cells.reduce((m, row) => Math.max(m, row.length), 0);
  for (const row of cells) while (row.length < width) row.push({ ch: ' ' });
  return {
    width,
    height: cells.length,
    cells,
    nodes: canvas.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height })),
  };
}
