<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { onNavigate } from '$app/navigation';
	import { page } from '$app/state';

	let { children } = $props();

	// The global view is full-bleed (its own flex workspace fills the main
	// column); the Local view and the landing page keep the outer page gutter.
	let globalView = $derived(page.url.pathname.startsWith('/global'));

	// A↔B (Global↔Local) crossfade via the View Transitions API. SvelteKit keeps
	// the old page mounted until `navigation.complete`, so awaiting it inside the
	// transition callback lets the browser snapshot and crossfade both trees.
	// Browsers without the API just navigate normally.
	onNavigate((navigation) => {
		if (typeof document === 'undefined' || !document.startViewTransition) return;
		return new Promise<void>((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>scip-graph</title>
</svelte:head>

<header>
	<a class="brand" href="/global">scip-graph</a>
	<nav>
		<a href="/global" aria-current={page.url.pathname === '/global' ? 'page' : undefined}>Global</a>
		<a href="/local" aria-current={page.url.pathname === '/local' ? 'page' : undefined}>Local</a>
	</nav>
</header>

<main class:global-view={globalView}>
	{@render children()}
</main>

<style>
	:global(html) {
		height: 100%;
	}

	/* Full-height column: #app owns the flex context so <header> keeps its
	   intrinsic height and <main> absorbs the remaining viewport (100dvh). */
	:global(body) {
		height: 100dvh;
		margin: 0;
		display: flex;
		flex-direction: column;
		font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
		color: #1c2330;
		background: #f6f7f9;
	}

	:global(#app) {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	header {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		padding: 0.75rem 1.25rem;
		border-bottom: 1px solid #d8dce3;
		background: #fff;
	}

	.brand {
		font-weight: 700;
		text-decoration: none;
		color: inherit;
	}

	nav {
		display: flex;
		gap: 0.75rem;
	}

	nav a {
		padding: 0.25rem 0.6rem;
		border-radius: 6px;
		text-decoration: none;
		color: #3a4252;
	}

	nav a[aria-current='page'] {
		background: #1c2330;
		color: #fff;
	}

	main {
		flex: 1 1 auto;
		min-height: 0;
		padding: 1.25rem;
	}

	/* Global: no page gutter and no page scroll — the workspace fills main. */
	main.global-view {
		padding: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	/* Keep the page-to-page crossfade quick and smooth. */
	:global(::view-transition-old(root)),
	:global(::view-transition-new(root)) {
		animation-duration: 260ms;
		animation-timing-function: ease;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(::view-transition-old(root)),
		:global(::view-transition-new(root)) {
			animation-duration: 1ms;
		}
	}
</style>
