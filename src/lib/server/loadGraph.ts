import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isSgGraph, type SgGraph } from '$lib/graph/schema';

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
