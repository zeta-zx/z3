<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { client } from "$lib/ephaptic";
    import type { AudioStream, SongResult, VideoResult } from "$lib/schema";
    import { type LrcLine, parseLrc, formatTime, getMimeType } from "$lib/utils";
    import { fly } from "svelte/transition";
    import { playerState } from "$lib/state/player.svelte";

    let lyricsTextCurrent = $state("♪");
    let lyricsTextNext = $state("");

    let currentLyricIndex = $state(-1);
    let transitionStyle = $state("");
    let currentPos = $state("lyric-center");
    let nextPos = $state("lyric-down");

    let audioElement: HTMLAudioElement;

    $effect(() => {
        if (playerState.streams.length > 0 && audioElement)
            audioElement.load();
    });

    $effect(() => {
        if (playerState.isLoading) {
            lyricsTextCurrent = 'Loading song...';
            return;
        }

        if (currentLyricIndex < 0) {
            lyricsTextCurrent = '♪';
            // return;
        }

        if (!playerState.lyrics || playerState.lyrics.length === 0) {
            lyricsTextCurrent = "♪ (Lyrics not available)";
            return;
        }

        let newIdx = playerState.lyrics.findIndex(line => line.time > playerState.currentTime) - 1;
        if (newIdx < 0 && playerState.currentTime >= (playerState.lyrics.at(-1)?.time || 0))
            newIdx = playerState.lyrics.length = 1;

        if (newIdx >= 0 && newIdx !== currentLyricIndex) {
            const nextLyricText = playerState.lyrics[newIdx]?.text || '♪';

            transitionStyle = "none";
            nextPos = "lyric-down";
            lyricsTextNext = nextLyricText;

            requestAnimationFrame(() => {
                transitionStyle = "opacity 0.3s ease-out, transform 0.3s ease-out";
                currentPos = "lyric-up";
                nextPos = "lyric-center";

                setTimeout(() => {
                    lyricsTextCurrent = nextLyricText;
                    transitionStyle = "none";
                    currentPos = "lyric-center";
                    nextPos = "lyric-down";
                    lyricsTextNext = playerState.lyrics[newIdx + 1]?.text || '♪';
                }, 300);
            });

            currentLyricIndex = newIdx;
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

        // navigator.mediaSession.setActionHandler('previoustrack', () => playPrevious());
        // navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
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

    /*
        $effect(() => {
            if (!playerState.paused) {
                updatePositionState(); 
                const interval = setInterval(updatePositionState, 1000);
                
                return () => clearInterval(interval);
            }
        });
    */


</script>

<div id="player" class="player-bar" transition:fly={{ y: 100, duration: 300 }}>

    <audio
        id="audio-player"
        bind:this={audioElement}
        bind:paused={playerState.paused}
        bind:currentTime={playerState.currentTime}
        bind:duration={playerState.duration}
        autoplay
        onended={() => playerState.paused = true}
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

    <img
        alt="Song Cover"
        src={playerState.currentTrack?.thumbnails.at(-1)?.url || "https://placehold.co/64"}
        referrerPolicy="no-referrer"
    >

    <div class="player-content">
        <div>
            <h4 title={playerState.currentTrack?.title}>{playerState.currentTrack?.title}</h4>
            <small>{playerState.currentTrack?.artists.map(a => a.name).join(', ')}</small>
        </div>

        <div class="controls">
            <button onclick={() => playerState.paused = !playerState.paused} class="primary">
                <Icon name={playerState.isLoading ? 'loader-circle' : playerState.paused ? "play" : "pause"} />
            </button>

            <input
                id="bar"
                type="range"
                min={0}
                max={playerState.duration || 0}
                bind:value={playerState.currentTime}
            />

            <div class="playbackDuration">
                <span id="currentPlayback">{formatTime(playerState.currentTime)}</span>
                /
                <span id="totalPlayback">{formatTime(playerState.duration)}</span>
            </div>
        </div>

        <button onclick={playerState.currentTrack = null} class="secondary">
            <Icon name="x" />
        </button>

    </div>

</div>

<div class="lyrics-container" transition:fly={{ y: 100, duration: 300, delay: 50 }}>
    <span
        id="lyricsTextCurrent"
        class="lyric-line {currentPos}"
        style="transition: {transitionStyle}"
    >{lyricsTextCurrent}</span>

    <span id="lyricsTextNext"
        class="lyric-line {nextPos}"
        style="transition: {transitionStyle}"
    >{lyricsTextNext}</span>
</div>
