/**
 * `scip-graph` command-line interface: argument parsing, dispatch, exit codes
 * and the human / JSON / export output selection.
 *
 * Exit codes (`EXIT`): 0 success, 1 selector error, 2 usage error, 3 missing
 * dependency (graph or boundary index). `--json` keeps stdout machine-only;
 * every diagnostic goes to stderr.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_INDEX_PATH, emptyBoundaries, filterBoundaries, loadBoundaries } from './boundaries';
import type { BoundaryData } from './boundaries';
import { buildBoundaryEnvelope, buildReachEnvelope, buildRefsEnvelope } from './envelope';
import { toDot, toMermaid } from './export';
import {
  EXIT,
  SelectorError,
  UsageError,
  loadGraph,
  type ExitCode,
  type GraphIndex,
} from './graph';
import { refsOf } from './refs';
import { normalizeDepth, traverse, type TraverseDirection } from './reach';
import { renderBoundaries, renderRefs, renderTree } from './render';
import { resolveSelector } from './select';

type Format = 'mermaid' | 'dot';

type ParsedArgs = {
  positional: string[];
  json: boolean;
  help: boolean;
  depth: string | undefined;
  format: string | null;
  out: string | null;
  graph: string | null;
  symbol: string | null;
  file: string | null;
  limit: string | undefined;
  index: string | null;
};

const REACH_COMMANDS: Record<string, TraverseDirection> = {
  callers: 'callers',
  callees: 'callees',
  impact: 'both',
};

const USAGE = {
  main: [
    '用法：scip-graph <子命令> [选择器] [选项]',
    '',
    '子命令：',
    '  callers <选择器> [--depth N]     反向可达：谁（间接）调用它（默认深度 1）',
    '  callees <选择器> [--depth N]     正向可达：它（间接）调用了谁（默认深度 1）',
    '  impact  <选择器> [--depth N]     双向可达（默认深度 1）',
    '  refs    <选择器>                 该节点的全部调用点（入站 / 出站，读 edge.sites）',
    '  boundaries [--symbol S] [--file G] [--limit N]   未解析 callee（读 fork 索引）',
    '',
    '通用选项：--json  --format mermaid|dot  --out <file>  --graph <path>  --help',
    '选择器：<file>:<line>（精确 id）| <file>（整文件，支持 glob）| name（精确→子串）',
  ].join('\n'),
  reach: [
    '用法：scip-graph <callers|callees|impact> <选择器> [--depth N] [--json]',
    '                [--format mermaid|dot] [--out <file>] [--graph <path>]',
    '  选择器：<file>:<line>（精确 id）| <file>（整文件，支持 glob）| name（精确→子串）',
    '  --depth N   BFS 层数，默认 1（0 表示只看目标自身）',
    '  --json      输出稳定 JSON 信封（query/selector/depth/count/results/edges）',
    '  --format    mermaid：Markdown 代码块里的 flowchart；dot：Graphviz',
  ].join('\n'),
  refs: [
    '用法：scip-graph refs <选择器> [--json] [--format mermaid|dot] [--out <file>]',
    '  --json 输出 {query,selector,count,results:{incoming,outgoing}}',
  ].join('\n'),
  boundaries: [
    '用法：scip-graph boundaries [--symbol <名>] [--file <glob>] [--limit N] [--json] [--index <path>]',
    '  读取 fork SCIP 索引，列出 callee 解析不到 in-repo 定义的调用点；',
    '  类别：runes | builtins | node_modules | unclassified。',
    '  索引缺失：stderr 提示 + 空结果 + 退出码 3（--json 也发空信封）。',
  ].join('\n'),
};

const FLAG_ALIASES: Record<string, string> = { '--out-file': '--out' };

/** Hand-rolled argument parser. `--flag=value` and `--flag value` both work. */
function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positional: [],
    json: false,
    help: false,
    depth: undefined,
    format: null,
    out: null,
    graph: null,
    symbol: null,
    file: null,
    limit: undefined,
    index: null,
  };
  const valueFlags: Record<string, (value: string) => void> = {
    '--depth': (value) => (parsed.depth = value),
    '--format': (value) => (parsed.format = value),
    '--out': (value) => (parsed.out = value),
    '--graph': (value) => (parsed.graph = value),
    '--symbol': (value) => (parsed.symbol = value),
    '--file': (value) => (parsed.file = value),
    '--limit': (value) => (parsed.limit = value),
    '--index': (value) => (parsed.index = value),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = FLAG_ALIASES[args[index]] ?? args[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(0, eq);
      const handler = valueFlags[name];
      if (!handler) throw new UsageError(`未知选项 ${name}`);
      handler(arg.slice(eq + 1));
    } else if (valueFlags[arg]) {
      index += 1;
      if (index >= args.length) throw new UsageError(`${arg} 缺少值`);
      valueFlags[arg](args[index]);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`未知选项 ${arg}`);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function requireSelector(parsed: ParsedArgs, command: string): string {
  if (parsed.positional.length === 0) throw new UsageError(`${command} 缺少选择器`);
  if (parsed.positional.length > 1) {
    throw new UsageError(`${command} 只接受一个选择器，收到：${parsed.positional.join(', ')}`);
  }
  return parsed.positional[0];
}

function selectorErrorReport(error: SelectorError): void {
  process.stderr.write(`选择器错误（${error.code}）：${error.message}\n`);
  for (const candidate of error.candidates ?? []) {
    process.stderr.write(`  - ${candidate.name}  (${candidate.file}:${candidate.line})\n`);
  }
}

function normalizeLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0) throw new UsageError(`--limit 必须是非负整数`);
  return limit;
}

/** Write an export: `--out` writes a file + stderr notice, else stdout. */
function emitExport(command: string, content: string, parsed: ParsedArgs): void {
  if (parsed.out) {
    writeFileSync(parsed.out, `${content}\n`);
    process.stderr.write(`[scip-graph] ${command} 子图已写入 ${parsed.out}（${parsed.format}）\n`);
  } else {
    process.stdout.write(`${content}\n`);
  }
}

/** Validate `--format` and render the focused sub-graph. */
function renderExport(
  graph: GraphIndex,
  nodeIds: string[],
  edges: GraphIndex['edges'],
  parsed: ParsedArgs,
): string {
  const format = parsed.format as Format | null;
  if (format !== 'mermaid' && format !== 'dot') {
    throw new UsageError(`--format 只支持 mermaid|dot，收到 ${parsed.format}`);
  }
  return format === 'mermaid' ? toMermaid(graph, nodeIds, edges) : toDot(graph, nodeIds, edges);
}

function emitJson(envelope: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

function runReach(command: string, graph: GraphIndex, parsed: ParsedArgs): ExitCode {
  if (parsed.help) {
    process.stdout.write(`${USAGE.reach}\n`);
    return EXIT.OK;
  }
  const selector = requireSelector(parsed, command);
  if (parsed.json && parsed.format) throw new UsageError('--json 与 --format 不能同时使用');
  const roots = resolveSelector(graph, selector);
  const result = traverse(graph, {
    start: roots,
    direction: REACH_COMMANDS[command],
    depth: parsed.depth ?? 1,
  });
  if (parsed.format) {
    const nodeIds = result.nodes.map((item) => item.id);
    emitExport(command, renderExport(graph, nodeIds, result.edges, parsed), parsed);
    return EXIT.OK;
  }
  if (parsed.json) emitJson(buildReachEnvelope(command, selector, result, graph));
  else process.stdout.write(`${renderTree(graph, result, { rootIds: roots })}\n`);
  return EXIT.OK;
}

function runRefs(graph: GraphIndex, parsed: ParsedArgs): ExitCode {
  if (parsed.help) {
    process.stdout.write(`${USAGE.refs}\n`);
    return EXIT.OK;
  }
  const selector = requireSelector(parsed, 'refs');
  if (parsed.json && parsed.format) throw new UsageError('--json 与 --format 不能同时使用');
  const roots = resolveSelector(graph, selector);
  if (roots.length !== 1) {
    throw new UsageError(`refs 需要唯一节点，选择器命中了 ${roots.length} 个；请用 <file>:<line>`);
  }
  const refs = refsOf(graph, roots[0]);
  if (parsed.format) {
    const edges = graph.edges.filter((edge) => edge.from === roots[0] || edge.to === roots[0]);
    const neighbors = new Set<string>([roots[0]]);
    for (const edge of edges) {
      neighbors.add(edge.from);
      neighbors.add(edge.to);
    }
    const content = renderExport(graph, [...neighbors], edges, parsed);
    emitExport('refs', content, parsed);
    return EXIT.OK;
  }
  if (parsed.json) emitJson(buildRefsEnvelope(selector, refs));
  else process.stdout.write(`${renderRefs(graph, roots[0], refs)}\n`);
  return EXIT.OK;
}

function runBoundaries(parsed: ParsedArgs): ExitCode {
  if (parsed.help) {
    process.stdout.write(`${USAGE.boundaries}\n`);
    return EXIT.OK;
  }
  if (parsed.positional.length > 0) throw new UsageError('boundaries 不接受位置参数选择器');
  if (parsed.format) throw new UsageError('boundaries 不支持 --format（没有可导出的子图）');
  const limit = normalizeLimit(parsed.limit);
  const indexPath = parsed.index ? resolve(parsed.index) : resolve(DEFAULT_INDEX_PATH);
  let data: BoundaryData;
  let exitCode: ExitCode = EXIT.OK;
  if (!existsSync(indexPath)) {
    process.stderr.write(
      `[scip-graph] fork 索引不存在：${indexPath}\n` +
        `  未解析边界无法计算；请先构建 fork 版 scip-typescript 并生成索引。\n`,
    );
    data = emptyBoundaries(`index-missing:${indexPath}`);
    exitCode = EXIT.MISSING;
  } else {
    const collected = loadBoundaries(indexPath);
    data = filterBoundaries(collected, { symbol: parsed.symbol, file: parsed.file, limit });
  }
  if (parsed.json) {
    emitJson(buildBoundaryEnvelope(null, data, limit));
  } else {
    process.stdout.write(`${renderBoundaries(data, { indexPath })}\n`);
  }
  return exitCode;
}

function dispatch(argv: string[]): ExitCode {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE.main}\n`);
    return EXIT.OK;
  }
  if (!REACH_COMMANDS[command] && command !== 'refs' && command !== 'boundaries') {
    process.stderr.write(`未知子命令 "${command}"\n${USAGE.main}\n`);
    return EXIT.USAGE;
  }
  const parsed = parseArgs(rest);
  if (command === 'boundaries') return runBoundaries(parsed);
  const graph = loadGraph(parsed.graph);
  if (command === 'refs') return runRefs(graph, parsed);
  return runReach(command, graph, parsed);
}

/** Main entry (testable): returns an exit code, never calls `process.exit`. */
export function runCli(argv: string[]): ExitCode {
  try {
    return dispatch(argv);
  } catch (error) {
    if (error instanceof SelectorError) {
      selectorErrorReport(error);
      return EXIT.SELECTOR;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.USAGE;
    }
    throw error;
  }
}

/** Re-exported for convenience. */
export { USAGE };
