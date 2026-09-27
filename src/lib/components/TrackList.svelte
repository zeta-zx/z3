<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import EqBars from "$lib/components/EqBars.svelte";
    import type { Playlist, Song } from "$lib/schema";
    import { libraryState } from "$lib/state/library.svelte";
    import { playerState, togglePlay } from "$lib/state/player.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { trackMenu } from "$lib/actions";
    import { artistNames, formatTime } from "$lib/utils";
    import { onMount } from "svelte";

    interface Props {
        tracks: Song[];
        /** Called with the index into `tracks` when a row is played. */
        onplay: (index: number) => void;
        /** Context for "remove from this playlist" and active highlighting. */
        playlist?: Playlist | null;
        reorderable?: boolean;
        onreorder?: (from: number, to: number) => void;
        showAlbum?: boolean;
        /** Original indices, when `tracks` is a filtered view of the playlist. */
        indices?: number[];
    }

    let { tracks, onplay, playlist = null, reorderable = false, onreorder, showAlbum = true, indices }: Props = $props();

    let dragFrom = $state<number | null>(null);
    let dragOver = $state<number | null>(null);

    /* ---- virtualization: long lists only render the rows near the viewport ---- */
    const ROW = 70; // 64px row + 6px gap
    const VIRTUAL_MIN = 60;
    const OVERSCAN = 8;

    let listEl = $state<HTMLDivElement>();
    let range = $state({ start: 0, end: 30 });
    let scroller: HTMLElement | null = null;
    let frame = 0;

    const virtual = $derived(tracks.length > VIRTUAL_MIN);
    const offset = $derived(virtual ? range.start : 0);
    const visible = $derived(virtual ? tracks.slice(range.start, range.end) : tracks);

    function measure() {
        frame = 0;
        if (!listEl || !scroller) return;
        // How far the top of the list has scrolled above the scroller's top edge.
        const past = scroller.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
        const start = Math.max(0, Math.floor(past / ROW) - OVERSCAN);
        const end = Math.min(tracks.length, Math.ceil((past + scroller.clientHeight) / ROW) + OVERSCAN);
        if (start !== range.start || end !== range.end) range = { start, end };
    }

    function schedule() {
        if (!frame) frame = requestAnimationFrame(measure);
    }

    onMount(() => {
        scroller = (listEl?.closest("main") as HTMLElement | null) ?? document.documentElement;
        scroller.addEventListener("scroll", schedule, { passive: true });
        const ro = new ResizeObserver(schedule);
        ro.observe(scroller);
        measure();
        return () => {
            scroller?.removeEventListener("scroll", schedule);
            ro.disconnect();
            cancelAnimationFrame(frame);
        };
    });

    // The list length changed (filtering, adds/removes): recompute the window.
    $effect(() => {
        void tracks.length;
        schedule();
    });

    function isCurrent(track: Song) {
        return playerState.currentTrack?.id === track.id;
    }

    function play(i: number, track: Song) {
        if (isCurrent(track) && (!playlist || playerState.currentPlaylist?.id === playlist.id)) togglePlay();
        else onplay(i);
    }

    function drop() {
        if (dragFrom !== null && dragOver !== null && dragFrom !== dragOver) onreorder?.(dragFrom, dragOver);
        dragFrom = dragOver = null;
    }
</script>

<div
    class="tracklist"
    class:virtual
    role="list"
    bind:this={listEl}
    style:height={virtual ? `${tracks.length * ROW - 6}px` : undefined}
>
    {#each visible as track, j (track.id)}
        {@const i = offset + j}
        {@const current = isCurrent(track)}
        {@const fav = libraryState.isFavourite(track.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
            class="row track"
            class:current
            class:dragging={dragFrom === i}
            class:drop-above={dragOver === i && dragFrom !== null && dragFrom > i}
            class:drop-below={dragOver === i && dragFrom !== null && dragFrom < i}
            role="listitem"
            draggable={reorderable}
            ondblclick={() => play(i, track)}
            onclick={(e) => {
                // Single click plays too, unless it landed on a control.
                if (!(e.target as HTMLElement).closest("button")) play(i, track);
            }}
            oncontextmenu={(e) => ui.openMenu(e, trackMenu(track, { playlist }))}
            ondragstart={(e) => {
                dragFrom = i;
                e.dataTransfer!.effectAllowed = "move";
            }}
            ondragover={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                dragOver = i;
            }}
            ondragend={() => (dragFrom = dragOver = null)}
            ondrop={(e) => {
                e.preventDefault();
                drop();
            }}
            style:animation-delay={virtual ? undefined : `${Math.min(i, 20) * 18}ms`}
            style:top={virtual ? `${i * ROW}px` : undefined}
        >
            <span class="num">
                {#if current && !playerState.paused}
                    <span class="n-eq"><EqBars paused={playerState.paused} /></span>
                    <button class="n-btn" aria-label="Pause" onclick={() => togglePlay()}><Icon name="pause" /></button>
                {:else}
                    <span class="n-text">{(indices?.[i] ?? i) + 1}</span>
                    <button class="n-btn" aria-label="Play" onclick={() => play(i, track)}><Icon name="play" /></button>
                {/if}
            </span>

            <span class="title-cell">
                <Cover thumbnails={track.thumbnails} title={track.title} size={42} radius="var(--r-xs)" />
                <span class="title-text">
                    <span class="title ellipsis" title={track.title}>{track.title}</span>
                    <span class="artist ellipsis">
                        {#if track.isDownloaded}<span class="dl" title="Downloaded"><Icon name="circle-arrow-down" /></span>{/if}
                        {artistNames(track)}{#if showAlbum && track.album?.title}<span class="alb">{" · "}{track.album.title}</span>{/if}
                    </span>
                </span>
            </span>

            <span class="fav-cell">
                <button
                    class="icon-btn sm fav"
                    class:is-fav={fav}
                    title={fav ? "Remove from Favourites" : "Add to Favourites"}
                    onclick={() => libraryState.toggleFavourite(track)}
                >
                    <Icon name="heart" />
                </button>
            </span>

            <span class="dur subtle">{track.duration ? formatTime(track.duration) : "–"}</span>

            <span class="more-cell">
                <button class="icon-btn sm more" title="More" onclick={(e) => ui.openMenuAt(e.currentTarget, trackMenu(track, { playlist }))}>
                    <Icon name="ellipsis" />
                </button>
            </span>
        </div>
    {/each}
</div>

<style>
    .tracklist {
        container-type: inline-size;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    /* Virtualized: a sized box with absolutely positioned rows. */
    .tracklist.virtual {
        position: relative;
        display: block;
    }
    .virtual .track {
        position: absolute;
        left: 0;
        right: 0;
        animation: none;
    }
    .row {
        display: grid;
        grid-template-columns: 46px minmax(0, 1fr) 36px 52px 36px;
        align-items: center;
        gap: 10px;
        padding: 0 10px 0 6px;
    }
    @container (max-width: 480px) {
        .row {
            grid-template-columns: 34px minmax(0, 1fr) 36px 36px;
        }
        .dur {
            display: none;
        }
    }
    .track {
        height: 64px;
        cursor: default;
        position: relative;
        border-radius: 20px;
        background: rgb(255 255 255 / 0.035);
        border: 1px solid rgb(255 255 255 / 0.04);
        transition: background 0.25s, border-color 0.25s, transform 0.35s var(--ease-out), box-shadow 0.35s;
        animation: row-in 0.5s var(--ease-out) both;
    }
    @keyframes row-in {
        from {
            opacity: 0;
            transform: translateX(-10px);
        }
    }
    .track:hover {
        background: rgb(255 255 255 / 0.08);
        border-color: rgb(255 255 255 / 0.08);
        transform: translateX(4px);
    }
    .track.current {
        background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 22%, transparent), color-mix(in srgb, var(--accent) 6%, transparent));
        border-color: color-mix(in srgb, var(--accent) 35%, transparent);
        box-shadow: 0 10px 30px -18px var(--accent-glow);
    }
    .track.dragging {
        opacity: 0.4;
    }
    .track.drop-above {
        box-shadow: 0 -3px 0 -1px var(--accent);
    }
    .track.drop-below {
        box-shadow: 0 3px 0 -1px var(--accent);
    }
    .track[draggable="true"] {
        cursor: grab;
    }

    .num {
        position: relative;
        display: grid;
        place-items: center;
        height: 100%;
        color: rgb(255 255 255 / 0.28);
        font-family: var(--font-display);
        font-weight: 800;
        font-size: 17px;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.03em;
    }
    .current .num {
        color: var(--accent);
    }
    .n-btn {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        color: var(--text);
        opacity: 0;
    }
    .n-btn :global(svg) {
        width: 17px;
        height: 17px;
        fill: currentColor;
    }
    .track:hover .n-btn {
        opacity: 1;
    }
    .track:hover .n-text,
    .track:hover .n-eq {
        opacity: 0;
    }

    .title-cell {
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
    }
    .title-cell :global(.cover) {
        border-radius: 12px !important;
    }
    .alb {
        color: var(--text-3);
    }
    .title-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }
    .title {
        font-weight: 550;
        font-size: 14.5px;
        color: var(--text);
    }
    .current .title {
        color: var(--accent);
    }
    .artist {
        display: block;
        font-size: 13px;
        color: var(--text-2);
    }
    .dl {
        display: inline-grid;
        vertical-align: -2px;
        margin-right: 4px;
        color: var(--success);
    }
    .dl :global(svg) {
        width: 13px;
        height: 13px;
    }
    .dur {
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-size: 13px;
    }
    .fav,
    .more {
        opacity: 0;
    }
    .fav.is-fav {
        opacity: 1;
        color: var(--accent);
    }
    .fav.is-fav :global(svg) {
        fill: currentColor;
    }
    .track:hover .fav,
    .track:hover .more {
        opacity: 1;
    }
</style>
