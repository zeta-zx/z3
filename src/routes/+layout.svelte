<script lang="ts">
	import "$lib/styles.css";

	let { children } = $props();
</script>

<svelte:head>
	<title>Zeta</title>
	<link rel="icon" href="/zeta.png" />
</svelte:head>

<main class="container">
	{@render children()}
</main>

<footer>
	<small>
	<p>© 2025 uukelele</p>
	</small>
</footer>