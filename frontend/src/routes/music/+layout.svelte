<script lang="ts">
    import { client } from "$lib/ephaptic";
    import Icon from "$lib/components/Icon.svelte";
    import MusicPlayer from "$lib/components/MusicPlayer.svelte";
    import MiniMusicPlayer from "$lib/components/MiniMusicPlayer.svelte";
    import { previousTrack, nextTrack, playerState, cache, loadTrack, resetState, applyCache } from "$lib/state/player.svelte";
    import { page } from "$app/state";
    import { parseLrc, getMimeType } from "$lib/utils";
    import { fade } from "svelte/transition";
    import { preloadData } from "$app/navigation";

    let { children } = $props();

    let audioElement = $state<HTMLAudioElement>();

    $effect(() => {
        if (playerState.streams.length > 0 && audioElement)
            audioElement.load();
    });

    $effect(() => {
        const track = playerState.currentTrack;

        if (!track) {
            playerState.streams = [];
            playerState.lyrics = [];
            playerState.paused = true;
            return;
        }

        resetState();

        const cached = cache.get(track.videoId);
        if (cached && cached.streams.length > 0) applyCache(cached);
        else {
            loadTrack(track)
                .then(() => applyCache(cache.get(track.videoId)!))
                .catch(console.error)
                .finally(() => playerState.isLoading = false);
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
            album: 'album' in track && track.album? track.album.name : 'Zeta Music',
            artwork: track.thumbnails.map(t => ({
                src: t.url,
                sizes: `${t.width}x${t.height}`,
                type: 'image/jpeg',
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

</script>

<br>

<div class="layout-grid">
    <aside>
        <nav>
            <ul>
            	<li>
					<a
						href="/music/explore"
						aria-current={page.url.pathname === '/music/explore' ? 'page' : undefined}
					>
						<Icon name="boom-box" /> Explore
					</a>
				</li>
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
    >
        {#each playerState.streams as stream}
            <source
                src={stream.url}
                type={getMimeType(stream)}
            />
        {/each}
    </audio>

{/if}