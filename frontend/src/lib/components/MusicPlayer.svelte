<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { client } from "$lib/ephaptic";
    import type { AudioStream, SongResult, VideoResult } from "$lib/schema";
    import { type LrcLine, parseLrc, formatTime, getMimeType } from "$lib/utils";
    import { fly } from "svelte/transition";

    interface Props {
        track: SongResult | VideoResult;
        onClose: () => void;
    }

    const { track, onClose }: Props = $props();

    let paused = $state(true);
    let currentTime = $state(0);
    let duration = $state(0);
    let isLoading = $state(true);

    let streams = $state<AudioStream[]>([]);
    let lyrics = $state<LrcLine[]>([]);

    let lyricsTextCurrent = $state("♪");
    let lyricsTextNext = $state("");

    let currentLyricIndex = $state(-1);
    let transitionStyle = $state("");
    let currentPos = $state("lyric-center");
    let nextPos = $state("lyric-down");

    let audioElement: HTMLAudioElement;

    $inspect(streams);

    $effect(() => {
        if (streams.length > 0 && audioElement)
            audioElement.load();
    });

    $effect(() => {
        if (!track) return;

        streams = [];
        lyrics = [];
        paused = true;

        currentTime = 0;
        duration = 0;

        currentLyricIndex = -1;
        lyricsTextCurrent = "♪";
        lyricsTextNext = "";
        transitionStyle = "none";
        currentPos = "lyric-center";
        nextPos = "lyric-down";

        isLoading = true;

        client!.music_lyrics(`${track.title} - ${track.artists.map(a => a.name).join(', ')}`)
            .then(data => lyrics = parseLrc(data || "No lyrics found."))
            .catch(console.error);

        client!.music_stream(track.videoId)
            .then(data => {
                streams = data
                paused = false;
                isLoading = false;
            })
            .catch(console.error);
    
    });

    $effect(() => {
        if (isLoading) {
            lyricsTextCurrent = 'Loading song...';
            return;
        }

        if (currentLyricIndex < 0) {
            lyricsTextCurrent = '♪';
            // return;
        }

        if (!lyrics || lyrics.length === 0) {
            lyricsTextCurrent = "♪ (Lyrics not available)";
            return;
        }

        let newIdx = lyrics.findIndex(line => line.time > currentTime) - 1;
        if (newIdx < 0 && currentTime >= (lyrics.at(-1)?.time || 0))
            newIdx = lyrics.length = 1;

        if (newIdx >= 0 && newIdx !== currentLyricIndex) {
            const nextLyricText = lyrics[newIdx]?.text || '♪';

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
                    lyricsTextNext = lyrics[newIdx + 1]?.text || '♪';
                }, 300);
            });

            currentLyricIndex = newIdx;
        }

    });

    $effect(() => {
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
        if (!track || !('mediaSession' in navigator)) return;

        navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
    });

    $effect(() => {
        if (!track || !('mediaSession' in navigator)) return;

        navigator.mediaSession.setActionHandler('play', () => paused = false);
        navigator.mediaSession.setActionHandler('pause', () => paused = true);

        navigator.mediaSession.setActionHandler('seekto', details => {
            if (details.seekTime !== undefined && details.seekTime !== null)
                currentTime = details.seekTime;
        });

        // navigator.mediaSession.setActionHandler('previoustrack', () => playPrevious());
        // navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
    });

    function updatePositionState() {
        if (!track || !('mediaSession' in navigator)) return;

        navigator.mediaSession.setPositionState({
            duration: duration || 0,
            playbackRate: 1,
            position: currentTime,
        });
    }

    $effect(() => {
        if (!paused) {
            updatePositionState(); 
            const interval = setInterval(updatePositionState, 1000);
            
            return () => clearInterval(interval);
        }
    });


</script>

<div id="player" class="player-bar" transition:fly={{ y: 100, duration: 300 }}>

    <audio
        id="audio-player"
        bind:this={audioElement}
        bind:paused
        bind:currentTime
        bind:duration
        autoplay
        onended={() => paused = true}
        onplay={updatePositionState}
        onseeked={updatePositionState}
    >
        {#each streams as stream}
            <source
                src={stream.url}
                type={getMimeType(stream)}
            />
        {/each}
    </audio>

    <img
        alt="Song Cover"
        src={track.thumbnails.at(-1)?.url || "https://placehold.co/64"}
        referrerPolicy="no-referrer"
    >

    <div class="player-content">
        <div>
            <h4 title={track.title}>{track.title}</h4>
            <small>{track.artists.map(a => a.name).join(', ')}</small>
        </div>

        <div class="controls">
            <button onclick={() => paused = !paused} class="primary">
                <Icon name={isLoading ? 'loader-circle' : paused ? "play" : "pause"} />
            </button>

            <input
                id="bar"
                type="range"
                min={0}
                max={duration || 0}
                bind:value={currentTime}
            />

            <div class="playbackDuration">
                <span id="currentPlayback">{formatTime(currentTime)}</span>
                /
                <span id="totalPlayback">{formatTime(duration)}</span>
            </div>
        </div>

        <button onclick={onClose} class="secondary">
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
