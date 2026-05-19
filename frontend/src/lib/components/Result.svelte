<script lang="ts">
    import { client } from "$lib/ephaptic";
    import Icon from "./Icon.svelte";
    import { libraryState, isPlayableTrack } from "$lib/state/library.svelte";
    import { fade, fly } from "svelte/transition";
    
    export type ResultType = Awaited<ReturnType<NonNullable<typeof client>['music_search']>>[number]; // spaghetti code but it works

    interface Props {
        result: ResultType,
        handleClick: (result: ResultType) => any,
    }

    const { result, handleClick }: Props = $props();

    const isFavourited = $derived(isPlayableTrack(result) && libraryState.isInPlaylist('favourites', result.videoId));

    let isAddToPlaylistOpen = $state(false);
    let isHovered = $state(false);
</script>

<!-- svelte-ignore (a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions) -->
<article
    onclick={() => handleClick(result)}
    onmouseenter={() => (isHovered = true)}
    onmouseleave={() => (isHovered = false)}
  >
    <div class="img-wrapper">
        <img src={result.thumbnails.at(-1)?.url || "https://placehold.co/64"} alt={JSON.stringify(result)} referrerPolicy="no-referrer" /> <!-- https://stackoverflow.com/a/76662026 -->
        {#if result.resultType === 'song' || result.resultType === 'video' || result.resultType === 'album'}
            {#if result.duration}
                <span title={result.duration} class="duration">{result.duration}</span>
            {/if}
        {/if}
        {#if isFavourited}
            <span class="isFavourited" title="In Favourites">
                <Icon name="heart" />
            </span>
        {/if}
    </div>
    
    <div class="info-wrapper">
        {#if result.category}
            <small class="category-badge">{result.category}</small>
        {/if}

        {#if result.resultType === 'song'}
            <h4 title={result.title}>{result.title}</h4>
            <p>
                <small><Icon name="music" /> Song</small>
                <small><Icon name="user" /> {result.artists.map(a => a.name).join(', ')}</small>
                {#if result.album}
                    <small><Icon name="disc-album" /> {result.album.name}</small>
                {/if}
                {#if result.views}
                    <small><Icon name="eye" /> {result.views}</small>
                {/if}
            </p>

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
        {/if}

        {#if isPlayableTrack(result)}
            <div class="btngroup" class:transparent={!isHovered} transition:fade={{ duration: 50 }}>
                <button
                    class = { isFavourited ? 'primary' : 'secondary' }
                    onclick = { e => { e.stopPropagation(); libraryState.toggleFromPlaylist('favourites', result) } }
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
                        <li class:active={libraryState.isInPlaylist(playlist.id, result.videoId)}>
                            <a 
                                href='#'
                                onclick={e => {
                                    e.stopPropagation();
                                    e.preventDefault(); 
                                    libraryState.toggleFromPlaylist(playlist.id, result);
                                }}
                            >
                                {#if playlist.id === 'favourites'}
                                    <Icon name="heart" />
                                {:else}
                                    <Icon name="list-plus" />
                                {/if}
                                {#if libraryState.isInPlaylist(playlist.id, result.videoId)}
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