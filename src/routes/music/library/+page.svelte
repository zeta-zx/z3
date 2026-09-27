<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import MediaCard from "$lib/components/MediaCard.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import { libraryState, FAVOURITES_ID } from "$lib/state/library.svelte";
    import { playerState, playPlaylist, togglePlay } from "$lib/state/player.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { createPlaylistWith, openPlaylist } from "$lib/actions";
    import { formatLongDuration } from "$lib/utils";
    import type { Playlist } from "$lib/schema";

    let filter = $state("");
    let sort = $state<"recent" | "name" | "size">("recent");

    const playlists = $derived.by(() => {
        const q = filter.trim().toLowerCase();
        const list = libraryState.playlists.filter((p) => !q || p.name.toLowerCase().includes(q));
        const fav = list.filter((p) => p.id === FAVOURITES_ID);
        const rest = list.filter((p) => p.id !== FAVOURITES_ID);
        if (sort === "name") rest.sort((a, b) => a.name.localeCompare(b.name));
        else if (sort === "size") rest.sort((a, b) => b.tracks.length - a.tracks.length);
        else rest.sort((a, b) => b.createdAt - a.createdAt);
        return [...fav, ...rest];
    });

    const totalSongs = $derived(new Set(libraryState.playlists.flatMap((p) => p.tracks.map((t) => t.id))).size);
    const duration = (p: Playlist) => p.tracks.reduce((s, t) => s + (t.duration || 0), 0);

    function play(p: Playlist) {
        if (playerState.currentPlaylist?.id === p.id) togglePlay();
        else playPlaylist(p);
    }

    function menu(e: MouseEvent, p: Playlist) {
        ui.openMenu(e, [
            { label: "Play", icon: "play", disabled: !p.tracks.length, action: () => playPlaylist(p) },
            { label: "Shuffle play", icon: "shuffle", disabled: !p.tracks.length, action: () => playPlaylist(p, undefined, true) },
            { label: "Open", icon: "arrow-up-right", action: () => openPlaylist(p) },
            { label: "Download all", icon: "download", action: () => libraryState.downloadPlaylist(p) },
            ...(!p.isProtected
                ? [
                      { separator: true },
                      {
                          label: "Rename…",
                          icon: "pencil",
                          action: async () => {
                              const name = await ui.prompt("Rename playlist", { value: p.name });
                              if (name) libraryState.renamePlaylist(p.id, name);
                          },
                      },
                      {
                          label: "Delete",
                          icon: "trash-2",
                          danger: true,
                          action: async () => {
                              if (await ui.confirm(`Delete “${p.name}”?`, { message: "The playlist file is removed; downloaded songs stay in your music folder.", confirmLabel: "Delete", danger: true }))
                                  libraryState.deletePlaylist(p.id);
                          },
                      },
                  ]
                : []),
        ]);
    }
</script>

<div class="page">
    <header class="head">
        <div class="head-text">
            <span class="kicker"><Icon name="library-big" /> Collection</span>
            <h1 class="page-title">Library</h1>
            <p class="muted">
                {libraryState.playlists.length} playlists · {totalSongs} songs
                <span class="path" title={libraryState.path}><Icon name="folder" /> {libraryState.path || "…"}</span>
            </p>
        </div>
        <button class="btn btn-primary" onclick={() => createPlaylistWith()}><Icon name="plus" /> New playlist</button>
    </header>

    <div class="toolbar">
        <label class="filter">
            <Icon name="search" />
            <input bind:value={filter} placeholder="Filter playlists" spellcheck="false" />
        </label>
        <div class="segmented">
            <button aria-pressed={sort === "recent"} onclick={() => (sort = "recent")}>Recent</button>
            <button aria-pressed={sort === "name"} onclick={() => (sort = "name")}>A–Z</button>
            <button aria-pressed={sort === "size"} onclick={() => (sort = "size")}>Size</button>
        </div>
    </div>

    {#if libraryState.loading && !libraryState.playlists.length}
        <div class="grid-cards">
            {#each Array(6) as _}
                <div><div class="skeleton" style="aspect-ratio:1"></div><div class="skeleton" style="height:14px;margin-top:12px;width:70%"></div></div>
            {/each}
        </div>
    {:else}
        <div class="grid-cards">
            {#each playlists as p, i (p.id)}
                <MediaCard
                    title={p.name}
                    subtitle="{p.tracks.length} songs{p.tracks.length ? ` · ${formatLongDuration(duration(p))}` : ''}"
                    src={p.thumbnail}
                    index={i}
                    playing={playerState.currentPlaylist?.id === p.id}
                    paused={playerState.paused}
                    onclick={() => openPlaylist(p)}
                    onplay={p.tracks.length ? () => play(p) : undefined}
                    oncontextmenu={(e) => menu(e, p)}
                >
                    {#snippet art()}
                        {#if p.id === FAVOURITES_ID}
                            <div class="fav-art">
                                <Icon name="heart" />
                            </div>
                        {:else}
                            <Cover src={p.thumbnail} title={p.name} size="100%" radius="var(--r-md)" />
                        {/if}
                    {/snippet}
                </MediaCard>
            {/each}
            {#if !filter}
                <button class="create" onclick={() => createPlaylistWith()}>
                    <span class="plus"><Icon name="plus" /></span>
                    <span>New playlist</span>
                </button>
            {/if}
        </div>
        {#if filter && !playlists.length}
            <div class="empty"><Icon name="search-x" /><h3>No playlists match “{filter}”</h3></div>
        {/if}
    {/if}
</div>

<style>
    .head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 4px 26px;
    }
    .head-text {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
    }
    .head p {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px 14px;
    }
    .path {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 12.5px;
        color: var(--text-3);
        max-width: 420px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .path :global(svg) {
        width: 13px;
        height: 13px;
        flex-shrink: 0;
    }
    .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 26px;
    }
    .filter {
        display: flex;
        align-items: center;
        gap: 8px;
        width: min(320px, 100%);
        height: 38px;
        padding: 0 14px;
        border-radius: var(--r-full);
        background: var(--surface-2);
        border: 1px solid var(--border);
        color: var(--text-3);
    }
    .filter:focus-within {
        border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    }
    .filter :global(svg) {
        width: 16px;
        height: 16px;
    }
    .filter input {
        flex: 1;
        min-width: 0;
        background: none;
        border: none;
        outline: none;
        color: var(--text);
        font: inherit;
    }
    .fav-art {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        background: radial-gradient(120% 100% at 0% 0%, #7c5cff, #4a2bd6 45%, #b04ac9);
    }
    .fav-art :global(svg) {
        width: 64px;
        height: 64px;
        fill: #fff;
        margin-bottom: 40px;
        filter: drop-shadow(0 10px 20px rgb(0 0 0 / 0.3));
    }
    .create {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        aspect-ratio: 1;
        border-radius: 26px;
        border: 1.5px dashed rgb(255 255 255 / 0.2);
        background: rgb(16 13 24 / 0.5);
        color: var(--text-2);
        font-weight: 650;
        transition: border-color 0.25s, color 0.25s, background 0.25s;
    }
    .create:hover {
        border-color: var(--accent);
        color: var(--text);
        background: var(--accent-soft);
    }
    .plus {
        display: grid;
        place-items: center;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: var(--surface-3);
        transition: transform 0.35s var(--ease-spring);
    }
    .create:hover .plus {
        transform: rotate(90deg) scale(1.08);
    }
</style>
