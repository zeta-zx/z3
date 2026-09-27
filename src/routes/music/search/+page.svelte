<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import TrackList from "$lib/components/TrackList.svelte";
    import { searchState } from "$lib/state/search.svelte";
    import { playerState, playTrack, playPlaylist, togglePlay, addToQueue } from "$lib/state/player.svelte";
    import { ui } from "$lib/state/ui.svelte";
    import { trackMenu, radioFrom } from "$lib/actions";
    import { artistNames } from "$lib/utils";
    import { toasts } from "$lib/state/toast.svelte";
    import { tilt } from "$lib/tilt";
    import type { Playlist } from "$lib/schema";

    const moods = [
        { label: "Chill", q: "chill vibes", hue: 190, icon: "waves" },
        { label: "Workout", q: "workout hits", hue: 10, icon: "flame" },
        { label: "Focus", q: "lofi focus", hue: 260, icon: "brain" },
        { label: "Party", q: "party anthems", hue: 320, icon: "party-popper" },
        { label: "Throwbacks", q: "2000s hits", hue: 40, icon: "rewind" },
        { label: "Indie", q: "indie pop", hue: 150, icon: "leaf" },
        { label: "Hip-hop", q: "hip hop hits", hue: 30, icon: "mic-vocal" },
        { label: "Bollywood", q: "bollywood hits", hue: 350, icon: "sparkles" },
        { label: "Sleep", q: "sleep ambient", hue: 230, icon: "moon" },
        { label: "Rock", q: "classic rock", hue: 0, icon: "guitar" },
    ];

    function search(q: string) {
        searchState.query = q;
        searchState.run();
    }

    const results = $derived(searchState.results);
    const top = $derived(results[0]);
    const topPlaying = $derived(!!top && playerState.currentTrack?.id === top.id);

    // "Play all" plays through the results as a context.
    const resultsContext = $derived<Playlist>({
        id: `search:${searchState.lastQuery}`,
        name: `Search · “${searchState.lastQuery}”`,
        tracks: results,
        createdAt: 0,
        isProtected: true,
    });
</script>

<div class="page">
    {#if searchState.error}
        <div class="error island">
            <Icon name="circle-alert" />
            <span>{searchState.error}</span>
            <button class="btn btn-ghost" onclick={() => searchState.run()}>Retry</button>
        </div>
    {/if}

    {#if searchState.loading && !results.length}
        <div class="results-grid">
            <div class="skeleton" style="height:340px;border-radius:28px"></div>
            <div class="rows">{#each Array(6) as _}<div class="skeleton" style="height:64px;border-radius:20px"></div>{/each}</div>
        </div>
    {:else if results.length && top}
        <header class="results-head">
            <span class="kicker"><Icon name="search" /> Results</span>
            <h1 class="page-title">“{searchState.lastQuery}”</h1>
        </header>

        <div class="results-grid" class:stale={searchState.loading}>
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
                class="top island"
                role="button"
                tabindex="0"
                onclick={() => (topPlaying ? togglePlay() : playTrack(top))}
                oncontextmenu={(e) => ui.openMenu(e, trackMenu(top))}
            >
                <div class="top-art" use:tilt={{ max: 12 }}>
                    <Cover thumbnails={top.thumbnails} title={top.title} size="100%" radius="22px" />
                    <span class="top-shine"></span>
                </div>
                <span class="kicker">Top result</span>
                <h2 class="top-title" title={top.title}>{top.title}</h2>
                <p class="muted ellipsis">{artistNames(top)}{#if top.album}{" · "}{top.album.title}{/if}</p>
                <div class="top-actions">
                    <button
                        class="play-btn"
                        aria-label="Play"
                        onclick={(e) => {
                            e.stopPropagation();
                            if (topPlaying) togglePlay();
                            else playTrack(top);
                        }}
                    >
                        <Icon name={topPlaying && !playerState.paused ? "pause" : "play"} />
                    </button>
                    <button class="btn" onclick={(e) => { e.stopPropagation(); radioFrom(top); }}><Icon name="radio" /> Radio</button>
                </div>
            </div>

            <div class="list">
                <div class="list-actions">
                    <button class="chip" onclick={() => playPlaylist(resultsContext, 0)}><Icon name="play" /> Play all</button>
                    <button
                        class="chip"
                        onclick={() => {
                            results.forEach((t) => addToQueue(t));
                            toasts.success(`Queued ${results.length} songs`);
                        }}
                    >
                        <Icon name="list-end" /> Queue all
                    </button>
                </div>
                <TrackList tracks={results} showAlbum={false} onplay={(i) => playTrack(results[i])} />
            </div>
        </div>
    {:else}
        <header class="results-head">
            <span class="kicker"><Icon name="compass" /> Discover</span>
            <h1 class="page-title">Find your sound</h1>
            <p class="muted">Type in the bar above, or dive into a mood.</p>
        </header>

        {#if searchState.recent.length}
            <section class="section">
                <div class="section-head"><h2 class="section-title">Recent</h2></div>
                <div class="recent">
                    {#each searchState.recent as r}
                        <span class="recent-chip">
                            <button class="chip" onclick={() => search(r)}><Icon name="history" />{r}</button>
                            <button class="icon-btn sm x" aria-label="Remove" onclick={() => searchState.forget(r)}><Icon name="x" /></button>
                        </span>
                    {/each}
                </div>
            </section>
        {/if}

        <section class="section">
            <div class="moods">
                {#each moods as m, i}
                    <button class="mood" style:--h={m.hue} style:animation-delay="{i * 40}ms" onclick={() => search(m.q)}>
                        <span class="blob"></span>
                        <Icon name={m.icon} />
                        <span class="mood-label">{m.label}</span>
                    </button>
                {/each}
            </div>
        </section>
    {/if}
</div>

<style>
    .results-head {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 18px 4px 26px;
    }
    .results-head .page-title {
        overflow-wrap: anywhere;
    }
    .error {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 10px 10px 18px;
        margin: 12px 0;
        color: var(--danger);
    }
    .error span {
        flex: 1;
        color: var(--text);
    }
    .results-grid {
        display: grid;
        grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
        gap: 22px;
        align-items: start;
        transition: opacity 0.3s;
    }
    .results-grid.stale {
        opacity: 0.5;
    }
    .rows {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .top {
        position: sticky;
        top: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 18px 18px 20px;
        cursor: pointer;
        min-width: 0;
        animation: rise 0.6s var(--ease-out) both;
    }
    @keyframes rise {
        from {
            opacity: 0;
            transform: translateY(14px);
        }
    }
    .top-art {
        --rx: 0deg;
        --ry: 0deg;
        --mx: 50%;
        --my: 0%;
        position: relative;
        aspect-ratio: 1;
        border-radius: 22px;
        margin-bottom: 10px;
        transform: perspective(900px) rotateX(var(--rx)) rotateY(var(--ry));
        transition: transform 0.2s linear;
        box-shadow: 0 30px 60px -30px rgb(0 0 0 / 0.95), 0 0 50px -24px var(--accent-glow);
    }
    .top-shine {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: radial-gradient(55% 55% at var(--mx) var(--my), rgb(255 255 255 / 0.28), transparent 70%);
        mix-blend-mode: overlay;
    }
    .top-title {
        font-size: 28px;
        font-weight: 850;
        letter-spacing: -0.04em;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }
    .top-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 10px;
    }
    .top-actions .btn {
        height: 42px;
        background: rgb(255 255 255 / 0.1);
    }
    .list {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 0;
    }
    .list-actions {
        display: flex;
        gap: 8px;
    }

    .recent {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }
    .recent-chip {
        position: relative;
        display: inline-flex;
    }
    .recent-chip .chip {
        padding-right: 32px;
    }
    .recent-chip .x {
        position: absolute;
        right: 2px;
        top: 1px;
        width: 30px;
        height: 30px;
        opacity: 0;
    }
    .recent-chip:hover .x {
        opacity: 1;
    }

    /* moods: glassy orbs with a drifting colour blob inside */
    .moods {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 16px;
    }
    .mood {
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        align-items: flex-start;
        height: 132px;
        padding: 18px 20px;
        border-radius: 28px;
        overflow: hidden;
        text-align: left;
        background: rgb(16 13 24 / 0.6);
        border: 1px solid rgb(255 255 255 / 0.09);
        transition: transform 0.4s var(--ease-spring), border-color 0.3s;
        animation: rise 0.55s var(--ease-out) both;
    }
    .blob {
        position: absolute;
        width: 150%;
        aspect-ratio: 1;
        right: -70%;
        bottom: -100%;
        border-radius: 42% 58% 60% 40%;
        background: radial-gradient(circle at 40% 40%, hsl(var(--h) 90% 62%), hsl(calc(var(--h) + 50) 80% 35%) 60%, transparent 72%);
        opacity: 0.75;
        animation: morph 9s ease-in-out infinite alternate;
        transition: transform 0.7s var(--ease-out);
    }
    /* rotation only: it's composited, whereas animating border-radius repaints */
    @keyframes morph {
        to {
            rotate: 40deg;
        }
    }
    .mood:hover {
        transform: translateY(-4px) scale(1.02);
        border-color: hsl(var(--h) 80% 60% / 0.5);
    }
    .mood:hover .blob {
        transform: translate(-12%, -14%) scale(1.1);
    }
    .mood > :global(svg) {
        position: relative;
        width: 26px;
        height: 26px;
        color: hsl(var(--h) 90% 78%);
    }
    .mood-label {
        position: relative;
        font-family: var(--font-display);
        font-size: 22px;
        font-weight: 800;
        letter-spacing: -0.03em;
    }

    @media (max-width: 900px) {
        .results-grid {
            grid-template-columns: 1fr;
        }
        .top {
            position: static;
        }
        .top-art {
            max-width: 220px;
        }
    }
</style>
