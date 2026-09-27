<script lang="ts">
    import { client } from "$lib/ephaptic";
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import TrackList from "$lib/components/TrackList.svelte";
    import { page } from "$app/state";
    import { goto } from "$app/navigation";
    import { libraryState, FAVOURITES_ID } from "$lib/state/library.svelte";
    import { playerState, playPlaylist, togglePlay, setShuffle } from "$lib/state/player.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { artistNames, formatLongDuration, getThumbnailUrl, slimSong, songKey } from "$lib/utils";
    import type { Song } from "$lib/schema";
    import { tilt } from "$lib/tilt";

    const id = $derived(decodeURIComponent(page.params.id ?? ""));
    const playlist = $derived(libraryState.getPlaylist(id));
    const isFav = $derived(id === FAVOURITES_ID);
    const playingHere = $derived(playerState.currentPlaylist?.id === id);

    let filter = $state("");
    const view = $derived.by(() => {
        const tracks = playlist?.tracks ?? [];
        const q = filter.trim().toLowerCase();
        const indices: number[] = [];
        const list: Song[] = [];
        tracks.forEach((t, i) => {
            if (!q || t.title.toLowerCase().includes(q) || artistNames(t).toLowerCase().includes(q) || t.album?.title.toLowerCase().includes(q)) {
                list.push(t);
                indices.push(i);
            }
        });
        return { list, indices };
    });

    const totalSeconds = $derived(playlist?.tracks.reduce((s, t) => s + (t.duration || 0), 0) ?? 0);
    const downloaded = $derived(playlist?.tracks.filter((t) => t.isDownloaded).length ?? 0);
    const cover = $derived(playlist?.thumbnail || (playlist?.tracks[0] ? getThumbnailUrl(playlist.tracks[0].thumbnails) : null));

    function playMain() {
        if (!playlist) return;
        if (playingHere) togglePlay();
        else playPlaylist(playlist);
    }

    function shufflePlay() {
        if (!playlist) return;
        if (playingHere) setShuffle(!playerState.shuffle);
        else playPlaylist(playlist, undefined, true);
    }

    function changeCover() {
        if (!playlist) return;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => reader.result && libraryState.saveThumbnail(playlist.id, reader.result.toString());
            reader.readAsDataURL(file);
        };
        input.click();
    }

    async function rename() {
        if (!playlist) return;
        const name = await ui.prompt("Rename playlist", { value: playlist.name });
        if (name) libraryState.renamePlaylist(playlist.id, name);
    }

    async function remove() {
        if (!playlist) return;
        const ok = await ui.confirm(`Delete “${playlist.name}”?`, {
            message: "The playlist file is removed; downloaded songs stay in your music folder.",
            confirmLabel: "Delete",
            danger: true,
        });
        if (!ok) return;
        await libraryState.deletePlaylist(playlist.id);
        goto("/music/library");
    }

    function moreMenu(el: Element) {
        if (!playlist) return;
        ui.openMenuAt(el, [
            { label: "Download all", icon: "download", action: () => libraryState.downloadPlaylist(playlist) },
            { label: "Change cover…", icon: "image", action: changeCover },
            ...(!playlist.isProtected
                ? [
                      { label: "Rename…", icon: "pencil", action: rename },
                      { separator: true },
                      { label: "Delete playlist", icon: "trash-2", danger: true, action: remove },
                  ]
                : []),
        ]);
    }

    function reorder(from: number, to: number) {
        if (!playlist) return;
        const ids = playlist.tracks.map((t) => t.id);
        const [moved] = ids.splice(from, 1);
        ids.splice(to, 0, moved);
        libraryState.reorderPlaylist(playlist.id, ids);
    }

    /* ---- recommendations ---- */
    let recs = $state<Song[]>([]);
    let recsLoading = $state(false);
    let recsFor = "";

    async function loadRecs() {
        if (!playlist?.tracks.length) {
            recs = [];
            return;
        }
        recsLoading = true;
        const seed = playlist.tracks[Math.floor(Math.random() * playlist.tracks.length)];
        const exclude = playlist.tracks.map((t) => t.id);
        try {
            const out = await client.musicRadio(slimSong($state.snapshot(seed) as Song), exclude);
            const have = new Set(playlist.tracks.map(songKey));
            recs = out.filter((t) => !libraryState.isInPlaylist(id, t.id) && !have.has(songKey(t))).slice(0, 8);
        } catch {
            recs = [];
        } finally {
            recsLoading = false;
        }
    }

    $effect(() => {
        // Once per playlist visit (and once its tracks are known).
        if (playlist && recsFor !== id && playlist.tracks.length) {
            recsFor = id;
            loadRecs();
        }
    });

    async function addRec(track: Song) {
        recs = recs.filter((t) => t.id !== track.id);
        await libraryState.addToPlaylist(id, track);
    }
</script>

{#if !playlist}
    <div class="page">
        {#if libraryState.loading}
            <div class="layout">
                <div class="skeleton" style="height:520px;border-radius:28px"></div>
                <div style="display:grid;gap:8px;align-content:start">{#each Array(6) as _}<div class="skeleton" style="height:64px;border-radius:20px"></div>{/each}</div>
            </div>
        {:else}
            <div class="empty"><Icon name="list-x" /><h3>Playlist not found</h3><a class="btn" href="/music/library">Back to Library</a></div>
        {/if}
    </div>
{:else}
    <div class="page">
        <div class="layout">
            <aside class="sleeve island">
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div class="cover" role="button" tabindex="0" title="Change cover" use:tilt={{ max: 14 }} onclick={changeCover}>
                    {#if isFav}
                        <div class="fav-art"><Icon name="heart" /></div>
                    {:else}
                        <Cover src={playlist.thumbnail} thumbnails={playlist.tracks[0]?.thumbnails} title={playlist.name} size="100%" radius="22px" />
                    {/if}
                    <span class="cover-shine"></span>
                    <span class="cover-edit"><Icon name="image-plus" /></span>
                </div>

                <div class="meta">
                    <span class="kicker">{#if isFav}<Icon name="heart" /> Liked songs{:else}<Icon name="disc-3" /> Playlist{/if}</span>
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <h1 class="name" title={playlist.name} onclick={() => !playlist.isProtected && rename()}>{playlist.name}</h1>
                    <div class="stats">
                        <span><strong>{playlist.tracks.length}</strong> songs</span>
                        {#if totalSeconds}<span><strong>{formatLongDuration(totalSeconds)}</strong></span>{/if}
                    </div>
                    {#if playlist.tracks.length}
                        <div class="dl-meter" title="{downloaded} of {playlist.tracks.length} saved offline">
                            <div class="dl-bar"><i style:width="{(downloaded / playlist.tracks.length) * 100}%"></i></div>
                            <span>{downloaded === playlist.tracks.length ? "All saved offline" : `${downloaded}/${playlist.tracks.length} offline`}</span>
                        </div>
                    {/if}
                </div>

                <div class="actions">
                    <button class="play-btn" disabled={!playlist.tracks.length} aria-label="Play" onclick={playMain}>
                        {#if playingHere && playerState.isLoading}
                            <span class="spin"><Icon name="loader-circle" /></span>
                        {:else}
                            <Icon name={playingHere && !playerState.paused ? "pause" : "play"} />
                        {/if}
                    </button>
                    <button class="icon-btn lg" class:on={playingHere && playerState.shuffle} title={playingHere ? "Toggle shuffle" : "Shuffle play"} disabled={!playlist.tracks.length} onclick={shufflePlay}>
                        <Icon name="shuffle" />
                    </button>
                    <button class="icon-btn lg" title="Save all offline" disabled={!playlist.tracks.length} onclick={() => libraryState.downloadPlaylist(playlist)}>
                        <Icon name="circle-arrow-down" />
                    </button>
                    <button class="icon-btn lg" title="More" onclick={(e) => moreMenu(e.currentTarget)}>
                        <Icon name="ellipsis" />
                    </button>
                </div>

                {#if playlist.tracks.length > 4}
                    <label class="filter">
                        <Icon name="search" />
                        <input bind:value={filter} placeholder="Find in playlist" spellcheck="false" />
                        {#if filter}<button class="icon-btn sm" aria-label="Clear" onclick={() => (filter = "")}><Icon name="x" /></button>{/if}
                    </label>
                {/if}
            </aside>

            <div class="stack">
                {#if playlist.tracks.length}
                    <TrackList
                        tracks={view.list}
                        indices={view.indices}
                        {playlist}
                        reorderable={!filter}
                        onreorder={reorder}
                        onplay={(i) => playPlaylist(playlist, view.indices[i])}
                    />
                    {#if filter && !view.list.length}
                        <div class="empty"><Icon name="search-x" /><h3>Nothing matches “{filter}”</h3></div>
                    {/if}
                {:else}
                    <div class="empty island">
                        <Icon name="music-2" />
                        <h3>An empty sleeve</h3>
                        <p>Search for songs, then add them with a right-click or the <strong>⋯</strong> menu.</p>
                        <a class="btn btn-primary" href="/music/search"><Icon name="search" /> Find songs</a>
                    </div>
                {/if}

                {#if playlist.tracks.length}
                    <section class="recs island">
                        <div class="section-head">
                            <div>
                                <span class="kicker"><Icon name="wand-sparkles" /> Fits this playlist</span>
                                <h2 class="section-title">Recommended</h2>
                            </div>
                            <button class="icon-btn" title="Refresh" disabled={recsLoading} onclick={loadRecs}>
                                <span class:spin={recsLoading} class="ic"><Icon name="refresh-cw" /></span>
                            </button>
                        </div>
                        {#if recsLoading && !recs.length}
                            <div class="rec-list">{#each Array(4) as _}<div class="skeleton" style="height:52px"></div>{/each}</div>
                        {:else}
                            <div class="rec-list" class:stale={recsLoading}>
                                {#each recs as track, i (track.id)}
                                    <div class="rec" style:animation-delay="{i * 40}ms">
                                        <Cover thumbnails={track.thumbnails} title={track.title} size={44} radius="12px" />
                                        <div class="rec-text">
                                            <span class="ellipsis rec-title">{track.title}</span>
                                            <span class="ellipsis subtle">{artistNames(track)}</span>
                                        </div>
                                        <button class="add" title="Add to playlist" onclick={() => addRec(track)}><Icon name="plus" /></button>
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    </section>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .layout {
        display: grid;
        grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
        gap: 22px;
        align-items: start;
        margin-top: 12px;
    }
    .sleeve {
        position: sticky;
        top: 0;
        display: flex;
        flex-direction: column;
        gap: 18px;
        padding: 18px;
        animation: rise 0.7s var(--ease-out) both;
    }
    @keyframes rise {
        from {
            opacity: 0;
            transform: translateY(16px);
        }
    }
    .cover {
        --rx: 0deg;
        --ry: 0deg;
        --mx: 50%;
        --my: 0%;
        position: relative;
        aspect-ratio: 1;
        border-radius: 22px;
        cursor: pointer;
        transform: perspective(900px) rotateX(var(--rx)) rotateY(var(--ry));
        transition: transform 0.2s linear;
        box-shadow: 0 30px 60px -30px rgb(0 0 0 / 0.95), 0 0 50px -24px var(--accent-glow);
    }
    .cover-shine {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: radial-gradient(55% 55% at var(--mx) var(--my), rgb(255 255 255 / 0.28), transparent 70%);
        mix-blend-mode: overlay;
        pointer-events: none;
    }
    .cover-edit {
        position: absolute;
        right: 12px;
        top: 12px;
        display: grid;
        place-items: center;
        width: 38px;
        height: 38px;
        border-radius: 50%;
        background: rgb(0 0 0 / 0.55);
        backdrop-filter: blur(8px);
        opacity: 0;
        transform: scale(0.8);
        transition: opacity 0.2s, transform 0.3s var(--ease-spring);
    }
    .cover-edit :global(svg) {
        width: 18px;
        height: 18px;
    }
    .cover:hover .cover-edit {
        opacity: 1;
        transform: none;
    }
    .fav-art {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        border-radius: 22px;
        background: radial-gradient(120% 100% at 0% 0%, #7c5cff, #4a2bd6 45%, #b04ac9);
    }
    .fav-art :global(svg) {
        width: 90px;
        height: 90px;
        fill: #fff;
        filter: drop-shadow(0 10px 20px rgb(0 0 0 / 0.3));
    }
    .meta {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 0 4px;
        min-width: 0;
    }
    .name {
        font-size: clamp(28px, 2.6vw, 40px);
        font-weight: 850;
        letter-spacing: -0.045em;
        line-height: 1.02;
        padding-bottom: 0.06em;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
    }
    .stats {
        display: flex;
        gap: 14px;
        color: var(--text-2);
    }
    .stats strong {
        color: var(--text);
        font-weight: 700;
    }
    .dl-meter {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-3);
    }
    .dl-bar {
        flex: 1;
        height: 4px;
        border-radius: 4px;
        background: rgb(255 255 255 / 0.1);
        overflow: hidden;
    }
    .dl-bar i {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: var(--success);
        transition: width 0.6s var(--ease-out);
    }
    .actions {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .actions .play-btn {
        margin-right: auto;
    }
    .play-btn .spin :global(svg) {
        fill: none;
    }
    .filter {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 40px;
        padding: 0 6px 0 14px;
        border-radius: var(--r-full);
        background: rgb(255 255 255 / 0.07);
        border: 1px solid var(--border);
        color: var(--text-3);
        transition: border-color 0.2s, background 0.2s;
    }
    .filter:focus-within {
        border-color: color-mix(in srgb, var(--accent) 50%, transparent);
        background: rgb(255 255 255 / 0.1);
    }
    .filter > :global(svg) {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
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

    .stack {
        display: flex;
        flex-direction: column;
        gap: 22px;
        min-width: 0;
    }
    .recs {
        padding: 20px 18px 14px;
    }
    .recs .section-head {
        align-items: center;
        padding: 0 4px;
    }
    .rec-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 4px 12px;
        transition: opacity 0.3s;
    }
    .rec-list.stale {
        opacity: 0.5;
    }
    .rec {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px;
        border-radius: 16px;
        transition: background 0.2s;
        animation: rise 0.45s var(--ease-out) both;
    }
    .rec:hover {
        background: rgb(255 255 255 / 0.07);
    }
    .rec-text {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        font-size: 13px;
    }
    .rec-title {
        font-weight: 600;
        font-size: 14px;
    }
    .add {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        border: 1.5px solid rgb(255 255 255 / 0.25);
        color: var(--text-2);
        transition: all 0.25s var(--ease-spring);
        flex-shrink: 0;
    }
    .add :global(svg) {
        width: 16px;
        height: 16px;
    }
    .add:hover {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--on-accent);
        transform: rotate(90deg) scale(1.08);
    }
    .ic {
        display: inline-grid;
    }
    .empty.island {
        padding: 56px 20px;
    }

    @media (max-width: 1000px) {
        .layout {
            grid-template-columns: 1fr;
        }
        .sleeve {
            position: static;
            display: grid;
            grid-template-columns: 180px minmax(0, 1fr);
            align-items: end;
        }
        .sleeve .actions,
        .sleeve .filter {
            grid-column: 1 / -1;
        }
    }
</style>
