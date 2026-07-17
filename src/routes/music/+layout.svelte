<script lang="ts">
    import { client } from "$lib/ephaptic";
    import Icon from "$lib/components/Icon.svelte";
    import MusicPlayer from "$lib/components/MusicPlayer.svelte";
    import MiniMusicPlayer from "$lib/components/MiniMusicPlayer.svelte";
    import { previousTrack, nextTrack, playerState, cache, loadTrack, resetState, applyCache } from "$lib/state/player.svelte";
    import { page } from "$app/state";
    import { fade } from "svelte/transition";
    import { untrack } from "svelte";
    import { updateThumbnailUrl } from "$lib/utils";

    let { children } = $props();

    let audioElement = $state<HTMLAudioElement>();

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

        if (cache.has(track.id)) applyCache(cache.get(track.id));
        else {
            loadTrack(track)
                .then(() => {
                    if (playerState.currentTrack?.id === loadingId)
                        applyCache(cache.get(loadingId)!);
                })
                .catch(console.error)
                .finally(() => {
                    if (playerState.currentTrack?.id === loadingId)
                        applyCache(cache.get(loadingId)!);
                });
        }
    });

    $effect(() => {
        if (playerState._upcomingTrack) {
            loadTrack(playerState._upcomingTrack); // preload in background so that its ready for playback
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
            playerState.paused = true;
            nextTrack();
        }}
        onplay={updatePositionState}
        onseeked={updatePositionState}
        src={playerState.stream ? URL.createObjectURL(new Blob([new Uint8Array(playerState.stream.data)], { type: playerState.stream.mimetype })) : null}
    ></audio>

{/if}