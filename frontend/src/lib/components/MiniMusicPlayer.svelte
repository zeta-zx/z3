<script lang="ts">
    import { playerState } from "$lib/state/player.svelte";
    import { libraryState } from "$lib/state/library.svelte";
    import Icon from "$lib/components/Icon.svelte";
    import LyricText from "./LyricText.svelte";
    import { fly } from "svelte/transition";

    let track = $derived(playerState.currentTrack);

    let isFav = $derived<boolean>(track ? libraryState.isInPlaylist('favourites', track.videoId) : false);

    let isAddToPlaylistOpen = $state(false);
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
                <Icon name="skip-back" />
            </button>
            <button class='pause-btn' disabled={playerState.isLoading} onclick={() => { playerState.paused = !playerState.paused }}>
                <Icon name={playerState.isLoading ? 'loader-circle' : playerState.paused ? 'play' : 'pause'} />
            </button>
            <button class="secondary" disabled>
                <Icon name="skip-forward" />
            </button>
        </div>

        <div class="btngroup">
            <button class="secondary" disabled>
                <Icon name="repeat" />
            </button>
            <button class="secondary" disabled>
                <Icon name="shuffle" />
            </button>
        </div>
    </div>

    <div class="bar lyrics">
        <LyricText />
    </div>

    <div class="bar playlist">
        <div class="btngroup">
            <button
                class={ isFav ? 'primary' : 'secondary' }
                onclick={ () => libraryState.toggleFromPlaylist('favourites', track) }
                title={ isFav ? "Remove from Favourites" : "Add to Favourites" }
            >
                <Icon name="heart-plus" />
            </button>
            <button class={ isAddToPlaylistOpen ? 'primary' : 'secondary' } onclick={() => isAddToPlaylistOpen = !isAddToPlaylistOpen}>
                <Icon name="list-plus" />
            </button>
        </div>
        <div class="txt">
            No playlist playing.
        </div>

        {#if isAddToPlaylistOpen}
            <ul class='playlist-selector' dir="ltr" transition:fly={{ x: 0, y: -50, duration: 300 }}>
                {#each libraryState.playlists as playlist}
                    <li class:active={libraryState.isInPlaylist(playlist.id, track.videoId)}>
                        <a 
                            href='#'
                            onclick={(e) => {
                                e.preventDefault(); 
                                libraryState.toggleFromPlaylist(playlist.id, track);
                                // TODO: Add toast
                            }}
                        >
                            {#if playlist.id === 'favourites'}
                                <Icon name="heart" />
                            {:else}
                                <Icon name="list-plus" />
                            {/if}
                            {#if libraryState.isInPlaylist(playlist.id, track.videoId)}
                                Remove from
                            {:else}
                                Add to
                            {/if}
                            {playlist.name}
                        </a>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
{/if}