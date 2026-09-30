/**
 * Outline splitter drag for the global view.
 *
 * Clamps the sidebar width, captures the pointer for the duration of the drag
 * and persists the final width. The width state stays reactive on the page.
 */

export type SplitterOptions = {
	getWidth: () => number;
	setWidth: (width: number) => void;
	min: number;
	max: number;
	storageKey: string;
};

export function handleSplitterDrag(event: PointerEvent, options: SplitterOptions): void {
	const el = event.currentTarget as HTMLElement;
	const startX = event.clientX;
	const startWidth = options.getWidth();
	event.preventDefault();
	try {
		el.setPointerCapture(event.pointerId);
	} catch {
		/* synthetic pointer events have no active pointer to capture */
	}
	const onMove = (e: PointerEvent) => {
		options.setWidth(
			Math.max(options.min, Math.min(options.max, startWidth + (e.clientX - startX)))
		);
	};
	const onUp = (e: PointerEvent) => {
		el.removeEventListener('pointermove', onMove);
		el.removeEventListener('pointerup', onUp);
		el.removeEventListener('pointercancel', onUp);
		try {
			el.releasePointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
		try {
			localStorage.setItem(options.storageKey, String(options.getWidth()));
		} catch {
			/* storage unavailable */
		}
	};
	el.addEventListener('pointermove', onMove);
	el.addEventListener('pointerup', onUp);
	el.addEventListener('pointercancel', onUp);
}
