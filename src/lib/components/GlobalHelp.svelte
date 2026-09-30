<script lang="ts">
	/**
	 * Keyboard-shortcut overlay for the global density view (toggled with `?`).
	 * Static content; the page decides whether it is mounted.
	 */
	let { onclose }: { onclose: () => void } = $props();
</script>

<div class="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
	<div class="help-card">
		<h3>Keyboard shortcuts</h3>
		<dl>
			<dt>click / tap</dt><dd>select the node under the pointer</dd>
			<dt>drag / touch drag</dt><dd>pan the viewport</dd>
			<dt>pinch / wheel</dt><dd>zoom in / out</dd>
			<dt>← ↑ → ↓</dt><dd>move selection to nearest node</dd>
			<dt>+ / −</dt><dd>zoom in / out</dd>
			<dt>0</dt><dd>fit graph</dd>
			<dt>/</dt><dd>focus outline search</dd>
			<dt>Enter</dt><dd>open selection in Local</dd>
			<dt>j</dt><dd>jump to source</dd>
			<dt>Esc</dt><dd>clear selection / close help</dd>
			<dt>?</dt><dd>toggle this help</dd>
		</dl>
		<button onclick={onclose}>close</button>
	</div>
</div>

<style>
	.help {
		position: absolute;
		inset: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #0b0f1499;
	}

	.help-card {
		min-width: 320px;
		padding: 16px 20px;
		color: #d5dde8;
		background: #171c24f2;
		border: 1px solid #2a3340;
		border-radius: 10px;
		box-shadow: 0 18px 48px #0008;
	}

	.help-card h3 {
		margin: 0 0 10px;
		color: #ffd54a;
	}

	.help-card dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 14px;
		margin: 0 0 12px;
	}

	.help-card dt {
		color: #9fd0e8;
	}

	.help-card dd {
		margin: 0;
	}

	button {
		font: inherit;
		color: #d5dde8;
		background: #212a36;
		border: 1px solid #2a3340;
		border-radius: 6px;
		padding: 3px 9px;
		cursor: pointer;
	}

	button:hover {
		border-color: #ffd54a;
	}
</style>
