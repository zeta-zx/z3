<script lang="ts">
    import PlayerEngine from "$lib/components/PlayerEngine.svelte";
    import AmbientBackground from "$lib/components/AmbientBackground.svelte";
    import Dock from "$lib/components/Dock.svelte";
    import PlayerCapsule from "$lib/components/PlayerCapsule.svelte";
    import NowPlaying from "$lib/components/NowPlaying.svelte";
    import SidePanel from "$lib/components/SidePanel.svelte";
    import ContextMenu from "$lib/components/ContextMenu.svelte";
    import Dialog from "$lib/components/Dialog.svelte";
    import Shortcuts from "$lib/components/Shortcuts.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { page } from "$app/state";
    import { afterNavigate } from "$app/navigation";
    import { fly } from "svelte/transition";

    let { children } = $props();

    let main = $state<HTMLElement>();

    // Each page starts at the top.
    afterNavigate(() => main?.scrollTo({ top: 0 }));
</script>

<AmbientBackground
    intensity={ui.nowPlayingOpen ? 1 : 0}
    hidden={ui.nowPlayingOpen && ui.nowPlayingMode === "visualizer"}
/>

<div class="world" class:behind={ui.nowPlayingOpen} class:panel-open={!!ui.sidePanel}>
    <main bind:this={main}>
        {#key page.url.pathname}
            <div class="route" in:fly={{ y: 18, duration: 480, delay: 80, opacity: 0 }}>
                {@render children()}
            </div>
        {/key}
    </main>

    <Dock />

    {#if ui.sidePanel}
        <SidePanel />
    {/if}

    <PlayerCapsule />
</div>

{#if ui.nowPlayingOpen}
    <NowPlaying />
{/if}

<PlayerEngine />
<ContextMenu />
<Dialog />
<Shortcuts />

<style>
    .world {
        position: relative;
        z-index: 1;
        height: 100vh;
        transition: opacity 0.5s var(--ease-out), scale 0.6s var(--ease-out), visibility 0s;
    }
    /* Recede while the full-screen player is up, then stop painting entirely. */
    .world.behind {
        opacity: 0;
        scale: 0.96;
        pointer-events: none;
        visibility: hidden;
        transition: opacity 0.5s var(--ease-out), scale 0.6s var(--ease-out), visibility 0s 0.6s;
    }
    main {
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        /* room for the floating dock and player capsule */
        padding: 88px 0 120px;
        scroll-padding-top: 88px;
        transition: padding-right 0.45s var(--ease-out);
    }
    /* make room for the floating queue/lyrics island on wide screens */
    @media (min-width: 1180px) {
        .panel-open main {
            padding-right: calc(var(--panel-w) + 24px);
        }
    }
    .route {
        min-height: 100%;
    }
</style>
