<script lang="ts">
    import { browser } from "$app/environment";
    import Icon from "$lib/components/Icon.svelte";
    import { libraryState, type Playlist } from "$lib/state/library.svelte";
    import { playerState, playPlaylist } from "$lib/state/player.svelte";
    import { formatDate, createPlaceholderUrl, getCSSVar, Font } from "$lib/utils";
    import { fade, fly } from "svelte/transition";

    let playlists = $derived(libraryState.playlists);

    let currentlyOpenPlaylist = $state<Playlist | null>(null);

    // const totalDuration = (playlist: Playlist) => playlist.tracks.map(track => track.duration_seconds).reduce((sum, current) => (sum??0) + (current??0), 0);
    // Unfortunately, YT Music API doesn't return duration for all tracks >:(

    function handleImport() {
        const i = document.createElement('input');
        i.type = 'file';
        i.click();
        i.addEventListener('input', async e => {
            const data = i.files?.[0];
            if (!data) return; // upload cancelled
            const text = await data.text();
            libraryState.import(text);
        });
    }

    function handleExport() {
        const data = libraryState.export();
        
        const blob = new Blob([data], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'playlists.zeta';
        a.click();

        URL.revokeObjectURL(url);
    }
</script>

{#if !currentlyOpenPlaylist}
    <button class="secondary" onclick={handleImport}>
        <Icon name='download' />
        Import Playlists
    </button>
    <button class="secondary" onclick={handleExport}>
        <Icon name='upload' />
        Export Playlists
    </button>
    <div class="results playlists">
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
                </div>
            </div>
        </div>
        <br />
        <div class="track-list">
            {#each playlist.tracks as track, i (track.videoId)}
               <div class="track-row" class:active={playerState.currentTrack?.videoId === track.videoId}>
                    <span class="track-num">#{i + 1}</span>
                    <img src={track.thumbnails?.at(-1)?.url || createPlaceholderUrl()} alt="Track Cover" referrerPolicy="no-referrer">
                    <div class="track-info">
                        <strong>{track.title}</strong>
                        <small>{track.artists.map(a => a.name).join(', ')}</small>
                    </div>
                    <div class="track-action-row">
                        {#if playerState.currentTrack?.videoId === track.videoId}
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