/**
 * Selection pre-animation for the Global → Local handoff.
 *
 * Briefly zooms + glows the current selection so the handoff reads as a
 * continuation rather than a jump cut. The mutable `view` object is updated in
 * place; `setElevate` drives the page's glow value and `draw` re-renders.
 */

import type { AggNode } from './aggregate';
import { selectionBounds, zoomToBounds, type View } from './geometry';

export type SelectionAnimationDeps = {
	view: View;
	selection: ReadonlySet<string>;
	nodeById: ReadonlyMap<string, AggNode>;
	canvas: HTMLCanvasElement | undefined;
	draw: () => void;
	setElevate: (value: number) => void;
};

/**
 * Animate the viewport to the selection bounds, then run `run`. Falls back to
 * an immediate `run()` when there is nothing to animate.
 */
export async function animateSelection(
	deps: SelectionAnimationDeps,
	run: () => void
): Promise<void> {
	const { view, selection, nodeById, canvas, draw, setElevate } = deps;
	const bounds = selectionBounds(selection, nodeById);
	const target = bounds && canvas ? zoomToBounds(bounds, canvas.clientWidth, canvas.clientHeight) : null;
	if (!target || !canvas) {
		run();
		return;
	}
	const start = { k: view.k, tx: view.tx, ty: view.ty };
	const dur = 240;
	const t0 = performance.now();
	await new Promise<void>((resolve) => {
		const step = (now: number) => {
			const t = Math.min(1, (now - t0) / dur);
			const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			view.k = start.k + (target.k - start.k) * e;
			view.tx = start.tx + (target.tx - start.tx) * e;
			view.ty = start.ty + (target.ty - start.ty) * e;
			setElevate(Math.sin(Math.PI * t));
			draw();
			if (t < 1) requestAnimationFrame(step);
			else {
				setElevate(0);
				draw();
				resolve();
			}
		};
		requestAnimationFrame(step);
	});
	run();
}
