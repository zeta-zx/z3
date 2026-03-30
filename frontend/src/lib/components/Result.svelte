<script lang="ts">
    import { client } from "$lib/ephaptic";
    import Icon from "./Icon.svelte";

    
    export type ResultType = Awaited<ReturnType<NonNullable<typeof client>['music_search']>>[number]; // spaghetti code but it works

    interface Props {
        result: ResultType,
        handleClick: (result: ResultType) => any,
    }

    const { result, handleClick }: Props = $props();
</script>

<!-- svelte-ignore (a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions) -->
<article onclick={() => handleClick(result)}>
    <div class="img-wrapper">
        <img src={result.thumbnails.at(-1)?.url || "https://placehold.co/64"} alt={JSON.stringify(result)} referrerPolicy="no-referrer" /> <!-- https://stackoverflow.com/a/76662026 -->
        {#if result.resultType === 'song' || result.resultType === 'video' || result.resultType === 'album'}
            {#if result.duration}
                <span title={result.duration} class="duration">{result.duration}</span>
            {/if}
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
                <small><Icon name="disc-album" /> {result.type}</small>
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
    </div>
</article>