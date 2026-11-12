<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import Slider from "$lib/components/Slider.svelte";
    import LyricsView from "$lib/components/LyricsView.svelte";
    import ShaderCanvas from "$lib/components/ShaderCanvas.svelte";
    import MusicVideoPlayer from "$lib/components/MusicVideoPlayer.svelte";
    import ArtistLinks from "$lib/components/ArtistLinks.svelte";
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
    import { tilt } from "$lib/tilt";
    import { client } from "$lib/ephaptic";
    import type { Song } from "$lib/schema";

    const track = $derived(playerState.currentTrack);
    const fav = $derived(track ? libraryState.isFavourite(track.id) : false);
    const mode = $derived(ui.nowPlayingMode);
    const pack = $derived(VISUALIZER_PACKS.find((p) => p.id === ui.visualizerPack) ?? VISUALIZER_PACKS[0]);
    const artSrc = $derived(artworkState.url);
    let videos = $state<Song[]>([]);
    let selectedVideo = $state<Song | null>(null);
    let videoLoading = $state(false);
    let videoError = $state("");
    let videoRequest = 0;
    let requestedVideoTrack = $state("");
    let videoEntryTime = $state(0);
    let videoEntryPlaying = $state(true);
    const videoRequested = $derived(mode === "video");

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

    function normalizeVideoText(value: string) {
        return value
            .replace(/\((?:official\s*)?(?:music\s*)?video\)|\[(?:official\s*)?(?:music\s*)?video\]/gi, " ")
            .replace(/\((?:official\s*)?(?:audio|lyrics?|visuali[sz]er)\)|\[(?:official\s*)?(?:audio|lyrics?|visuali[sz]er)\]/gi, " ")
            .replace(/[\[(].*?[\])]/g, " ")
            .normalize("NFKD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim();
    }

    function bestVideoForTrack(current: Song, results: Song[]) {
        const title = normalizeVideoText(current.title);
        const artists = current.artists.map((artist) => normalizeVideoText(artist.name)).filter(Boolean);
        return [...results]
            .filter((video) => video.id.startsWith("yt:") && /^[\w-]{11}$/.test(video.id.slice(3)))
            .map((video, index) => {
                const candidateTitle = normalizeVideoText(video.title);
                const candidateArtists = video.artists.map((artist) => normalizeVideoText(artist.name)).filter(Boolean);
                const titleMatch = !candidateTitle ? 0 : candidateTitle === title ? 100 : candidateTitle.includes(title) ? 60 : title.includes(candidateTitle) ? 30 : 0;
                const artistMatch = artists.some((artist) => candidateArtists.some((candidate) =>
                    candidate === artist || candidate.includes(artist) || artist.includes(candidate),
                ));
                return { video, index, score: titleMatch + (artistMatch ? 40 : 0) };
            })
            .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.video ?? null;
    }

    async function loadVideosForTrack(current: Song) {
        requestedVideoTrack = current.id;
        selectedVideo = null;
        videos = [];
        videoError = "";
        videoLoading = true;
        const request = ++videoRequest;
        const query = `${current.title} ${current.artists.map((artist) => artist.name).join(" ")}`.trim();
        try {
            const results = await client.musicSearchVideos(query);
            if (request !== videoRequest || playerState.currentTrack?.id !== current.id) return;
            const list = results.filter((video) => video.id.startsWith("yt:") && /^[\w-]{11}$/.test(video.id.slice(3)));
            if (current.id.startsWith("yt:") && /^[\w-]{11}$/.test(current.id.slice(3)) && !list.some((v) => v.id === current.id)) {
                list.unshift(current);
            }
            videos = list;
            selectedVideo = bestVideoForTrack(current, list) ?? (list[0] ?? null);
        } catch (error) {
            if (request === videoRequest) videoError = error instanceof Error ? error.message : String(error);
        } finally {
            if (request === videoRequest) videoLoading = false;
        }
    }

    let prevMode = $state(ui.nowPlayingMode);
    $effect(() => {
        const m = mode;
        if (m === "video" && prevMode !== "video") {
            videoEntryTime = playerState.currentTime || 0;
            videoEntryPlaying = !playerState.paused;
        }
        prevMode = m;
    });

    $effect(() => {
        const current = track;
        if (!videoRequested || !current || requestedVideoTrack === current.id) return;
        videoEntryTime = playerState.currentTime || 0;
        videoEntryPlaying = !playerState.paused;
        void loadVideosForTrack(current);
    });

    function retryVideoSearch() {
        if (track) void loadVideosForTrack(track);
    }

    function selectVideo(video: Song) {
        const videoId = video.id.startsWith("yt:") ? video.id.slice(3) : "";
        if (!/^[\w-]{11}$/.test(videoId)) return;
        videoEntryTime = playerState.currentTime || 0;
        videoEntryPlaying = true;
        selectedVideo = video;
    }

    const selectedVideoId = $derived(
        selectedVideo?.id.startsWith("yt:") && /^[\w-]{11}$/.test(selectedVideo.id.slice(3))
            ? selectedVideo.id.slice(3)
            : "",
    );
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="np"
    class:vis={mode === "visualizer" || mode === "video"}
    class:idle={idle && (mode === "visualizer" || mode === "video")}
    onmousemove={wake}
    onpointerdown={wake}
    in:fly={{ y: 60, duration: 520, opacity: 0, easing: (t) => 1 - Math.pow(1 - t, 4) }}
    out:fly={{ y: 60, duration: 320, opacity: 0 }}
>
    {#if mode === "visualizer"}
        {#key pack.id}
            <div class="vis-canvas" transition:fade={{ duration: 500 }}>
                {@render visualizer()}
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
            <div class="segmented">
                <button aria-pressed={mode === "lyrics"} onclick={() => (ui.nowPlayingMode = "lyrics")}>
                    <Icon name="mic-vocal" /> Lyrics
                </button>
                <button aria-pressed={mode === "stage"} onclick={() => (ui.nowPlayingMode = "stage")}>
                    <Icon name="blend" /> Stage
                </button>
                <button aria-pressed={mode === "visualizer"} onclick={() => (ui.nowPlayingMode = "visualizer")}>
                    <Icon name="audio-waveform" /> Visualizer
                </button>
                <button aria-pressed={mode === "video"} onclick={() => (ui.nowPlayingMode = "video")}>
                    <Icon name="film" /> Video
                </button>
            </div>
        </div>
        {#if mode === "stage" || mode === "visualizer"}
            <div class="packs-bar">
                <div class="segmented packs">
                    {#each VISUALIZER_PACKS as p}
                        <button aria-pressed={p.id === pack.id} onclick={() => setPack(p.id)}>{p.name}</button>
                    {/each}
                </div>
            </div>
        {/if}
    </header>

    {#if track}
        {#if mode === "lyrics"}
            <div class="stage" class:no-lyrics={!lyricsState.has && !playerState.isLoading && !playerState.lyricsPending}>
                <div class="left">
                    {#key track.id}
                        <!-- Shares a key with the capsule artwork, so it morphs in from the capsule. -->
                        <div class="art-slot" in:receiveArt={{ key: "art" }} out:sendArt={{ key: "art" }}>
                            <!-- Leans toward the cursor, like the cards in search. -->
                            <div class="art-tilt" use:tilt={{ max: 9 }}>
                                <div class="art" class:paused={playerState.paused}>
                                    <Cover src={artSrc} thumbnails={track.thumbnails} title={track.title} size="100%" radius="var(--r-lg)" />
                                </div>
                                <div class="shine"></div>
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
        {:else if mode === "stage"}
            <div class="split">
                <div class="lyrics-pane">
                    {#if lyricsState.has || playerState.lyricsPending}
                        <LyricsView />
                    {:else}
                        <div class="lyrics-empty">
                            <Icon name="mic-vocal" />
                            <h3>No lyrics for this one</h3>
                            <p>Enjoy the visuals.</p>
                        </div>
                    {/if}
                </div>
                <div class="vis-pane">
                    <div class="vis-frame">
                        {#key pack.id}
                            <div class="vis-canvas" transition:fade={{ duration: 400 }}>
                                {@render visualizer()}
                            </div>
                        {/key}
                        {#if pack.id === "halo"}
                            <div class="disc framed" class:spinning={!playerState.paused && !ui.lite}>
                                <Cover src={artSrc} thumbnails={track.thumbnails} title={track.title} size="100%" radius="50%" />
                            </div>
                        {/if}
                    </div>
                    <div class="vis-bar">
                        <div class="vis-meta">
                            {#if pack.id !== "halo"}
                                <Cover src={artSrc} thumbnails={track.thumbnails} title={track.title} size={56} radius="var(--r-sm)" />
                            {/if}
                            {@render meta()}
                        </div>
                        {@render controls()}
                    </div>
                </div>
            </div>
        {:else if mode === "video"}
            <MusicVideoPlayer
                {track}
                videoId={selectedVideoId}
                {videos}
                {selectedVideo}
                loadingVideos={videoLoading}
                {videoError}
                {idle}
                entryTime={videoEntryTime}
                entryPlaying={videoEntryPlaying}
                onselectvideo={selectVideo}
                onretry={retryVideoSearch}
            />
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

{#snippet visualizer()}
    {#if !ui.lite}
    <ShaderCanvas
        {pack}
        onerror={(err) => {
            toasts.error(`Visualizer “${pack.name}” failed to start: ${err.message}`);
            if (pack.id !== "halo") setPack("halo");
        }}
    />
    {/if}
{/snippet}

{#snippet meta()}
    {#if track}
        <div class="meta">
            <div class="meta-text">
                {#key track.id}
                    <h1 class="ellipsis" title={track.title} in:fly={{ y: 10, duration: 500 }}>{track.title}</h1>
                    <p class="ellipsis" in:fly={{ y: 10, duration: 500, delay: 60 }}>
                        <ArtistLinks
                            artists={track.artists}
                            album={track.album}
                            showAlbum={mode === "lyrics"}
                            providerHint={track.id.startsWith("js:") ? "js" : "yt"}
                        />
                    </p>
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
        /* Leave the OS window buttons their corner (see --wc-left/right);
           the rest of the bar doubles as the window's drag handle. */
        padding: 12px calc(22px + var(--wc-right)) 16px calc(22px + var(--wc-left));
        transition: opacity 0.6s;
        -webkit-app-region: drag;
    }
    .top :global(button) {
        -webkit-app-region: no-drag;
    }
    .idle .top,
    .idle .vis-bottom,
    .idle .packs-bar {
        opacity: 0;
    }
    .packs-bar {
        position: absolute;
        top: calc(100% - 4px);
        left: 50%;
        translate: -50% 0;
        transition: opacity 0.6s;
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
    /* The whole column is exactly as wide as the cover (which is capped by the
       window height), so the title, seek bar and buttons line up with it. */
    .left {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 22px;
        min-width: 0;
        width: min(100%, 480px, max(280px, 48vh));
        justify-self: end;
    }
    .art-slot {
        width: 100%;
    }
    .art-tilt {
        --rx: 0deg;
        --ry: 0deg;
        --mx: 50%;
        --my: 0%;
        position: relative;
        perspective: 900px;
        transform-style: preserve-3d;
    }
    .art {
        width: 100%;
        aspect-ratio: 1;
        border-radius: var(--r-lg);
        transform: rotateX(var(--rx)) rotateY(var(--ry)) scale(var(--art-scale, 1));
        box-shadow: 0 40px 80px -20px rgb(0 0 0 / 0.65), 0 12px 30px rgb(0 0 0 / 0.3);
        transition:
            transform 0.6s var(--ease-spring),
            translate 0.4s var(--ease-out),
            box-shadow 0.7s;
    }
    .art-tilt:hover .art {
        translate: 0 -4px;
        transition:
            transform 0.1s linear,
            translate 0.4s var(--ease-out),
            box-shadow 0.7s;
    }
    .art.paused {
        --art-scale: 0.9;
        box-shadow: 0 20px 50px -20px rgb(0 0 0 / 0.5);
    }
    .shine {
        position: absolute;
        inset: 0;
        border-radius: var(--r-lg);
        background: radial-gradient(60% 60% at var(--mx) var(--my), rgb(255 255 255 / 0.24), transparent 70%);
        opacity: 0;
        transition: opacity 0.3s;
        pointer-events: none;
        mix-blend-mode: overlay;
    }
    .art-tilt:hover .shine {
        opacity: 1;
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

    /* --- stage: lyrics on the left, the visualizer on the right -------- */
    .split {
        position: relative;
        z-index: 1;
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(280px, 0.85fr) minmax(0, 1.15fr);
        gap: clamp(20px, 3.4vw, 64px);
        width: 100%;
        max-width: 1600px;
        margin: 0 auto;
        /* clear of the floating pack selector under the header */
        padding: 44px clamp(24px, 4.6vw, 84px) 22px;
    }
    .lyrics-pane {
        min-width: 0;
        min-height: 0;
        display: flex;
        align-items: center;
        padding-bottom: 12px;
    }
    .lyrics-pane > :global(.lyrics) {
        width: 100%;
        height: 100%;
        mask-image: linear-gradient(180deg, transparent 0%, #000 14%, #000 80%, transparent 100%);
    }
    .lyrics-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: 100%;
        height: 100%;
        text-align: center;
        color: rgb(255 255 255 / 0.55);
    }
    .lyrics-empty :global(svg) {
        width: 30px;
        height: 30px;
        opacity: 0.7;
    }
    .lyrics-empty h3 {
        font-size: 17px;
        font-weight: 700;
        color: rgb(255 255 255 / 0.8);
    }
    .lyrics-empty p {
        font-size: 13.5px;
    }

    .vis-pane {
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-width: 0;
        min-height: 0;
    }
    .vis-frame {
        position: relative;
        flex: 1;
        min-height: 0;
        border-radius: 26px;
        overflow: hidden;
        border: 1px solid rgb(255 255 255 / 0.09);
        box-shadow: 0 30px 70px -30px rgb(0 0 0 / 0.8);
        container-type: size;
        isolation: isolate;
    }
    .vis-frame .vis-canvas {
        border-radius: inherit;
    }
    .vis-bar {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 0 2px;
    }
    .vis-bar .ctl {
        padding: 0;
    }
    /* The cover sits at the centre of the Halo ring inside its frame. */
    .disc.framed {
        width: min(46cqw, 46cqh);
        height: auto;
        aspect-ratio: 1;
        margin-top: 0;
    }
    .disc.framed :global(.cover) {
        border-radius: 50%;
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
        z-index: 3;
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
    @media (max-width: 600px) {
        :global([data-os="android"]) .top {
            grid-template-columns: auto 1fr;
            padding: calc(12px + env(safe-area-inset-top, 0px)) 16px 12px;
        }
        :global([data-os="android"]) .from { justify-self: center; max-width: 70vw; }
        :global([data-os="android"]) .top-right { grid-column: 1 / -1; justify-content: center; margin-top: 10px; }
        :global([data-os="android"]) .packs-bar {
            position: static;
            translate: none;
            grid-column: 1 / -1;
            justify-self: center;
            margin-top: 8px;
        }
        :global([data-os="android"]) .packs { display: flex; }
        :global([data-os="android"]) .stage {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 24px;
            overflow-y: auto;
            padding: 0 20px calc(20px + env(safe-area-inset-bottom, 0px));
        }
        :global([data-os="android"]) .left { flex-shrink: 0; }
        :global([data-os="android"]) .stage:not(.no-lyrics) .right {
            display: block;
            flex-shrink: 0;
            width: 100%;
            height: 60dvh;
        }
        :global([data-os="android"]) .split { grid-template-columns: 1fr; overflow-y: auto; }
        :global([data-os="android"]) .vis-pane { min-height: 320px; }
    }
    :global([data-os="android"]) .vis .top {
        background: linear-gradient(180deg, rgb(7 6 11 / 0.86), rgb(7 6 11 / 0.45));
        backdrop-filter: blur(12px);
    }
    :global([data-os="android"]) .vis-bottom {
        background: linear-gradient(0deg, rgb(7 6 11 / 0.94), rgb(7 6 11 / 0.64) 75%, transparent);
    }
    @media (max-width: 600px) and (orientation: portrait) {
        :global([data-os="android"]) .left { gap: 16px; }
        :global([data-os="android"]) .art-slot {
            width: min(100%, max(140px, calc(100dvh - 380px)));
            align-self: center;
        }
    }
    @media (orientation: landscape) and (max-height: 600px) {
        :global([data-os="android"]) .stage { display: block; overflow-y: auto; }
        :global([data-os="android"]) .left {
            display: grid;
            grid-template-columns: minmax(120px, 200px) minmax(0, 1fr);
            align-items: center;
            width: min(100%, 720px);
            margin: 0 auto 20px;
            gap: 16px;
        }
        :global([data-os="android"]) .art-slot { grid-row: 1 / span 2; }
        :global([data-os="android"]) .stage:not(.no-lyrics) .right { display: block; width: 100%; height: 60dvh; }
    }
</style>
