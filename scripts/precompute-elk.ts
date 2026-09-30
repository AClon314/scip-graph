#!/usr/bin/env bun
/**
 * Precompute the offline ELK `stress` layout for the global symbol view.
 *
 * Phase 6 acceleration: the original plan's `elk-stress` "clean skeleton" mode
 * took ~74 s of single-threaded ELK.js (GWT-compiled JS) compute per session.
 * Instead of rewriting ELK in WASM / splitting it across worker_threads (both
 * impossible — see `docs/phase6-acceleration.md`), we run it **once in Node**
 * and ship the result as a static file. The browser then loads it instantly.
 *
 * Pipeline:
 *   static/graph.json -> aggregate(symbol) -> ELK stress layout
 *                     -> deterministic rect-separation cleanup (same code as
 *                        `src/lib/global/layout.worker.ts`)
 *                     -> static/elk-stress-symbol.json
 *
 * Usage:
 *   bun run precompute:elk
 *   bun scripts/precompute-elk.ts --graph static/graph.json --out static/elk-stress-symbol.json
 *   bun scripts/precompute-elk.ts --check          # verify an existing file has 0 overlaps
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ELKApi from 'elkjs/lib/elk-api.js';
import type { ELK, ElkNode } from 'elkjs/lib/elk-api.js';
import { aggregate } from '../src/lib/global/aggregate';
import { isElkStressLayout, type ElkStressLayout } from '../src/lib/global/elk-stress';
import { computeMetrics } from '../src/lib/global/metrics';
import { countOverlaps, separateRects, type RectNode } from '../src/lib/global/rect-separation';
import type { SgGraph } from '../src/lib/graph/schema';
import { Progress } from './progress';

const DEFAULT_GRAPH = 'static/graph.json';
const DEFAULT_OUT = 'static/elk-stress-symbol.json';

const USAGE = `scip-graph precompute:elk — offline ELK stress layout for the global symbol view

Usage:
  bun scripts/precompute-elk.ts [--graph <graph.json>] [--out <elk-stress-symbol.json>]
  bun scripts/precompute-elk.ts --check [--out <elk-stress-symbol.json>]

Options:
  --graph <path>   input graph JSON (default: ${DEFAULT_GRAPH})
  --out <path>     output precomputed layout (default: ${DEFAULT_OUT})
  --check          validate the output file instead of recomputing it
  -h, --help       show this help
`;

interface CliOptions {
  graph: string;
  out: string;
  check: boolean;
  help: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { graph: DEFAULT_GRAPH, out: DEFAULT_OUT, check: false, help: false };
  const takeValue = (flag: string, inline: string | undefined, next: () => string | undefined): string => {
    if (inline !== undefined) return inline;
    const value = next();
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--check') options.check = true;
    else if (flag === '--graph') options.graph = takeValue(flag, inline, () => argv[++i]);
    else if (flag === '--out') options.out = takeValue(flag, inline, () => argv[++i]);
    else if (flag.startsWith('-')) throw new UsageError(`unknown option: ${arg}`);
    else throw new UsageError(`unexpected argument: ${arg}`);
  }
  return options;
}

type ElkWorkerLike = new (url?: string) => unknown;

/**
 * Construct an ELK instance backed by elkjs' in-process fake worker.
 *
 * elkjs ships a browserified fake worker (`lib/elk-worker.min.js`) whose UMD
 * wrapper only assigns its CommonJS `Worker` export when `self` is undefined.
 * Bun defines a global `self`, so the module takes the "inside a Web Worker"
 * branch and exports nothing. Hiding `self` for the duration of the
 * (lazily-required) worker-module initialisation restores the Node behaviour.
 */
function createElk(): ELK {
  const require = createRequire(import.meta.url);
  const scope = globalThis as { self?: unknown };
  const savedSelf = scope.self;
  delete scope.self;
  let FakeWorker: ElkWorkerLike;
  try {
    ({ Worker: FakeWorker } = require('elkjs/lib/elk-worker.min.js') as { Worker: ElkWorkerLike });
  } finally {
    if (savedSelf !== undefined) scope.self = savedSelf;
  }
  return new ELKApi({ workerFactory: () => new FakeWorker() as unknown as Worker });
}

/** Node with centre + half-extents, plus the symbol id used to key positions. */
type PlacedNode = RectNode & { id: string };

function assertNoOverlap(nodes: readonly PlacedNode[], label: string): void {
  const overlaps = countOverlaps(nodes);
  if (overlaps !== 0) {
    throw new Error(`${label}: ${overlaps} overlapping rect pairs after cleanup`);
  }
}

function checkFile(outFile: string): number {
  const parsed: unknown = JSON.parse(readFileSync(outFile, 'utf8'));
  if (!isElkStressLayout(parsed)) {
    throw new Error(`Invalid precomputed ELK stress layout: ${outFile}`);
  }
  const nodes: PlacedNode[] = parsed.positions.map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    hw: p.w / 2,
    hh: p.h / 2,
  }));
  assertNoOverlap(nodes, outFile);
  const metrics = computeMetrics(nodes);
  process.stdout.write(
    `[precompute:elk] ok ${outFile}: ${nodes.length} positions, ` +
      `overlap ${metrics.nodeOverlapRatio}, fill ${metrics.fillNet.toFixed(4)}\n`,
  );
  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const outFile = resolve(process.cwd(), options.out);
  if (options.check) return checkFile(outFile);

  const graphFile = resolve(process.cwd(), options.graph);
  const graph = JSON.parse(readFileSync(graphFile, 'utf8')) as SgGraph;
  const agg = aggregate(graph, 'symbol');

  const children: ElkNode[] = agg.nodes.map((n) => ({
    id: n.id,
    width: n.hw * 2,
    height: n.hh * 2,
  }));
  const edges = agg.edges.map((e, i) => ({
    id: `e${i}`,
    sources: [e.source],
    targets: [e.target],
  }));

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'stress',
      'elk.stress.desiredEdgeLength': '100',
      'elk.spacing.nodeNode': '12',
    },
    children,
    edges,
  };

  process.stdout.write(
    `[precompute:elk] ${children.length} symbol nodes, ${edges.length} edges; running ELK stress…\n`,
  );
  const progress = new Progress({ label: 'precompute:elk' });
  progress.set('nodes', children.length);
  progress.set('edges', edges.length);
  progress.section('elk-stress');
  const elk = createElk();
  const t0 = performance.now();
  const layout = await elk.layout(elkGraph);
  const elkMs = performance.now() - t0;
  progress.set('elk', `${elkMs.toFixed(0)}ms`);

  const placed: PlacedNode[] = (layout.children ?? []).map((child) => {
    const w = child.width ?? 0;
    const h = child.height ?? 0;
    return {
      id: child.id,
      x: (child.x ?? 0) + w / 2,
      y: (child.y ?? 0) + h / 2,
      hw: w / 2,
      hh: h / 2,
    };
  });
  if (placed.length !== children.length) {
    throw new Error(`ELK returned ${placed.length}/${children.length} symbol nodes`);
  }

  const t1 = performance.now();
  // ELK stress leaves a small number of drawn-rect overlaps; relax with the
  // exact same deterministic pass the live worker uses. The sparse residual
  // needs more than the worker's 250-pass budget, so run it in 500-pass
  // rounds until clean (hard-capped so a pathological graph cannot hang).
  const MAX_CLEANUP_PASSES = 20000;
  let cleanupPasses = 0;
  let overlaps = countOverlaps(placed);
  progress.section('cleanup', 'pass');
  progress.set('overlap', overlaps);
  while (overlaps > 0 && cleanupPasses < MAX_CLEANUP_PASSES) {
    cleanupPasses += separateRects(placed, 500);
    overlaps = countOverlaps(placed);
    progress.tick(cleanupPasses, 0);
    progress.set('overlap', overlaps);
  }
  const cleanupMs = performance.now() - t1;
  progress.done();
  assertNoOverlap(placed, 'elk-stress');

  const out: ElkStressLayout = {
    level: 'symbol',
    ms: Math.round(elkMs + cleanupMs),
    cleanupPasses,
    positions: placed.map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.hw * 2, h: p.hh * 2 })),
  };
  writeFileSync(outFile, JSON.stringify(out));

  const metrics = computeMetrics(placed);
  process.stdout.write(
    `[precompute:elk] wrote ${outFile}\n` +
      `  elk ${elkMs.toFixed(0)} ms + cleanup ${cleanupMs.toFixed(1)} ms ` +
      `(${cleanupPasses} passes) = ${out.ms} ms\n` +
      `  positions ${out.positions.length} · overlap ${metrics.nodeOverlapRatio} · ` +
      `fill ${metrics.fillNet.toFixed(4)}\n`,
  );
  return 0;
}

const invokedDirectly =
  typeof (import.meta as ImportMeta & { main?: boolean }).main === 'boolean'
    ? (import.meta as ImportMeta & { main?: boolean }).main === true
    : Boolean(process.argv[1]?.includes('precompute-elk'));

if (invokedDirectly) {
  try {
    process.exit(await runCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `[precompute:elk] error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
