<script lang="ts">
	/**
	 * Keyboard-shortcut help overlay for the local view (toggled with `?`).
	 */
	type Shortcut = { keys: string[]; label: string };

	const SHORTCUTS: Shortcut[] = [
		{ keys: ['↑', '↓'], label: 'focus previous / next node in the column' },
		{ keys: ['←', '→'], label: 'focus the nearest node in the adjacent column' },
		{ keys: ['Enter'], label: 're-center on the focused node' },
		{ keys: ['Shift', 'Enter'], label: 'add / remove the focused node from the focus set' },
		{ keys: ['+', '-'], label: 'show / hide hops on edge crossings' },
		{ keys: ['j'], label: 'open the focused node in the editor' },
		{ keys: ['/'], label: 'focus the node-id search input' },
		{ keys: ['Esc'], label: 'clear focus / close this overlay' },
		{ keys: ['?'], label: 'toggle this shortcut help' }
	];

	let { onclose }: { onclose: () => void } = $props();
</script>

<div class="helpOverlay">
	<div class="helpCard" role="dialog" aria-modal="true" aria-label="keyboard shortcuts">
		<h2>Keyboard shortcuts</h2>
		<dl>
			{#each SHORTCUTS as shortcut (shortcut.label)}
				<div>
					<dt>
						{#each shortcut.keys as key, i}{#if i}<span class="sep">+</span>{/if}<kbd>{key}</kbd>{/each}
					</dt>
					<dd>{shortcut.label}</dd>
				</div>
			{/each}
		</dl>
		<button class="closeBtn" onclick={onclose}>close</button>
	</div>
</div>

<style>
	.helpOverlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(6, 8, 12, 0.62);
		z-index: 30;
	}

	.helpCard {
		width: min(560px, 90vw);
		background: #141a22;
		border: 1px solid #3c4c62;
		border-radius: 10px;
		padding: 1.2rem 1.4rem;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
		color: #d9e2ee;
	}

	.helpCard h2 {
		margin: 0 0 0.8rem;
		color: #b98cff;
		font-size: 15px;
	}

	.helpCard dl {
		margin: 0 0 1rem;
		display: grid;
		gap: 0.45lh;
	}

	.helpCard dl > div {
		display: grid;
		grid-template-columns: 12ch 1fr;
		gap: 1ch;
		align-items: baseline;
	}

	.helpCard dt {
		color: #aebcd0;
	}

	.helpCard dd {
		margin: 0;
		color: #8493a8;
	}

	.sep {
		color: #8493a8;
		padding: 0 0.2ch;
	}

	kbd {
		display: inline-block;
		min-width: 1.4em;
		padding: 0.05lh 0.5ch;
		background: #0f141b;
		border: 1px solid #3c4c62;
		border-bottom-width: 2px;
		border-radius: 4px;
		color: #d9e2ee;
		font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
		text-align: center;
	}

	.closeBtn {
		background: #0f141b;
		color: #d9e2ee;
		border: 1px solid #232c38;
		border-radius: 5px;
		padding: 0.25lh 0.8ch;
		font: inherit;
		cursor: pointer;
	}

	.closeBtn:hover {
		border-color: #b98cff;
		color: #fff;
	}
</style>
