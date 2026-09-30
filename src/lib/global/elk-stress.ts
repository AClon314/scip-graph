/**
 * Precomputed ELK `stress` layout for the global view (symbol level).
 *
 * This is the Phase-6 acceleration: the offline `elk-stress` "clean skeleton"
 * mode from the original plan, run once in Node (`bun run precompute:elk`) and
 * shipped as a static file so the browser loads it instantly instead of paying
 * the ~74 s single-threaded ELK compute cost per session.
 *
 * The file is derived and graph-specific, so it is git-ignored. When it is
 * absent the global view falls back to the live d3-force worker.
 *
 * Positions are stored the same way the app consumes them: `x`/`y` is the
 * *centre* of the drawn rectangle and `w`/`h` are its full extents in world
 * units (matching the aggregate node's `x`/`y` + `2*hw`/`2*hh`).
 */

/** Default on-disk location, relative to the project root. */
export const ELK_STRESS_FILE = 'static/elk-stress-symbol.json';

export type ElkStressPosition = { id: string; x: number; y: number; w: number; h: number };

export type ElkStressLayout = {
  /** Only the symbol level is precomputed (ELK stress is whole-graph). */
  level: 'symbol';
  /** Wall time of the offline ELK compute + rect-separation cleanup, in ms. */
  ms: number;
  /** Number of cleanup passes the offline run needed (0 when ELK was clean). */
  cleanupPasses: number;
  positions: ElkStressPosition[];
};

function isPosition(value: unknown): value is ElkStressPosition {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<ElkStressPosition>;
  return (
    typeof p.id === 'string' &&
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    typeof p.w === 'number' &&
    typeof p.h === 'number'
  );
}

/** Narrow an arbitrary parsed JSON value to an `ElkStressLayout`. */
export function isElkStressLayout(value: unknown): value is ElkStressLayout {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ElkStressLayout>;
  return (
    candidate.level === 'symbol' &&
    typeof candidate.ms === 'number' &&
    Array.isArray(candidate.positions) &&
    candidate.positions.every(isPosition)
  );
}
