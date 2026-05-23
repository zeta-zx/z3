<script lang="ts">
    import Icon from "./Icon.svelte";
    import { libraryState, isPlayableTrack } from "$lib/state/library.svelte";
    import { fade, fly } from "svelte/transition";
    import type { Song } from "$lib/schema";
    import { formatDuration, createPlaceholderUrl, getThumbnailUrl } from "$lib/utils";
    
    interface Props {
        result: Song,
        handleClick: (result: Song) => any,
    }

    const { result, handleClick }: Props = $props();

    const isFavourited = $derived(isPlayableTrack(result) && libraryState.isInPlaylist('favourites.m3u8', result.id));

    let isAddToPlaylistOpen = $state(false);
    let isHovered = $state(false);

    const thumbnailUrl = $derived.by(() => getThumbnailUrl(result.thumbnails, result.title));
</script>

<!-- svelte-ignore (a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions) -->
<article
    onclick={() => handleClick(result)}
    onmouseenter={() => (isHovered = true)}
    onmouseleave={() => (isHovered = false)}
  >
    <div class="img-wrapper">
        <img src={thumbnailUrl} alt={JSON.stringify(result)} referrerPolicy="no-referrer" /> <!-- https://stackoverflow.com/a/76662026 -->
        {#if result.duration}
            <span title={formatDuration(result.duration)} class="duration">{formatDuration(result.duration)}</span>
        {/if}
        {#if isFavourited}
            <span class="isFavourited" title="In Favourites">
                <Icon name="heart" />
            </span>
        {/if}
    </div>
    
    <div class="info-wrapper">
        {#if 'song' === 'song'}
            <h4 title={result.title}>{result.title}</h4>
            <p>
                <small><Icon name="music" /> Song</small>
                <small><Icon name="user" /> {result.artists.map(a => a.name).join(', ')}</small> <!-- TODO: Artist icons -->
                {#if result.album}
                    <small><Icon name="disc-album" /> {result.album.title}</small>
                {/if}
                {#if result.streams}
                    <small><Icon name="eye" /> {result.streams}</small>
                {/if}
                {#if result.isDownloaded}
                    <small><Icon name="arrow-big-down-dash" /> Downloaded locally</small>
                {/if}
            </p>

        <!--
        {:else if result.resultType === 'video'}
            <h4 title={result.title}>{result.title}</h4>
            <p>
                <small><Icon name="video" /> Video</small>
                <small><Icon name="user" /> {result.artists.map(a => a.name).join(', ')}</small>
                {#if result.views}
                    <small><Icon name="eye" /> {result.views}</small>
                {/if}
            </p>

        {:else if result.resultType === 'artist'}
            <h4 title={result.artist || 'Artist'}>
                {result.artist || result.artists?.map(a => a.name).join(', ') || 'Unknown Artist'}
            </h4>
            <p>
                <small><Icon name="user" /> Artist</small>
                {#if result.subscribers}
                    <small><Icon name="youtube" /> {result.subscribers}</small>
                {/if}
            </p>

        {:else if result.resultType === 'album'}
            <h4 title={result.title}>{result.title}</h4>
            <p>
                <small><Icon name="disc-album" /> {result.type ?? result.title}</small>
                <small><Icon name="user" /> {result.artists.map(a => a.name).join(', ')}</small>
                {#if result.year}
                    <small><Icon name="calendar" /> {result.year}</small>
                {/if}
            </p>

        {:else if result.resultType === 'playlist'}
            <h4 title={result.title}>{result.title}</h4>
            <p>
                <small><Icon name="list-video" /> Playlist</small>
                {#if typeof result.author === 'string'}
                    <small><Icon name="user" /> {result.author}</small>
                {:else if Array.isArray(result.author)}
                    <small><Icon name="user" /> {result.author.map(a => a.name).join(', ')}</small>
                {/if}
                {#if result.itemCount}
                    <small><Icon name="library-big" /> {result.itemCount} items</small>
                {/if}
            </p>

        {:else if result.resultType === 'episode'}
            <h4 title={result.title}>{result.title}</h4>
            <p>
                <small><Icon name="clapperboard" /> Episode</small>
                {#if result.podcast}
                    <small><Icon name="podcast"/> {result.podcast.name}</small>
                {/if}
                <small><Icon name="calendar" /> {result.date}</small>
            </p>

        {:else if result.resultType === 'podcast'}
            <h4 title={result.title}>{result.title}</h4>
            <p>
                <small><Icon name="podcast"/> Podcast</small>
            </p>
        -->
        {/if}

        {#if true}
            <div class="btngroup" class:transparent={!isHovered} transition:fade={{ duration: 50 }}>
                <button
                    class = { isFavourited ? 'primary' : 'secondary' }
                    onclick = { e => { e.stopPropagation(); libraryState.toggleFromPlaylist('favourites.m3u8', result) } }
                    title = { isFavourited ? "Remove from Favourites" : "Add to Favourites" }
                >
                    <Icon name="heart-plus" />
                </button>
                <button
                    class = { isAddToPlaylistOpen ? 'primary' : 'secondary' }
                    onclick = { e => { e.stopPropagation(); isAddToPlaylistOpen = !isAddToPlaylistOpen } }
                    title = "Add to Playlist"
                >
                    <Icon name="list-plus" />
                </button>
            </div>

            {#if isAddToPlaylistOpen}
                <ul class='playlist-selector' dir="ltr" transition:fly={{ x: 0, y: -50, duration: 300 }}>
                    {#each libraryState.playlists as playlist}
                        <li class:active={libraryState.isInPlaylist(playlist.id, result.id)}>
                            <a 
                                href='#'
                                onclick={e => {
                                    e.stopPropagation();
                                    e.preventDefault(); 
                                    libraryState.toggleFromPlaylist(playlist.id, result);
                                }}
                            >
                                {#if playlist.id === 'favourites.m3u8'}
                                    <Icon name="heart" />
                                {:else}
                                    <Icon name="list-plus" />
                                {/if}
                                {#if libraryState.isInPlaylist(playlist.id, result.id)}
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
        {/if}
    </div>
</article>