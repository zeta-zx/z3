<script lang="ts">
    import { onDestroy } from "svelte";
    import { client } from "$lib/ephaptic";
    import { analyser } from "$lib/audio/analyser";
    import { peers } from "$lib/state/peers.svelte";
    import { isAndroid } from "$lib/platform";
    import type { Song } from "$lib/schema";

    interface Props {
        song: Song | null;
        enabled: boolean;
    }

    let { song, enabled }: Props = $props();
    let audio = $state<HTMLAudioElement>();
    let objectUrl = $state<string | null>(null);
    let loadedId = $state("");
    let request = 0;

    function cleanup() {
        request++;
        if (audio) {
            analyser.detach(audio);
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
        }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        loadedId = "";
    }

    async function load(current: Song) {
        cleanup();
        const id = ++request;
        if (!isAndroid || !enabled) return;
        try {
            // persist=true lets Android reuse the downloaded file for the
            // native player and for later visualizer sessions.
            const stream = await client.musicStream(current.id, undefined, true, current);
            if (id !== request || !audio) return;
            const url = stream.url ?? (stream.data.length
                ? (objectUrl = URL.createObjectURL(new Blob([new Uint8Array(stream.data)], { type: stream.mimetype })))
                : null);
            if (!url) return;
            audio.muted = true;
            audio.volume = 0;
            audio.src = url;
            audio.preload = "auto";
            analyser.attachSilent(audio);
            loadedId = current.id;
            const position = peers.remote?.position ?? 0;
            audio.addEventListener("loadedmetadata", () => {
                if (id !== request) return;
                audio!.currentTime = Math.max(0, Math.min(position, audio!.duration || position));
                if (!peers.remote?.paused) void audio!.play().catch(() => {});
            }, { once: true });
            audio.load();
        } catch (error) {
            console.warn("[remote-visualizer] silent stream failed", error);
        }
    }

    $effect(() => {
        const current = song;
        if (!current || !enabled || !isAndroid) {
            cleanup();
            return;
        }
        if (current.id !== loadedId) void load(current);
    });

    $effect(() => {
        const current = peers.remote;
        if (!audio || !loadedId || !current) return;
        if (current.song?.id !== loadedId) return;
        const drift = current.position - audio.currentTime;
        if (Math.abs(drift) > 0.35) audio.currentTime = Math.max(0, current.position);
        if (current.paused) audio.pause();
        else if (audio.paused) void audio.play().catch(() => {});
    });

    onDestroy(cleanup);
</script>

<audio bind:this={audio} aria-hidden="true" tabindex="-1" playsinline></audio>

<style>
    audio { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
</style>
