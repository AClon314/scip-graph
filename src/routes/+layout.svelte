<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';

	let { children } = $props();
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

<main>
	{@render children()}
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
		color: #1c2330;
		background: #f6f7f9;
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
		padding: 1.25rem;
	}
</style>
