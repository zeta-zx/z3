<script lang="ts">
    /**
     * Renders a Shadertoy pack full-size, fed by the live audio analysis and the
     * current album art/palette. Pauses when the window is hidden.
     */
    import { onMount } from "svelte";
    import { analyser } from "$lib/audio/analyser";
    import { artworkState, type RGB } from "$lib/state/artwork.svelte";
    import { ShaderRunner, squareArt, type ShaderPack } from "$lib/visualizer/shadertoy";
    import { isAndroid } from '$lib/platform';

    interface Props {
        pack: ShaderPack;
        /** 0..1, forwarded as iIntensity (tweened). */
        intensity?: number;
        /** Render continuously (false = draw only when art changes, e.g. reduced motion). */
        animate?: boolean;
        /** Optional remote playback clock in seconds for a non-playing guest. */
        clock?: number;
        onerror?: (err: Error) => void;
    }

    let { pack, intensity = 1, animate = true, clock, onerror }: Props = $props();

    let canvas = $state<HTMLCanvasElement>();
    let failed = $state(false);

    onMount(() => {
        let runner: ShaderRunner;
        try {
            runner = new ShaderRunner(canvas!, pack);
        } catch (err) {
            console.warn(`[shader:${pack.id}]`, err);
            failed = true;
            onerror?.(err as Error);
            return;
        }

        const start = performance.now();
        let artMix = 1;
        let artVersion = -1;
        let lastDraw = 0;
        let shownIntensity = intensity;
        let timeOffset = 0;
        let loadingArt = false;
        let dirty = true;
        // Palette shown in the shader: glides to a new song's colours (~1.5s)
        // like the background does, instead of snapping.
        const target = () => [...artworkState.palette.colors, artworkState.palette.accent] as RGB[];
        const shownColors = target().map((c) => [...c] as RGB);
        const colorsSettled = () => target().every((c, i) => c.every((v, j) => Math.abs(v - shownColors[i][j]) < 0.5));

        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, isAndroid ? 1.25 : 2);
            const w = Math.max(1, Math.round(canvas!.clientWidth * dpr * pack.scale));
            const h = Math.max(1, Math.round(canvas!.clientHeight * dpr * pack.scale));
            if (canvas!.width !== w || canvas!.height !== h) {
                canvas!.width = w;
                canvas!.height = h;
                dirty = true;
            }
        };
        const ro = new ResizeObserver(resize);
        ro.observe(canvas!);
        resize();

        async function syncArt() {
            if (loadingArt || artworkState.version === artVersion) return;
            loadingArt = true;
            const version = artworkState.version;
            const url = artworkState.url;
            try {
                const image = url ? await squareArt(url) : null;
                runner.setArt(image, artworkState.palette.colors[2]);
                artMix = 0;
            } catch {
                runner.setArt(null, artworkState.palette.colors[2]);
            }
            artVersion = version;
            loadingArt = false;
            dirty = true;
        }

        const unsubscribe = analyser.subscribe((features, dt) => {
            if (document.hidden) return;
            syncArt();

            const now = performance.now();
            // Transitions (new artwork, intensity change) always get full frame rate.
            const settling = artMix < 1 || Math.abs(intensity - shownIntensity) > 0.002 || !colorsSettled();
            if (!animate && !settling && !dirty) return;
            const fps = isAndroid ? (settling ? 24 : 12) : features.live || settling ? pack.maxFps : (pack.idleFps ?? pack.maxFps);
            const minFrame = fps ? 1000 / fps : 0;
            if (now - lastDraw < minFrame - 1) return;
            const frameDt = Math.min(0.25, (now - lastDraw) / 1000);

            artMix = Math.min(1, artMix + frameDt / 1.4);
            shownIntensity += (intensity - shownIntensity) * Math.min(1, frameDt * 3);
            const ease = Math.min(1, frameDt * 2.5);
            target().forEach((c, i) => c.forEach((v, j) => (shownColors[i][j] += (v - shownColors[i][j]) * ease)));

            lastDraw = now;
            dirty = false;
            const elapsed = (now - start) / 1000;
            if (clock !== undefined) timeOffset += (clock - (elapsed + timeOffset)) * Math.min(1, frameDt * 4);
            runner.render({
                time: animate ? elapsed + timeOffset : 0,
                dt: Math.min(0.1, frameDt || dt),
                audio: features,
                colors: [shownColors[0], shownColors[1], shownColors[2]],
                accent: shownColors[3],
                artMix,
                intensity: shownIntensity,
            });
        });

        return () => {
            unsubscribe();
            ro.disconnect();
            runner.dispose();
        };
    });
</script>

<canvas bind:this={canvas} class:failed></canvas>

<style>
    canvas {
        display: block;
        width: 100%;
        height: 100%;
    }
    .failed {
        visibility: hidden;
    }
</style>
