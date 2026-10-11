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
import { KIND_COLOR, buildAppVM, layoutScreen, type AppState, type CallGraph, type GraphScene } from '../lib/core/model';
import { fromIR } from '../lib/core/from-ir';
import { mockLayeredGraph } from '../lib/ir/mock';
import { CellBuffer } from '../lib/render/tui/cell';
import { paintScene } from '../lib/render/tui/render';

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

/** call graph 的 retained-mode 包装：内部是立即模式的 CellBuffer 绘制。 */
class GraphRenderable extends Renderable {
  #sceneFn: () => GraphScene;
  #onPick: (id: string) => void;

  constructor(ctx: CliRenderer, sceneFn: () => GraphScene, onPick: (id: string) => void) {
    super(ctx, { flexGrow: 1, buffered: true });
    this.#sceneFn = sceneFn;
    this.#onPick = onPick;
  }

  pick(id: string): void {
    this.#onPick(id);
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const w = Math.max(0, Math.floor(this.width));
    const h = Math.max(0, Math.floor(this.height));
    if (w < 6 || h < 4) return;
    const tmp = new CellBuffer(w, h);
    paintScene(tmp, this.#sceneFn(), { col: 0, row: 0, width: w, height: h });
    const bg = RGBA.fromHex('#16161e');
    const fgDefault = RGBA.fromHex('#c0caf5');
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const cell = tmp.cell(r, c);
        if (cell.ch === ' ') continue;
        buffer.setCell(c, r, cell.ch, cell.fg ? RGBA.fromHex(cell.fg) : fgDefault, bg, 0);
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

function buildApp(renderer: CliRenderer) {
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
    () => buildAppVM(ui.app).scene,
    (id) => {
      ui = selectNode(ui, id);
      refresh();
    },
  );
  // 鼠标：点图上节点（把点击位置反投影回 scene 坐标，取最近节点）。
  graph.onMouseDown = (e: TuiMouseEvent) => {
    const scene = buildAppVM(ui.app).scene;
    const lx = e.x - graph.x;
    const ly = e.y - graph.y;
    const pad = 3;
    const sx = (graph.width - pad * 2) / Math.max(1, scene.bounds.width);
    const sy = (graph.height - pad * 2) / Math.max(1, scene.bounds.height);
    let best: { id: string; d: number } | null = null;
    for (const n of scene.nodes) {
      const cx = pad + (n.x + n.width / 2 - scene.bounds.x) * sx;
      const cy = pad + (n.y + n.height / 2 - scene.bounds.y) * sy;
      const d = Math.hypot(cx - lx, cy - ly);
      if (!best || d < best.d) best = { id: n.id, d };
    }
    if (best) graph.pick(best.id);
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

if (headless) {
  const setup = await createTestRenderer({ width: W, height: H, exitOnCtrlC: false });
  buildApp(setup.renderer);
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
  buildApp(renderer);
}
