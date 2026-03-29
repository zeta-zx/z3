<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { client } from "$lib/ephaptic";
    import type { AudioStream, SongResult, VideoResult } from "$lib/schema";
    import { type LrcLine, parseLrc, formatTime, getMimeType } from "$lib/utils";
    import { fly } from "svelte/transition";
    import { playerState } from "$lib/state/player.svelte";
    import LyricText from "$lib/components/LyricText.svelte";
</script>

<div
    id="player"
    class="player-bar"
    in:fly={{ y: 100, duration: 300 }}
    out:fly={{ y: 100, duration: 300, delay: 50 }}
>

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
            <button onclick={() => playerState.paused = !playerState.paused} disabled={playerState.isLoading} class="primary">
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

    </div>

</div>

<div class="lyrics-container"
    in:fly={{ y: 100, duration: 300, delay: 50 }}
    out:fly={{ y: 100, duration: 300, delay: 0 }}
>
    <LyricText />
</div>
