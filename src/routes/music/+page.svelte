<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import MediaCard from "$lib/components/MediaCard.svelte";
    import { libraryState, FAVOURITES_ID } from "$lib/state/library.svelte";
    import { playerState, playPlaylist, playTrack, togglePlay } from "$lib/state/player.svelte";
    import { statsState } from "$lib/state/stats.svelte";
    import { lyricsState } from "$lib/state/lyrics.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { openPlaylist, radioFrom, trackMenu } from "$lib/actions";
    import { artistNames, formatLongDuration } from "$lib/utils";
    import { tilt } from "$lib/tilt";
    import type { Playlist, Song } from "$lib/schema";

    $effect(() => {
        statsState.load();
    });

    const hour = new Date().getHours();
    const greeting = hour < 5 ? "Still up?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const greetingIcon = hour < 5 || hour >= 20 ? "moon-star" : hour < 12 ? "sunrise" : hour < 18 ? "sun" : "sunset";

    type StatSong = { id: string; title: string; artists: string[]; thumbnailUrl?: string };

    /** Prefer the rich library copy of a song; otherwise rebuild one from stats. */
    function toSong(s: StatSong): Song {
        const found = libraryState.tracks.get(s.id);
        if (found) return found;
        return {
            id: s.id,
            title: s.title,
            artists: s.artists.map((name) => ({ name, thumbnails: [] })),
            thumbnails: s.thumbnailUrl ? [{ url: s.thumbnailUrl }] : [],
            album: null,
            duration: 0,
            isDownloaded: false,
        };
    }

    const recent = $derived.by(() => {
        const seen = new Set<string>();
        return (statsState.summary?.history ?? []).filter((h) => !seen.has(h.id) && seen.add(h.id)).slice(0, 14).map(toSong);
    });
    const top = $derived((statsState.summary?.topSongs ?? []).slice(0, 14).map(toSong));
    const radios = $derived(top.slice(0, 8));

    // The hero: what's playing, else the last thing you played.
    const hero = $derived(playerState.currentTrack ?? recent[0] ?? null);
    const heroLive = $derived(!!playerState.currentTrack && hero?.id === playerState.currentTrack.id);
    const heroLyric = $derived(heroLive && lyricsState.active >= 0 ? lyricsState.lines[lyricsState.active]?.text : null);

    const isPlaying = (p: Playlist) => playerState.currentPlaylist?.id === p.id;
    const duration = (p: Playlist) => p.tracks.reduce((s, t) => s + (t.duration || 0), 0);

    function heroPlay() {
        if (!hero) return;
        if (heroLive) togglePlay();
        else playTrack(hero);
    }
</script>

<div class="page">
    <section class="hero island" class:has-track={!!hero}>
        <div class="hero-text">
            <span class="kicker"><Icon name={greetingIcon} /> {greeting}</span>
            {#if hero}
                <h1 class="page-title">{heroLive ? "Now playing" : "Pick up where you left off"}</h1>
                <div class="now">
                    <span class="now-title ellipsis">{hero.title}</span>
                    <span class="now-artist ellipsis">{artistNames(hero)}</span>
                </div>
                {#if heroLyric}
                    {#key heroLyric}<p class="lyric"><Icon name="mic-vocal" /><span>{heroLyric}</span></p>{/key}
                {/if}
                <div class="hero-actions">
                    <button class="play-btn" aria-label="Play" onclick={heroPlay}>
                        <Icon name={heroLive && !playerState.paused ? "pause" : "play"} />
                    </button>
                    {#if heroLive}
                        <button class="btn" onclick={() => ui.openNowPlaying("lyrics")}><Icon name="mic-vocal" /> Lyrics</button>
                        <button class="btn" onclick={() => ui.openNowPlaying("visualizer")}><Icon name="audio-waveform" /> Visualize</button>
                    {/if}
                    <button class="btn" onclick={() => radioFrom(hero)}><Icon name="radio" /> Radio</button>
                </div>
            {:else}
                <h1 class="page-title">What are we listening to?</h1>
                <p class="muted intro">Search YouTube Music or JioSaavn. Save a song to a playlist and it's yours: stored in your own folder, playable anywhere.</p>
                <div class="hero-actions">
                    <a class="btn btn-primary" href="/music/search"><Icon name="search" /> Start searching</a>
                </div>
            {/if}
        </div>
        {#if hero}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div class="hero-art" role="button" tabindex="0" use:tilt={{ max: 12 }} onclick={() => (heroLive ? ui.openNowPlaying() : playTrack(hero))}>
                {#key hero.id}
                    <Cover thumbnails={hero.thumbnails} title={hero.title} size="100%" radius="26px" />
                {/key}
                <div class="hero-shine"></div>
            </div>
        {/if}
    </section>

    {#if libraryState.playlists.length}
        <section class="section">
            <div class="section-head">
                <h2 class="section-title">Your playlists</h2>
                <a class="section-sub link" href="/music/library">See all</a>
            </div>
            <div class="shelf">
                {#each libraryState.playlists as p, i (p.id)}
                    <MediaCard
                        title={p.name}
                        subtitle="{p.tracks.length} songs{p.tracks.length ? ` · ${formatLongDuration(duration(p))}` : ''}"
                        src={p.thumbnail}
                        index={i}
                        playing={isPlaying(p)}
                        paused={playerState.paused}
                        onclick={() => openPlaylist(p)}
                        onplay={p.tracks.length ? () => (isPlaying(p) ? togglePlay() : playPlaylist(p)) : undefined}
                    >
                        {#snippet art()}
                            {#if p.id === FAVOURITES_ID}
                                <div class="fav-art"><Icon name="heart" /></div>
                            {:else}
                                <Cover src={p.thumbnail} title={p.name} size="100%" radius="0" />
                            {/if}
                        {/snippet}
                    </MediaCard>
                {/each}
            </div>
        </section>
    {/if}

    {#if recent.length > 1}
        <section class="section">
            <div class="section-head"><h2 class="section-title">Jump back in</h2></div>
            <div class="shelf">
                {#each recent as song, i (song.id)}
                    <MediaCard
                        title={song.title}
                        subtitle={artistNames(song)}
                        thumbnails={song.thumbnails}
                        index={i}
                        playing={playerState.currentTrack?.id === song.id}
                        paused={playerState.paused}
                        onclick={() => (playerState.currentTrack?.id === song.id ? togglePlay() : playTrack(song))}
                        onplay={() => (playerState.currentTrack?.id === song.id ? togglePlay() : playTrack(song))}
                        oncontextmenu={(e) => ui.openMenu(e, trackMenu(song))}
                    />
                {/each}
            </div>
        </section>
    {/if}

    {#if radios.length}
        <section class="section">
            <div class="section-head">
                <h2 class="section-title">Stations for you</h2>
                <span class="section-sub">Endless mixes spun from your favourites</span>
            </div>
            <div class="shelf radios">
                {#each radios as song, i (song.id)}
                    <MediaCard
                        round
                        title={song.title}
                        subtitle={artistNames(song)}
                        index={i}
                        onclick={() => radioFrom(song)}
                        onplay={() => radioFrom(song)}
                    >
                        {#snippet art()}
                            <div class="vinyl">
                                <div class="grooves"></div>
                                <div class="label-art"><Cover thumbnails={song.thumbnails} title={song.title} size="100%" radius="50%" /></div>
                            </div>
                        {/snippet}
                    </MediaCard>
                {/each}
            </div>
        </section>
    {/if}

    {#if top.length}
        <section class="section">
            <div class="section-head">
                <h2 class="section-title">On repeat</h2>
                <a class="section-sub link" href="/music/stats">Your stats</a>
            </div>
            <div class="shelf">
                {#each top as song, i (song.id)}
                    <MediaCard
                        title={song.title}
                        subtitle={artistNames(song)}
                        thumbnails={song.thumbnails}
                        index={i}
                        playing={playerState.currentTrack?.id === song.id}
                        paused={playerState.paused}
                        onclick={() => playTrack(song)}
                        onplay={() => (playerState.currentTrack?.id === song.id ? togglePlay() : playTrack(song))}
                        oncontextmenu={(e) => ui.openMenu(e, trackMenu(song))}
                    />
                {/each}
            </div>
        </section>
    {/if}
</div>

<style>
    .hero {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        align-items: center;
        gap: 40px;
        padding: 40px 44px;
        margin-top: 12px;
        overflow: hidden;
        animation: rise 0.7s var(--ease-out) both;
    }
    .hero.has-track {
        grid-template-columns: minmax(0, 1fr) minmax(200px, 300px);
    }
    @keyframes rise {
        from {
            opacity: 0;
            transform: translateY(18px);
        }
    }
    /* soft accent bloom inside the island */
    .hero::before {
        content: "";
        position: absolute;
        inset: -40% 30% auto -20%;
        height: 140%;
        background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 22%, transparent), transparent);
        pointer-events: none;
    }
    .hero-text {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 14px;
        min-width: 0;
    }
    .now {
        display: flex;
        flex-direction: column;
        min-width: 0;
        max-width: 100%;
        margin-top: 4px;
    }
    .now-title {
        font-family: var(--font-display);
        font-size: clamp(22px, 2.4vw, 30px);
        font-weight: 800;
        letter-spacing: -0.03em;
        max-width: 100%;
    }
    .now-artist {
        font-size: 16px;
        color: var(--text-2);
        max-width: 100%;
    }
    .lyric {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: color-mix(in srgb, var(--accent) 55%, white);
        animation: lyric-in 0.5s var(--ease-out);
        max-width: 60ch;
    }
    .lyric :global(svg) {
        width: 17px;
        height: 17px;
        flex-shrink: 0;
        opacity: 0.7;
    }
    @keyframes lyric-in {
        from {
            opacity: 0;
            transform: translateY(8px);
            filter: blur(4px);
        }
    }
    .intro {
        max-width: 56ch;
        font-size: 15.5px;
        line-height: 1.6;
    }
    .hero-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 8px;
    }
    .hero-actions .btn {
        height: 42px;
        background: rgb(255 255 255 / 0.1);
    }
    .hero-art {
        --rx: 0deg;
        --ry: 0deg;
        --mx: 50%;
        --my: 0%;
        position: relative;
        aspect-ratio: 1;
        width: 100%;
        border-radius: 26px;
        cursor: pointer;
        transform: perspective(900px) rotateX(var(--rx)) rotateY(var(--ry));
        transition: transform 0.2s linear;
        box-shadow: 0 40px 70px -30px rgb(0 0 0 / 0.9), 0 0 60px -20px var(--accent-glow);
        animation: rise 0.8s 0.1s var(--ease-out) both;
    }
    .hero-shine {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: radial-gradient(50% 50% at var(--mx) var(--my), rgb(255 255 255 / 0.25), transparent 70%);
        mix-blend-mode: overlay;
        pointer-events: none;
    }

    .fav-art {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        background: radial-gradient(120% 100% at 0% 0%, #7c5cff, #4a2bd6 45%, #b04ac9);
    }
    .fav-art :global(svg) {
        width: 64px;
        height: 64px;
        fill: #fff;
        margin-bottom: 40px;
        filter: drop-shadow(0 10px 20px rgb(0 0 0 / 0.3));
    }

    /* stations look like records: grooves with the cover as the label */
    .radios {
        grid-auto-columns: 172px;
    }
    .vinyl {
        position: relative;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: radial-gradient(circle, #1a1720 0 30%, #0c0a10 31% 100%);
    }
    .grooves {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background:
            repeating-radial-gradient(circle, rgb(255 255 255 / 0.05) 0 1px, transparent 1px 4px),
            conic-gradient(from 30deg, transparent 0 20%, rgb(255 255 255 / 0.12) 25%, transparent 30% 70%, rgb(255 255 255 / 0.08) 75%, transparent 80%);
    }
    .label-art {
        position: absolute;
        inset: 26%;
        border-radius: 50%;
        overflow: hidden;
        box-shadow: 0 0 0 3px rgb(0 0 0 / 0.5);
        transition: transform 1.2s var(--ease-out);
    }
    .vinyl:hover .label-art {
        transform: rotate(160deg);
    }
    .link:hover {
        color: var(--text);
        text-decoration: underline;
    }

    @media (max-width: 820px) {
        .hero.has-track {
            grid-template-columns: 1fr;
        }
        .hero-art {
            max-width: 240px;
        }
    }
</style>
