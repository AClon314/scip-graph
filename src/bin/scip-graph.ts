#!/usr/bin/env bun
/**
 * Thin entrypoint for the `scip-graph` query CLI.
 *
 * Always runs (it is never imported): delegates to `runCli` and propagates the
 * exit code. All logic lives under `$lib/query`.
 *
 * Usage:
 *   bun src/bin/scip-graph.ts <callers|callees|impact|refs|boundaries> [selector] [options]
 *   bun run scip-graph -- callers "src/lib/components/areas/CodeArea.svelte:86" --json
 */

import { runCli } from '../lib/query/cli';

process.exit(runCli(process.argv.slice(2)));
