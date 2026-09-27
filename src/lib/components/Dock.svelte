<script lang="ts">
    /**
     * The floating navigation island. On the search route it morphs into the
     * search bar itself; "Library" opens a quick playlist popover.
     */
    import { client } from "$lib/ephaptic";
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import EqBars from "$lib/components/EqBars.svelte";
    import { page } from "$app/state";
    import { goto } from "$app/navigation";
    import { libraryState, FAVOURITES_ID } from "$lib/state/library.svelte";
    import { playerState } from "$lib/state/player.svelte";
    import { searchState } from "$lib/state/search.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { createPlaylistWith } from "$lib/actions";
    import { debounce } from "$lib/utils";
    import { fly, scale } from "svelte/transition";
    import { tick } from "svelte";

    const path = $derived(page.url.pathname);
    const onSearch = $derived(path.startsWith("/music/search"));
    const isActive = (href: string) => (href === "/music" ? path === "/music" : path.startsWith(href));

    let input = $state<HTMLInputElement>();
    let suggestions = $state<string[]>([]);
    let showSuggestions = $state(false);
    let highlighted = $state(-1);
    let libraryOpen = $state(false);
    let libraryTimer: ReturnType<typeof setTimeout>;

    $effect(() => {
        if (onSearch) tick().then(() => !searchState.results.length && input?.focus());
    });

    const fetchSuggestions = debounce(async (q: string) => {
        if (!q.trim()) return (suggestions = []);
        try {
            const s = await client.musicSearchSuggestions(q);
            if (q === searchState.query) suggestions = s.slice(0, 7);
        } catch {
            suggestions = [];
        }
    }, 200);

    function submit(q?: string) {
        if (q !== undefined) searchState.query = q;
        showSuggestions = false;
        highlighted = -1;
        input?.blur();
        searchState.run();
    }

    function onKey(e: KeyboardEvent) {
        if (e.key === "Escape") {
            showSuggestions = false;
            input?.blur();
            return;
        }
        if (!showSuggestions || !suggestions.length) return;
        if (e.key === "ArrowDown") highlighted = (highlighted + 1) % suggestions.length;
        else if (e.key === "ArrowUp") highlighted = highlighted <= 0 ? suggestions.length - 1 : highlighted - 1;
        else if (e.key === "Enter" && highlighted >= 0) submit(suggestions[highlighted]);
        else return;
        e.preventDefault();
    }

    function openLibrary() {
        clearTimeout(libraryTimer);
        libraryOpen = true;
    }
    function closeLibrarySoon() {
        clearTimeout(libraryTimer);
        libraryTimer = setTimeout(() => (libraryOpen = false), 220);
    }
</script>

<div class="dock-wrap">
    <nav class="dock" class:searching={onSearch}>
        <a class="mark" href="/music" title="Zeta">ζ</a>

        <div class="arrows">
            <button class="icon-btn sm" title="Back" onclick={() => history.back()}><Icon name="chevron-left" /></button>
            <button class="icon-btn sm" title="Forward" onclick={() => history.forward()}><Icon name="chevron-right" /></button>
        </div>

        <div class="items">
            <a href="/music" class="item" class:active={isActive("/music")}><Icon name="sparkles" /><span>Home</span></a>

            {#if onSearch}
                <form
                    class="search"
                    in:scale={{ start: 0.85, duration: 350, opacity: 0 }}
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
                        autocomplete="off"
                        spellcheck="false"
                        oninput={() => {
                            showSuggestions = true;
                            highlighted = -1;
                            fetchSuggestions(searchState.query);
                        }}
                        onfocus={() => (showSuggestions = true)}
                        onblur={() => setTimeout(() => (showSuggestions = false), 150)}
                        onkeydown={onKey}
                    />
                    {#if searchState.loading}
                        <span class="spin subtle"><Icon name="loader-circle" /></span>
                    {:else if searchState.query}
                        <button type="button" class="icon-btn sm" aria-label="Clear" onclick={() => { searchState.query = ""; suggestions = []; input?.focus(); }}>
                            <Icon name="x" />
                        </button>
                    {/if}
                    <select class="provider" bind:value={searchState.provider} onchange={() => searchState.query.trim() && searchState.run()} title="Source">
                        <option value="yt">YouTube Music</option>
                        <option value="js">JioSaavn</option>
                    </select>
                </form>
            {:else}
                <a href="/music/search" class="item"><Icon name="search" /><span>Search</span></a>
            {/if}

            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="lib" onmouseenter={openLibrary} onmouseleave={closeLibrarySoon}>
                <a href="/music/library" class="item" class:active={isActive("/music/library") || isActive("/music/playlist")}>
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

            <a href="/music/stats" class="item" class:active={isActive("/music/stats")}><Icon name="chart-no-axes-column" /><span>Stats</span></a>
        </div>

        <div class="tail">
            <button class="icon-btn sm" title="Keyboard shortcuts (?)" onclick={() => (ui.shortcutsOpen = true)}><Icon name="keyboard" /></button>
            <a class="icon-btn sm" class:on={isActive("/music/settings")} title="Settings" href="/music/settings"><Icon name="settings-2" /></a>
        </div>
    </nav>

    {#if onSearch && showSuggestions && searchState.query && suggestions.length}
        <div class="suggestions glass" transition:fly={{ y: -8, duration: 180 }}>
            {#each suggestions as s, i}
                <button class="sugg" class:hl={i === highlighted} onmousedown={(e) => e.preventDefault()} onclick={() => submit(s)}>
                    <Icon name="search" />
                    <span class="ellipsis">{s}</span>
                    <Icon name="corner-down-left" />
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .dock-wrap {
        position: fixed;
        top: 14px;
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
    .provider {
        height: 32px;
        padding: 0 8px;
        border-radius: var(--r-full);
        background: rgb(0 0 0 / 0.3);
        border: none;
        color: var(--text-2);
        font: 600 12px var(--font);
        cursor: pointer;
        outline: none;
    }
    .provider option {
        background: #16131f;
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
        width: min(560px, 90vw);
        padding: 6px;
        border-radius: 22px;
        background: rgb(16 13 24 / 0.85);
        box-shadow: var(--shadow-lg);
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
</style>
