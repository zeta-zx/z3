<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { statsState } from "$lib/state/stats.svelte";
    import { formatTime, createPlaceholderUrl, formatDate } from "$lib/utils";

    // Load whenever the page mounts so freshly-recorded plays show up.
    $effect(() => {
        statsState.load();
    });

    const dur = (ms: number) => formatTime((ms || 0) / 1000);
    const cover = (url: string | undefined, title: string) =>
        url || createPlaceholderUrl({ height: 64, text: title });

    let s = $derived(statsState.summary);
</script>

<h2><Icon name="chart-no-axes-column" /> Listening stats</h2>

{#if statsState.loading && !s}
    <p aria-busy="true">Crunching your listening history…</p>
{:else if s}
    <div class="totals">
        <div class="stat-card">
            <strong>{dur(s.totals.totalPlayTimeMs)}</strong>
            <small>Total listening time</small>
        </div>
        <div class="stat-card">
            <strong>{s.totals.totalPlays}</strong>
            <small>Plays</small>
        </div>
        <div class="stat-card">
            <strong>{s.totals.uniqueSongs}</strong>
            <small>Unique songs</small>
        </div>
    </div>

    {#if s.totals.totalPlays === 0}
        <p><small>No plays yet. Listen to some music (or import a Muzza backup) and it'll show up here.</small></p>
    {/if}

    <div class="stats-grid">
        <section>
            <h4><Icon name="music" /> Most played songs</h4>
            {#if s.topSongs.length === 0}
                <p><small>Nothing yet.</small></p>
            {:else}
                <ol class="rank-list">
                    {#each s.topSongs as song (song.id)}
                        <li>
                            <img src={cover(song.thumbnailUrl, song.title)} alt="" referrerPolicy="no-referrer" />
                            <div class="rank-info">
                                <strong title={song.title}>{song.title}</strong>
                                <small>{song.artists.join(", ")}</small>
                            </div>
                            <div class="rank-meta">
                                <span>{dur(song.playTimeMs)}</span>
                                <small>{song.plays} play{song.plays === 1 ? "" : "s"}</small>
                            </div>
                        </li>
                    {/each}
                </ol>
            {/if}
        </section>

        <section>
            <h4><Icon name="user" /> Top artists</h4>
            {#if s.topArtists.length === 0}
                <p><small>Nothing yet.</small></p>
            {:else}
                <ol class="rank-list">
                    {#each s.topArtists as artist (artist.name)}
                        <li>
                            <div class="rank-info">
                                <strong title={artist.name}>{artist.name}</strong>
                            </div>
                            <div class="rank-meta">
                                <span>{dur(artist.playTimeMs)}</span>
                                <small>{artist.plays} play{artist.plays === 1 ? "" : "s"}</small>
                            </div>
                        </li>
                    {/each}
                </ol>
            {/if}
        </section>

        <section class="history-section">
            <h4><Icon name="history" /> Recent history</h4>
            {#if s.history.length === 0}
                <p><small>Nothing yet.</small></p>
            {:else}
                <ul class="rank-list">
                    {#each s.history as ev, i (ev.timestamp + ev.id + i)}
                        <li>
                            <img src={cover(ev.thumbnailUrl, ev.title)} alt="" referrerPolicy="no-referrer" />
                            <div class="rank-info">
                                <strong title={ev.title}>{ev.title}</strong>
                                <small>{ev.artists.join(", ")}</small>
                            </div>
                            <div class="rank-meta">
                                <small>{formatDate(ev.timestamp)}</small>
                                <small>{dur(ev.playTimeMs)}</small>
                            </div>
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    </div>
{/if}

<style>
    .totals {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin-bottom: 1.5rem;
    }
    .stat-card {
        flex: 1;
        min-width: 8rem;
        background: var(--pico-card-background-color, #1c1c1e);
        border: 1px solid var(--pico-muted-border-color, #333);
        border-radius: var(--pico-border-radius, 0.5rem);
        padding: 0.9rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }
    .stat-card strong {
        font-size: 1.4rem;
    }
    .stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1.5rem;
    }
    .history-section {
        grid-column: 1 / -1;
    }
    .rank-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }
    .rank-list li {
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }
    .rank-list img {
        width: 40px;
        height: 40px;
        border-radius: 4px;
        object-fit: cover;
        flex-shrink: 0;
    }
    .rank-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
    }
    .rank-info strong,
    .rank-info small {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .rank-meta {
        text-align: right;
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
    }
    @media (max-width: 800px) {
        .stats-grid {
            grid-template-columns: 1fr;
        }
    }
</style>
