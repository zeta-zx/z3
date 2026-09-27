<script lang="ts">
    /**
     * The floating player island. Compact by default (art, title, play/next);
     * expands on hover/focus into full transport, seek bar and tools. Its glow
     * breathes with the music, and its artwork morphs into the full player.
     */
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import Slider from "$lib/components/Slider.svelte";
    import LyricText from "$lib/components/LyricText.svelte";
    import { lyricsState } from "$lib/state/lyrics.svelte";
    import {
        playerState,
        togglePlay,
        nextTrack,
        previousTrack,
        isNextTrackAvailable,
        toggleShuffle,
        cycleRepeat,
        seek,
        setVolume,
        toggleMute,
        isRadioContext,
    } from "$lib/state/player.svelte";
    import { libraryState } from "$lib/state/library.svelte";
    import { ui, type MenuItem } from "$lib/state/ui.svelte";
    import { toasts } from "$lib/state/toast.svelte";
    import { trackMenu } from "$lib/actions";
    import { analyser } from "$lib/audio/analyser";
    import { sendArt, receiveArt } from "$lib/transitions";
    import { artistNames, formatTime } from "$lib/utils";
    import { onMount } from "svelte";
    import { slide } from "svelte/transition";

    const track = $derived(playerState.currentTrack);
    const fav = $derived(track ? libraryState.isFavourite(track.id) : false);
    const pct = $derived(playerState.duration ? (playerState.currentTime / playerState.duration) * 100 : 0);
    const volumeIcon = $derived(
        playerState.muted || playerState.volume === 0 ? "volume-x" : playerState.volume < 0.4 ? "volume-1" : "volume-2",
    );

    let glowEl = $state<HTMLDivElement>();
    let capsuleEl = $state<HTMLDivElement>();
    let lastLv = -1;
    let hovered = $state(false);
    let focused = $state(false);
    let pinned = $state(false);
    let leaveTimer: ReturnType<typeof setTimeout>;
    const expanded = $derived(!!track && (hovered || focused || pinned || !!ui.menu));

    function enter() {
        clearTimeout(leaveTimer);
        hovered = true;
    }
    function leave() {
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => (hovered = false), 450);
    }

    // The glow follows the music's loudness and kicks.
    onMount(() =>
        analyser.subscribe((f) => {
            if (!glowEl) return;
            // Always softly lit while there's a track; kicks flare it up.
            const energy = Math.min(1, f.level * 1.4 + f.beat * 1.1 + f.bass * 0.5);
            const lv = playerState.currentTrack ? (playerState.paused ? 0.3 : 0.5 + energy * 0.5) : 0;
            if (Math.abs(lv - lastLv) < 0.01) return;
            lastLv = lv;
            // opacity/scale only: composited, no repaint of the glass. The whole
            // capsule pulses so the glow always hugs its edges.
            glowEl.style.opacity = lv.toFixed(3);
            if (capsuleEl) capsuleEl.style.scale = playerState.paused ? "1" : (1 + energy * 0.022).toFixed(4);
        }),
    );

    function sleepMenu(anchor: Element) {
        const set = (v: number | "track" | null, msg: string) => () => {
            ui.sleepAt = typeof v === "number" ? Date.now() + v * 60_000 : v;
            toasts.info(msg);
        };
        const items: MenuItem[] = [
            { label: "15 minutes", icon: "timer", action: set(15, "Sleep timer: 15 minutes") },
            { label: "30 minutes", icon: "timer", action: set(30, "Sleep timer: 30 minutes") },
            { label: "45 minutes", icon: "timer", action: set(45, "Sleep timer: 45 minutes") },
            { label: "1 hour", icon: "timer", action: set(60, "Sleep timer: 1 hour") },
            { label: "End of this track", icon: "disc-3", checked: ui.sleepAt === "track", action: set("track", "Stopping after this track") },
            ...(ui.sleepAt ? [{ separator: true }, { label: "Turn off", icon: "x", action: set(null, "Sleep timer off") }] : []),
        ];
        ui.openMenuAt(anchor, items);
    }

    let now = $state(Date.now());
    $effect(() => {
        if (typeof ui.sleepAt !== "number") return;
        const t = setInterval(() => (now = Date.now()), 1000);
        return () => clearInterval(t);
    });
    const sleepLeft = $derived(typeof ui.sleepAt === "number" ? Math.max(0, Math.ceil((ui.sleepAt - now) / 60000)) : null);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="capsule"
    class:expanded
    class:empty={!track}
    class:playing={track && !playerState.paused}
    bind:this={capsuleEl}
    onmouseenter={enter}
    onmouseleave={leave}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
>
    <div class="glow" bind:this={glowEl} aria-hidden="true"></div>
    {#if track}
        <div class="main">
            <button class="art" title="Open player (F)" onclick={() => ui.openNowPlaying()}>
                {#if !ui.nowPlayingOpen}
                    <span class="art-inner" in:receiveArt={{ key: "art" }} out:sendArt={{ key: "art" }}>
                        {#key track.id}
                            <Cover thumbnails={track.thumbnails} title={track.title} size="100%" radius="14px" />
                        {/key}
                    </span>
                {/if}
            </button>

            <button class="info" onclick={() => ui.openNowPlaying()}>
                {#key track.id}
                    <span class="title ellipsis" title={track.title}>{track.title}</span>
                    {#if !expanded && lyricsState.synced && !playerState.paused}
                        <span class="ticker"><LyricText /></span>
                    {:else}
                    <span class="artist ellipsis">
                        {artistNames(track)}
                        {#if expanded && playerState.currentPlaylist}
                            <span class="ctx">
                                · <Icon name={isRadioContext() ? "radio" : "list-music"} /> {playerState.currentPlaylist.name}
                            </span>
                        {/if}
                    </span>
                    {/if}
                {/key}
            </button>

            <button class="icon-btn fav" class:is-fav={fav} title="Favourite" onclick={() => libraryState.toggleFavourite(track)}>
                <Icon name="heart" />
            </button>
            {#if expanded}
                <button class="icon-btn" title="Previous" onclick={previousTrack}><Icon name="skip-back" /></button>
            {/if}
            <button class="play" title="Play/Pause (Space)" disabled={playerState.isLoading} onclick={togglePlay}>
                {#if playerState.isLoading}
                    <span class="spin"><Icon name="loader-circle" /></span>
                {:else}
                    <Icon name={playerState.paused ? "play" : "pause"} />
                {/if}
            </button>
            <button class="icon-btn" title="Next" disabled={!isNextTrackAvailable()} onclick={nextTrack}><Icon name="skip-forward" /></button>
        </div>

        {#if expanded}
            <div class="more" transition:slide={{ duration: 260 }}>
                <div class="seek">
                    <span class="time">{formatTime(playerState.currentTime)}</span>
                    <Slider value={playerState.currentTime} max={playerState.duration || 0} onchange={seek} format={formatTime} disabled={!playerState.duration} label="Seek" />
                    <span class="time">{formatTime(playerState.duration || track.duration || 0)}</span>
                </div>
                <div class="tools">
                    <div class="group">
                        <button class="icon-btn sm" class:on={playerState.shuffle} title="Shuffle (S)" onclick={toggleShuffle}><Icon name="shuffle" /></button>
                        <button class="icon-btn sm" class:on={playerState.repeat !== "off"} title="Repeat: {playerState.repeat} (R)" onclick={cycleRepeat}>
                            <Icon name={playerState.repeat === "one" ? "repeat-1" : "repeat"} />
                        </button>
                        <button class="icon-btn sm" class:on={!!ui.sleepAt} title="Sleep timer" onclick={(e) => sleepMenu(e.currentTarget)}>
                            <Icon name="moon" />
                            {#if sleepLeft !== null}<span class="badge-n">{sleepLeft}</span>{/if}
                        </button>
                    </div>
                    <div class="group">
                        <button class="icon-btn sm" class:on={ui.sidePanel === "lyrics"} title="Lyrics (Y)" onclick={() => ui.toggleSidePanel("lyrics")}><Icon name="mic-vocal" /></button>
                        <button class="icon-btn sm" class:on={ui.sidePanel === "queue"} title="Queue (Q)" onclick={() => ui.toggleSidePanel("queue")}><Icon name="list-music" /></button>
                        <button class="icon-btn sm" title="Visualizer (V)" onclick={() => ui.openNowPlaying("visualizer")}><Icon name="audio-waveform" /></button>
                        <button class="icon-btn sm" title="More" onclick={(e) => ui.openMenuAt(e.currentTarget, trackMenu(track, { playlist: playerState.currentPlaylist }))}><Icon name="ellipsis" /></button>
                    </div>
                    <div class="group vol">
                        <button class="icon-btn sm" title="Mute (M)" onclick={toggleMute}><Icon name={volumeIcon} /></button>
                        <Slider value={playerState.muted ? 0 : playerState.volume} max={1} live onchange={setVolume} format={(v) => `${Math.round(v * 100)}%`} label="Volume" />
                        <button class="icon-btn sm" class:on={pinned} title={pinned ? "Unpin" : "Keep expanded"} onclick={() => (pinned = !pinned)}>
                            <Icon name={pinned ? "pin-off" : "pin"} />
                        </button>
                    </div>
                </div>
            </div>
        {:else}
            <div class="line" style:transform="scaleX({(pct / 100).toFixed(4)})"></div>
        {/if}
    {:else}
        <a class="idle" href="/music/search">
            <span class="idle-mark">ζ</span>
            <span>Nothing playing — <strong>find something you love</strong></span>
            <Icon name="arrow-right" />
        </a>
    {/if}
</div>

<style>
    .capsule {
        position: fixed;
        left: 50%;
        bottom: 18px;
        translate: -50% 0;
        z-index: 60;
        width: min(500px, calc(100vw - 28px));
        padding: 8px;
        border-radius: 32px;
        background: rgb(16 13 24 / 0.6);
        backdrop-filter: blur(30px) saturate(1.8);
        -webkit-backdrop-filter: blur(30px) saturate(1.8);
        border: 1px solid rgb(255 255 255 / 0.1);
        box-shadow:
            0 24px 60px -18px rgb(0 0 0 / 0.75),
            inset 0 1px 0 rgb(255 255 255 / 0.08);
        transition:
            width 0.55s var(--ease-spring),
            border-radius 0.45s var(--ease-out),
            background 0.3s;
        animation: capsule-in 0.9s var(--ease-spring) both;
    }
    /* The music-reactive halo: a static glow whose opacity/scale are driven per
       frame from script (compositor-only properties). */
    .glow {
        position: absolute;
        inset: -1px;
        z-index: -1;
        border-radius: inherit;
        /* an accent rim plus a tight and a wide halo */
        border: 1.5px solid color-mix(in srgb, var(--accent) 75%, transparent);
        box-shadow:
            0 0 18px 1px color-mix(in srgb, var(--accent) 85%, transparent),
            0 0 60px 12px color-mix(in srgb, var(--accent) 45%, transparent);
        opacity: 0;
        will-change: opacity;
        pointer-events: none;
    }
    @keyframes capsule-in {
        from {
            opacity: 0;
            transform: translateY(30px) scale(0.85);
        }
    }
    .capsule.expanded {
        width: min(780px, calc(100vw - 28px));
        border-radius: 28px;
        background: rgb(16 13 24 / 0.72);
    }
    .capsule.empty {
        width: auto;
    }

    .main {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .art {
        position: relative;
        width: 48px;
        height: 48px;
        border-radius: 14px;
        flex-shrink: 0;
        transition: width 0.45s var(--ease-spring), height 0.45s var(--ease-spring);
    }
    .expanded .art {
        width: 56px;
        height: 56px;
    }
    .art-inner {
        display: block;
        width: 100%;
        height: 100%;
        border-radius: 14px;
        box-shadow: 0 6px 16px -6px rgb(0 0 0 / 0.8);
    }
    .playing .art-inner {
        animation: breathe 3.2s ease-in-out infinite;
    }
    @keyframes breathe {
        50% {
            transform: scale(1.04);
        }
    }
    .info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        padding: 0 6px;
        text-align: left;
    }
    .title {
        max-width: 100%;
        font-weight: 700;
        font-size: 14.5px;
        animation: text-in 0.45s var(--ease-out);
    }
    .artist {
        max-width: 100%;
        font-size: 12.5px;
        color: var(--text-2);
        animation: text-in 0.45s 0.05s var(--ease-out) both;
    }
    .ticker {
        position: relative;
        display: block;
        width: 100%;
        height: 17px;
        overflow: hidden;
        font-size: 12.5px;
        font-weight: 600;
        color: color-mix(in srgb, var(--accent) 70%, white);
    }
    .ctx {
        color: var(--text-3);
    }
    .ctx :global(svg) {
        width: 11px;
        height: 11px;
        vertical-align: -1px;
    }
    @keyframes text-in {
        from {
            opacity: 0;
            transform: translateY(6px);
        }
    }
    .fav.is-fav {
        color: var(--accent);
    }
    .fav.is-fav :global(svg) {
        fill: currentColor;
        animation: pop 0.45s var(--ease-spring);
    }
    @keyframes pop {
        0% {
            transform: scale(0.6);
        }
        60% {
            transform: scale(1.25);
        }
    }
    .play {
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: var(--text);
        color: #0b0913;
        flex-shrink: 0;
        transition: transform 0.3s var(--ease-spring), background 0.3s;
    }
    .play :global(svg) {
        width: 19px;
        height: 19px;
        fill: currentColor;
    }
    .play .spin :global(svg) {
        fill: none;
    }
    .play:hover:not(:disabled) {
        transform: scale(1.08);
        background: #fff;
    }
    .play:active:not(:disabled) {
        transform: scale(0.92);
    }

    /* Progress is a full-width bar scaled horizontally: transform is composited,
       whereas animating width would re-layout and repaint every tick. */
    .line {
        position: absolute;
        left: 22px;
        right: 22px;
        bottom: 3px;
        height: 2px;
        border-radius: 2px;
        background: var(--accent);
        box-shadow: 0 0 8px var(--accent);
        transform-origin: left center;
        transition: transform 0.3s linear;
    }

    .more {
        padding: 4px 6px 0;
    }
    .seek {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 4px 2px;
    }
    .time {
        width: 38px;
        font-size: 11px;
        font-weight: 600;
        color: var(--text-3);
        font-variant-numeric: tabular-nums;
        text-align: center;
        flex-shrink: 0;
    }
    .tools {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 2px 0 2px;
    }
    .group {
        display: flex;
        align-items: center;
        gap: 2px;
    }
    .vol {
        width: 200px;
    }
    .badge-n {
        position: absolute;
        top: -2px;
        right: -4px;
        min-width: 15px;
        height: 15px;
        padding: 0 3px;
        border-radius: 8px;
        background: var(--accent);
        color: var(--on-accent);
        font-size: 9px;
        font-weight: 800;
        display: grid;
        place-items: center;
    }

    .idle {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 4px 14px 4px 4px;
        font-size: 13.5px;
        color: var(--text-2);
        white-space: nowrap;
    }
    .idle strong {
        color: var(--text);
    }
    .idle :global(svg) {
        width: 16px;
        height: 16px;
        transition: transform 0.3s var(--ease-spring);
    }
    .idle:hover :global(svg) {
        transform: translateX(4px);
    }
    .idle-mark {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: conic-gradient(from 200deg, var(--accent), var(--art-2), var(--accent));
        color: #0b0913;
        font: italic 700 24px "Times New Roman", Georgia, serif;
        padding-bottom: 3px;
    }
</style>
