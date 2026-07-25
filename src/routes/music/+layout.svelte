<script lang="ts">
    import { client } from "$lib/ephaptic";
    import Icon from "$lib/components/Icon.svelte";
    import MusicPlayer from "$lib/components/MusicPlayer.svelte";
    import MiniMusicPlayer from "$lib/components/MiniMusicPlayer.svelte";
    import { previousTrack, nextTrack, playerState, cache, loadTrack, resetState, applyCache, isNextTrackAvailable } from "$lib/state/player.svelte";
    import { page } from "$app/state";
    import { fade } from "svelte/transition";
    import { untrack, onDestroy } from "svelte";
    import { updateThumbnailUrl } from "$lib/utils";
    import { toasts } from "$lib/state/toast.svelte";
    import type { Song } from "$lib/schema";

    let { children } = $props();

    let audioElement = $state<HTMLAudioElement>();

    // --- listening stats: accumulate actual played time and report a listen
    //     event whenever we leave a track (or it ends). ---
    let statsTrack: Song | null = null;
    let playedMs = 0;
    let lastTime = 0;

    function flushListen() {
        const track = statsTrack;
        if (track && playedMs >= 1000) {
            client
                .statsRecordEvent(track.id, Math.round(playedMs), Date.now() - Math.round(playedMs), {
                    title: track.title,
                    artists: track.artists.map((a) => a.name),
                    thumbnailUrl: track.thumbnails.find((t) => t.url)?.url,
                })
                .catch(() => {});
        }
        playedMs = 0;
        lastTime = 0;
    }

    function accumulatePlaytime() {
        if (!audioElement) return;
        const t = audioElement.currentTime;
        const dt = t - lastTime;
        // Ignore seeks (large jumps) and paused gaps.
        if (dt > 0 && dt < 2 && !playerState.paused) playedMs += dt * 1000;
        lastTime = t;
    }

    // Flush the outgoing track's listen when the current track changes.
    $effect(() => {
        const track = playerState.currentTrack;
        if (track?.id !== statsTrack?.id) {
            untrack(() => flushListen());
            statsTrack = track;
        }
    });

    onDestroy(() => flushListen());

    // Consecutive playback failures, to avoid skipping forever through a broken
    // playlist. Reset on any successful load.
    let failCount = 0;

    function handlePlaybackFailure(track: Song, err: unknown) {
        if (playerState.currentTrack?.id !== track.id) return;

        playerState.stream = null;
        playerState.isLoading = false;
        playerState.paused = true;

        const msg = (err as any)?.message ?? String(err);

        // If we're in a playlist, show the error and skip to the next track so
        // playback keeps going — unless we've already skipped through the whole
        // playlist (everything is broken).
        const playlist = playerState.currentPlaylist;
        if (playlist && isNextTrackAvailable() && failCount < playlist.tracks.length) {
            failCount++;
            toasts.error(`Skipping "${track.title}": ${msg}`);
            nextTrack();
        } else {
            failCount = 0;
            toasts.error(`Couldn't play "${track.title}": ${msg}`);
        }
    }

    $effect(() => {
        if (playerState.stream && audioElement)
            audioElement.load();
    });

    $effect(() => {
        const track = playerState.currentTrack;

        if (!track) {
            playerState.stream = null;
            playerState.lyrics = [];
            playerState.paused = true;
            return;
        }

        const loadingId = track.id;

        resetState();

        if (cache.has(track.id)) {
            applyCache(cache.get(track.id));
            failCount = 0;
        } else {
            loadTrack(track)
                .then(() => {
                    if (playerState.currentTrack?.id === loadingId) {
                        applyCache(cache.get(loadingId));
                        failCount = 0;
                    }
                })
                .catch((err) => handlePlaybackFailure(track, err));
        }
    });

    $effect(() => {
        if (playerState._upcomingTrack) {
            // Preload in the background; ignore failures here (they'll be shown
            // if/when the track actually becomes the current one).
            loadTrack(playerState._upcomingTrack).catch(() => {});
        }
    });

    $effect(() => {
        const track = playerState.currentTrack;
        if (!track || !('mediaSession' in navigator)) return;

        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.artists.map(a => a.name).join(', '),
            album: 'album' in track && track.album? track.album.title : 'Zeta Music',
            artwork: track.thumbnails.map(t => ({
                src: t.url ? updateThumbnailUrl(t.url) : (t.data ? URL.createObjectURL(new Blob([new Uint8Array(t.data)], { type: t.mimetype })) : ''),
                sizes: `${t.width}x${t.height}`,
                type: t.mimetype ?? 'image/jpeg',
            })),
        });
    });

    $effect(() => {
        const track = playerState.currentTrack;
        if (!track || !('mediaSession' in navigator)) return;

        navigator.mediaSession.playbackState = playerState.paused ? 'paused' : 'playing';
    });

    $effect(() => {
        const track = playerState.currentTrack;
        if (!track || !('mediaSession' in navigator)) return;

        navigator.mediaSession.setActionHandler('play', () => playerState.paused = false);
        navigator.mediaSession.setActionHandler('pause', () => playerState.paused = true);

        navigator.mediaSession.setActionHandler('seekto', details => {
            if (details.seekTime !== undefined && details.seekTime !== null)
                playerState.currentTime = details.seekTime;
        });

        navigator.mediaSession.setActionHandler('previoustrack', previousTrack);
        navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
    });

    function updatePositionState() {
        const track = playerState.currentTrack;
        if (!track || !('mediaSession' in navigator)) return;

        navigator.mediaSession.setPositionState({
            duration: playerState.duration || 0,
            playbackRate: 1,
            position: playerState.currentTime,
        });
    }

    $effect(() => {
        const track = playerState.currentTrack;
        const paused = playerState.paused;

        if (!track || paused) {
            client.clearRPC();
            return;
        }

        const elapsed = untrack(() => playerState.currentTime);

        client.setRPC({
            type: 2, // Listening
            details: track.title,
            state: track.artists.map(a => a.name).join(', '),
            name: track.title,
            startTimestamp: Date.now() - (elapsed * 1000),

            // largeImageText: track.title,
            largeImageUrl: updateThumbnailUrl(track.thumbnails.filter(t => !!t.url)?.at(0)?.url),
            largeImageKey: updateThumbnailUrl(track.thumbnails.filter(t => !!t.url)?.at(0)?.url),

            smallImageText: 'Zeta Music',
            smallImageUrl: 'zeta',
            smallImageKey: 'zeta',
        })!.catch(console.error);
    })

</script>

<br>

<div class="layout-grid">
    <aside>
        <nav>
            <ul>
                <li>
					<a
						href="/music/search"
						aria-current={page.url.pathname === '/music/search' ? 'page' : undefined}
					>
						<Icon name="search" /> Search
					</a>
				</li>
				<li>
					<a
						href="/music/library"
						aria-current={page.url.pathname === '/music/library' ? 'page' : undefined}
					>
						<Icon name="library-big" /> Library
					</a>
				</li>
				<li>
					<a
						href="/music/stats"
						aria-current={page.url.pathname === '/music/stats' ? 'page' : undefined}
					>
						<Icon name="chart-no-axes-column" /> Stats
					</a>
				</li>
				<li>
					<a
						href="/music/settings"
						aria-current={page.url.pathname === '/music/settings' ? 'page' : undefined}
					>
						<Icon name="settings" /> Settings
					</a>
				</li>
            </ul>
        </nav>

        <br>

        <MiniMusicPlayer />
    </aside>

    <div class="content">
		<main class="container">
            <h1 class="zeta"><span class="zcolor"><Icon name="audio-lines" /> Zeta</span> Music</h1>

            <p>What do you want to check out?</p>

            {#key page.url.pathname}
                <div
                    class="page-content-wrapper"
                    in:fade={{ duration: 200, delay: 200 }}
                    out:fade={{ duration: 200 }}>
                    {@render children()}
                </div>
            {/key}
        </main>
	</div>
</div>

{#if playerState.currentTrack}
    {#if playerState.maximised}
        <MusicPlayer />
    {/if}

    <button
        class='panel-control secondary'
        onclick = { () => playerState.maximised = !playerState.maximised }
    >
        <Icon name="panel-bottom-{ playerState.maximised ? 'close' : 'open' }" />
    </button>

    <audio
        id="audio-player"
        bind:this={audioElement}
        bind:paused={playerState.paused}
        bind:currentTime={playerState.currentTime}
        bind:duration={playerState.duration}
        autoplay
        onended={() => {
            flushListen();
            playerState.paused = true;
            nextTrack();
        }}
        ontimeupdate={accumulatePlaytime}
        onplay={updatePositionState}
        onseeked={updatePositionState}
        onerror={() => {
            // Decode/playback failure on a loaded stream: surface it and, in a
            // playlist, skip onward instead of stalling.
            if (playerState.stream && playerState.currentTrack)
                handlePlaybackFailure(playerState.currentTrack, new Error("This track could not be played."));
        }}
        src={playerState.stream ? URL.createObjectURL(new Blob([new Uint8Array(playerState.stream.data)], { type: playerState.stream.mimetype })) : null}
    ></audio>

{/if}