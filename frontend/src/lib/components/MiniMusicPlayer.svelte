<script lang="ts">
    import type { SongResult, VideoResult } from "$lib/schema";
    import { playerState } from "$lib/state/player.svelte";
    import Icon from "$lib/components/Icon.svelte";
    import LyricText from "./LyricText.svelte";

    let track = $derived(playerState.currentTrack);
</script>

<div class="mini-player-bg" style="background-image: url('{track?.thumbnails.at(-1)?.url ?? 'https://placehold.co/64'}');">
    <div class="mini-player">
        <h4 title={track ? track.title : "Nothing is playing."}>{track ? track.title : "Nothing is playing."}</h4>
        <small>{track ? track.artists.map(a => a.name).join(', ') : "Search for a song!"}</small>
        <br>
        {#if track}
        <progress 
            max={playerState.duration || 1} 
            value={playerState.currentTime}
        ></progress>
        {/if}
    </div>
</div>
{#if track}
    <div class="bar controls">
        <div class="btngroup">
            <button class="secondary" disabled>
                <Icon name="skip-back"></Icon>
            </button>
            <button class='pause-btn' disabled={playerState.isLoading} onclick={() => { playerState.paused = !playerState.paused }}>
                <Icon name={playerState.isLoading ? 'loader-circle' : playerState.paused ? 'play' : 'pause'} />
            </button>
            <button class="secondary" disabled>
                <Icon name="skip-forward"></Icon>
            </button>
        </div>

        <div class="btngroup">
            <button class="secondary" disabled>
                <Icon name="repeat"></Icon>
            </button>
            <button class="secondary" disabled>
                <Icon name="shuffle"></Icon>
            </button>
        </div>
    </div>

    <div class="bar lyrics">
        <LyricText />
    </div>
{/if}