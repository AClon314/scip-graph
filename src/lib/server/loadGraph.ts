import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isSgGraph, type SgGraph } from '$lib/graph/schema';
import {
  ELK_STRESS_FILE,
  isElkStressLayout,
  type ElkStressLayout,
} from '$lib/global/elk-stress';

/** Default location when `SCIP_GRAPH_FILE` is not set. */
export const DEFAULT_GRAPH_FILE = 'static/graph.json';

/** Absolute path of the graph JSON to load. */
export function resolveGraphFile(): string {
  const configured = process.env.SCIP_GRAPH_FILE?.trim();
  return resolve(process.cwd(), configured && configured.length > 0 ? configured : DEFAULT_GRAPH_FILE);
}

/**
 * Server-side loader: parse the graph JSON so the client can render it.
 * Returns `null` when no graph file exists yet (derive has not been run).
 */
export async function loadGraph(): Promise<SgGraph | null> {
  const file = resolveGraphFile();
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isSgGraph(parsed)) throw new Error(`Invalid graph JSON (missing nodes/edges): ${file}`);
  return parsed;
}

/** Absolute path of the precomputed ELK stress layout (env override supported). */
export function resolveElkStressFile(): string {
  const configured = process.env.SCIP_GRAPH_ELK_FILE?.trim();
  return resolve(
    process.cwd(),
    configured && configured.length > 0 ? configured : ELK_STRESS_FILE,
  );
}

/**
 * Sibling loader for the Phase-6 precomputed `elk-stress` layout.
 * Returns `null` when the file has not been generated yet (`bun run
 * precompute:elk`), which makes the global view disable the option and fall
 * back to the live d3-force worker.
 */
export async function loadElkStress(): Promise<ElkStressLayout | null> {
  const file = resolveElkStressFile();
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isElkStressLayout(parsed)) {
    throw new Error(`Invalid precomputed ELK stress layout: ${file}`);
  }
  return parsed;
}
