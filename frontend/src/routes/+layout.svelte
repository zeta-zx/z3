<script lang="ts">
	import "$lib/styles.css";

	let { children } = $props();
</script>

<svelte:head>
	<title>Zeta</title>
	<link rel="icon" href="/zeta.png" />
	<link href="https://cdn.jsdelivr.net/npm/@picocss/pico/css/pico.min.css" rel="stylesheet">
	<!-- <link rel="stylesheet" href="https://unpkg.com/papercss/dist/paper.min.css"> -->
</svelte:head>

<main class="container">
	{@render children()}
</main>

<footer>
	<small>
	<p>© 2025 uukelele</p>
	</small>
</footer>