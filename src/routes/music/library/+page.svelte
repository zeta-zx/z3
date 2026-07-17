<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { libraryState } from "$lib/state/library.svelte";
    import { playerState, playPlaylist } from "$lib/state/player.svelte";
    import { formatDate, createPlaceholderUrl, Font, formatTime, getThumbnailUrl } from "$lib/utils";
    import { fade, fly } from "svelte/transition";
    import type { Playlist, Song } from "$lib/schema";

    let playlists = $derived(libraryState.playlists);

    let openPlaylistId = $state<string | null>(null);
    // Derive from the store so live updates (rename, thumbnail, reorder) flow through.
    let currentlyOpenPlaylist = $derived<Playlist | null>(
        openPlaylistId ? playlists.find((p) => p.id === openPlaylistId) ?? null : null,
    );

    // Name dialog (create / rename).
    let dialogMode = $state<"create" | "rename" | null>(null);
    let dialogValue = $state("");
    let dialogTargetId = $state<string | null>(null);

    const totalDuration = (playlist: Playlist) =>
        playlist.tracks.map((t) => t.duration).reduce((sum, cur) => (sum ?? 0) + (cur ?? 0), 0);

    function openCreateDialog() {
        dialogMode = "create";
        dialogValue = "";
        dialogTargetId = null;
    }

    function openRenameDialog(playlist: Playlist) {
        dialogMode = "rename";
        dialogValue = playlist.name;
        dialogTargetId = playlist.id;
    }

    function closeDialog() {
        dialogMode = null;
        dialogValue = "";
        dialogTargetId = null;
    }

    async function submitDialog(e: Event) {
        e.preventDefault();
        const name = dialogValue.trim();
        if (!name) return;

        if (dialogMode === "create") {
            const created = await libraryState.createPlaylist(name);
            if (created) openPlaylistId = created.id;
        } else if (dialogMode === "rename" && dialogTargetId) {
            await libraryState.renamePlaylist(dialogTargetId, name);
        }
        closeDialog();
    }

    async function deletePlaylist(playlist: Playlist) {
        if (playlist.isProtected) return;
        if (!confirm(`Delete playlist "${playlist.name}"? This cannot be undone.`)) return;
        await libraryState.deletePlaylist(playlist.id);
        if (openPlaylistId === playlist.id) openPlaylistId = null;
    }

    function handleEditImage(playlist: Playlist) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.click();
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                if (!reader.result) return;
                libraryState.saveThumbnail(playlist.id, reader.result.toString());
            };
            reader.readAsDataURL(file);
        });
    }

    // ---- drag reorder ----
    let dragIndex = $state<number | null>(null);
    let dragOverIndex = $state<number | null>(null);

    function onDrop(playlist: Playlist) {
        if (dragIndex === null || dragOverIndex === null || dragIndex === dragOverIndex) {
            dragIndex = dragOverIndex = null;
            return;
        }
        const ids = playlist.tracks.map((t) => t.id);
        const [moved] = ids.splice(dragIndex, 1);
        ids.splice(dragOverIndex, 0, moved);
        libraryState.reorderPlaylist(playlist.id, ids);
        dragIndex = dragOverIndex = null;
    }

    const thumbFor = (playlist: Playlist) =>
        playlist.thumbnail ??
        createPlaceholderUrl({ width: 256, height: 256, text: playlist.name, font: Font.NotoSans });
</script>

{#if !currentlyOpenPlaylist}
    <p>
        Your music is located at <code>{libraryState.path || "…"}</code>.
    </p>
    <div class="results search-results playlists">
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <article class="playlist" onclick={openCreateDialog}>
            <div class="img-wrapper">
                <img
                    src={createPlaceholderUrl({
                        width: 256,
                        height: 256,
                        text: "+",
                        font: Font.NotoSans,
                    })}
                    alt="Create Playlist"
                />
            </div>
            <div class="info-wrapper">
                <h4>Create Playlist</h4>
            </div>
        </article>
        {#each playlists as playlist (playlist.id)}
            {@const duration = formatTime(totalDuration(playlist))}
            <!-- svelte-ignore (a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions) -->
            <article class="playlist" onclick={() => (openPlaylistId = playlist.id)}>
                <div class="img-wrapper">
                    <img src={thumbFor(playlist)} alt="Playlist Thumbnail" referrerPolicy="no-referrer" />
                </div>
                <div class="info-wrapper">
                    <h4 title={playlist.name}>{playlist.name}</h4>
                    <small title="Created {formatDate(playlist.createdAt)}">
                        <Icon name="clock-plus" />
                        Created {formatDate(playlist.createdAt)}
                    </small>
                    <small title="{playlist.tracks.length} tracks">
                        <Icon name="square-library" />
                        {playlist.tracks.length} tracks
                    </small>
                    <small title="Duration: {duration}">
                        <Icon name="clock" />
                        Duration: {duration}
                    </small>
                </div>
            </article>
        {/each}
    </div>
{:else}
    {@const playlist = currentlyOpenPlaylist}
    {@const duration = formatTime(totalDuration(playlist))}
    <div class="playlist-view" in:fly={{ y: 20, duration: 300 }} out:fade={{ duration: 150 }}>
        <button class="secondary back-btn" onclick={() => (openPlaylistId = null)}>
            <Icon name="arrow-left" /> Back to Library
        </button>
        <div class="top-section">
            <img src={thumbFor(playlist)} alt="Playlist Thumbnail" referrerPolicy="no-referrer" />
            <div class="info-wrapper">
                <h1 class="zeta" title={playlist.name}>{playlist.name}</h1>
                <small title="Created {formatDate(playlist.createdAt)}">
                    <Icon name="clock-plus" />
                    {formatDate(playlist.createdAt)}
                </small>
                <small title="{playlist.tracks.length} tracks">
                    <Icon name="square-library" />
                    {playlist.tracks.length} tracks
                </small>
                <small title="Duration: {duration}">
                    <Icon name="clock" />
                    Duration: {duration}
                </small>
                <br />
                <div class="action-row">
                    {#if playerState.currentPlaylist?.id === playlist.id}
                        <button class="primary" onclick={() => (playerState.paused = !playerState.paused)}>
                            <Icon name={playerState.paused ? "play" : playerState.isLoading ? "loader-circle" : "pause"} />
                        </button>
                    {:else}
                        <button class="primary" disabled={playlist.tracks.length === 0} onclick={() => playPlaylist(playlist)}>
                            <Icon name="play" />
                        </button>
                    {/if}
                    <button class="secondary" disabled={playlist.tracks.length === 0} onclick={() => playPlaylist(playlist, 0, true)}>
                        <Icon name="shuffle" />
                    </button>
                    <button class="secondary" onclick={() => handleEditImage(playlist)} title="Edit Image">
                        <Icon name="image" />
                    </button>
                    {#if !playlist.isProtected}
                        <button class="secondary" onclick={() => openRenameDialog(playlist)} title="Rename">
                            <Icon name="pencil" />
                        </button>
                        <button class="secondary" onclick={() => deletePlaylist(playlist)} title="Delete playlist">
                            <Icon name="trash-2" />
                        </button>
                    {/if}
                </div>
            </div>
        </div>
        <br />
        <div class="track-list">
            {#if playlist.tracks.length === 0}
                <p><small>This playlist is empty. Add songs from the search page.</small></p>
            {/if}
            {#each playlist.tracks as track, i (track.id)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="track-row"
                    class:active={playerState.currentTrack?.id === track.id}
                    class:drag-over={dragOverIndex === i}
                    draggable="true"
                    ondragstart={() => (dragIndex = i)}
                    ondragover={(e) => {
                        e.preventDefault();
                        dragOverIndex = i;
                    }}
                    ondragend={() => (dragIndex = dragOverIndex = null)}
                    ondrop={(e) => {
                        e.preventDefault();
                        onDrop(playlist);
                    }}
                >
                    <span class="track-num">#{i + 1}</span>
                    <img src={getThumbnailUrl(track.thumbnails, track.title)} alt="Track Cover" referrerPolicy="no-referrer" />
                    <div class="track-info">
                        <strong>{track.title}</strong>
                        <small>{track.artists.map((a) => a.name).join(", ")}</small>
                    </div>
                    <div class="track-action-row">
                        {#if playerState.currentTrack?.id === track.id}
                            <button class="primary" onclick={() => (playerState.paused = !playerState.paused)}>
                                <Icon name={playerState.paused ? "play" : playerState.isLoading ? "loader-circle" : "pause"} />
                            </button>
                        {:else}
                            <button class="primary" onclick={() => playPlaylist(playlist, i)}>
                                <Icon name="play" />
                            </button>
                        {/if}
                        <button
                            class={libraryState.isInPlaylist("favourites.m3u8", track.id) ? "primary" : "secondary"}
                            title="Toggle Favourite"
                            onclick={() => libraryState.toggleFromPlaylist("favourites.m3u8", track)}
                        >
                            <Icon name="heart" />
                        </button>
                        <button
                            class="secondary"
                            title="Remove from playlist"
                            onclick={() => libraryState.removeFromPlaylist(playlist.id, track.id)}
                        >
                            <Icon name="trash-2" />
                        </button>
                    </div>
                </div>
            {/each}
        </div>
    </div>
{/if}

{#if dialogMode}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="modal-backdrop"
        onclick={(e) => {
            if (e.target === e.currentTarget) closeDialog();
        }}
        transition:fade={{ duration: 150 }}
    >
        <form class="modal" onsubmit={submitDialog}>
            <h4>{dialogMode === "create" ? "Create Playlist" : "Rename Playlist"}</h4>
            <!-- svelte-ignore a11y_autofocus -->
            <input type="text" bind:value={dialogValue} placeholder="Playlist name" autofocus />
            <div class="modal-actions">
                <button type="button" class="secondary" onclick={closeDialog}>Cancel</button>
                <button type="submit" class="primary" disabled={!dialogValue.trim()}>
                    {dialogMode === "create" ? "Create" : "Save"}
                </button>
            </div>
        </form>
    </div>
{/if}

<style>
    .track-row {
        cursor: grab;
    }
    .track-row.drag-over {
        outline: 2px dashed var(--pico-primary, #7aa2f7);
        outline-offset: -2px;
    }
    .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1100;
    }
    .modal {
        background: var(--pico-card-background-color, #1c1c1e);
        border: 1px solid var(--pico-muted-border-color, #333);
        border-radius: var(--pico-border-radius, 0.5rem);
        padding: 1.25rem;
        width: min(90vw, 380px);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }
    .modal input {
        width: 100%;
    }
    .modal-actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
    }
    .modal-actions button {
        width: auto;
    }
</style>
