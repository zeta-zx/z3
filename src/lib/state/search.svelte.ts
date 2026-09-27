import { browser } from "$app/environment";
import { client } from "$lib/ephaptic";
import type { MusicProvider, Song } from "$lib/schema";

const RECENT_KEY = "zeta:recent-searches";

/** Search state lives outside the page so results survive navigation. */
class SearchStore {
    query = $state("");
    lastQuery = $state("");
    provider = $state<MusicProvider>("yt");
    results = $state<Song[]>([]);
    loading = $state(false);
    error = $state("");
    recent = $state<string[]>(browser ? JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") : []);

    private seq = 0;

    async run(query = this.query) {
        const q = query.trim();
        if (!q) return;
        this.query = q;
        this.error = "";
        this.loading = true;
        const seq = ++this.seq;
        try {
            const results = await client.musicSearch(q, $state.snapshot(this.provider));
            if (seq !== this.seq) return; // a newer search superseded this one
            this.results = results;
            this.lastQuery = q;
            this.remember(q);
        } catch (err: any) {
            if (seq === this.seq) this.error = err?.message ?? String(err);
        } finally {
            if (seq === this.seq) this.loading = false;
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
