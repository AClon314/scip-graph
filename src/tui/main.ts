/**
 * TUI 入口（opentui）。
 *
 * 架构（PLAN D5）：
 *  - 共享层 `src/lib/core`：view-model + reducer + keys，框架无关。
 *  - chrome（面板 / 边框 / 标题 / 文本 / 输入）交给 opentui 内置 Renderable + Yoga 布局。
 *  - call graph 用**自定义 Renderable**：`buffered:true` + `renderSelf(buffer)`，
 *    内部复用 `src/lib/render/tui` 的 CellBuffer 绘制逻辑（paintScene）。
 *  - 鼠标：树行点击、图上点节点（反投影取最近节点）。
 *  - 数据：`src/lib/ir/mock.ts` 的手放坐标（`mockLayeredGraph`）。
 *
 *   bun run tui                    交互（真实 TTY，mouse 开）
 *   bun run tui -- --headless      无 TTY：渲染一帧并打印字符帧
 *   bun run tui -- --headless --keys "down down enter tab"   回放按键
 */

import {
  BoxRenderable,
  InputRenderable,
  RGBA,
  Renderable,
  StyledText,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent as TuiMouseEvent,
  type OptimizedBuffer,
  type TextChunk,
} from '@opentui/core';
import { createTestRenderer, KeyCodes } from '@opentui/core/testing';
import { initUi, reduceKey, selectNode, type UiState } from '../lib/core/app';
import type { Key as AppKey } from '../lib/core/keys';
import { KIND_COLOR, buildAppVM, layoutScreen, type AppState, type CallGraph } from '../lib/core/model';
import { fromIR } from '../lib/core/from-ir';
import { mockLayeredGraph } from '../lib/ir/mock';
import { buildOrchgraphView, type OrchCanvasView } from '../lib/render/tui/orchgraph-canvas';

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (n: string) => args.includes(`--${n}`);

const W = Number(flag('width') ?? 110);
const H = Number(flag('height') ?? 32);

const APP_GRAPH: CallGraph = fromIR(mockLayeredGraph);

function makeState(): AppState {
  const selected = flag('select');
  return {
    graph: APP_GRAPH,
    fold: new Set<string>(),
    selectedId: selected !== undefined ? selected : (APP_GRAPH.nodes[1]?.id ?? null),
    inputValue: '',
    focus: (flag('focus') as AppState['focus']) ?? 'tree',
  };
}

// ---------------------------------------------------------------- 自定义 renderable

/** call graph 的 retained-mode 包装：内部 blit orchgraph 产出的带色 cell 网格。 */
class GraphRenderable extends Renderable {
  view: OrchCanvasView | null = null;
  #selected: () => string | null;
  #onPick: (id: string) => void;
  #offset = { x: 0, y: 0 };

  constructor(ctx: CliRenderer, selected: () => string | null, onPick: (id: string) => void) {
    super(ctx, { flexGrow: 1, buffered: true });
    this.#selected = selected;
    this.#onPick = onPick;
  }

  pick(id: string): void {
    this.#onPick(id);
  }

  /** 屏幕坐标 → canvas 坐标 → 命中节点（盒子包含优先，否则最近中心）。 */
  hitTest(e: TuiMouseEvent): string | undefined {
    const v = this.view;
    if (!v) return undefined;
    const lx = e.x - this.x + this.#offset.x;
    const ly = e.y - this.y + this.#offset.y;
    let near: { id: string; d: number } | undefined;
    for (const n of v.nodes) {
      if (lx >= n.x && lx < n.x + n.width && ly >= n.y && ly < n.y + n.height) return n.id;
      const d = Math.hypot(n.x + n.width / 2 - lx, n.y + n.height / 2 - ly);
      if (!near || d < near.d) near = { id: n.id, d };
    }
    return near?.id;
  }

  /** 显式平移（供键盘/拖拽用）。 */
  pan(dx: number, dy: number): void {
    const v = this.view;
    if (!v) return;
    const w = Math.floor(this.width);
    const h = Math.floor(this.height);
    const maxX = Math.max(0, v.width - w);
    const maxY = Math.max(0, v.height - h);
    this.#offset = {
      x: Math.max(0, Math.min(maxX, this.#offset.x + dx)),
      y: Math.max(0, Math.min(maxY, this.#offset.y + dy)),
    };
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const v = this.view;
    const w = Math.max(0, Math.floor(this.width));
    const h = Math.max(0, Math.floor(this.height));
    if (!v || w < 4 || h < 4) return;
    const sel = this.#selected();
    const selBox = sel ? v.nodes.find((n) => n.id === sel) : undefined;
    // 视口跟随选中节点居中，并夹在 canvas 边界内。
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    const cx = selBox ? selBox.x + selBox.width / 2 : v.width / 2;
    const cy = selBox ? selBox.y + selBox.height / 2 : v.height / 2;
    const offX = clamp(Math.round(cx - w / 2), 0, Math.max(0, v.width - w));
    const offY = clamp(Math.round(cy - h / 2), 0, Math.max(0, v.height - h));
    this.#offset = { x: offX, y: offY };

    const bg = RGBA.fromHex('#16161e');
    const def = RGBA.fromHex('#c0caf5');
    const accent = RGBA.fromHex('#f7768e');
    for (let r = 0; r < h; r++) {
      const row = v.cells[offY + r];
      if (!row) break;
      for (let c = 0; c < w; c++) {
        const cell = row[offX + c];
        if (!cell || cell.ch === ' ') continue;
        const canvasR = offY + r;
        const canvasC = offX + c;
        const inSel =
          selBox !== undefined &&
          canvasC >= selBox.x &&
          canvasC < selBox.x + selBox.width &&
          canvasR >= selBox.y &&
          canvasR < selBox.y + selBox.height;
        const fg = inSel ? accent : cell.fg ? RGBA.fromHex(cell.fg) : def;
        buffer.setCell(c, r, cell.ch, fg, bg, 0);
      }
    }
    if (selBox) {
      const mx = selBox.x - offX;
      const my = selBox.y - 1 - offY;
      if (my >= 0 && mx >= 0 && mx < w) buffer.setCell(mx, my, '▼', accent, bg, 0);
    }
    // 视口提示（右下角）：canvas 总尺寸 + 当前位置。
    if (v.height > h || v.width > w) {
      const label = `[${offX},${offY}] ${v.width}×${v.height}`;
      const start = Math.max(0, w - label.length);
      for (let i = 0; i < label.length && start + i < w; i++) {
        buffer.setCell(start + i, h - 1, label[i]!, RGBA.fromHex('#565f89'), bg, 0);
      }
    }
  }
}

// ---------------------------------------------------------------- 文本 chunk 工具

const chunk = (text: string, fg?: string): TextChunk => ({
  __isChunk: true,
  text,
  ...(fg ? { fg: RGBA.fromHex(fg) } : {}),
});

function treeStyled(ui: UiState, treeWidth: number): StyledText {
  const chunks: TextChunk[] = [];
  ui.rows.forEach((row, i) => {
    const prefix = '│ '.repeat(row.depth);
    const marker = row.hasChildren ? (row.expanded ? 'v ' : '› ') : '─ ';
    const cursor = ui.app.focus === 'tree' && i === ui.treeCursor;
    const badge = row.badge ?? '';
    const room = treeWidth - 3 - prefix.length - marker.length - (badge ? badge.length + 1 : 0);
    const label = row.label.length > room ? row.label.slice(0, Math.max(1, room - 1)) + '…' : row.label;
    const fg = cursor
      ? KIND_COLOR.accent
      : row.dimmed
        ? KIND_COLOR.dim
        : row.kind === 'dir'
          ? '#7dcfff'
          : row.kind === 'file'
            ? '#c0caf5'
            : '#9ece6a';
    chunks.push(chunk((cursor ? '▌' : ' ') + prefix + marker + label, fg));
    if (badge) chunks.push(chunk(' ' + badge, KIND_COLOR.dim));
    chunks.push(chunk('\n'));
  });
  return new StyledText(chunks);
}

const statusStyled = (ui: UiState): StyledText => {
  const segments = ui.message ? [{ text: ui.message, color: KIND_COLOR.accent }] : buildAppVM(ui.app).status;
  const chunks: TextChunk[] = segments.map((s) => chunk(s.text, s.color));
  chunks.push(chunk(`    focus: ${ui.app.focus}`, KIND_COLOR.dim));
  return new StyledText(chunks);
};

function toAppKey(e: KeyEvent): AppKey | undefined {
  if (e.ctrl && e.name === 'c') return { type: 'ctrl-c' };
  switch (e.name) {
    case 'tab':
      return e.shift ? { type: 'shift-tab' } : { type: 'tab' };
    case 'up':
      return { type: 'up' };
    case 'down':
      return { type: 'down' };
    case 'left':
      return { type: 'left' };
    case 'right':
      return { type: 'right' };
    case 'return':
    case 'enter':
      return { type: 'enter' };
    case 'backspace':
      return { type: 'backspace' };
    case 'escape':
      return { type: 'esc' };
    default:
      return e.name.length === 1 ? { type: 'char', ch: e.name } : undefined;
  }
}

// ---------------------------------------------------------------- app

function buildApp(renderer: CliRenderer, view: OrchCanvasView | null) {
  let ui = initUi(makeState());
  const layout = layoutScreen(W, H);

  const root = new BoxRenderable(renderer, {
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    backgroundColor: '#1a1b26',
  });
  renderer.root.add(root);

  root.add(
    new TextRenderable(renderer, {
      content: new StyledText([chunk(' scip-graph', KIND_COLOR.accent), chunk('  ir → vm (opentui)')]),
      height: 1,
    }),
  );

  const body = new BoxRenderable(renderer, { flexDirection: 'row', flexGrow: 1 });
  root.add(body);

  const treeBox = new BoxRenderable(renderer, {
    width: layout.tree.width,
    border: true,
    borderStyle: 'single',
    borderColor: KIND_COLOR.edge,
    title: ' files ',
    titleColor: KIND_COLOR.file,
    flexDirection: 'column',
  });
  const treeText = new TextRenderable(renderer, { content: treeStyled(ui, layout.tree.width), flexGrow: 1 });
  treeBox.add(treeText);
  // 鼠标：点树行 → 选择 / 折叠。
  treeBox.onMouseDown = (e: TuiMouseEvent) => {
    const row = ui.rows[Math.max(0, e.y - treeBox.y - 1)];
    if (!row) return;
    const cursor = ui.rows.indexOf(row);
    ui = reduceKey({ ...ui, treeCursor: cursor }, { type: 'enter' });
    refresh();
  };
  body.add(treeBox);

  const graphBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    border: true,
    borderStyle: 'single',
    borderColor: KIND_COLOR.edge,
    title: ' call graph ',
    titleColor: KIND_COLOR.file,
    flexDirection: 'column',
  });
  const graph = new GraphRenderable(
    renderer,
    () => ui.app.selectedId,
    (id) => {
      ui = selectNode(ui, id);
      refresh();
    },
  );
  graph.view = view;
  // 鼠标：点图上节点（在 orchgraph canvas 坐标里命中盒子 / 最近中心）。
  graph.onMouseDown = (e: TuiMouseEvent) => {
    const id = graph.hitTest(e);
    if (id) graph.pick(id);
  };
  graphBox.add(graph);
  body.add(graphBox);

  const statusText = new TextRenderable(renderer, { content: statusStyled(ui), height: 1 });
  root.add(statusText);

  const inputRow = new BoxRenderable(renderer, { flexDirection: 'row', height: 1 });
  inputRow.add(new TextRenderable(renderer, { content: new StyledText([chunk('> ', KIND_COLOR.accent)]), width: 2 }));
  const input = new InputRenderable(renderer, {
    flexGrow: 1,
    placeholder: 'query: callers <symbol> …',
    backgroundColor: '#1a1b26',
    textColor: '#c0caf5',
  });
  inputRow.add(input);
  root.add(inputRow);

  function refresh(): void {
    treeText.content = treeStyled(ui, layout.tree.width);
    statusText.content = statusStyled(ui);
    graph.requestRender();
    if (ui.app.focus === 'input') input.focus();
    else input.blur();
    renderer.requestRender();
  }

  renderer.keyInput.on('keypress', (e: KeyEvent) => {
    const key = toAppKey(e);
    if (!key) return;
    // 输入框聚焦时，文本键交给 Input 组件，只拦 tab/esc。
    if (ui.app.focus === 'input' && key.type === 'char') return;
    ui = reduceKey(ui, key);
    if (ui.quit) {
      renderer.destroy();
      process.exit(0);
    }
    ui.app.inputValue = input.value;
    refresh();
  });

  refresh();
  return { refresh, graph, getUi: () => ui };
}

// ---------------------------------------------------------------- run

/** 回放键名 → opentui KeyCodes 名（命名键必须走 KeyCodes，否则逐字输入）。 */
const KEYCODE: Record<string, string> = {
  tab: 'TAB',
  's-tab': 'TAB',
  up: 'ARROW_UP',
  down: 'ARROW_DOWN',
  left: 'ARROW_LEFT',
  right: 'ARROW_RIGHT',
  return: 'RETURN',
  enter: 'RETURN',
  backspace: 'BACKSPACE',
  escape: 'ESCAPE',
};

const headless = has('headless') || !process.stdin.isTTY;

const orchView = await buildOrchgraphView(mockLayeredGraph, { direction: 'right', spacing: 2, maxNodeWidth: 20 });

if (headless) {
  const setup = await createTestRenderer({ width: W, height: H, exitOnCtrlC: false });
  buildApp(setup.renderer, orchView);
  const spec = flag('keys');
  if (spec) {
    for (const tok of spec.split(/\s+/).filter(Boolean)) {
      const named = KEYCODE[tok];
      setup.mockInput.pressKey((named ?? (tok.length === 1 ? tok : KeyCodes.ESCAPE)) as never);
      await setup.renderOnce();
    }
  }
  const click = flag('click');
  if (click) {
    const [cx, cy] = click.split(',').map(Number);
    await setup.mockMouse.click(cx!, cy!);
    await setup.renderOnce();
  }
  await setup.renderOnce();
  process.stdout.write(setup.captureCharFrame() + '\n');
  await setup.dispose();
} else {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  buildApp(renderer, orchView);
}
