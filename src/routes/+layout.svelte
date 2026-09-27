<script lang="ts">
	import "$lib/styles.css";
	import Toaster from "$lib/components/Toaster.svelte";

	let { children } = $props();
</script>

<svelte:head>
	<title>Zeta</title>
	<link rel="icon" href="/zeta.png" />
</svelte:head>

{@render children()}

<Toaster />
