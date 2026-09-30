#!/usr/bin/env bun
/**
 * Precompute the offline `d3-force` layout for the global symbol view.
 *
 * The live symbol-level d3-force run costs ~6.5 s in the browser Web Worker.
 * This mirrors the ELK clean-mode cache (`precompute-elk.ts`): run the same
 * simulation once in Node and ship the settled + overlap-free positions as a
 * static file so the browser can load them instantly.
 *
 * The simulation below is a faithful copy of `src/lib/global/layout.worker.ts`
 * (same seeded spiral start, forces and params). `layout.worker.ts` is a Web
 * Worker entry point (`self.onmessage`), so it cannot be imported directly;
 * the shared deterministic cleanup, node sizing and metrics come from
 * `src/lib/global/rect-separation.ts` / `metrics.ts` / `aggregate.ts`.
 *
 * Pipeline:
 *   static/graph.json -> aggregate(symbol) -> d3-force simulation
 *                     -> deterministic rect-separation cleanup (same function
 *                        the worker uses, run until zero overlap)
 *                     -> static/d3force-symbol.json
 *
 * Usage:
 *   bun run precompute:force
 *   bun scripts/precompute-force.ts --graph static/graph.json --out static/d3force-symbol.json
 *   bun scripts/precompute-force.ts --check          # verify an existing file has 0 overlaps
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { aggregate } from '../src/lib/global/aggregate';
import { isForceLayout, type ForceLayout } from '../src/lib/global/force-cache';
import type { LayoutParams } from '../src/lib/global/layout.worker';
import { computeMetrics } from '../src/lib/global/metrics';
import { countOverlaps, radiusOf, separateRects, type RectNode } from '../src/lib/global/rect-separation';
import type { SgGraph } from '../src/lib/graph/schema';
import { Progress } from './progress';

const DEFAULT_GRAPH = 'static/graph.json';
const DEFAULT_OUT = 'static/d3force-symbol.json';

/** Symbol-level tuning, mirrored from `src/routes/global/+page.svelte` (PARAMS.symbol / TICKS.symbol). */
const SYMBOL_TICKS = 400;
const SYMBOL_PARAMS: LayoutParams = {
  linkDistance: 80,
  linkStrength: 0.15,
  charge: -40,
  chargeDistanceMax: 600,
};
/** Same default seed as `layout.worker.ts` when the caller omits one. */
const DEFAULT_SEED = 0x9e3779b9;
/** Hard cap on the "run until clean" cleanup rounds, so a pathological graph cannot hang. */
const MAX_CLEANUP_PASSES = 20000;
/** Passes per cleanup round (the worker's own cap is 250). */
const CLEANUP_ROUND = 500;

const USAGE = `scip-graph precompute:force — offline d3-force layout for the global symbol view

Usage:
  bun scripts/precompute-force.ts [--graph <graph.json>] [--out <d3force-symbol.json>]
                                  [--ticks <n>] [--seed <n>]
  bun scripts/precompute-force.ts --check [--out <d3force-symbol.json>]

Options:
  --graph <path>   input graph JSON (default: ${DEFAULT_GRAPH})
  --out <path>     output precomputed layout (default: ${DEFAULT_OUT})
  --ticks <n>      simulation ticks (default: ${SYMBOL_TICKS})
  --seed <n>       initial-position seed (default: ${DEFAULT_SEED})
  --check          validate the output file instead of recomputing it
  -h, --help       show this help
`;

interface CliOptions {
  graph: string;
  out: string;
  ticks: number;
  seed: number;
  check: boolean;
  help: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    graph: DEFAULT_GRAPH,
    out: DEFAULT_OUT,
    ticks: SYMBOL_TICKS,
    seed: DEFAULT_SEED,
    check: false,
    help: false,
  };
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
    else if (flag === '--ticks') options.ticks = Number(takeValue(flag, inline, () => argv[++i]));
    else if (flag === '--seed') options.seed = Number(takeValue(flag, inline, () => argv[++i]));
    else if (flag.startsWith('-')) throw new UsageError(`unknown option: ${arg}`);
    else throw new UsageError(`unexpected argument: ${arg}`);
  }
  if (!Number.isInteger(options.ticks) || options.ticks < 0) {
    throw new UsageError(`--ticks must be a non-negative integer`);
  }
  if (!Number.isInteger(options.seed)) throw new UsageError(`--seed must be an integer`);
  return options;
}

/** Node with centre + half-extents, plus the symbol id used to key positions. */
type PlacedNode = RectNode & { id: string };

/** Node datum used by the simulation (position + drawn half-extents). */
interface SimNode extends SimulationNodeDatum {
  id: string;
  hw: number;
  hh: number;
  radius: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  calls: number;
}

/** Deterministic PRNG (same as `layout.worker.ts`). */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertNoOverlap(nodes: readonly PlacedNode[], label: string): void {
  const overlaps = countOverlaps(nodes);
  if (overlaps !== 0) {
    throw new Error(`${label}: ${overlaps} overlapping rect pairs after cleanup`);
  }
}

/**
 * Build + configure the simulation exactly like `layout.worker.ts` does for the
 * symbol level (seeded phyllotaxis start, then link / charge / collide / center).
 */
function buildSimulation(
  agg: ReturnType<typeof aggregate>,
  params: LayoutParams,
  seed: number,
): { sim: ReturnType<typeof forceSimulation<SimNode>>; simNodes: SimNode[] } {
  const rnd = mulberry32(seed);
  const simNodes: SimNode[] = agg.nodes.map((meta, i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const radius = 12 * Math.sqrt(0.5 + i);
    return {
      id: meta.id,
      index: i,
      hw: meta.hw,
      hh: meta.hh,
      radius: radiusOf(meta),
      x: radius * Math.cos(angle) + (rnd() - 0.5) * 4,
      y: radius * Math.sin(angle) + (rnd() - 0.5) * 4,
      vx: 0,
      vy: 0,
    };
  });
  const byId = new Map(simNodes.map((node) => [node.id, node]));
  const links: SimLink[] = agg.edges.map((edge) => ({
    source: byId.get(edge.source) as SimNode,
    target: byId.get(edge.target) as SimNode,
    calls: edge.calls,
  }));

  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance(params.linkDistance ?? 80)
        .strength(params.linkStrength ?? 0.15),
    )
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength(params.charge ?? -40)
        .distanceMax(params.chargeDistanceMax ?? 600),
    )
    .force(
      'collide',
      forceCollide<SimNode>((d) => d.radius)
        .strength(params.collideStrength ?? 1)
        .iterations(params.collideIterations ?? 4),
    )
    .force('center', forceCenter<SimNode>(0, 0))
    .stop();

  return { sim, simNodes };
}

function checkFile(outFile: string): number {
  const parsed: unknown = JSON.parse(readFileSync(outFile, 'utf8'));
  if (!isForceLayout(parsed)) {
    throw new Error(`Invalid precomputed d3-force layout: ${outFile}`);
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
    `[precompute:force] ok ${outFile}: ${nodes.length} positions, ` +
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

  const progress = new Progress({ label: 'precompute:force' });
  progress.set('nodes', agg.nodes.length);
  progress.set('edges', agg.edges.length);

  const t0 = performance.now();
  const { sim, simNodes } = buildSimulation(agg, SYMBOL_PARAMS, options.seed);

  progress.section('d3-force', 'tick');
  const CHUNK = 10;
  let ticked = 0;
  for (let i = 0; i < options.ticks; i += CHUNK) {
    const step = Math.min(CHUNK, options.ticks - i);
    sim.tick(step);
    ticked += step;
    progress.tick(ticked, options.ticks);
    if (ticked % 50 === 0 || ticked >= options.ticks) {
      const snap = computeMetrics(simNodes);
      progress.set('overlap', snap.nodeOverlapPairs);
      progress.set('fill', snap.fillNet);
    }
  }
  const forceMs = performance.now() - t0;

  const overlapsBefore = countOverlaps(simNodes);
  progress.section('cleanup', 'pass');
  progress.set('overlap', overlapsBefore);
  const t1 = performance.now();
  let cleanupPasses = 0;
  let overlaps = overlapsBefore;
  while (overlaps > 0 && cleanupPasses < MAX_CLEANUP_PASSES) {
    cleanupPasses += separateRects(simNodes, CLEANUP_ROUND);
    overlaps = countOverlaps(simNodes);
    progress.tick(cleanupPasses, 0);
    progress.set('overlap', overlaps);
  }
  const cleanupMs = performance.now() - t1;
  progress.done();
  assertNoOverlap(simNodes, 'd3-force');

  const out: ForceLayout = {
    level: 'symbol',
    algorithm: 'd3-force',
    ms: Math.round(forceMs + cleanupMs),
    iterations: ticked,
    cleanupPasses,
    positions: simNodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      w: node.hw * 2,
      h: node.hh * 2,
    })),
  };
  writeFileSync(outFile, JSON.stringify(out));

  const metrics = computeMetrics(simNodes);
  process.stdout.write(
    `[precompute:force] wrote ${outFile}\n` +
      `  d3-force ${forceMs.toFixed(0)} ms + cleanup ${cleanupMs.toFixed(1)} ms ` +
      `(${cleanupPasses} passes) = ${out.ms} ms\n` +
      `  iterations ${out.iterations} · positions ${out.positions.length} · ` +
      `overlap ${metrics.nodeOverlapRatio} · fill ${metrics.fillNet.toFixed(4)}\n`,
  );
  return 0;
}

const invokedDirectly =
  typeof (import.meta as ImportMeta & { main?: boolean }).main === 'boolean'
    ? (import.meta as ImportMeta & { main?: boolean }).main === true
    : Boolean(process.argv[1]?.includes('precompute-force'));

if (invokedDirectly) {
  try {
    process.exit(await runCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `[precompute:force] error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
