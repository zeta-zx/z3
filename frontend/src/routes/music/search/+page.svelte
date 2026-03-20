<script lang="ts">
    import { client } from "$lib/ephaptic";
    import type { FilterType, SongResult, VideoResult } from "$lib/schema";
    import { toTitleCase } from "$lib/utils";
    import Icon from "$lib/components/Icon.svelte";
    import MusicPlayer from "$lib/components/MusicPlayer.svelte";
    import { playerState } from "$lib/state/player.svelte";
    import { tick } from "svelte";

    let searchValue = $state("");
    let isLoading = $state(false);
    let errorMessage = $state("");
    let isSearchInvalid = $derived(!!errorMessage);
    let searchType = $state<FilterType | null>(null);
    let suggestions = $state<string[]>([]);

    type SearchResult = Awaited<ReturnType<NonNullable<typeof client>['music_search']>>[number]; // spaghetti code but it works
    let results = $state<SearchResult[]>([]);

    $inspect(results);

    const filterTypes = [
        "songs",
        "videos",
        "albums",
        "artists",
        "playlists",
        "episodes",
    ] as const satisfies readonly FilterType[];

    async function searchMusic(event: Event) {
        event.preventDefault();

        errorMessage = "";
        isSearchInvalid = false;

        if (!searchValue) return;

        isLoading = true;

        try {
            results = await client!.music_search(searchValue, searchType);
        } catch (err: any) {
            errorMessage = err;
            return;
        } finally {
            isLoading = false;
        }
    }

    async function updateSuggestions() {
        if (!searchValue) {
            suggestions = [];
            return;
        }
        try {
            suggestions = await client!.music_search_suggestions(searchValue);
            await tick();
        } catch (err: any) {
            console.error(err);
            suggestions = [];
            return;
        }
    }

    async function handleClick(result: SearchResult) {
        console.log(result);

        if (result.resultType === 'song' || result.resultType === 'video') {
            playerState.currentTrack = result;
        }
    }
</script>

<form name="search_music" onsubmit={searchMusic}>
    <!-- svelte-ignore (a11y_no_redundant_roles) because we need it for PicoCSS -->
    <fieldset role="search">
        <input
            name="query"
            id="query"
            type="search"
            placeholder="Search..."
            list="search-suggestions"
            autocomplete="off"
            bind:value={searchValue}
            aria-invalid={isSearchInvalid ? "true" : undefined}
            oninput={updateSuggestions}
        />
        <datalist id="search-suggestions">
            {#each suggestions as suggestion}
                <option value={suggestion}></option>
            {/each}
        </datalist>
        <select style="width:10rem;" name="type" bind:value={searchType}>
            <option value={null}>All</option>
            {#each filterTypes as filterType}
                <option value={filterType}>{toTitleCase(filterType)}</option>
            {/each}
        </select>
        <button type="submit" aria-busy={isLoading ? "true" : undefined}>
            <Icon name="search" />
        </button>
    </fieldset>
    {#if isSearchInvalid}
        <small aria-invalid="true">{errorMessage}</small>
    {/if}
</form>

<div class="search-results">
    {#each results as result}
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
                        <Icon name="music" /> Song <br /> <Icon name="user" /> {result.artists.map(a => a.name).join(', ')} 
                        {#if result.album} <br /> <Icon name="disc-album" /> {result.album.name}{/if}
                        {#if result.views} <br /> <Icon name="eye" /> {result.views}{/if}
                    </p>

                {:else if result.resultType === 'video'}
                    <h4 title={result.title}>{result.title}</h4>
                    <p>
                        <Icon name="video" /> Video <br /> <Icon name="user" /> {result.artists.map(a => a.name).join(', ')} 
                        {#if result.views} <br /> <Icon name="eye" /> {result.views}{/if}
                    </p>

                {:else if result.resultType === 'artist'}
                    <h4 title={result.artist || 'Artist'}>
                        {result.artist || result.artists?.map(a => a.name).join(', ') || 'Unknown Artist'}
                    </h4>
                    <p>
                        <Icon name="user" /> Artist 
                        {#if result.subscribers} <br /> <Icon name="youtube" /> {result.subscribers}{/if}
                    </p>

                {:else if result.resultType === 'album'}
                    <h4 title={result.title}>{result.title}</h4>
                    <p>
                        <Icon name="disc-album" /> {result.type} <br /> <Icon name="user" /> {result.artists.map(a => a.name).join(', ')} 
                        {#if result.year} <br /> <Icon name="calendar" /> {result.year}{/if}
                    </p>

                {:else if result.resultType === 'playlist'}
                    <h4 title={result.title}>{result.title}</h4>
                    <p>
                        <Icon name="list-video" /> Playlist 
                        {#if typeof result.author === 'string'}
                            <br /> <Icon name="user" /> {result.author}
                        {:else if Array.isArray(result.author)}
                            <br /> <Icon name="user" /> {result.author.map(a => a.name).join(', ')}
                        {/if}
                        {#if result.itemCount} <br /> <Icon name="library-big" /> {result.itemCount} items{/if}
                    </p>

                {:else if result.resultType === 'episode'}
                    <h4 title={result.title}>{result.title}</h4>
                    <p><Icon name="clapperboard" /> Episode <br /> <Icon name="podcast"/> {result.podcast.name} <br /> <Icon name="calendar" /> {result.date}</p>

                {:else if result.resultType === 'podcast'}
                    <h4 title={result.title}>{result.title}</h4>
                    <p><Icon name="podcast"/> Podcast</p>
                {/if}
            </div>
        </article>
    {/each}
</div>