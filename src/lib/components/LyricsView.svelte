<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { lyricsState } from "$lib/state/lyrics.svelte";
    import { playerState, seek } from "$lib/state/player.svelte";
    import { analyser } from "$lib/audio/analyser";
    import { onMount, tick } from "svelte";

    let { compact = false }: { compact?: boolean } = $props();

    let container = $state<HTMLDivElement>();
    let column = $state<HTMLDivElement>();

    // Line geometry (offsetTop / height), re-measured on layout changes.
    let tops = $state<number[]>([]);
    let heights = $state<number[]>([]);
    let viewH = $state(0);

    // Manual (wheel/drag) offset; springs back to the active line when idle.
    let userOffset = $state(0);
    let manual = $state(false);
    let idleTimer: ReturnType<typeof setTimeout>;

    const lines = $derived(lyricsState.lines);
    const active = $derived(lyricsState.active);
    const anchorRatio = $derived(compact ? 0.3 : 0.36);

    function measure() {
        if (!column || !container) return;
        const els = [...column.querySelectorAll<HTMLElement>("[data-line]")];
        tops = els.map((el) => el.offsetTop);
        heights = els.map((el) => el.offsetHeight);
        viewH = container.clientHeight;
    }

    onMount(() => {
        const ro = new ResizeObserver(() => measure());
        ro.observe(container!);
        ro.observe(column!);
        return () => ro.disconnect();
    });

    $effect(() => {
        void lines;
        tick().then(measure);
    });

    // New song: start from the top.
    $effect(() => {
        void playerState.currentTrack?.id;
        userOffset = 0;
        manual = false;
    });

    const focusIndex = $derived(Math.max(0, active));
    const baseY = $derived.by(() => {
        if (!tops.length) return viewH * anchorRatio;
        const i = Math.min(focusIndex, tops.length - 1);
        return viewH * anchorRatio - (tops[i] + (heights[i] ?? 0) / 2);
    });

    function onWheel(e: WheelEvent) {
        if (!lines.length) return;
        e.preventDefault();
        manual = true;
        const min = -(tops.at(-1) ?? 0) - baseY + viewH * 0.2;
        const max = -baseY + viewH * 0.6;
        userOffset = Math.max(min, Math.min(max, userOffset - e.deltaY));
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            manual = false;
            userOffset = 0;
        }, 2600);
    }

    function jump(time: number) {
        seek(time);
        if (playerState.paused) playerState.paused = false;
        manual = false;
        userOffset = 0;
    }

    /* ---- per-frame work: word fill, interlude progress, audio glow ---- */
    // playerState.currentTime only updates ~4×/s; interpolate for smooth fills.
    let clockBase = 0;
    let clockAt = 0;
    $effect(() => {
        clockBase = playerState.currentTime;
        clockAt = performance.now();
    });

    let lastGlow = -1;
    let glowEl: HTMLElement | null = null;

    onMount(() =>
        analyser.subscribe((f) => {
            if (!container || (playerState.paused && lastGlow === 0)) return;
            const t = playerState.paused ? clockBase : clockBase + (performance.now() - clockAt) / 1000;

            const line = lines[active];
            const el = column?.querySelector<HTMLElement>(`[data-line="${active}"]`) ?? null;

            // The glow lives on the active line only: setting it on the container
            // would restyle every line, every frame.
            const glow = playerState.paused ? 0 : Math.min(1, f.level * 0.9 + f.beat * 0.6);
            if (el !== glowEl) {
                glowEl?.style.removeProperty("--glow");
                glowEl = el;
                lastGlow = -1;
            }
            if (el && Math.abs(glow - lastGlow) >= 0.02) {
                el.style.setProperty("--glow", glow.toFixed(2));
                lastGlow = glow;
            }
            if (!line || !el) return;

            if (line.interlude) {
                const p = Math.min(1, Math.max(0, (t - line.time) / Math.max(0.1, line.end - line.time)));
                el.style.setProperty("--p", p.toFixed(3));
            } else if (line.words) {
                // The glow sweeps across the line word by word.
                if (el !== fillEl) {
                    fillEl = el;
                    fillState = [];
                }
                const words = el.querySelectorAll<HTMLElement>("[data-w]");
                // Estimated timings sweep over ~90% of the line (see lyrics store).
                const sweepEnd = line.estimated ? line.time + Math.max(0.4, (line.end - line.time) * 0.9) : line.end;
                line.words.forEach((w, i) => {
                    const end = line.words![i + 1]?.time ?? sweepEnd;
                    const p = Math.min(1, Math.max(0, (t - w.time) / Math.max(0.05, end - w.time)));
                    const last = fillState[i] ?? -1;
                    if (Math.abs(p - last) < 0.005 && !(p === 1 && last !== 1) && !(p === 0 && last !== 0)) return;
                    fillState[i] = p;
                    const word = words[i];
                    if (!word) return;
                    word.style.setProperty("--wp", `${(p * 100).toFixed(1)}%`);
                    word.classList.toggle("lit", p > 0);
                });
            }
        }),
    );

    // Per-word fill progress of the active line, to skip redundant style writes.
    let fillEl: HTMLElement | null = null;
    let fillState: number[] = [];
</script>

<div class="lyrics" class:compact class:manual bind:this={container} onwheel={onWheel}>
    {#if lines.length}
        <div class="column" bind:this={column}>
            {#each lines as line, i (i)}
                {@const dist = Math.abs(i - focusIndex)}
                {@const state = i === active ? "active" : i < active ? "past" : "future"}
                <!-- Lines below the active one trail slightly behind: the "wave". Lines
                     above must never lag the active line, or they'd overlap it on the way up. -->
                {@const delay = manual || i <= focusIndex ? 0 : Math.min(i - focusIndex, 8) * 38}
                {#if line.interlude}
                    <div
                        class="line interlude {state}"
                        data-line={i}
                        style:translate="0 {baseY + userOffset}px"
                        style:transition-delay="{delay}ms"
                        style:--dist={dist}
                    >
                        <span class="dots"><i></i><i></i><i></i></span>
                    </div>
                {:else}
                    <button
                        class="line {state}"
                        class:far={dist > 5}
                        class:has-words={!!line.words}
                        data-line={i}
                        style:translate="0 {baseY + userOffset}px"
                        style:transition-delay="{delay}ms"
                        style:--dist={dist}
                        onclick={() => jump(line.time)}
                    >
                        {#if line.words}
                            {#each line.words as word}<span class="word" data-w>{word.text}</span>{/each}
                        {:else}
                            {line.text}
                        {/if}
                    </button>
                {/if}
            {/each}
        </div>
    {:else if lyricsState.plain.length}
        <div class="plain">
            <span class="badge"><Icon name="text" /> Unsynced lyrics</span>
            {#each lyricsState.plain as text}
                <p>{text}</p>
            {/each}
        </div>
    {:else if playerState.isLoading}
        <div class="loading">
            {#each [70, 88, 56, 80] as w, i}
                <div class="skeleton" style:width="{w}%" style:animation-delay="{i * 120}ms"></div>
            {/each}
        </div>
    {:else}
        <div class="none">
            <Icon name="mic-vocal" />
            <h3>No lyrics for this one</h3>
            <p>Enjoy the music.</p>
        </div>
    {/if}
</div>

<style>
    .lyrics {
        --size: clamp(26px, 2.6vw, 40px);
        --glow: 0;
        position: relative;
        height: 100%;
        overflow: hidden;
        mask-image: linear-gradient(180deg, transparent 0%, #000 12%, #000 78%, transparent 100%);
        user-select: none;
    }
    .compact {
        --size: 22px;
        mask-image: linear-gradient(180deg, transparent 0%, #000 8%, #000 82%, transparent 100%);
    }
    .column {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: calc(var(--size) * 0.55);
        padding: 0 8px;
    }
    .line {
        display: block;
        max-width: 100%;
        padding: 6px 12px;
        margin-left: -12px;
        border-radius: var(--r-md);
        text-align: left;
        font-family: var(--font);
        font-size: var(--size);
        font-weight: 800;
        line-height: 1.22;
        letter-spacing: -0.022em;
        color: #fff;
        opacity: 0.32;
        transform-origin: left center;
        cursor: pointer;
        /* Scrolling uses `translate`, not `transform`: the `scale` below is
           applied on top of `transform` (it would shrink the scroll offset too,
           shifting inactive lines relative to the active one), whereas
           `translate` is applied after it and stays exact. */
        transition:
            translate 0.75s cubic-bezier(0.2, 0.85, 0.25, 1),
            opacity 0.5s var(--ease-out),
            filter 0.5s var(--ease-out),
            scale 0.5s var(--ease-out),
            background 0.2s;
        filter: blur(calc(min(var(--dist), 5) * 0.55px));
        scale: 0.965;
        overflow-wrap: anywhere;
    }
    .compact .line {
        font-weight: 750;
        filter: blur(calc(min(var(--dist), 5) * 0.35px));
    }
    .manual .line {
        transition:
            translate 0.18s linear,
            opacity 0.4s,
            filter 0.4s,
            scale 0.4s;
        filter: none;
    }
    .lyrics:hover .line {
        filter: none;
    }
    /* Already-sung lines (above) sit in a lighter grey than upcoming ones (below). */
    .line.past {
        opacity: 0.55;
    }
    /* Distant lines are faint anyway; skipping their blur saves a lot of GPU. */
    .line.far {
        filter: none;
        opacity: 0.18;
    }
    .line.past.far {
        opacity: 0.36;
    }
    .line:hover {
        background: rgb(255 255 255 / 0.07);
        opacity: 0.75;
    }
    .line.active {
        opacity: 1;
        scale: 1;
        filter: none;
    }

    /* Karaoke: the white glow sweeps across the line word by word (real word
       timings when available, otherwise spread evenly over the line). */
    .word {
        --wp: 0%;
        white-space: pre-wrap;
    }
    .line.active .word {
        background: linear-gradient(90deg, #fff var(--wp), rgb(255 255 255 / 0.32) calc(var(--wp) + 8%));
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
    }
    /* words that have started glow, breathing with the music */
    /* `lit` is toggled from script, hence :global (Svelte can't see it statically) */
    .line.active .word:global(.lit) {
        filter: drop-shadow(0 0 calc(5px + var(--glow) * 12px) rgb(255 255 255 / calc(0.4 + var(--glow) * 0.35)));
    }

    /* instrumental break: three dots filling in sequence, gently breathing */
    .interlude {
        --p: 0;
        height: calc(var(--size) * 1.1);
        display: flex;
        align-items: center;
        cursor: default;
        opacity: 0;
        scale: 0.6;
    }
    .interlude.active {
        opacity: 1;
        scale: 1;
    }
    .dots {
        display: inline-flex;
        gap: calc(var(--size) * 0.3);
        animation: breathe 2.4s ease-in-out infinite;
        transform-origin: left center;
    }
    .dots i {
        width: calc(var(--size) * 0.36);
        height: calc(var(--size) * 0.36);
        border-radius: 50%;
        background: #fff;
        opacity: 0.25;
        transition: opacity 0.3s;
    }
    .interlude.active .dots i:nth-child(1) {
        opacity: calc(0.25 + min(1, max(0, var(--p) * 3)) * 0.75);
    }
    .interlude.active .dots i:nth-child(2) {
        opacity: calc(0.25 + min(1, max(0, var(--p) * 3 - 1)) * 0.75);
    }
    .interlude.active .dots i:nth-child(3) {
        opacity: calc(0.25 + min(1, max(0, var(--p) * 3 - 2)) * 0.75);
    }
    @keyframes breathe {
        0%,
        100% {
            transform: scale(0.92);
        }
        50% {
            transform: scale(1.08);
        }
    }

    .plain {
        height: 100%;
        overflow-y: auto;
        padding: 12% 8px 30%;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 14px;
        mask-image: none;
    }
    .plain p {
        font-family: var(--font-display);
        font-size: calc(var(--size) * 0.8);
        font-weight: 750;
        line-height: 1.25;
        color: rgb(255 255 255 / 0.85);
    }
    .plain .badge {
        margin-bottom: 8px;
    }
    .loading {
        display: flex;
        flex-direction: column;
        gap: 22px;
        padding-top: 30%;
    }
    .loading .skeleton {
        height: calc(var(--size) * 0.9);
    }
    .none {
        height: 100%;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 6px;
        text-align: center;
        color: rgb(255 255 255 / 0.6);
    }
    .none :global(svg) {
        width: 44px;
        height: 44px;
        opacity: 0.5;
        margin-bottom: 6px;
    }
    .none h3 {
        color: #fff;
        font-size: 20px;
    }
</style>
