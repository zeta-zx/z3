<script lang="ts">
    import { client } from "$lib/ephaptic";
    import type { FilterType, SongResult, VideoResult } from "$lib/schema";
    import { toTitleCase } from "$lib/utils";
    import Icon from "$lib/components/Icon.svelte";
    import MusicPlayer from "$lib/components/MusicPlayer.svelte";
    import { playerState, playTrack } from "$lib/state/player.svelte";
    import { tick } from "svelte";
    import Result, { type ResultType } from "$lib/components/Result.svelte";

    let searchValue = $state("");
    let isLoading = $state(false);
    let errorMessage = $state("");
    let isSearchInvalid = $derived(!!errorMessage);
    let searchType = $state<FilterType | null>(null);
    let suggestions = $state<string[]>([]);

    let results = $state<ResultType[]>([]);

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

    async function handleClick(result: ResultType) {
        if (result.resultType === 'song' || result.resultType === 'video') {
            playTrack(result);
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

<div class="results search-results">
    {#each results as result}
        <Result {result} {handleClick} />
    {/each}
</div>