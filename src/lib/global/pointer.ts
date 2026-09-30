/**
 * Pointer / touch / wheel gesture controller for the global density canvas.
 *
 * Owns the non-reactive gesture state (active pointers, drag, pinch, tap
 * suppression) and reports everything else through the `PointerHost` callbacks
 * so the page keeps its reactive state and rendering. Behaviour is a direct
 * extraction of the previous inline handlers.
 */

import type { AggNode } from './aggregate';
import type { Box, View } from './geometry';
import { hitTest as hitTestNode, zoomAround } from './geometry';

/** Pointer travel (px) below which a pointerup counts as a tap, not a pan. */
const TAP_SLOP = 6;

export type PointerPoint = { x: number; y: number };

type DragState = {
	mode: 'pan' | 'select';
	startX: number;
	startY: number;
	moved: boolean;
	tx: number;
	ty: number;
	selStart: [number, number];
	rect?: Box;
};

type PinchState = {
	startDist: number;
	startK: number;
	midX: number;
	midY: number;
	startTx: number;
	startTy: number;
};

export type PointerHost = {
	canvas: () => HTMLCanvasElement | undefined;
	/** Mutated in place by the controller. */
	view: View;
	draw: () => void;
	select: (ids: string[]) => void;
	hitTest: (sx: number, sy: number) => AggNode | null;
	selectionSize: () => number;
	showTooltip: (node: AggNode, clientX: number, clientY: number) => void;
	hideTooltip: () => void;
	setPanning: (value: boolean) => void;
	setSelecting: (value: boolean) => void;
	setSelBox: (box: Box | null) => void;
	setHoverId: (id: string | null) => void;
	finalizeBoxSelect: (rect: Box) => void;
};

function pointerPos(canvasEl: HTMLCanvasElement | undefined, event: { clientX: number; clientY: number }): [number, number] {
	if (!canvasEl) return [0, 0];
	const rect = canvasEl.getBoundingClientRect();
	return [event.clientX - rect.left, event.clientY - rect.top];
}

export function createPointerController(host: PointerHost) {
	const activePointers = new Map<number, PointerPoint>();
	let drag: DragState | null = null;
	let pinch: PinchState | null = null;
	/** Set once a gesture becomes a pinch so the trailing finger-up is not a tap. */
	let suppressTap = false;
	let canvasEl: HTMLCanvasElement | null = null;

	function onDown(event: PointerEvent): void {
		if (!canvasEl) return;
		const [x, y] = pointerPos(canvasEl, event);
		activePointers.set(event.pointerId, { x, y });
		try {
			canvasEl.setPointerCapture(event.pointerId);
		} catch {
			/* synthetic pointer events have no active pointer to capture */
		}

		// Second finger → pinch zoom; abandon any pan/select gesture in flight.
		if (activePointers.size === 2) {
			drag = null;
			host.setSelBox(null);
			host.setPanning(false);
			host.setSelecting(false);
			const [p1, p2] = [...activePointers.values()];
			const midX = (p1.x + p2.x) / 2;
			const midY = (p1.y + p2.y) / 2;
			const startDist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
			pinch = {
				startDist,
				startK: host.view.k,
				midX,
				midY,
				startTx: host.view.tx,
				startTy: host.view.ty
			};
			suppressTap = true;
			return;
		}
		if (activePointers.size > 2 || pinch) return; // ignore extra fingers mid-pinch

		const mode = event.shiftKey ? 'select' : 'pan';
		drag = {
			mode,
			startX: x,
			startY: y,
			moved: false,
			tx: host.view.tx,
			ty: host.view.ty,
			selStart: [x, y]
		};
		host.setPanning(mode === 'pan');
		host.setSelecting(mode === 'select');
		if (mode === 'select') host.setSelBox({ x, y, w: 0, h: 0 });
	}

	function onMove(event: PointerEvent): void {
		if (activePointers.has(event.pointerId)) {
			const [px, py] = pointerPos(canvasEl ?? undefined, event);
			activePointers.set(event.pointerId, { x: px, y: py });
		}

		// Two-finger pinch: scale around the midpoint (and pan with it).
		if (pinch && activePointers.size >= 2) {
			const [p1, p2] = [...activePointers.values()];
			const curMidX = (p1.x + p2.x) / 2;
			const curMidY = (p1.y + p2.y) / 2;
			const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
			const k = Math.max(0.02, Math.min(40, pinch.startK * (dist / pinch.startDist)));
			const wx = (pinch.midX - pinch.startTx) / pinch.startK;
			const wy = (pinch.midY - pinch.startTy) / pinch.startK;
			host.view.k = k;
			host.view.tx = curMidX - wx * k;
			host.view.ty = curMidY - wy * k;
			host.draw();
			return;
		}

		const [x, y] = pointerPos(canvasEl ?? undefined, event);
		if (drag) {
			const dx = x - drag.startX;
			const dy = y - drag.startY;
			if (Math.hypot(dx, dy) > TAP_SLOP) drag.moved = true;
			if (drag.mode === 'pan') {
				host.view.tx = drag.tx + dx;
				host.view.ty = drag.ty + dy;
				host.draw();
			} else {
				const x0 = Math.min(drag.selStart[0], x);
				const y0 = Math.min(drag.selStart[1], y);
				const w = Math.abs(x - drag.selStart[0]);
				const h = Math.abs(y - drag.selStart[1]);
				drag.rect = { x: x0, y: y0, w, h };
				host.setSelBox(drag.rect);
			}
			return;
		}
		const node = host.hitTest(x, y);
		host.setHoverId(node ? node.id : null);
		if (node) host.showTooltip(node, event.clientX, event.clientY);
		else host.hideTooltip();
		host.draw();
	}

	function onUp(event: PointerEvent): void {
		activePointers.delete(event.pointerId);
		const wasPinch = pinch !== null;
		if (wasPinch) {
			// Keep suppressing until every finger is up so a pinch never taps.
			if (activePointers.size < 2) pinch = null;
			suppressTap = true;
			host.setPanning(false);
			host.setSelecting(false);
			host.setSelBox(null);
			drag = null;
			release(event.pointerId);
			return;
		}

		host.setPanning(false);
		host.setSelecting(false);
		if (drag && drag.mode === 'select' && drag.rect) {
			host.finalizeBoxSelect(drag.rect);
		} else if (drag && drag.mode === 'pan' && !drag.moved && !suppressTap) {
			// A tap/click (movement below the slop) activates the node under the
			// pointer; clicking empty space clears the selection.
			const [x, y] = pointerPos(canvasEl ?? undefined, event);
			const node = host.hitTest(x, y);
			if (node) {
				host.select([node.id]);
				host.hideTooltip();
			} else if (host.selectionSize()) {
				host.select([]);
			}
		}
		suppressTap = false;
		host.setSelBox(null);
		drag = null;
		release(event.pointerId);
	}

	function onCancel(event: PointerEvent): void {
		activePointers.delete(event.pointerId);
		host.setPanning(false);
		host.setSelecting(false);
		host.setSelBox(null);
		drag = null;
		pinch = null;
		suppressTap = false;
	}

	function onLeave(): void {
		if (drag) return;
		host.setHoverId(null);
		host.hideTooltip();
		host.draw();
	}

	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		const [x, y] = pointerPos(canvasEl ?? undefined, event);
		const factor = Math.exp(-event.deltaY * 0.0015);
		const next = zoomAround(host.view, x, y, factor);
		host.view.k = next.k;
		host.view.tx = next.tx;
		host.view.ty = next.ty;
		host.draw();
	}

	function release(pointerId: number): void {
		try {
			canvasEl?.releasePointerCapture(pointerId);
		} catch {
			/* pointer already released */
		}
	}

	function attach(canvas: HTMLCanvasElement): void {
		canvasEl = canvas;
		canvas.addEventListener('pointerdown', onDown);
		canvas.addEventListener('pointermove', onMove);
		canvas.addEventListener('pointerup', onUp);
		canvas.addEventListener('pointercancel', onCancel);
		canvas.addEventListener('pointerleave', onLeave);
		canvas.addEventListener('wheel', onWheel, { passive: false });
	}

	function detach(): void {
		if (!canvasEl) return;
		canvasEl.removeEventListener('pointerdown', onDown);
		canvasEl.removeEventListener('pointermove', onMove);
		canvasEl.removeEventListener('pointerup', onUp);
		canvasEl.removeEventListener('pointercancel', onCancel);
		canvasEl.removeEventListener('pointerleave', onLeave);
		canvasEl.removeEventListener('wheel', onWheel);
		canvasEl = null;
	}

	return { attach, detach };
}
