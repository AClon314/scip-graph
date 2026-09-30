/**
 * Precomputed `d3-force` layout for the global view (symbol level).
 *
 * The live symbol-level d3-force run takes ~6.5 s in the Web Worker. This
 * mirrors the ELK clean-mode cache (`elk-stress.ts`): the same layout is also
 * computed once offline (`bun run precompute:force`) and shipped as a static
 * file so the browser can load it instantly. When the file is absent the global
 * view falls back to the live worker run.
 *
 * The file is derived and graph-specific, so it is git-ignored. Positions use
 * the same convention as `ElkStressPosition`: `x`/`y` is the drawn rectangle
 * centre and `w`/`h` are its full extents in world units.
 */

/** Default on-disk location, relative to the project root. */
export const FORCE_SYMBOL_FILE = 'static/d3force-symbol.json';

export type ForcePosition = { id: string; x: number; y: number; w: number; h: number };

export type ForceLayout = {
	/** Only the symbol level is precomputed (it is the only slow level). */
	level: 'symbol';
	algorithm: 'd3-force';
	/** Wall time of the offline force simulation + rect-separation cleanup. */
	ms: number;
	/** Iterations the offline simulation actually settled at. */
	iterations: number;
	/** Cleanup passes the offline run needed (0 when the force run was clean). */
	cleanupPasses: number;
	positions: ForcePosition[];
};

function isPosition(value: unknown): value is ForcePosition {
	if (typeof value !== 'object' || value === null) return false;
	const p = value as Partial<ForcePosition>;
	return (
		typeof p.id === 'string' &&
		typeof p.x === 'number' &&
		typeof p.y === 'number' &&
		typeof p.w === 'number' &&
		typeof p.h === 'number'
	);
}

/** Narrow an arbitrary parsed JSON value to a `ForceLayout`. */
export function isForceLayout(value: unknown): value is ForceLayout {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<ForceLayout>;
	return (
		candidate.level === 'symbol' &&
		candidate.algorithm === 'd3-force' &&
		typeof candidate.ms === 'number' &&
		Array.isArray(candidate.positions) &&
		candidate.positions.every(isPosition)
	);
}
