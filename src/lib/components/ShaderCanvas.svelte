<script lang="ts">
    /**
     * Renders a Shadertoy pack full-size, fed by the live audio analysis and the
     * current album art/palette. Pauses when the window is hidden.
     */
    import { onMount } from "svelte";
    import { analyser } from "$lib/audio/analyser";
    import { artworkState } from "$lib/state/artwork.svelte";
    import { ShaderRunner, squareArt, type ShaderPack } from "$lib/visualizer/shadertoy";

    interface Props {
        pack: ShaderPack;
        /** 0..1, forwarded as iIntensity (tweened). */
        intensity?: number;
        /** Render continuously (false = draw only when art changes, e.g. reduced motion). */
        animate?: boolean;
        onerror?: (err: Error) => void;
    }

    let { pack, intensity = 1, animate = true, onerror }: Props = $props();

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
        let loadingArt = false;
        let dirty = true;

        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
            const settling = artMix < 1 || Math.abs(intensity - shownIntensity) > 0.002;
            if (!animate && !settling && !dirty) return;
            const fps = features.live || settling ? pack.maxFps : (pack.idleFps ?? pack.maxFps);
            const minFrame = fps ? 1000 / fps : 0;
            if (now - lastDraw < minFrame - 1) return;
            const frameDt = Math.min(0.25, (now - lastDraw) / 1000);

            artMix = Math.min(1, artMix + frameDt / 1.4);
            shownIntensity += (intensity - shownIntensity) * Math.min(1, frameDt * 3);

            lastDraw = now;
            dirty = false;
            runner.render({
                time: animate ? (now - start) / 1000 : 0,
                dt: Math.min(0.1, frameDt || dt),
                audio: features,
                colors: artworkState.palette.colors,
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
