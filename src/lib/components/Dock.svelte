<script lang="ts">
    /**
     * The floating navigation island. On the search route it morphs into the
     * search bar itself; "Library" opens a quick playlist popover.
     */
    import { client } from "$lib/ephaptic";
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import EqBars from "$lib/components/EqBars.svelte";
    import { createPlaylistWith, openArtist, openCollection } from "$lib/actions";
    import { page } from "$app/state";
    import { goto } from "$app/navigation";
    import { libraryState, FAVOURITES_ID } from "$lib/state/library.svelte";
    import { playerState, playTrack } from "$lib/state/player.svelte";
    import { searchState } from "$lib/state/search.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { liquidGlass } from "$lib/liquid-glass";
    import { debounce } from "$lib/utils";
    import type { Artist, CollectionSummary, SearchExtras, Song } from "$lib/schema";
    import { fly } from "svelte/transition";
    import { tick } from "svelte";
    import { isAndroid } from '$lib/platform';

    const path = $derived(page.url.pathname);
    const onSearch = $derived(path.startsWith("/music/search"));
    const isActive = (href: string) => (href === "/music" ? path === "/music" : path.startsWith(href));

    let input = $state<HTMLInputElement>();
    let suggestions = $state<string[]>([]);
    type QuickItem =
        | { kind: "song"; value: Song }
        | { kind: "artist"; value: Artist }
        | { kind: "collection"; value: CollectionSummary };
    let quickItems = $state<QuickItem[]>([]);
    let suggestionsLoading = $state(false);
    let showSuggestions = $state(false);
    let highlighted = $state(-1);
    let suggestionRequest = 0;
    let libraryOpen = $state(false);
    let providerPicker = $state<HTMLDetailsElement>();
    let libraryTimer: ReturnType<typeof setTimeout>;
    const providers = [
        { id: "yt", label: "YouTube Music" },
        { id: "js", label: "JioSaavn" },
    ] as const;
    const selectedProvider = $derived(providers.find((provider) => provider.id === searchState.provider)!);
    const normalizeMatch = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const exactSong = $derived.by(() => {
        const query = normalizeMatch(searchState.query);
        if (!query) return undefined;
        const matches = quickItems.filter((item): item is Extract<QuickItem, { kind: "song" }> =>
            item.kind === "song" && normalizeMatch(item.value.title) === query
        );
        return matches.length === 1 ? matches[0] : undefined;
    });
    const otherQuickItems = $derived(quickItems.filter((item) => item !== exactSong));

    $effect(() => {
        if (onSearch) tick().then(() => !searchState.results.length && input?.focus());
    });

    const fetchSuggestions = debounce((q: string, provider: typeof searchState.provider, request: number) => {
        if (!q.trim()) {
            suggestions = [];
            quickItems = [];
            suggestionsLoading = false;
            return;
        }
        suggestionsLoading = true;
        const isCurrent = () => request === suggestionRequest && q === searchState.query && provider === searchState.provider;
        let songs: Song[] = [];
        let extras: SearchExtras = { artists: [], albums: [], playlists: [] };
        let pending = 3;
        const finishRequest = () => {
            if (isCurrent() && --pending === 0) suggestionsLoading = false;
        };
        const updateQuickItems = () => {
            if (!isCurrent()) return;
            quickItems = [
                ...songs.slice(0, 4).map((value) => ({ kind: "song" as const, value })),
                ...extras.artists.slice(0, 2).map((value) => ({ kind: "artist" as const, value })),
                ...extras.albums.slice(0, 2).map((value) => ({ kind: "collection" as const, value })),
                ...extras.playlists.slice(0, 2).map((value) => ({ kind: "collection" as const, value })),
            ];
        };

        void client.musicSearchSuggestions(q).then((results) => {
            if (isCurrent()) suggestions = results.slice(0, 5);
        }).catch((error) => {
            if (isCurrent()) console.warn("[search] Text suggestions failed:", error);
        }).finally(finishRequest);
        void client.musicSearch(q, provider).then((results) => {
            songs = results;
            updateQuickItems();
        }).catch((error) => {
            if (isCurrent()) console.warn("[search] Song suggestions failed:", error);
        }).finally(finishRequest);
        void client.musicSearchExtras(q, provider).then((results) => {
            extras = results;
            updateQuickItems();
        }).catch((error) => {
            if (isCurrent()) console.warn("[search] Artist and album suggestions failed:", error);
        }).finally(finishRequest);
    }, 320);

    function selectQuickItem(item: QuickItem) {
        showSuggestions = false;
        input?.blur();
        if (item.kind === "song") playTrack(item.value);
        else if (item.kind === "artist") openArtist(item.value, searchState.provider);
        else openCollection(item.value, item.value.artists[0]?.name);
    }

    function submit(q?: string) {
        if (q !== undefined) searchState.query = q;
        const query = searchState.query.trim();
        if (!query) return;
        showSuggestions = false;
        highlighted = -1;
        input?.blur();
        const params = new URLSearchParams({ q: query, provider: searchState.provider });
        const target = `/music/search?${params}`;
        if (page.url.pathname === "/music/search" && page.url.search === `?${params}`) {
            void searchState.run(query);
        } else {
            void goto(target);
        }
    }

    function onKey(e: KeyboardEvent) {
        if (e.key === "Escape") {
            showSuggestions = false;
            input?.blur();
            return;
        }
        const count = suggestions.length + otherQuickItems.length + (exactSong ? 1 : 0);
        if (!showSuggestions || !count) return;
        if (e.key === "ArrowDown") highlighted = (highlighted + 1) % count;
        else if (e.key === "ArrowUp") highlighted = highlighted <= 0 ? count - 1 : highlighted - 1;
        else if (e.key === "Enter" && highlighted >= 0) {
            if (exactSong && highlighted === 0) selectQuickItem(exactSong);
            else {
                const index = highlighted - (exactSong ? 1 : 0);
                if (index < suggestions.length) submit(suggestions[index]);
                else selectQuickItem(otherQuickItems[index - suggestions.length]);
            }
        }
        else return;
        e.preventDefault();
    }

    function openLibrary() {
        if (isAndroid) return;
        clearTimeout(libraryTimer);
        libraryOpen = true;
    }
    function closeLibrarySoon() {
        clearTimeout(libraryTimer);
        libraryTimer = setTimeout(() => (libraryOpen = false), 220);
    }

    function chooseProvider(provider: typeof providers[number]["id"]) {
        searchState.provider = provider;
        if (providerPicker) providerPicker.open = false;
        if (searchState.query.trim()) submit();
    }

    function closeProviderPicker(event: MouseEvent) {
        if (providerPicker && event.target instanceof Node && !providerPicker.contains(event.target)) {
            providerPicker.open = false;
        }
    }

    function handleProviderEscape(event: KeyboardEvent) {
        if (event.key === "Escape" && providerPicker?.open) {
            providerPicker.open = false;
            providerPicker.querySelector("summary")?.focus();
        }
    }
</script>

<svelte:window onclick={closeProviderPicker} onkeydown={handleProviderEscape} />

<div class="dock-wrap">
    <nav class="dock" class:searching={onSearch} use:liquidGlass={{ enabled: ui.glassOn, depth: 10, blur: 9 }}>
        <a
            class="mark"
            class:home-active={isActive("/music")}
            href="/music"
            aria-label="Home"
            aria-current={isActive("/music") ? "page" : undefined}
            title="Home"
        >ζ</a>

        <div class="arrows">
            <button class="icon-btn sm" title="Back" onclick={() => history.back()}><Icon name="chevron-left" /></button>
            <button class="icon-btn sm" title="Forward" onclick={() => history.forward()}><Icon name="chevron-right" /></button>
        </div>

        <div class="items">
            {#if isAndroid}
                <a
                    href="/music"
                    class="item"
                    aria-label="Home"
                    aria-current={isActive("/music") ? "page" : undefined}
                    class:active={isActive("/music")}
                ><Icon name="house" /><span>Home</span></a>
            {/if}
            <form
                class="search"
                onsubmit={(e) => {
                    e.preventDefault();
                    submit();
                }}
            >
                <Icon name="search" />
                <input
                    id="search-input"
                    bind:this={input}
                    bind:value={searchState.query}
                    placeholder="Songs, artists, moods…"
                    aria-label="Search songs, artists, albums, and playlists"
                    autocomplete="off"
                    spellcheck="false"
                    oninput={() => {
                        showSuggestions = true;
                        highlighted = -1;
                        suggestions = [];
                        quickItems = [];
                        suggestionsLoading = !!searchState.query.trim();
                        fetchSuggestions(searchState.query, searchState.provider, ++suggestionRequest);
                    }}
                    onfocus={() => {
                        showSuggestions = true;
                        if (searchState.query.trim()) fetchSuggestions(searchState.query, searchState.provider, ++suggestionRequest);
                    }}
                    onblur={() => setTimeout(() => (showSuggestions = false), 150)}
                    onkeydown={onKey}
                />
                {#if searchState.loading}
                    <span class="spin subtle"><Icon name="loader-circle" /></span>
                {:else if searchState.query}
                    <button type="button" class="icon-btn sm" aria-label="Clear" onclick={() => {
                        searchState.query = "";
                        suggestions = [];
                        quickItems = [];
                        suggestionsLoading = false;
                        input?.focus();
                    }}>
                        <Icon name="x" />
                    </button>
                {/if}
                <details class="provider-picker" bind:this={providerPicker}>
                    <summary aria-label={`Search source: ${selectedProvider.label}`} aria-haspopup="listbox">
                        <span>{selectedProvider.label}</span>
                        <Icon name="chevron-down" />
                    </summary>
                    <div class="provider-menu" role="listbox" aria-label="Search source">
                        {#each providers as provider}
                            <button
                                type="button"
                                role="option"
                                aria-selected={searchState.provider === provider.id}
                                class:selected={searchState.provider === provider.id}
                                onclick={() => chooseProvider(provider.id)}
                            >{provider.label}</button>
                        {/each}
                    </div>
                </details>
            </form>

            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="lib" onmouseenter={openLibrary} onmouseleave={closeLibrarySoon}>
                <a href="/music/library" class="item" aria-label="Library" class:active={isActive("/music/library") || isActive("/music/playlist")}>
                    <Icon name="library-big" /><span>Library</span>
                </a>
                {#if libraryOpen}
                    <div class="popover glass" transition:fly={{ y: -8, duration: 200 }}>
                        {#each libraryState.playlists as p (p.id)}
                            <a class="pl" href="/music/playlist/{encodeURIComponent(p.id)}" onclick={() => (libraryOpen = false)}>
                                {#if p.id === FAVOURITES_ID}
                                    <span class="fav-art"><Icon name="heart" /></span>
                                {:else}
                                    <Cover src={p.thumbnail} title={p.name} size={36} radius="10px" />
                                {/if}
                                <span class="pl-name ellipsis">{p.name}</span>
                                {#if playerState.currentPlaylist?.id === p.id}<EqBars size={11} paused={playerState.paused} />{/if}
                                <span class="pl-count">{p.tracks.length}</span>
                            </a>
                        {/each}
                        <button class="pl new" onclick={() => { libraryOpen = false; createPlaylistWith(); }}>
                            <span class="plus"><Icon name="plus" /></span> New playlist
                        </button>
                    </div>
                {/if}
            </div>

            <a href="/music/stats" class="item" aria-label="Stats" class:active={isActive("/music/stats")}><Icon name="chart-no-axes-column" /><span>Stats</span></a>
        </div>

        <div class="tail">
            <a class="icon-btn sm" class:on={isActive("/music/settings")} aria-label="Settings" title="Settings" href="/music/settings">
                <Icon name="settings-2" />
                <span class="android-nav-label">Settings</span>
            </a>
        </div>
    </nav>

    {#if showSuggestions && searchState.query && (quickItems.length || suggestions.length || suggestionsLoading)}
        <div class="suggestions glass" transition:fly={{ y: -8, duration: 180 }}>
            <div class="search-hints">
                <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
                <span><kbd>Enter</kbd> Search</span>
            </div>
            {#if suggestionsLoading}
                <div class="suggestions-loading" role="status"><Icon name="loader-circle" /> Finding songs, artists, and albums…</div>
            {/if}
            {#if exactSong}
                {@render quickRow(exactSong, 0)}
            {/if}
            {#each suggestions as s, i}
                <button
                    class="sugg"
                    class:hl={i + (exactSong ? 1 : 0) === highlighted}
                    onmousedown={(e) => e.preventDefault()}
                    onclick={() => submit(s)}
                >
                    <Icon name="search" />
                    <span class="ellipsis">{s}</span>
                </button>
            {/each}
            {#if suggestions.length && otherQuickItems.length}
                <div class="suggestion-divider">Top results</div>
            {/if}
            {#each otherQuickItems as item, i}
                {@render quickRow(item, i + suggestions.length + (exactSong ? 1 : 0))}
            {/each}
        </div>
    {/if}
</div>

{#snippet quickRow(item: QuickItem, keyboardIndex: number)}
    {@const title = item.kind === "song"
        ? item.value.title
        : item.kind === "artist"
          ? item.value.name
          : item.value.title}
    {@const subtitle = item.kind === "song"
        ? item.value.artists.map((artist) => artist.name).join(", ")
        : item.kind === "artist"
          ? item.value.subtitle ?? "Artist"
          : item.value.subtitle ?? (item.value.kind === "playlist" ? "Playlist" : "Album")}
    {@const thumbnails = item.value.thumbnails}
    <div class="quick-row">
        <button
            class="sugg quick-sugg"
            class:hl={keyboardIndex === highlighted}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => selectQuickItem(item)}
        >
            <Cover {thumbnails} {title} size={36} radius={item.kind === "artist" ? "50%" : "9px"} />
            <span class="quick-copy">
                <strong class="ellipsis">{title}</strong>
                <small class="ellipsis">{subtitle}</small>
            </span>
            <span class="quick-type">{item.kind === "collection" ? item.value.kind : item.kind}</span>
        </button>
        {#if item.kind === "song"}
            <button
                class="quick-add"
                class:is-fav={libraryState.isFavourite(item.value.id)}
                aria-label={libraryState.isFavourite(item.value.id) ? "Remove from Favourites" : "Add to Favourites"}
                title={libraryState.isFavourite(item.value.id) ? "Remove from Favourites" : "Add to Favourites"}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => libraryState.toggleFavourite(item.value)}
            >
                <Icon name={libraryState.isFavourite(item.value.id) ? "check" : "plus"} />
            </button>
        {/if}
    </div>
{/snippet}

<style>
    .dock-wrap {
        position: fixed;
        top: calc(var(--titlebar-h) + 8px);
        left: 50%;
        translate: -50% 0;
        z-index: 50;
        display: flex;
        flex-direction: column;
        align-items: center;
        max-width: calc(100vw - 28px);
    }
    .dock {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 56px;
        padding: 0 8px;
        border-radius: var(--r-full);
        background: rgb(16 13 24 / 0.55);
        backdrop-filter: blur(30px) saturate(1.8);
        -webkit-backdrop-filter: blur(30px) saturate(1.8);
        border: 1px solid rgb(255 255 255 / 0.1);
        box-shadow: 0 20px 50px -20px rgb(0 0 0 / 0.7), inset 0 1px 0 rgb(255 255 255 / 0.08);
        transition: width 0.5s var(--ease-out);
        animation: dock-in 0.8s var(--ease-spring) both;
    }
    @keyframes dock-in {
        from {
            opacity: 0;
            transform: translateY(-20px) scale(0.9);
        }
    }
    .mark {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: conic-gradient(from 200deg, var(--accent), var(--art-2), var(--accent));
        color: #0b0913;
        font-family: "Times New Roman", Georgia, serif;
        font-style: italic;
        font-size: 26px;
        font-weight: 700;
        line-height: 1;
        padding-bottom: 3px;
        box-shadow: 0 0 22px -4px var(--accent-glow);
        transition: transform 0.5s var(--ease-spring);
        flex-shrink: 0;
    }
    .mark:hover {
        transform: rotate(-14deg) scale(1.06);
    }
    .mark.home-active {
        box-shadow: 0 0 0 2px var(--text), 0 0 22px -4px var(--accent-glow);
    }
    .arrows {
        display: flex;
        padding-right: 4px;
        border-right: 1px solid var(--border);
    }
    .items {
        display: flex;
        align-items: center;
        gap: 2px;
    }
    .item {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 40px;
        padding: 0 16px;
        border-radius: var(--r-full);
        font-weight: 650;
        font-size: 14px;
        color: var(--text-2);
        white-space: nowrap;
        transition: background 0.25s, color 0.25s;
    }
    .item :global(svg) {
        width: 18px;
        height: 18px;
    }
    .item:hover {
        color: var(--text);
        background: rgb(255 255 255 / 0.07);
    }
    .item.active {
        background: var(--text);
        color: #0b0913;
    }
    .search {
        display: flex;
        align-items: center;
        gap: 8px;
        width: min(460px, 42vw);
        height: 40px;
        padding: 0 4px 0 14px;
        border-radius: var(--r-full);
        background: rgb(255 255 255 / 0.1);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .search > :global(svg) {
        width: 18px;
        height: 18px;
        color: var(--accent);
        flex-shrink: 0;
    }
    .search input {
        flex: 1;
        min-width: 0;
        background: none;
        border: none;
        outline: none;
        color: var(--text);
        font: inherit;
        font-size: 14.5px;
        font-weight: 550;
    }
    .search input::placeholder {
        color: var(--text-3);
    }
    .spin :global(svg) {
        width: 16px;
        height: 16px;
    }
    .provider-picker {
        position: relative;
        flex: 0 0 auto;
    }
    .provider-picker summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 7px;
        min-height: 32px;
        padding: 0 10px;
        border: 1px solid rgb(255 255 255 / 0.12);
        border-radius: var(--r-full);
        color: var(--text-2);
        background: rgb(0 0 0 / 0.24);
        font: 600 12px var(--font);
        white-space: nowrap;
        cursor: pointer;
        list-style: none;
    }
    .provider-picker summary::-webkit-details-marker {
        display: none;
    }
    .provider-picker summary :global(svg) {
        width: 14px;
        height: 14px;
        color: var(--text-3);
        transition: transform 140ms ease;
    }
    .provider-picker[open] summary :global(svg) {
        transform: rotate(180deg);
    }
    .provider-picker summary:focus-visible,
    .provider-menu button:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
    }
    .provider-menu {
        position: absolute;
        top: calc(100% + 7px);
        right: 0;
        z-index: 60;
        display: grid;
        width: max-content;
        min-width: 100%;
        gap: 3px;
        padding: 5px;
        border: 1px solid rgb(255 255 255 / 0.13);
        border-radius: 12px;
        background: rgb(20 17 29);
        box-shadow: 0 10px 28px rgb(0 0 0 / 0.55);
    }
    .provider-menu button {
        padding: 8px 10px;
        border: 0;
        border-radius: 8px;
        color: var(--text-2);
        background: transparent;
        font: 600 12px var(--font);
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
    }
    .provider-menu button:hover,
    .provider-menu button.selected {
        color: var(--text);
        background: rgb(255 255 255 / 0.1);
    }
    .tail {
        display: flex;
        padding-left: 4px;
        border-left: 1px solid var(--border);
    }

    .lib {
        position: relative;
    }
    .popover {
        position: absolute;
        top: calc(100% + 12px);
        left: 50%;
        translate: -50% 0;
        width: 290px;
        max-height: 60vh;
        overflow-y: auto;
        padding: 6px;
        border-radius: 22px;
        background: rgb(16 13 24 / 0.82);
        box-shadow: var(--shadow-lg);
    }
    .popover::before {
        content: "";
        position: absolute;
        inset: -14px 0 auto;
        height: 14px;
    }
    .pl {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 6px;
        border-radius: 14px;
        font-weight: 600;
        font-size: 13.5px;
        text-align: left;
        transition: background 0.18s;
    }
    .pl:hover {
        background: rgb(255 255 255 / 0.08);
    }
    .pl-name {
        flex: 1;
    }
    .pl-count {
        font-size: 12px;
        color: var(--text-3);
        font-variant-numeric: tabular-nums;
    }
    .fav-art,
    .plus {
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        border-radius: 10px;
        flex-shrink: 0;
    }
    .fav-art {
        background: linear-gradient(135deg, #5b3df5, #c86dd7);
    }
    .fav-art :global(svg) {
        width: 16px;
        height: 16px;
        fill: #fff;
    }
    .plus {
        background: rgb(255 255 255 / 0.08);
    }
    .plus :global(svg) {
        width: 16px;
        height: 16px;
    }
    .new {
        color: var(--text-2);
        margin-top: 2px;
    }

    .suggestions {
        margin-top: 10px;
        width: min(440px, 90vw);
        max-height: min(70vh, 620px);
        overflow-y: auto;
        padding: 6px;
        border-radius: 22px;
        background: rgb(16 13 24 / 0.85);
        box-shadow: var(--shadow-lg);
    }
    .android-nav-label { display: none; }
    :global([data-os="android"]) .dock-wrap {
        top: calc(env(safe-area-inset-top, 0px) + 8px);
        width: calc(100vw - 24px);
        max-width: 520px;
    }
    :global([data-os="android"]) .item {
        min-height: 44px;
    }
    :global([data-os="android"]) .item span {
        display: inline;
        font-size: 11px;
    }
    :global([data-os="android"]) .search {
        height: 46px;
    }
    :global([data-os="android"]) .provider-picker summary {
        min-height: 40px;
    }
    .search-hints {
        display: flex;
        justify-content: space-between;
        padding: 7px 10px 9px;
        border-bottom: 1px solid var(--border);
        color: var(--text-3);
        font-size: 11px;
    }
    .search-hints span {
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .search-hints kbd {
        min-width: 17px;
        padding: 1px 4px;
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--text-2);
        font: inherit;
        text-align: center;
    }
    .suggestion-divider {
        padding: 9px 12px 4px;
        color: var(--text-3);
        font-size: 10px;
        font-weight: 650;
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }
    .suggestions-loading {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        color: var(--text-2);
        font-size: 13px;
    }
    .suggestions-loading :global(svg) {
        width: 15px;
        height: 15px;
        animation: spin 1s linear infinite;
    }
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
    .sugg {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        height: 42px;
        padding: 0 14px;
        border-radius: 14px;
        text-align: left;
        font-weight: 550;
    }
    .sugg :global(svg) {
        width: 15px;
        height: 15px;
        color: var(--text-3);
        flex-shrink: 0;
    }
    .sugg span {
        flex: 1;
    }
    .quick-sugg {
        height: 52px;
        gap: 10px;
        padding: 0 8px;
    }
    .quick-row {
        display: flex;
        align-items: center;
        border-radius: 14px;
        padding-right: 8px;
    }
    .quick-row:hover,
    .quick-row:focus-within {
        background: rgb(255 255 255 / 0.09);
    }
    .quick-row .quick-sugg:hover,
    .quick-row .quick-sugg.hl {
        background: transparent;
    }
    .quick-add {
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        flex: 0 0 30px;
        border: 1px solid var(--border);
        border-radius: 50%;
        color: var(--text-2);
        transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .quick-add:hover,
    .quick-add.is-fav {
        color: var(--accent);
        border-color: color-mix(in srgb, var(--accent) 60%, transparent);
        background: color-mix(in srgb, var(--accent) 14%, transparent);
    }
    .quick-add :global(svg) {
        width: 15px;
        height: 15px;
    }
    .quick-sugg :global(.cover) {
        flex: 0 0 36px;
    }
    .quick-copy {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-width: 0;
        gap: 2px;
    }
    .quick-copy strong {
        color: var(--text);
        font-size: 13px;
        font-weight: 650;
    }
    .quick-copy small {
        color: var(--text-3);
        font-size: 11px;
        font-weight: 500;
    }
    .quick-type {
        flex: 0 0 auto !important;
        color: var(--text-3);
        font-size: 10px;
        text-transform: capitalize;
    }
    .sugg:hover,
    .sugg.hl {
        background: rgb(255 255 255 / 0.09);
    }

    @media (max-width: 900px) {
        .item span {
            display: none;
        }
        .item {
            padding: 0 12px;
        }
    }
    :global([data-os="android"]) .arrows,
    :global([data-os="android"]) .mark { display: none; }

    @media (max-width: 600px) {
        :global([data-os="android"]) .dock {
            width: calc(100vw - 28px);
            height: auto;
            min-height: 0;
            flex-wrap: wrap;
            align-content: flex-start;
            gap: 4px 2px;
            padding: 8px;
            border: 1px solid rgb(255 255 255 / 0.12);
            border-radius: 22px;
            background: rgb(12 10 18 / 0.94);
            box-shadow: 0 18px 44px -22px rgb(0 0 0 / 0.9), inset 0 1px 0 rgb(255 255 255 / 0.08);
        }
        :global([data-os="android"]) .items { display: contents; }
        :global([data-os="android"]) .search {
            order: 2;
            width: 100%;
            flex: 0 0 100%;
            margin-top: 4px;
            padding-left: 12px;
            border-radius: 15px;
            background: rgb(255 255 255 / 0.075);
            box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08);
        }
        :global([data-os="android"]) .lib { order: 1; }
        :global([data-os="android"]) .items > .item,
        :global([data-os="android"]) .lib > .item,
        :global([data-os="android"]) .tail > a {
            order: 1;
            display: flex;
            flex: 1 1 0;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            gap: 4px;
            min-width: 0;
            height: 54px;
            padding: 4px 2px;
            border-radius: 15px;
            color: var(--text-3);
        }
        :global([data-os="android"]) .tail { display: contents; }
        :global([data-os="android"]) .item {
            font-size: 11.5px;
            font-weight: 650;
            letter-spacing: 0;
        }
        :global([data-os="android"]) .item.active,
        :global([data-os="android"]) .tail > a.on {
            color: var(--accent);
            background: color-mix(in srgb, var(--accent) 13%, transparent);
        }
        :global([data-os="android"]) .item span,
        :global([data-os="android"]) .android-nav-label {
            display: block;
            overflow: hidden;
            max-width: 100%;
            font-size: 11px;
            line-height: 1.1;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        :global([data-os="android"]) .item :global(svg),
        :global([data-os="android"]) .tail > a :global(svg) {
            width: 19px;
            height: 19px;
        }
        :global([data-os="android"]) .provider-picker { max-width: 118px; }
        :global([data-os="android"]) .provider-picker summary {
            min-height: 38px;
            gap: 4px;
            padding-inline: 9px;
            border-radius: 12px;
            background: rgb(255 255 255 / 0.075);
        }
        :global([data-os="android"]) .provider-picker summary span { font-size: 11px; }
        :global([data-os="android"]) .suggestions {
            width: 100%;
            max-height: min(54vh, 440px);
            overflow-y: auto;
            border: 1px solid var(--border-strong);
            border-radius: 20px;
            background: rgb(12 10 18 / 0.98);
        }
        :global([data-os="android"]) .sugg { min-height: 48px; }
        :global([data-os="android"]) .quick-sugg { min-height: 56px; }
        :global([data-os="android"]) .quick-add {
            width: 44px;
            height: 44px;
            flex-basis: 44px;
        }
    }
</style>
