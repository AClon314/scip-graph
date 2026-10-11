import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  descriptorChain,
  displayName,
  leafKind,
  parentSymbol,
  parseSymbol,
  reassemble,
  type DescriptorKind,
} from '../src/lib/graph/scip-symbol';

const CHAIN = (symbol: string): [DescriptorKind, string][] =>
  descriptorChain(symbol).map((d) => [d.kind, d.name] as [DescriptorKind, string]);

describe('parseSymbol', () => {
  test('python method with parameter', () => {
    const symbol =
      'scip-python python order-service 2.1.0 `order_service.errors`/AppError#__init__().(message)';
    const parsed = parseSymbol(symbol);
    expect(parsed.isLocal).toBe(false);
    expect(parsed.package).toBe('order-service');
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.packagePrefix).toBe('scip-python python order-service 2.1.0 ');
    expect(CHAIN(symbol)).toEqual([
      ['namespace', 'order_service.errors'],
      ['type', 'AppError'],
      ['method', '__init__'],
      ['parameter', 'message'],
    ]);
    expect(displayName(symbol)).toBe('message');
    expect(leafKind(symbol)).toBe('Parameter');
  });

  test('typescript field', () => {
    const symbol = 'scip-typescript npm gpen-js 0.0.1 `src`/`lib`/`graph`/`schema.ts`/SgNode#kind.';
    expect(CHAIN(symbol)).toEqual([
      ['namespace', 'src'],
      ['namespace', 'lib'],
      ['namespace', 'graph'],
      ['namespace', 'schema.ts'],
      ['type', 'SgNode'],
      ['term', 'kind'],
    ]);
    expect(displayName(symbol)).toBe('kind');
    expect(leafKind(symbol)).toBe('Variable');
  });

  test('local symbol is document-scoped and has no package prefix', () => {
    const parsed = parseSymbol('local 3');
    expect(parsed.isLocal).toBe(true);
    expect(parsed.packagePrefix).toBe('');
    expect(CHAIN('local 3')).toEqual([['term', '3']]);
    expect(parentSymbol('local 3')).toBeNull();
  });

  test('type parameter and meta descriptors', () => {
    expect(CHAIN('scip-typescript npm pkg 1.0.0 `a.ts`/Foo#[T]')).toEqual([
      ['namespace', 'a.ts'],
      ['type', 'Foo'],
      ['type-parameter', 'T'],
    ]);
    expect(leafKind('scip-typescript npm pkg 1.0.0 `a.ts`/Foo#__init__:')).toBe('Meta');
  });

  test('backtick escaping is lossless', () => {
    // ``` inside a backtick name is an escaped single backtick.
    const symbol = 'scip-typescript npm pkg 1.0.0 `a``b`/c.';
    expect(CHAIN(symbol)).toEqual([
      ['namespace', 'a`b'],
      ['term', 'c'],
    ]);
    expect(reassemble(parseSymbol(symbol))).toBe(symbol);
  });

  test('unrecognized shape falls back to whole-symbol descriptors', () => {
    const parsed = parseSymbol('not-a-scip-symbol');
    expect(parsed.packagePrefix).toBe('');
    expect(parsed.descriptors.length).toBeGreaterThan(0);
  });
});

describe('parentSymbol', () => {
  test('walks from member to owner', () => {
    const symbol = 'scip-typescript npm pkg 1.0.0 `src`/`a.ts`/Foo#bar().';
    expect(parentSymbol(symbol)).toBe('scip-typescript npm pkg 1.0.0 `src`/`a.ts`/Foo#');
    expect(parentSymbol(parentSymbol(symbol)!)).toBe('scip-typescript npm pkg 1.0.0 `src`/`a.ts`/');
  });

  test('top-level namespace has no parent', () => {
    expect(parentSymbol('scip-typescript npm pkg 1.0.0 `src`/')).toBeNull();
  });

  test('meta self-marker is skipped, not treated as its own level', () => {
    expect(parentSymbol('scip-typescript npm pkg 1.0.0 `src`/`a.ts`/Foo#__init__:')).toBe(
      'scip-typescript npm pkg 1.0.0 `src`/`a.ts`/Foo#',
    );
  });

  test('every real fork-index symbol round-trips and terminates its ancestor chain', () => {
    const path = '../out/.cache/scip/index-fork.json';
    if (!existsSync(path)) return; // fixture not generated on this machine
    const index = JSON.parse(readFileSync(path, 'utf8')) as {
      documents: { symbols?: { symbol?: string }[] }[];
    };
    let checked = 0;
    for (const doc of index.documents) {
      for (const info of doc.symbols ?? []) {
        const symbol = info.symbol;
        if (!symbol) continue;
        checked += 1;
        const parsed = parseSymbol(symbol);
        if (!parsed.isLocal) expect(reassemble(parsed)).toBe(symbol);
        let cursor: string | null = symbol;
        let hops = 0;
        const seen = new Set<string>();
        while (cursor) {
          expect(seen.has(cursor)).toBe(false); // no cycles
          seen.add(cursor);
          cursor = parentSymbol(cursor);
          hops += 1;
          expect(hops).toBeLessThan(64);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
