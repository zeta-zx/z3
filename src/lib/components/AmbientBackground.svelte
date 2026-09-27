<script lang="ts">
    /**
     * The living backdrop behind the whole app: the current cover, heavily
     * blurred and slowly turning, under a fluid gradient of its own colours
     * whose blobs drift constantly and swell with the bass and beats.
     *
     * Deliberately not WebGL: it's a few layers moved with compositor-only
     * properties (transform/scale/opacity), so it works on every GPU and costs
     * almost nothing. The beat response is written straight to element styles
     * from the audio analyser, outside Svelte's reactivity.
     */
    import { onMount } from "svelte";
    import { fade } from "svelte/transition";
    import { analyser } from "$lib/audio/analyser";
    import { artworkState, type RGB } from "$lib/state/artwork.svelte";
    import { ui } from "$lib/state/ui.svelte";

    let { intensity = 0, hidden = false }: { intensity?: number; hidden?: boolean } = $props();

    const css = (c: RGB) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
    const palette = $derived(artworkState.palette);
    const blobs = $derived([palette.colors[0], palette.accent, palette.colors[1], palette.colors[2], palette.accent]);

    // How strongly each blob reacts: [bass swell, beat kick].
    const RESPONSE: [number, number][] = [
        [0.34, 0.16],
        [0.22, 0.3],
        [0.28, 0.12],
        [0.18, 0.22],
        [0.12, 0.34],
    ];

    let blobEls: HTMLDivElement[] = [];
    let artEl = $state<HTMLDivElement>();
    const shown = RESPONSE.map(() => 1);
    let artShown = 1;

    onMount(() =>
        analyser.subscribe((f) => {
            if (hidden || !ui.ambient) return;
            blobEls.forEach((el, i) => {
                if (!el) return;
                const [bass, kick] = RESPONSE[i];
                const target = 1 + f.bass * bass + f.beat * kick;
                // Fast attack, soft release, like a speaker cone.
                shown[i] += (target - shown[i]) * (target > shown[i] ? 0.45 : 0.12);
                el.style.scale = shown[i].toFixed(3);
                el.style.opacity = (0.62 + f.level * 0.3 + f.beat * 0.25).toFixed(3);
            });
            if (artEl) {
                const target = 1 + f.beat * 0.035 + f.bass * 0.02;
                artShown += (target - artShown) * (target > artShown ? 0.4 : 0.1);
                artEl.style.scale = artShown.toFixed(4);
            }
        }),
    );
</script>

<div class="ambient" aria-hidden="true">
    {#if ui.ambient && !hidden}
        <div class="art-wrap" bind:this={artEl}>
            {#key artworkState.blurred}
                <div
                    class="art"
                    class:empty={!artworkState.blurred}
                    style:background-image={artworkState.blurred ? `url(${artworkState.blurred})` : undefined}
                    transition:fade={{ duration: 1400 }}
                ></div>
            {/key}
        </div>
        <div class="blobs">
            {#each blobs as color, i}
                <div class="drift d{i}">
                    <div class="blob" bind:this={blobEls[i]} style:color={css(color)}></div>
                </div>
            {/each}
        </div>
    {:else}
        <!-- Static fallback (living background turned off in Settings). -->
        <div class="static" style:--c1={css(palette.colors[0])} style:--c2={css(palette.colors[1])} style:--c3={css(palette.accent)}></div>
    {/if}
    <!-- Darkening that adapts to the cover, so white text stays readable on bright art. -->
    <div class="shade" style:opacity={0.55 + artworkState.brightness * 0.9}></div>
    <!-- Extra dimming for the regular app; fades away in the full-screen player. -->
    <div class="scrim" style:opacity={1 - intensity}></div>
    <div class="grain"></div>
</div>

<style>
    .ambient {
        position: fixed;
        inset: 0;
        z-index: 0;
        overflow: hidden;
        background: #0b0912;
        pointer-events: none;
    }

    /* The blurred cover, slowly turning. A square wider than the screen's
       diagonal (√2 ≈ 1.42 × the longer side), so no corner is ever uncovered. */
    .art-wrap {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 160vmax;
        height: 160vmax;
        margin: -80vmax 0 0 -80vmax;
        animation: turn 120s linear infinite;
    }
    .art {
        position: absolute;
        inset: 0;
        background-size: cover;
        background-position: center;
        opacity: 0.85;
    }
    .art.empty {
        background: radial-gradient(circle at 30% 30%, #3b2a7a, #120c24 70%);
    }
    @keyframes turn {
        to {
            rotate: 360deg;
        }
    }

    /* the fluid gradient: big soft colour fields drifting over the cover */
    .blobs {
        position: absolute;
        inset: 0;
    }
    .drift {
        position: absolute;
        width: 70vmax;
        height: 70vmax;
        margin: -35vmax 0 0 -35vmax;
        animation: drift 26s ease-in-out infinite alternate;
    }
    .blob {
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: radial-gradient(closest-side, currentColor 0%, color-mix(in srgb, currentColor 45%, transparent) 45%, transparent 100%);
        opacity: 0.7;
        transition: color 1.6s ease;
    }
    .d0 {
        left: 18%;
        top: 22%;
        animation-duration: 29s;
    }
    .d1 {
        left: 82%;
        top: 18%;
        animation-duration: 23s;
        animation-delay: -7s;
    }
    .d2 {
        left: 70%;
        top: 85%;
        animation-duration: 31s;
        animation-delay: -13s;
    }
    .d3 {
        left: 12%;
        top: 88%;
        animation-duration: 27s;
        animation-delay: -4s;
    }
    .d4 {
        left: 50%;
        top: 50%;
        width: 55vmax;
        height: 55vmax;
        margin: -27.5vmax 0 0 -27.5vmax;
        animation-duration: 19s;
        animation-delay: -9s;
    }
    .d4 .blob {
        opacity: 0.45;
    }
    @keyframes drift {
        0% {
            translate: 0 0;
            rotate: 0deg;
        }
        33% {
            translate: 12vw -9vh;
            rotate: 40deg;
        }
        66% {
            translate: -10vw 11vh;
            rotate: -25deg;
        }
        100% {
            translate: 7vw 6vh;
            rotate: 15deg;
        }
    }

    .static {
        position: absolute;
        inset: -20%;
        background:
            radial-gradient(40% 50% at 20% 15%, color-mix(in srgb, var(--c1) 60%, transparent), transparent 70%),
            radial-gradient(45% 55% at 85% 20%, color-mix(in srgb, var(--c3) 45%, transparent), transparent 70%),
            radial-gradient(60% 60% at 50% 100%, color-mix(in srgb, var(--c2) 60%, transparent), transparent 70%);
    }

    .shade {
        position: absolute;
        inset: 0;
        background: radial-gradient(130% 100% at 50% 45%, rgb(8 6 14 / 0.3), rgb(8 6 14 / 0.62));
        transition: opacity 1.4s ease;
    }
    .scrim {
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgb(8 6 14 / 0.25), rgb(8 6 14 / 0.45));
        transition: opacity 0.8s var(--ease-out);
    }
    .grain {
        position: absolute;
        inset: 0;
        opacity: 0.05;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
    }

    @media (prefers-reduced-motion: reduce) {
        .art-wrap,
        .drift {
            animation: none;
        }
    }
</style>
