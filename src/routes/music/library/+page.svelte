<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { libraryState } from "$lib/state/library.svelte";
    import { playerState, playPlaylist } from "$lib/state/player.svelte";
    import { formatDate, createPlaceholderUrl, getCSSVar, Font, formatDuration, getThumbnailUrl } from "$lib/utils";
    import { fade, fly } from "svelte/transition";
    import type { Playlist } from "$lib/schema";

    let playlists = $derived(libraryState.playlists);

    let currentlyOpenPlaylist = $state<Playlist | null>(null);

    const totalDuration = (playlist: Playlist) => playlist.tracks.map(track => track.duration).reduce((sum, current) => (sum??0) + (current??0), 0);

    function handleEditImage() {
        if (!currentlyOpenPlaylist) return;
        const i = document.createElement('input');
        i.type = 'file';
        i.accept = 'image/*';
        i.click();
        i.addEventListener('input', async e => {
            const data = i.files?.[0];
            if (!data) return;
            const reader = new FileReader();
            reader.readAsDataURL(data);

            reader.onload = () => {
                if (!currentlyOpenPlaylist) return;
                if (!reader.result) return;
                currentlyOpenPlaylist.thumbnail = reader.result.toString();
                libraryState.save(); // TODO: Update thumbnail for library.
            };
        });
    }
</script>

{#if !currentlyOpenPlaylist}
    <div class="results search-results playlists">
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <article class="playlist" onclick={() => {}}>
            <div class="img-wrapper">
                <img
                    src={
                        createPlaceholderUrl({
                            width: 256,
                            height: 256,
                            backgroundColor: getCSSVar('--pico-primary')?.replace('#', ''),
                            textColor: 'white',
                            text: '+',
                            font: Font.NotoSans,
                        })
                    }
                    alt="Playlist Thumbnail"
                />
            </div>
            <div class="info-wrapper">
                <h4>Create Playlist</h4>
            </div>
        </article>
        {#each playlists as playlist (playlist.id)}
            {@const duration = formatDuration(totalDuration(playlist))}
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
                        Created {formatDate(playlist.createdAt)}
                    </small>
                    <small title="{playlist.tracks.length} tracks">
                        <Icon name="square-library" />
                        {playlist.tracks.length} tracks
                    </small>
                    <small title="Duration: {duration}">
                        <Icon name="clock" />
                        Duration: {duration}
                    </small>
                </div>
            </article>
        {/each}
    </div>
{:else}
    {@const playlist = currentlyOpenPlaylist}
    {@const duration = formatDuration(totalDuration(playlist))}
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
                <small title="Duration: {duration}">
                    <Icon name="clock" />
                    Duration: {duration}
                </small>
                <br />
                <div class="action-row">
                    {#if playerState.currentPlaylist?.id === playlist.id}
                        <button class="primary" onclick={() => playerState.paused = !playerState.paused}>
                            <Icon name={playerState.paused ? 'play' : playerState.isLoading ? 'loader-circle' : 'pause'} />
                        </button>
                    {:else}
                        <button class="primary" onclick={() => playPlaylist(playlist)}>
                            <Icon name='play' />
                        </button>
                    {/if}
                    <button class="secondary" onclick={() => playPlaylist(playlist, 0, true)}>
                        <Icon name="shuffle" />
                    </button>
                    <button class="secondary" onclick={handleEditImage} title="Edit Image">
                        <Icon name="pencil" />
                    </button>
                </div>
            </div>
        </div>
        <br />
        <div class="track-list">
            {#each playlist.tracks as track, i (track.id)}
               <div class="track-row" class:active={playerState.currentTrack?.id === track.id}>
                    <span class="track-num">#{i + 1}</span>
                    <img src={getThumbnailUrl(track.thumbnails, track.title)} alt="Track Cover" referrerPolicy="no-referrer">
                    <div class="track-info">
                        <strong>{track.title}</strong>
                        <small>{track.artists.map(a => a.name).join(', ')}</small>
                    </div>
                    <div class="track-action-row">
                        {#if playerState.currentTrack?.id === track.id}
                            <button class="primary" onclick={() => playerState.paused = !playerState.paused}>
                                <Icon name={playerState.paused ? 'play' : playerState.isLoading ? 'loader-circle' : 'pause'} />
                            </button>
                        {:else}
                            <button class="primary" onclick={() => playPlaylist(playlist, i)}>
                                <Icon name='play' />
                            </button>
                        {/if}
                        <button class="secondary"><Icon name="heart" /></button>
                        <button class="secondary"><Icon name="ellipsis-vertical" /></button>
                    </div>
                </div>
            {/each}
        </div>
    </div>
{/if}