<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { libraryState, type Playlist } from "$lib/state/library.svelte";
    import { playerState } from "$lib/state/player.svelte";
    import { formatDate, createPlaceholderUrl, getCSSVar, Font } from "$lib/utils";
    import { fade, fly } from "svelte/transition";

    let playlists = $derived(libraryState.playlists);

    let currentlyOpenPlaylist = $state<Playlist | null>(null);

    $inspect(currentlyOpenPlaylist);
</script>

{#if !currentlyOpenPlaylist}
    <div class="search-results playlists">
        {#each playlists as playlist (playlist.id)}
            <!-- svelte-ignore (a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions) -->
            <article class="playlist" onclick={() => currentlyOpenPlaylist = playlist}>
                <div class="img-wrapper">
                    <img
                        src={
                            playlist.thumbnail ?? createPlaceholderUrl({
                                width: 256,
                                height: 256,
                                // backgroundColor: getCSSVar('--pico-primary')?.replace('#', ''),
                                // textColor: 'white',
                                text: playlist.name,
                                font: Font.NotoSans,
                            })
                        }
                        alt="Playlist Thumbnail"
                    />
                </div>
                <div class="info-wrapper">
                    <h4 title={playlist.name}>{playlist.name}</h4>
                    <small title="Created {formatDate(playlist.createdAt)}">
                        <Icon name="clock-plus" />
                        {formatDate(playlist.createdAt)}
                    </small>
                    <small title="{playlist.tracks.length} tracks">
                        <Icon name="square-library" />
                        {playlist.tracks.length} tracks
                    </small>
                    {#each playlist.tracks as track (track.videoId)}
                        <!-- <small>{JSON.stringify(track)}</small> -->
                    {/each}
                </div>
            </article>
        {/each}
    </div>
{:else}
    {@const playlist = currentlyOpenPlaylist}
    <div class="playlist-view" in:fly={{ y: 20, duration: 300 }} out:fade={{ duration: 150 }}>
        <button class="secondary back-btn" onclick={() => currentlyOpenPlaylist = null}>
            <Icon name="arrow-left" /> Back to Library
        </button>
        <div class="top-section">
            <img
                src={
                    playlist.thumbnail ?? createPlaceholderUrl({
                        width: 256,
                        height: 256,
                        // backgroundColor: getCSSVar('--pico-primary')?.replace('#', ''),
                        // textColor: 'white',
                        text: playlist.name,
                        font: Font.NotoSans,
                    })
                }
                alt="Playlist Thumbnail"
                referrerPolicy="no-referrer"
            />
            <div class="info-wrapper">
                <h1 class='zeta' title={playlist.name}>{playlist.name}</h1>
                <small title="Created {formatDate(playlist.createdAt)}">
                    <Icon name="clock-plus" />
                    {formatDate(playlist.createdAt)}
                </small>
                <small title="{playlist.tracks.length} tracks">
                    <Icon name="square-library" />
                    {playlist.tracks.length} tracks
                </small>
                <br />
                <div class="action-row">
                    <button class="primary">
                        <Icon name="play" />
                    </button>
                    <button class="secondary">
                        <Icon name="shuffle" />
                    </button>
                </div>
            </div>
        </div>
        <br />
        <div class="track-list">
            {#each playlist.tracks as track, i (track.videoId)}
               <div class="track-row">
                    <span class="track-num">#{i + 1}</span>
                    <img src={track.thumbnails?.at(-1)?.url || createPlaceholderUrl()} alt="Track Cover" referrerPolicy="no-referrer">
                    <div class="track-info">
                        <strong>{track.title}</strong>
                        <small>{track.artists.map(a => a.name).join(', ')}</small>
                    </div>
                    <div class="track-action-row">
                        <button class="primary" onclick={() => playerState.currentTrack = track}><Icon name="play" /></button>
                        <button class="secondary"><Icon name="heart" /></button>
                        <button class="secondary"><Icon name="ellipsis-vertical" /></button>
                    </div>
                </div>
            {/each}
        </div>
    </div>
{/if}