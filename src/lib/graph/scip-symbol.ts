/**
 * Parser for SCIP symbol strings — the containment hierarchy encoded in the
 * descriptors of a symbol, without any extra index data.
 *
 * A SCIP symbol looks like:
 *
 *     scip-typescript npm gpen-js 0.0.1 `src`/`lib`/`graph`/`schema.ts`/SgNode#kind.
 *     └── scheme ───┘ └ mgr ┘ └ pkg ─┘ └ver ┘ └──────────── descriptors ────────────┘
 *
 * The descriptor suffixes encode the hierarchy:
 *   name/   namespace (module/package)
 *   name#   type (class/interface/struct)
 *   name.   term (field/variable/constant)
 *   name(). method
 *   (name)  parameter
 *   [name]  type-parameter
 *   name:   meta
 *
 * Spec: https://github.com/sourcegraph/scip/blob/main/scip.proto
 *
 * Pure, framework-free module so it can be unit-tested and reused by the query
 * CLI (`local N` symbols are document-scoped; callers must resolve them per
 * file, see `scripts/derive-graph.ts`). Port of
 * `scip-symbol-graph/app/scip.py` (see docs/scip-symbol-graph-review.md).
 */

export type DescriptorKind =
  | 'namespace'
  | 'type'
  | 'term'
  | 'method'
  | 'parameter'
  | 'type-parameter'
  | 'meta';

export type Descriptor = {
  name: string;
  kind: DescriptorKind;
  /** Exact source substring, so the symbol can be re-assembled losslessly. */
  raw: string;
};

export type ParsedSymbol = {
  raw: string;
  isLocal: boolean;
  /** `"<scheme> <manager> <package> <version> "` (trailing space) or `''`. */
  packagePrefix: string;
  scheme: string;
  manager: string;
  package: string;
  version: string;
  descriptors: Descriptor[];
};

/** Coarse display kind for a descriptor. */
export const KIND_FROM_DESCRIPTOR: Record<DescriptorKind, string> = {
  namespace: 'Module',
  type: 'Class',
  term: 'Variable',
  method: 'Method',
  parameter: 'Parameter',
  'type-parameter': 'TypeParameter',
  meta: 'Meta',
};

const STOP = new Set(['/', '#', '.', '(', ')', ':', '[', ']', '`']);

/** Read a (possibly backtick-escaped) name starting at `i`. */
function readName(source: string, start: number): { name: string; next: number } {
  if (source[start] === '`') {
    let j = start + 1;
    const buf: string[] = [];
    while (j < source.length) {
      if (source[j] === '`') {
        if (source[j + 1] === '`') {
          // Escaped backtick.
          buf.push('`');
          j += 2;
          continue;
        }
        break;
      }
      buf.push(source[j]);
      j += 1;
    }
    return { name: buf.join(''), next: j + 1 };
  }
  let j = start;
  while (j < source.length && !STOP.has(source[j])) j += 1;
  return { name: source.slice(start, j), next: j };
}

/** Split the descriptor part of a symbol into its components. */
export function parseDescriptors(desc: string): Descriptor[] {
  const components: Descriptor[] = [];
  let i = 0;
  const n = desc.length;
  while (i < n) {
    const start = i;
    const char = desc[i];
    if (char === '(') {
      const j = desc.indexOf(')', i);
      if (j === -1) break;
      components.push({ name: desc.slice(i + 1, j), kind: 'parameter', raw: desc.slice(start, j + 1) });
      i = j + 1;
      continue;
    }
    if (char === '[') {
      const j = desc.indexOf(']', i);
      if (j === -1) break;
      components.push({
        name: desc.slice(i + 1, j),
        kind: 'type-parameter',
        raw: desc.slice(start, j + 1),
      });
      i = j + 1;
      continue;
    }

    const { name, next } = readName(desc, i);
    i = next;
    if (i < n && desc[i] === '(') {
      // Method: name() then `.`
      const k = desc.indexOf(')', i);
      if (k === -1) break;
      i = k + 1;
      if (i < n && desc[i] === '.') i += 1;
      components.push({ name, kind: 'method', raw: desc.slice(start, i) });
    } else if (i < n && desc[i] === '/') {
      i += 1;
      components.push({ name, kind: 'namespace', raw: desc.slice(start, i) });
    } else if (i < n && desc[i] === '#') {
      i += 1;
      components.push({ name, kind: 'type', raw: desc.slice(start, i) });
    } else if (i < n && desc[i] === ':') {
      i += 1;
      components.push({ name, kind: 'meta', raw: desc.slice(start, i) });
    } else if (i < n && desc[i] === '.') {
      i += 1;
      components.push({ name, kind: 'term', raw: desc.slice(start, i) });
    } else {
      components.push({ name, kind: 'term', raw: desc.slice(start, i) || name });
    }
  }
  return components;
}

/** Parse a SCIP symbol string into its package prefix and descriptors. */
export function parseSymbol(symbol: string): ParsedSymbol {
  if (symbol.startsWith('local ')) {
    return {
      raw: symbol,
      isLocal: true,
      packagePrefix: '',
      scheme: 'local',
      manager: '',
      package: '',
      version: '',
      descriptors: parseDescriptors(symbol.slice('local '.length)),
    };
  }
  // `str.split(' ', 4)` semantics: at most 5 parts, remainder in the last slot.
  const parts = symbol.split(' ');
  const head = parts.length > 5 ? [...parts.slice(0, 4), parts.slice(4).join(' ')] : parts;
  if (head.length < 5) {
    return {
      raw: symbol,
      isLocal: false,
      packagePrefix: '',
      scheme: '',
      manager: '',
      package: '',
      version: '',
      descriptors: parseDescriptors(symbol),
    };
  }
  const [scheme, manager, pkg, version, desc] = head;
  return {
    raw: symbol,
    isLocal: false,
    packagePrefix: `${scheme} ${manager} ${pkg} ${version} `,
    scheme,
    manager,
    package: pkg,
    version,
    descriptors: parseDescriptors(desc),
  };
}

/** SCIP symbol of the immediate container, or `null` for a top-level symbol. */
export function parentSymbol(symbol: string): string | null {
  const parsed = parseSymbol(symbol);
  if (parsed.descriptors.length <= 1) return null;
  // Drop the trailing descriptor (including a meta `__init__:` self-marker) so a
  // member's parent is its owner.
  const parentDescriptors = parsed.descriptors.slice(0, -1);
  if (parentDescriptors.length === 0) return null;
  return parsed.packagePrefix + parentDescriptors.map((d) => d.raw).join('');
}

/** Human display name: the last descriptor's name (fallback `symbol`). */
export function displayName(symbol: string): string {
  const parsed = parseSymbol(symbol);
  if (parsed.descriptors.length === 0) return symbol;
  return parsed.descriptors[parsed.descriptors.length - 1].name || symbol;
}

/** Coarse node kind inferred from the last descriptor. */
export function leafKind(symbol: string): string {
  const parsed = parseSymbol(symbol);
  const last = parsed.descriptors[parsed.descriptors.length - 1];
  if (!last) return 'Unknown';
  return KIND_FROM_DESCRIPTOR[last.kind];
}

/** Root-to-leaf descriptors (the SCIP symbol itself is the leaf). */
export function descriptorChain(symbol: string): Descriptor[] {
  return parseSymbol(symbol).descriptors;
}

/** Faithful round-trip check: re-assembling the parts yields the original. */
export function reassemble(parsed: ParsedSymbol): string {
  return parsed.packagePrefix + parsed.descriptors.map((d) => d.raw).join('');
}
