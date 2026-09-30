/**
 * Global keydown handling for the density view.
 *
 * Kept out of the page so the shortcut table lives in one place; the page
 * supplies live accessors for its own state (help overlay, selection, view).
 */

import { isTypingTarget, type Direction } from './keyboard';

export type KeyActions = {
	helpOpen: () => boolean;
	closeHelp: () => void;
	hasSelection: () => boolean;
	clearSelection: () => void;
	moveSelection: (dir: Direction) => void;
	zoomBy: (factor: number) => void;
	fitView: () => void;
	focusSearch: () => void;
	toggleHelp: () => void;
	openLocal: () => void;
	jumpCurrent: () => void;
};

const ARROWS: Record<string, Direction> = {
	ArrowLeft: 'left',
	ArrowRight: 'right',
	ArrowUp: 'up',
	ArrowDown: 'down'
};

/** Process a global keydown event (mirrors the previous inline handler). */
export function handleGlobalKey(event: KeyboardEvent, actions: KeyActions): void {
	const key = event.key;
	if (key === 'Escape') {
		if (actions.helpOpen()) {
			actions.closeHelp();
			return;
		}
		if (isTypingTarget(event.target)) return;
		if (actions.hasSelection()) actions.clearSelection();
		return;
	}
	if (isTypingTarget(event.target)) return;
	const dir = ARROWS[key];
	if (dir) {
		event.preventDefault();
		actions.moveSelection(dir);
		return;
	}
	if (key === '+' || key === '=') {
		event.preventDefault();
		actions.zoomBy(1.2);
		return;
	}
	if (key === '-' || key === '_') {
		event.preventDefault();
		actions.zoomBy(1 / 1.2);
		return;
	}
	if (key === '0') {
		event.preventDefault();
		actions.fitView();
		return;
	}
	if (key === '/') {
		event.preventDefault();
		actions.focusSearch();
		return;
	}
	if (key === '?') {
		event.preventDefault();
		actions.toggleHelp();
		return;
	}
	if (key === 'Enter') {
		event.preventDefault();
		actions.openLocal();
		return;
	}
	if (key === 'j' || key === 'J') {
		event.preventDefault();
		actions.jumpCurrent();
	}
}
