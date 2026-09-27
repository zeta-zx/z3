<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import EqBars from "$lib/components/EqBars.svelte";
    import LyricsView from "$lib/components/LyricsView.svelte";
    import {
        playerState,
        getUpcomingContext,
        removeFromQueue,
        moveInQueue,
        clearQueue,
        playFromQueue,
        playFromContext,
        setAutoplay,
        isRadioContext,
        startRadio,
    } from "$lib/state/player.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { trackMenu } from "$lib/actions";
    import { artistNames, formatTime } from "$lib/utils";
    import { flip } from "svelte/animate";
    import { fly } from "svelte/transition";
    import type { Song } from "$lib/schema";

    const upcoming = $derived(getUpcomingContext(60));
    const track = $derived(playerState.currentTrack);

    let dragFrom = $state<number | null>(null);
    let dragOver = $state<number | null>(null);
</script>

{#snippet row(song: Song, onplay: () => void, extra?: { remove?: () => void; index?: number })}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
        class="q-row"
        role="listitem"
        class:drop={extra?.index !== undefined && dragOver === extra.index}
        draggable={extra?.index !== undefined}
        ondragstart={() => (dragFrom = extra?.index ?? null)}
        ondragover={(e) => {
            if (dragFrom === null || extra?.index === undefined) return;
            e.preventDefault();
            dragOver = extra.index;
        }}
        ondragend={() => (dragFrom = dragOver = null)}
        ondrop={() => {
            if (dragFrom !== null && dragOver !== null && dragFrom !== dragOver) moveInQueue(dragFrom, dragOver);
            dragFrom = dragOver = null;
        }}
        onclick={(e) => !(e.target as HTMLElement).closest("button") && onplay()}
        oncontextmenu={(e) => ui.openMenu(e, trackMenu(song))}
    >
        <Cover thumbnails={song.thumbnails} title={song.title} size={42} radius="var(--r-xs)" />
        <span class="q-text">
            <span class="q-title ellipsis">{song.title}</span>
            <span class="q-artist ellipsis">{artistNames(song)}</span>
        </span>
        {#if extra?.remove}
            <button class="icon-btn sm q-x" title="Remove from queue" onclick={extra.remove}><Icon name="x" /></button>
        {:else}
            <span class="q-dur">{song.duration ? formatTime(song.duration) : ""}</span>
        {/if}
    </div>
{/snippet}

<aside class="panel" transition:fly={{ x: 60, duration: 420, opacity: 0 }}>
    <header>
        <div class="segmented">
            <button aria-pressed={ui.sidePanel === "queue"} onclick={() => (ui.sidePanel = "queue")}>
                <Icon name="list-music" /> Queue
            </button>
            <button aria-pressed={ui.sidePanel === "lyrics"} onclick={() => (ui.sidePanel = "lyrics")}>
                <Icon name="mic-vocal" /> Lyrics
            </button>
        </div>
        <button class="icon-btn sm" title="Close" onclick={() => { ui.sidePanel = null; ui.save(); }}>
            <Icon name="x" />
        </button>
    </header>

    {#if ui.sidePanel === "lyrics"}
        <div class="lyrics-wrap">
            {#if track}
                <LyricsView compact />
            {:else}
                <div class="empty"><Icon name="mic-vocal" /><p>Play something to see its lyrics.</p></div>
            {/if}
        </div>
    {:else}
        <div class="scroll">
            {#if track}
                <section>
                    <h4>Now playing</h4>
                    <div class="q-row now">
                        <Cover thumbnails={track.thumbnails} title={track.title} size={48} radius="var(--r-xs)" />
                        <span class="q-text">
                            <span class="q-title ellipsis">{track.title}</span>
                            <span class="q-artist ellipsis">{artistNames(track)}</span>
                        </span>
                        <EqBars paused={playerState.paused} />
                    </div>
                </section>
            {/if}

            {#if playerState.upNext.length}
                <section>
                    <div class="sec-head">
                        <h4>Next in queue</h4>
                        <button class="link" onclick={clearQueue}>Clear</button>
                    </div>
                    <div role="list">
                        {#each playerState.upNext as song, i (song.id + ":" + i)}
                            <div animate:flip={{ duration: 250 }}>
                                {@render row(song, () => playFromQueue(i), { remove: () => removeFromQueue(i), index: i })}
                            </div>
                        {/each}
                    </div>
                </section>
            {/if}

            {#if upcoming.length}
                <section>
                    <h4>
                        Next from
                        <span class="ctx">
                            {#if isRadioContext()}<Icon name="radio" />{/if}
                            {playerState.currentPlaylist?.name}
                        </span>
                    </h4>
                    <div role="list">
                        {#each upcoming as song (song.id)}
                            <div animate:flip={{ duration: 250 }}>{@render row(song, () => playFromContext(song.id))}</div>
                        {/each}
                    </div>
                </section>
            {/if}

            <section class="autoplay">
                <div class="sec-head">
                    <h4><Icon name="infinity" /> Autoplay</h4>
                    <button
                        class="switch"
                        role="switch"
                        aria-checked={playerState.autoplay}
                        aria-label="Autoplay"
                        onclick={() => setAutoplay(!playerState.autoplay)}
                    ></button>
                </div>
                {#if playerState.autoplay}
                    {#if playerState.repeat === "all" && playerState.currentPlaylist && !isRadioContext()}
                        <p class="hint">Repeat is on, so “{playerState.currentPlaylist.name}” will loop. Turn repeat off to let Autoplay take over at the end.</p>
                    {:else if playerState.autoplayTracks.length}
                        <p class="hint">Similar to “{playerState.autoplaySeed?.title}”, when your queue ends.</p>
                        <div role="list">
                            {#each playerState.autoplayTracks.slice(0, 10) as song (song.id)}
                                {@render row(song, () => startRadio(song))}
                            {/each}
                        </div>
                    {:else}
                        <p class="hint">When your queue runs out, Zeta keeps playing songs like the ones you're listening to.</p>
                    {/if}
                {:else}
                    <p class="hint">Playback stops when the queue ends.</p>
                {/if}
            </section>

            {#if !track}
                <div class="empty"><Icon name="list-music" /><h3>Your queue is empty</h3><p>Right-click any song → Add to queue.</p></div>
            {/if}
        </div>
    {/if}
</aside>

<style>
    .panel {
        position: fixed;
        z-index: 40;
        top: 84px;
        right: 16px;
        bottom: 104px;
        display: flex;
        flex-direction: column;
        width: min(var(--panel-w), calc(100vw - 32px));
        border-radius: 28px;
        background: rgb(16 13 24 / 0.62);
        backdrop-filter: blur(30px) saturate(1.8);
        -webkit-backdrop-filter: blur(30px) saturate(1.8);
        border: 1px solid rgb(255 255 255 / 0.1);
        box-shadow: 0 30px 70px -20px rgb(0 0 0 / 0.75), inset 0 1px 0 rgb(255 255 255 / 0.07);
        overflow: hidden;
    }
    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 12px 10px 14px;
    }
    .scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 0 8px 24px;
    }
    .lyrics-wrap {
        flex: 1;
        min-height: 0;
        padding: 0 18px;
    }
    section {
        margin-top: 14px;
    }
    h4 {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 8px 6px;
        font-size: 14px;
        font-weight: 700;
        min-width: 0;
    }
    h4 :global(svg) {
        width: 15px;
        height: 15px;
    }
    .ctx {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--text-2);
        font-weight: 600;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .sec-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-right: 8px;
    }
    .sec-head h4 {
        padding-bottom: 6px;
    }
    .link {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--text-2);
    }
    .link:hover {
        color: var(--text);
        text-decoration: underline;
    }
    .q-row {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 6px 8px;
        border-radius: var(--r-sm);
        transition: background 0.18s;
    }
    .q-row:hover {
        background: var(--surface-2);
    }
    .q-row.drop {
        box-shadow: inset 0 2px 0 var(--accent);
    }
    .q-row[draggable="true"] {
        cursor: grab;
    }
    .q-row.now {
        background: color-mix(in srgb, var(--accent) 10%, transparent);
    }
    .now .q-title {
        color: var(--accent);
    }
    .q-text {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
    }
    .q-title {
        font-weight: 550;
        font-size: 13.5px;
    }
    .q-artist {
        font-size: 12.5px;
        color: var(--text-2);
    }
    .q-dur {
        font-size: 12px;
        color: var(--text-3);
        font-variant-numeric: tabular-nums;
    }
    .q-x {
        opacity: 0;
    }
    .q-row:hover .q-x {
        opacity: 1;
    }
    .hint {
        padding: 0 8px 8px;
        font-size: 12.5px;
        color: var(--text-3);
    }
    .autoplay {
        margin-top: 22px;
        padding-top: 14px;
        border-top: 1px solid var(--border);
    }
    .empty {
        padding: 40px 12px;
    }
</style>
