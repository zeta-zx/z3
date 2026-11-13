<script lang="ts">
    import { goto } from "$app/navigation";
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import MediaCard from "$lib/components/MediaCard.svelte";
    import ArtistLinks from "$lib/components/ArtistLinks.svelte";
    import { client } from "$lib/ephaptic";
    import { libraryState, FAVOURITES_ID } from "$lib/state/library.svelte";
    import { playerState, playPlaylist, playTrack, togglePlay } from "$lib/state/player.svelte";
    import { statsState } from "$lib/state/stats.svelte";
    import { lyricsState } from "$lib/state/lyrics.svelte";
    import { toasts } from "$lib/state/toast.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { collectionMenu, openPlaylist, openCollection, playCollection, radioFrom, trackMenu } from "$lib/actions";
    import { filterPlaylistRecommendations, filterRecommendationsByArtist } from "$lib/playlist-recommendations";
    import { splitArtistCredits } from "$lib/music-metadata";
    import { formatLongDuration, slimSong } from "$lib/utils";
    import { tilt } from "$lib/tilt";
    import type { Artist, CollectionSummary, Playlist, Song } from "$lib/schema";

    $effect(() => {
        statsState.load();
    });

    $effect(() => {
        void loadWorldwidePlaylists();
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

    const favourites = $derived(libraryState.getPlaylist(FAVOURITES_ID)?.tracks ?? []);
    let lastFavouritePlays = $state<Record<string, number> | null>(null);
    $effect(() => {
        const ids = favourites.map(({ id }) => id);
        let stale = false;
        lastFavouritePlays = null;
        void client.statsLastPlayed(ids).then((plays) => {
            if (!stale) lastFavouritePlays = plays;
        }).catch(() => {});
        return () => { stale = true; };
    });
    const forgotten = $derived.by(() => {
        if (!lastFavouritePlays) return [];
        const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
        return favourites.filter(({ id }) => lastFavouritePlays![id] > 0 && lastFavouritePlays![id] < cutoff)
            .toSorted((a, b) => lastFavouritePlays![a.id] - lastFavouritePlays![b.id]).slice(0, 12);
    });

    let recommendations = $state<Song[]>([]);
    let similarArtists = $state<Artist[]>([]);
    let discoveryArtists = $state<Artist[]>([]);
    let artistTab = $state<"similar" | "discover">("similar");
    let worldwidePlaylists = $state<CollectionSummary[]>([]);
    let chartsLoading = $state(true);
    let chartsStarted = false;
    let recommendationSource = $state("");
    let recommendationsLoading = $state(false);
    let recommendationRequest = 0;
    let recommendationStarted = false;

    async function loadWorldwidePlaylists() {
        if (chartsStarted) return;
        chartsStarted = true;
        const queries = ["Top 100 Global", "Global Top Songs", "Viral 50 Global", "Worldwide Hits"];
        const results = await Promise.allSettled(queries.map((query) => client.musicSearchPlaylists(query, "yt")));
        const playlists = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
        worldwidePlaylists = [...new Map(playlists.map((playlist) => [playlist.id, playlist])).values()].slice(0, 12);
        chartsLoading = false;
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") toasts.error(failure.reason);
    }

    function lastfmSong(track: Awaited<ReturnType<typeof client.scrobbleTaste>>[number]): Song {
        return {
            id: track.id,
            title: track.title,
            artists: track.artists.map((name) => ({ name, thumbnails: [] })),
            thumbnails: [],
            album: track.album ? { title: track.album, artists: [], thumbnails: [] } : null,
            duration: track.duration,
            isDownloaded: false,
        };
    }

    function selectTasteSeeds(songs: Song[], limit = 4) {
        const seenSongs = new Set<string>();
        const candidates = songs.filter((song) => {
            const songKey = `${song.title.toLowerCase()}|${song.artists[0]?.name.toLowerCase() ?? ""}`;
            if (seenSongs.has(songKey)) return false;
            seenSongs.add(songKey);
            return true;
        });
        const seeds: Song[] = [];
        const seenArtists = new Set<string>();
        for (let i = 0; i < limit && seeds.length < candidates.length; i++) {
            const position = Math.round(i * (candidates.length - 1) / Math.max(limit - 1, 1));
            const song = candidates.slice(position).find((candidate) => {
                const artist = candidate.artists[0]?.name.toLowerCase() ?? "";
                return !seeds.includes(candidate) && (!artist || !seenArtists.has(artist));
            }) ?? candidates.find((candidate) => {
                const artist = candidate.artists[0]?.name.toLowerCase() ?? "";
                return !seeds.includes(candidate) && (!artist || !seenArtists.has(artist));
            });
            if (!song) break;
            seeds.push(song);
            const artist = song.artists[0]?.name.toLowerCase();
            if (artist) seenArtists.add(artist);
        }
        return seeds;
    }

    async function loadRecommendations() {
        const request = ++recommendationRequest;
        recommendationsLoading = true;
        recommendations = [];
        similarArtists = [];
        discoveryArtists = [];
        let lastfmSongs: Song[] = [];
        let lastfmArtists: string[] = [];
        let heardSongs: Song[] = [];
        let extendedSummary: Awaited<ReturnType<typeof client.statsSummary>> | null = null;
        try {
            const [lastfmTaste, similarArtists, summary] = await Promise.allSettled([
                client.scrobbleTaste(),
                client.scrobbleSimilarArtists(),
                // Use a broad history window. Recommendations should reflect
                // the listener's catalogue over time, not one recent track.
                client.statsSummary(2000),
            ]);
            if (lastfmTaste.status === "fulfilled") lastfmSongs = lastfmTaste.value.map(lastfmSong);
            else toasts.error(lastfmTaste.reason);
            if (similarArtists.status === "fulfilled") lastfmArtists = similarArtists.value;
            else toasts.error(similarArtists.reason);
            if (summary.status === "fulfilled") extendedSummary = summary.value;
            else toasts.error(summary.reason);
        } catch (error) {
            toasts.error(error);
        }
        if (request !== recommendationRequest) return;

        const history = (extendedSummary?.history ?? statsState.summary?.history ?? []).map(toSong);
        const frequent = (extendedSummary?.topSongs ?? statsState.summary?.topSongs ?? []).map(toSong);
        const saved = [...libraryState.tracks.values()];
        heardSongs = [...history, ...frequent, ...lastfmSongs, ...saved, ...(playerState.currentTrack ? [playerState.currentTrack] : [])];
        const usingLastfm = lastfmSongs.length > 0;
        // Mix weighted favourites/top plays, broad recent history, imported
        // Last.fm taste, and the saved library. Last.fm is an extra signal,
        // never a replacement for Zeta's own listening history.
        const tasteProfile = [...frequent, ...history, ...lastfmSongs, ...saved];
        const seeds = selectTasteSeeds(tasteProfile, 12);
        recommendationSource = usingLastfm ? "your listening history and Last.fm taste" : "your listening history";
        if (!seeds.length) {
            recommendations = [];
            recommendationsLoading = false;
            recommendationSource = "";
            return;
        }

        const listenedArtists = new Set(heardSongs.flatMap((song) => song.artists.map((artist) => artist.name.toLowerCase())));
        const artistSeeds = selectTasteSeeds(tasteProfile, 12)
            .map((song) => song.artists[0]?.name)
            .filter((name): name is string => !!name);
        const similarResults = await Promise.allSettled(artistSeeds.map((name) => client.musicArtist(name)));
        const localSimilarNames = similarResults.flatMap((result) =>
            result.status === "fulfilled" ? result.value.similarArtists.map((artist) => artist.name) : [],
        );
        const similarArtistNames = [...new Set([...lastfmArtists, ...localSimilarNames])]
            .filter((name) => !listenedArtists.has(name.toLowerCase()));

        const artistResults = await Promise.allSettled(similarArtistNames.slice(0, 8).map((name) => client.musicArtist(name)));
        if (request !== recommendationRequest) return;
        const artistDetails = artistResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        similarArtists = artistDetails
            .filter((artist) => !listenedArtists.has(artist.name.toLowerCase()))
            .filter((artist, i, all) => all.findIndex((other) => other.name.toLowerCase() === artist.name.toLowerCase()) === i)
            .slice(0, 8);

        const knownIds = [...new Set(heardSongs.map((song) => song.id))];
        const radioResults = await Promise.allSettled(
            seeds.map((seed) => client.musicRadio(slimSong($state.snapshot(seed) as Song), knownIds)),
        );
        if (request === recommendationRequest) {
            const radioSongs = radioResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
            const relatedNames = new Set(similarArtists.map((artist) => artist.name.toLowerCase()));
            const discoveryNames = [...new Set(radioSongs.flatMap((song) =>
                splitArtistCredits(song.artists).map((credit) => credit.name),
            ))].filter((name) => name && !listenedArtists.has(name.toLowerCase()) && !relatedNames.has(name.toLowerCase()));
            const discoveryResults = await Promise.allSettled(discoveryNames.slice(0, 8).map((name) => client.musicArtist(name)));
            if (request !== recommendationRequest) return;
            discoveryArtists = discoveryResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
                .filter((artist) => !listenedArtists.has(artist.name.toLowerCase()) && !relatedNames.has(artist.name.toLowerCase()))
                .filter((artist, i, all) => all.findIndex((other) => other.name.toLowerCase() === artist.name.toLowerCase()) === i)
                .slice(0, 8);
            if (!similarArtists.length && discoveryArtists.length) artistTab = "discover";
            const artistSongs = [...similarArtists, ...discoveryArtists]
                .flatMap((artist) => artistDetails.find((detail) => detail.name === artist.name)?.topSongs
                    ?? discoveryResults.flatMap((result) => result.status === "fulfilled" && result.value.name === artist.name ? result.value.topSongs : []));
            const unseen = filterPlaylistRecommendations([...artistSongs, ...radioSongs], heardSongs, 100);
            recommendations = filterRecommendationsByArtist(unseen, 20);
            recommendationsLoading = false;
            const failure = artistResults.find((result) => result.status === "rejected")
                ?? radioResults.find((result) => result.status === "rejected")
                ?? discoveryResults.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") toasts.error(failure.reason);
        }
    }

    $effect(() => {
        if (!statsState.loading && !recommendationStarted) {
            recommendationStarted = true;
            void loadRecommendations();
        }
    });

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
                    <span class="now-artist ellipsis">
                        <ArtistLinks artists={hero.artists} album={hero.album} showAlbum providerHint={hero.id.startsWith("js:") ? "js" : "yt"} />
                    </span>
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

    {#if recommendationSource}
        <section class="section discovery">
            <div class="section-head discovery-head">
                <div class="discovery-copy">
                    <h2 class="section-title">Recommended for you</h2>
                    <span class="section-sub">Inspired by {recommendationSource}</span>
                </div>
                <button class="icon-btn discovery-refresh" aria-label="Refresh recommendations" title="Refresh recommendations"
                    disabled={recommendationsLoading} onclick={() => loadRecommendations()}>
                    <Icon name="refresh-cw" />
                </button>
            </div>
            {#if recommendationsLoading && !recommendations.length}
                <div class="shelf">
                    {#each Array(6) as _, i}
                        <div class="recommendation-skeleton" style:animation-delay="{i * 70}ms"></div>
                    {/each}
                </div>
            {:else if recommendations.length}
                <div class="shelf">
                    {#each recommendations as song, i (song.id)}
                        <MediaCard
                            title={song.title}
                            artists={song.artists}
                            providerHint={song.id.startsWith("js:") ? "js" : "yt"}
                            thumbnails={song.thumbnails}
                            index={i}
                            playing={playerState.currentTrack?.id === song.id}
                            paused={playerState.paused}
                            onclick={() => (playerState.currentTrack?.id === song.id ? togglePlay() : playTrack(song))}
                            onplay={() => (playerState.currentTrack?.id === song.id ? togglePlay() : playTrack(song))}
                            oncontextmenu={(e) => ui.openMenu(e, trackMenu(song))}
                        />
                    {/each}
                    {#if recommendationsLoading}
                        {#each Array(3) as _, i}
                            <div class="recommendation-skeleton" style:animation-delay="{i * 70}ms"></div>
                        {/each}
                    {/if}
                </div>
            {:else}
                <p class="discovery-empty">Keep listening and we’ll find your next favorite.</p>
            {/if}
        </section>
    {/if}

    {#if similarArtists.length || discoveryArtists.length}
        <section class="section">
            <div class="section-head">
                <h2 class="section-title">Artists for you</h2>
                <div class="segmented" aria-label="Artist recommendations">
                    <button
                        aria-pressed={artistTab === "similar"}
                        disabled={!similarArtists.length}
                        onclick={() => (artistTab = "similar")}
                    >Similar</button>
                    <button
                        aria-pressed={artistTab === "discover"}
                        disabled={!discoveryArtists.length}
                        onclick={() => (artistTab = "discover")}
                    >Discover</button>
                </div>
            </div>
            {#if artistTab === "similar"}
                <div class="shelf radios">
                    {#each similarArtists as artist, i (artist.id ?? artist.name)}
                        <MediaCard
                            round
                            title={artist.name}
                            subtitle="Similar to your listening"
                            thumbnails={artist.thumbnails}
                            index={i}
                            onclick={() => goto(`/music/artist/name:${encodeURIComponent(artist.name)}`)}
                        />
                    {/each}
                </div>
            {:else}
                <div class="shelf radios">
                    {#each discoveryArtists as artist, i (artist.id ?? artist.name)}
                        <MediaCard
                            round
                            title={artist.name}
                            subtitle="A new artist for you"
                            thumbnails={artist.thumbnails}
                            index={i}
                            onclick={() => goto(`/music/artist/name:${encodeURIComponent(artist.name)}`)}
                        />
                    {/each}
                </div>
            {/if}
        </section>
    {/if}

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

    <section class="section">
        <div class="section-head">
            <div>
                <h2 class="section-title">Worldwide charts</h2>
                <span class="section-sub">Global top 100, viral hits, and more</span>
            </div>
            <a class="section-sub link" href="/music/genres">Browse genres</a>
        </div>
        {#if chartsLoading && !worldwidePlaylists.length}
            <div class="shelf">
                {#each Array(5) as _, i}
                    <div class="recommendation-skeleton" style:animation-delay="{i * 70}ms"></div>
                {/each}
            </div>
        {:else if worldwidePlaylists.length}
            <div class="shelf">
                {#each worldwidePlaylists as playlist, i (playlist.id)}
                    <MediaCard
                        title={playlist.title}
                        subtitle={playlist.subtitle ?? "YouTube Music playlist"}
                        thumbnails={playlist.thumbnails}
                        providerHint="yt"
                        index={i}
                        playing={playerState.currentPlaylist?.id === `collection:${playlist.id}`}
                        paused={playerState.paused}
                        onclick={() => openCollection(playlist)}
                        onplay={() => playCollection(playlist)}
                        oncontextmenu={(e) => ui.openMenu(e, collectionMenu(playlist))}
                    />
                {/each}
            </div>
        {:else}
            <p class="discovery-empty">Worldwide playlists aren’t available right now.</p>
        {/if}
    </section>

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
                        artists={song.artists}
                        providerHint={song.id.startsWith("js:") ? "js" : "yt"}
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

    {#if forgotten.length}
        <section>
            <h2 class="section-title">Forgotten favourites</h2>
            <p class="muted">Favourites you haven't played in at least 90 days.</p>
            <div class="forgotten-tracks">
                {#each forgotten as song (song.id)}
                    <button class="btn" onclick={() => playTrack(song)}>{song.title}</button>
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
                        artists={song.artists}
                        providerHint={song.id.startsWith("js:") ? "js" : "yt"}
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
    .forgotten-tracks { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
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

    .discovery-head {
        align-items: center;
    }
    .discovery-copy {
        display: flex;
        align-items: baseline;
        gap: 12px;
        min-width: 0;
        flex-wrap: wrap;
    }
    .discovery-refresh {
        flex-shrink: 0;
        color: var(--text-2);
    }
    .discovery-refresh:disabled {
        opacity: 0.45;
        cursor: wait;
    }
    .recommendation-skeleton {
        aspect-ratio: 1;
        border-radius: 26px;
        background: linear-gradient(110deg, rgb(255 255 255 / 0.04) 25%, rgb(255 255 255 / 0.1) 45%, rgb(255 255 255 / 0.04) 65%);
        background-size: 220% 100%;
        animation: recommendation-shimmer 1.4s ease-in-out infinite, rise 0.5s var(--ease-out) both;
    }
    @keyframes recommendation-shimmer {
        to { background-position: -220% 0; }
    }
    .discovery-empty {
        padding: 10px 0 2px;
        color: var(--text-2);
        font-size: 14px;
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

    @media (max-width: 560px) {
        .discovery-copy {
            align-items: flex-start;
            flex-direction: column;
            gap: 2px;
        }
    }
    @media (max-width: 820px) {
        .hero.has-track {
            grid-template-columns: 1fr;
        }
        .hero-art {
            max-width: 240px;
        }
    }
    @media (max-width: 600px) {
        :global([data-os="android"]) .hero {
            gap: 20px;
            padding: 26px 22px 24px;
            margin-top: 4px;
            border-radius: 26px;
        }
        :global([data-os="android"]) .hero-text {
            gap: 12px;
        }
        :global([data-os="android"]) .hero .page-title {
            max-width: 12ch;
            font-size: clamp(34px, 9.5vw, 40px);
            line-height: 1;
        }
        :global([data-os="android"]) .hero .intro {
            max-width: 36ch;
            font-size: 14px;
            line-height: 1.55;
        }
        :global([data-os="android"]) .hero-actions {
            width: 100%;
            gap: 8px;
            margin-top: 4px;
        }
        :global([data-os="android"]) .hero-actions .btn {
            justify-content: center;
            min-height: 46px;
            padding-inline: 16px;
            border-radius: 15px;
        }
        :global([data-os="android"]) .section {
            margin-top: 30px;
        }
        :global([data-os="android"]) .section-head {
            align-items: flex-end;
            gap: 10px;
            margin-bottom: 8px;
        }
        :global([data-os="android"]) .section-title {
            font-size: 20px;
        }
        :global([data-os="android"]) .section-sub {
            font-size: 11.5px;
        }
        :global([data-os="android"]) .shelf {
            grid-auto-columns: 150px;
            gap: 14px;
            padding: 12px 18px 20px;
            margin: -12px -18px -20px;
            scroll-padding-inline: 18px;
        }
    }
</style>
