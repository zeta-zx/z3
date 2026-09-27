<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import Slider from "$lib/components/Slider.svelte";
    import LyricsView from "$lib/components/LyricsView.svelte";
    import ShaderCanvas from "$lib/components/ShaderCanvas.svelte";
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
    } from "$lib/state/player.svelte";
    import { libraryState } from "$lib/state/library.svelte";
    import { lyricsState } from "$lib/state/lyrics.svelte";
    import { artworkState } from "$lib/state/artwork.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { trackMenu } from "$lib/actions";
    import { VISUALIZER_PACKS } from "$lib/visualizer/packs";
    import { artistNames, formatTime } from "$lib/utils";
    import { fade, fly } from "svelte/transition";
    import { sendArt, receiveArt } from "$lib/transitions";
    import { toasts } from "$lib/state/toast.svelte";

    const track = $derived(playerState.currentTrack);
    const fav = $derived(track ? libraryState.isFavourite(track.id) : false);
    const mode = $derived(ui.nowPlayingMode);
    const pack = $derived(VISUALIZER_PACKS.find((p) => p.id === ui.visualizerPack) ?? VISUALIZER_PACKS[0]);
    const artSrc = $derived(artworkState.url);

    // Hide chrome when the mouse is idle (visualizer mode).
    let idle = $state(false);
    let idleTimer: ReturnType<typeof setTimeout>;
    function wake() {
        idle = false;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => (idle = true), 3200);
    }
    $effect(() => {
        wake();
        return () => clearTimeout(idleTimer);
    });

    $effect(() => {
        if (!track) ui.nowPlayingOpen = false;
    });

    function setPack(id: string) {
        ui.visualizerPack = id;
        ui.save();
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="np"
    class:vis={mode === "visualizer"}
    class:idle={idle && mode === "visualizer"}
    onmousemove={wake}
    in:fly={{ y: 60, duration: 520, opacity: 0, easing: (t) => 1 - Math.pow(1 - t, 4) }}
    out:fly={{ y: 60, duration: 320, opacity: 0 }}
>
    {#if mode === "visualizer"}
        {#key pack.id}
            <div class="vis-canvas" transition:fade={{ duration: 500 }}>
                <ShaderCanvas
                    {pack}
                    onerror={(err) => {
                        toasts.error(`Visualizer “${pack.name}” failed to start: ${err.message}`);
                        if (pack.id !== "halo") setPack("halo");
                    }}
                />
            </div>
        {/key}
    {/if}

    <header class="top">
        <button class="icon-btn" title="Close (Esc)" onclick={() => (ui.nowPlayingOpen = false)}>
            <Icon name="chevron-down" />
        </button>
        <div class="from">
            {#if playerState.currentPlaylist}
                <span class="from-label">Playing from</span>
                <span class="from-name ellipsis">{playerState.currentPlaylist.name}</span>
            {:else}
                <span class="from-label">Now playing</span>
            {/if}
        </div>
        <div class="top-right">
            {#if mode === "visualizer"}
                <div class="segmented packs">
                    {#each VISUALIZER_PACKS as p}
                        <button aria-pressed={p.id === pack.id} onclick={() => setPack(p.id)}>{p.name}</button>
                    {/each}
                </div>
            {/if}
            <div class="segmented">
                <button aria-pressed={mode === "lyrics"} onclick={() => (ui.nowPlayingMode = "lyrics")}>
                    <Icon name="mic-vocal" /> Lyrics
                </button>
                <button aria-pressed={mode === "visualizer"} onclick={() => (ui.nowPlayingMode = "visualizer")}>
                    <Icon name="audio-waveform" /> Visualizer
                </button>
            </div>
        </div>
    </header>

    {#if track}
        {#if mode === "lyrics"}
            <div class="stage" class:no-lyrics={!lyricsState.has && !playerState.isLoading}>
                <div class="left">
                    {#key track.id}
                        <!-- Shares a key with the capsule artwork, so it morphs in from the capsule. -->
                        <div class="art-slot" in:receiveArt={{ key: "art" }} out:sendArt={{ key: "art" }}>
                            <div class="art" class:paused={playerState.paused}>
                                <Cover src={artSrc} thumbnails={track.thumbnails} title={track.title} size="100%" radius="var(--r-lg)" />
                            </div>
                        </div>
                    {/key}
                    {@render meta()}
                    {@render controls()}
                </div>
                <div class="right">
                    <LyricsView />
                </div>
            </div>
        {:else}
            <div class="vis-stage">
                {#if pack.id === "halo"}
                    <div class="disc" class:spinning={!playerState.paused}>
                        <Cover src={artSrc} thumbnails={track.thumbnails} title={track.title} size="100%" radius="50%" />
                    </div>
                {/if}
                <div class="vis-bottom">
                    <div class="vis-meta">
                        {#if pack.id !== "halo"}
                            <Cover src={artSrc} thumbnails={track.thumbnails} title={track.title} size={64} radius="var(--r-sm)" />
                        {/if}
                        {@render meta()}
                    </div>
                    {@render controls()}
                </div>
            </div>
        {/if}
    {/if}
</div>

{#snippet meta()}
    {#if track}
        <div class="meta">
            <div class="meta-text">
                {#key track.id}
                    <h1 class="ellipsis" title={track.title} in:fly={{ y: 10, duration: 500 }}>{track.title}</h1>
                    <p class="ellipsis" in:fly={{ y: 10, duration: 500, delay: 60 }}>{artistNames(track)}</p>
                {/key}
            </div>
            <button class="icon-btn fav" class:is-fav={fav} title="Favourite" onclick={() => libraryState.toggleFavourite(track)}>
                <Icon name="heart" />
            </button>
            <button class="icon-btn" title="More" onclick={(e) => ui.openMenuAt(e.currentTarget, trackMenu(track, { playlist: playerState.currentPlaylist }))}>
                <Icon name="ellipsis" />
            </button>
        </div>
    {/if}
{/snippet}

{#snippet controls()}
    <div class="ctl">
        <div class="progress">
            <Slider value={playerState.currentTime} max={playerState.duration || 0} onchange={seek} format={formatTime} label="Seek" />
            <div class="times">
                <span>{formatTime(playerState.currentTime)}</span>
                <span>-{formatTime(Math.max(0, (playerState.duration || 0) - playerState.currentTime))}</span>
            </div>
        </div>
        <div class="buttons">
            <button class="icon-btn" class:on={playerState.shuffle} title="Shuffle" onclick={toggleShuffle}><Icon name="shuffle" /></button>
            <button class="icon-btn xl" title="Previous" onclick={previousTrack}><Icon name="skip-back" /></button>
            <button class="big-play" title="Play/Pause" disabled={playerState.isLoading} onclick={togglePlay}>
                {#if playerState.isLoading}
                    <span class="spin"><Icon name="loader-circle" /></span>
                {:else}
                    <Icon name={playerState.paused ? "play" : "pause"} />
                {/if}
            </button>
            <button class="icon-btn xl" title="Next" disabled={!isNextTrackAvailable()} onclick={nextTrack}><Icon name="skip-forward" /></button>
            <button class="icon-btn" class:on={playerState.repeat !== "off"} title="Repeat: {playerState.repeat}" onclick={cycleRepeat}>
                <Icon name={playerState.repeat === "one" ? "repeat-1" : "repeat"} />
            </button>
        </div>
        <div class="vol">
            <button class="icon-btn sm" onclick={toggleMute} title="Mute"><Icon name={playerState.muted || !playerState.volume ? "volume-x" : "volume-1"} /></button>
            <Slider value={playerState.muted ? 0 : playerState.volume} max={1} live onchange={setVolume} label="Volume" />
            <Icon name="volume-2" />
        </div>
    </div>
{/snippet}

<style>
    .np {
        position: fixed;
        inset: 0;
        z-index: 900;
        display: flex;
        flex-direction: column;
        color: #fff;
        overflow: hidden;
        /* the app's ambient backdrop shows through at full intensity */
        background: rgb(0 0 0 / 0.08);
    }
    .np.idle {
        cursor: none;
    }
    .vis-canvas {
        position: absolute;
        inset: 0;
        background: #000;
    }

    .top {
        position: relative;
        z-index: 2;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        padding: 16px 22px;
        transition: opacity 0.6s;
    }
    .idle .top,
    .idle .vis-bottom {
        opacity: 0;
    }
    .top .icon-btn {
        color: #fff;
    }
    .from {
        display: flex;
        flex-direction: column;
        align-items: center;
        min-width: 0;
        max-width: 40vw;
    }
    .from-label {
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgb(255 255 255 / 0.6);
    }
    .from-name {
        font-weight: 650;
        font-size: 13.5px;
    }
    .top-right {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
    }
    .segmented {
        background: rgb(0 0 0 / 0.25);
        border-color: rgb(255 255 255 / 0.1);
        backdrop-filter: blur(12px);
    }
    .segmented button {
        color: rgb(255 255 255 / 0.75);
    }
    .segmented button[aria-pressed="true"] {
        background: #fff;
        color: #000;
    }

    /* --- lyrics mode ---------------------------------------------------- */
    .stage {
        position: relative;
        z-index: 1;
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(300px, 0.9fr) minmax(0, 1.25fr);
        gap: clamp(32px, 6vw, 110px);
        padding: 0 clamp(28px, 6vw, 110px) 28px;
        max-width: 1600px;
        width: 100%;
        margin: 0 auto;
    }
    .left {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 22px;
        min-width: 0;
        max-width: 480px;
        width: 100%;
        justify-self: end;
    }
    .art-slot {
        width: 100%;
        max-height: 48vh;
        max-width: 48vh;
    }
    .art {
        width: 100%;
        aspect-ratio: 1;
        max-height: 48vh;
        max-width: 48vh;
        border-radius: var(--r-lg);
        box-shadow: 0 40px 80px -20px rgb(0 0 0 / 0.65), 0 12px 30px rgb(0 0 0 / 0.3);
        transition: transform 0.7s var(--ease-spring), box-shadow 0.7s;
    }
    .art.paused {
        transform: scale(0.9);
        box-shadow: 0 20px 50px -20px rgb(0 0 0 / 0.5);
    }
    .right {
        min-width: 0;
        min-height: 0;
        height: 100%;
    }
    .no-lyrics {
        grid-template-columns: 1fr;
    }
    .no-lyrics .right {
        display: none;
    }
    .no-lyrics .left {
        justify-self: center;
    }

    .meta {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
    }
    .meta-text {
        flex: 1;
        min-width: 0;
    }
    .meta h1 {
        font-size: clamp(20px, 2vw, 26px);
        font-weight: 800;
    }
    .meta p {
        font-size: clamp(15px, 1.4vw, 18px);
        color: rgb(255 255 255 / 0.7);
        margin-top: 2px;
    }
    .meta .icon-btn {
        color: rgb(255 255 255 / 0.8);
        background: rgb(255 255 255 / 0.08);
    }
    .fav.is-fav :global(svg) {
        fill: currentColor;
    }

    .ctl {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .progress .times {
        display: flex;
        justify-content: space-between;
        font-size: 11.5px;
        font-weight: 600;
        color: rgb(255 255 255 / 0.55);
        font-variant-numeric: tabular-nums;
        margin-top: 2px;
    }
    .ctl :global(.fill) {
        background: #fff !important;
    }
    .buttons {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 4px;
    }
    .buttons .icon-btn {
        color: rgb(255 255 255 / 0.8);
    }
    .buttons .icon-btn.on {
        color: #fff;
    }
    .buttons .icon-btn.on::after {
        background: #fff;
    }
    .icon-btn.xl {
        width: 52px;
        height: 52px;
    }
    .icon-btn.xl :global(svg) {
        width: 28px;
        height: 28px;
        fill: currentColor;
    }
    .big-play {
        display: grid;
        place-items: center;
        width: 70px;
        height: 70px;
        border-radius: 50%;
        background: #fff;
        color: #000;
        box-shadow: 0 12px 40px -10px rgb(0 0 0 / 0.6);
        transition: transform 0.3s var(--ease-spring);
    }
    .big-play :global(svg) {
        width: 30px;
        height: 30px;
        fill: currentColor;
    }
    .big-play .spin :global(svg) {
        fill: none;
    }
    .big-play:hover:not(:disabled) {
        transform: scale(1.06);
    }
    .big-play:active:not(:disabled) {
        transform: scale(0.94);
    }
    .vol {
        display: flex;
        align-items: center;
        gap: 6px;
        color: rgb(255 255 255 / 0.6);
    }
    .vol > :global(svg) {
        width: 16px;
        height: 16px;
    }

    /* --- visualizer mode ------------------------------------------------ */
    .vis-stage {
        position: relative;
        z-index: 1;
        flex: 1;
        min-height: 0;
    }
    /* Sits inside the Halo shader's ring (radius 0.25 of the short side). */
    .disc {
        position: absolute;
        left: 50%;
        top: 50%;
        width: calc(min(100vw, 100vh) * 0.46);
        height: calc(min(100vw, 100vh) * 0.46);
        margin-top: -32px;
        translate: -50% -50%;
        border-radius: 50%;
        box-shadow: 0 0 80px -10px color-mix(in srgb, var(--accent) 50%, transparent), 0 30px 60px rgb(0 0 0 / 0.6);
        animation: spin 40s linear infinite;
        animation-play-state: paused;
    }
    .disc.spinning {
        animation-play-state: running;
    }
    .vis-bottom {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 520px) minmax(0, 1fr);
        align-items: end;
        gap: 32px;
        padding: 60px 32px 26px;
        background: linear-gradient(0deg, rgb(0 0 0 / 0.55), transparent);
        transition: opacity 0.6s;
    }
    .vis-meta {
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
    }
    .vis-meta .meta {
        flex: 1;
    }

    @media (max-width: 900px) {
        .stage {
            grid-template-columns: 1fr;
        }
        .right {
            display: none;
        }
        .left {
            justify-self: center;
        }
        .vis-bottom {
            grid-template-columns: 1fr;
        }
        .packs {
            display: none;
        }
    }
</style>
