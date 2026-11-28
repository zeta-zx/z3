import { browser } from "$app/environment";
import { client } from "$lib/ephaptic";
import type { Artist, CollectionSummary, MusicProvider, Song } from "$lib/schema";
import { libraryState } from "$lib/state/library.svelte";
import { searchSavedSongs } from "$lib/saved-song-search";

const RECENT_KEY = "zeta:recent-searches";

/** Search state lives outside the page so results survive navigation. */
class SearchStore {
    query = $state("");
    lastQuery = $state("");
    provider = $state<MusicProvider>("yt");
    results = $state<Song[]>([]);
    artists = $state<Artist[]>([]);
    albums = $state<CollectionSummary[]>([]);
    playlists = $state<CollectionSummary[]>([]);
    videos = $state<Song[]>([]);
    videosLoading = $state(false);
    videosError = $state("");
    loading = $state(false);
    error = $state("");
    /** The results are songs saved on this device, because search couldn't reach the network. */
    offline = $state(false);
    recent = $state<string[]>(browser ? JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") : []);

    private seq = 0;

    clear() {
        this.seq++;
        this.query = "";
        this.lastQuery = "";
        this.results = [];
        this.artists = [];
        this.albums = [];
        this.playlists = [];
        this.videos = [];
        this.videosLoading = false;
        this.videosError = "";
        this.loading = false;
        this.error = "";
        this.offline = false;
    }

    async run(query = this.query) {
        const q = query.trim();
        if (!q) return;
        this.query = q;
        this.error = "";
        this.offline = false;
        this.videos = [];
        this.videosError = "";
        this.videosLoading = false;
        this.loading = true;
        const seq = ++this.seq;
        const provider = $state.snapshot(this.provider);
        if (browser && !navigator.onLine) {
            this.loading = false;
            this.showSaved(q);
            return;
        }
        try {
            const [results, extras] = await Promise.all([
                client.musicSearch(q, provider),
                client.musicSearchExtras(q, provider).catch(() => ({ artists: [], albums: [], playlists: [] })),
            ]);
            if (seq !== this.seq) return; // a newer search superseded this one
            let playlists = extras.playlists;
            let albums = extras.albums;
            if (provider === "yt" && (playlists.length < 8 || albums.length < 6)) {
                const playlistFallbacks = playlists.length < 8
                    ? Promise.allSettled([
                        client.musicSearchPlaylists(`Top 100 ${q}`, provider),
                        client.musicSearchPlaylists(`Best ${q} songs playlist`, provider),
                    ])
                    : Promise.resolve([]);
                const albumFallback = albums.length < 6
                    ? client.musicSearchAlbums(`${q} albums`, provider).catch(() => [])
                    : Promise.resolve([]);
                const [fallbacks, albumMatches] = await Promise.all([playlistFallbacks, albumFallback]);
                playlists = [
                    ...playlists,
                    ...fallbacks.flatMap((result) => result.status === "fulfilled" ? result.value : []),
                ];
                albums = [...albums, ...albumMatches];
                if (seq !== this.seq) return;
            }
            this.offline = false;
            this.results = results;
            this.artists = extras.artists;
            this.albums = [...new Map(albums.map((album) => [album.id, album])).values()].slice(0, 12);
            this.playlists = [...new Map(playlists.map((playlist) => [playlist.id, playlist])).values()].slice(0, 12);
            this.lastQuery = q;
            this.remember(q);
            if (provider === "yt") void this.loadVideos(q, seq);
        } catch (err: any) {
            if (seq !== this.seq) return;
            this.error = err?.message ?? String(err);
            // Lost the connection mid-search, or the network is unreachable:
            // fall back to whatever is saved on this device.
            const saved = searchSavedSongs(q, libraryState.tracks.values());
            if (!navigator.onLine || saved.length) this.showSaved(q, saved);
        } finally {
            if (seq === this.seq) this.loading = false;
        }
    }

    /** Show songs saved on this device that match the query. */
    private showSaved(q: string, saved = searchSavedSongs(q, libraryState.tracks.values())) {
        this.offline = true;
        this.results = saved;
        this.artists = [];
        this.albums = [];
        this.playlists = [];
        this.videos = [];
        this.lastQuery = q;
        this.remember(q);
    }

    private async loadVideos(query: string, seq: number) {
        this.videosLoading = true;
        try {
            const videos = await client.musicSearchVideos(query);
            if (seq !== this.seq) return;
            this.videos = videos;
        } catch (err) {
            if (seq === this.seq) this.videosError = err instanceof Error ? err.message : String(err);
        } finally {
            if (seq === this.seq) this.videosLoading = false;
        }
    }

    remember(q: string) {
        this.recent = [q, ...this.recent.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, 10);
        localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    }

    forget(q: string) {
        this.recent = this.recent.filter((r) => r !== q);
        localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    }
}

export const searchState = new SearchStore();
