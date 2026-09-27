import { browser } from "$app/environment";
import { client } from "$lib/ephaptic";
import type { Playlist, Song } from "$lib/schema";
import { toasts } from "$lib/state/toast.svelte";

export const FAVOURITES_ID = "favourites.m3u8";

export function isPlayableTrack(song: Song): boolean {
    // For backwards compatibility I guess?
    // Once search results start including playlists this will have a purpose again.
    return true;
}

/**
 * The library is held as *raw* (non-deep) state and updated immutably: every
 * change swaps in a new playlist object. Deep `$state` would wrap each of the
 * thousands of tracks in reactive proxies, making every read in every row slow.
 * Lookups go through derived indexes, so membership checks are O(1).
 */
class LibraryStore {
    playlists = $state.raw<Playlist[]>([]);
    path = $state<string>("");
    loading = $state<boolean>(true);

    /** id → playlist */
    private byId = $derived(new Map(this.playlists.map((p) => [p.id, p])));
    /** playlist id → set of its track ids */
    private members = $derived(new Map(this.playlists.map((p) => [p.id, new Set(p.tracks.map((t) => t.id))])));
    /** track id → the library's copy of that track (first occurrence) */
    tracks = $derived.by(() => {
        const map = new Map<string, Song>();
        for (const p of this.playlists) for (const t of p.tracks) if (!map.has(t.id)) map.set(t.id, t);
        return map;
    });

    constructor() {
        if (!browser) return;
        this.init();
    }

    async init() {
        this.loading = true;
        try {
            const { playlists, path } = await client.musicLoadLibrary();
            this.playlists = playlists;
            this.path = path;
        } catch (err) {
            toasts.error(err);
        } finally {
            this.loading = false;
        }
        void this.repairMetadata();
    }

    /**
     * In the background, fix songs whose info came from a filename (old
     * downloads without tags): the backend fetches real titles, artists and
     * covers, and we swap the fixed songs in as they arrive.
     */
    private async repairMetadata() {
        let fixed = 0;
        try {
            for (let round = 0; round < 50; round++) {
                const { repaired, remaining } = await client.musicRepairMetadata(8);
                this.replaceTracks(repaired);
                fixed += repaired.length;
                if (!remaining) break;
            }
        } catch (err) {
            console.warn("[library] Metadata repair stopped:", err);
        }
        if (fixed) toasts.success(`Fixed song info and artwork for ${fixed} song${fixed === 1 ? "" : "s"}.`);
    }

    /** Swap updated copies of songs into every playlist that has them. */
    private replaceTracks(songs: Song[]) {
        if (!songs.length) return;
        const byId = new Map(songs.map((s) => [s.id, s]));
        this.playlists = this.playlists.map((p) =>
            p.tracks.some((t) => byId.has(t.id))
                ? { ...p, tracks: p.tracks.map((t) => (byId.has(t.id) ? { ...byId.get(t.id)!, isDownloaded: t.isDownloaded } : t)) }
                : p,
        );
    }

    /** Reload the whole library from disk. */
    async refresh() {
        await this.init();
    }

    get favourites(): Playlist | undefined {
        return this.byId.get(FAVOURITES_ID);
    }

    isFavourite(trackId: string): boolean {
        return this.isInPlaylist(FAVOURITES_ID, trackId);
    }

    toggleFavourite(track: Song) {
        return this.toggleFromPlaylist(FAVOURITES_ID, track);
    }

    getPlaylist(id: string): Playlist | undefined {
        return this.byId.get(id);
    }

    isInPlaylist(playlistId: string, trackId: string): boolean {
        return this.members.get(playlistId)?.has(trackId) ?? false;
    }

    /** Swap in an updated copy of one playlist. */
    private update(playlistId: string, fn: (p: Playlist) => Playlist) {
        this.playlists = this.playlists.map((p) => (p.id === playlistId ? fn(p) : p));
    }

    /** Ids currently being downloaded (for spinners). */
    downloading = $state<Record<string, boolean>>({});

    /** Save a track to disk without adding it to a playlist. */
    async download(track: Song, quiet = false): Promise<boolean> {
        if (track.isDownloaded || this.downloading[track.id]) return true;
        this.downloading[track.id] = true;
        try {
            await client.musicDownloadSong($state.snapshot(track) as Song);
            this.markDownloaded(track.id);
            if (!quiet) toasts.success(`Downloaded “${track.title}”.`);
            return true;
        } catch (err) {
            if (!quiet) toasts.error(err);
            return false;
        } finally {
            delete this.downloading[track.id];
        }
    }

    /** Download every not-yet-downloaded track of a playlist, one at a time. */
    async downloadPlaylist(playlist: Playlist) {
        const pending = playlist.tracks.filter((t) => !t.isDownloaded);
        if (!pending.length) {
            toasts.info("Everything in this playlist is already downloaded.");
            return;
        }
        const toast = toasts.info(`Downloading ${pending.length} songs…`, 0);
        let ok = 0;
        for (const track of pending) if (await this.download(track, true)) ok++;
        toasts.dismiss(toast);
        if (ok === pending.length) toasts.success(`Downloaded ${ok} songs from “${playlist.name}”.`);
        else toasts.error(`Downloaded ${ok} of ${pending.length} songs; some failed.`);
    }

    async addToPlaylist(playlistId: string, track: Song) {
        if (!this.byId.has(playlistId)) {
            console.warn(`Playlist with ID ${playlistId} not found.`);
            return;
        }
        if (this.isInPlaylist(playlistId, track.id)) return;

        const plain = $state.snapshot(track) as Song;
        // Optimistic insert.
        this.update(playlistId, (p) => ({ ...p, tracks: [...p.tracks, plain] }));
        try {
            const saved = await client.musicPlaylistAddTrack(playlistId, plain);
            // Replace with the server's canonical (downloaded) version.
            this.update(playlistId, (p) => ({
                ...p,
                tracks: p.tracks.map((t) => (t.id === track.id ? saved : t)),
                thumbnail: p.thumbnail || saved.thumbnails.find((t) => t.url)?.url,
            }));
            if (saved.isDownloaded) this.markDownloaded(saved.id);
        } catch (err) {
            this.update(playlistId, (p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== track.id) }));
            toasts.error(err);
        }
    }

    async removeFromPlaylist(playlistId: string, trackId: string) {
        const playlist = this.byId.get(playlistId);
        if (!playlist) {
            console.warn(`Playlist with ID ${playlistId} not found.`);
            return;
        }

        const previous = playlist.tracks;
        this.update(playlistId, (p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== trackId) }));
        try {
            await client.musicPlaylistRemoveTrack(playlistId, trackId);
        } catch (err) {
            this.update(playlistId, (p) => ({ ...p, tracks: previous }));
            toasts.error(err);
        }
    }

    async toggleFromPlaylist(playlistId: string, track: Song) {
        if (this.isInPlaylist(playlistId, track.id)) {
            await this.removeFromPlaylist(playlistId, track.id);
        } else {
            await this.addToPlaylist(playlistId, track);
        }
    }

    async createPlaylist(name: string): Promise<Playlist | null> {
        try {
            const playlist = await client.musicPlaylistCreate(name);
            this.playlists = [...this.playlists, playlist];
            toasts.success(`Created playlist "${playlist.name}".`);
            return playlist;
        } catch (err) {
            toasts.error(err);
            return null;
        }
    }

    async renamePlaylist(playlistId: string, name: string) {
        try {
            const updated = await client.musicPlaylistRename(playlistId, name);
            if (updated) this.update(playlistId, () => updated);
        } catch (err) {
            toasts.error(err);
        }
    }

    async deletePlaylist(playlistId: string) {
        try {
            await client.musicPlaylistDelete(playlistId);
            this.playlists = this.playlists.filter((p) => p.id !== playlistId);
            toasts.success("Playlist deleted.");
        } catch (err) {
            toasts.error(err);
        }
    }

    async reorderPlaylist(playlistId: string, orderedTrackIds: string[]) {
        const playlist = this.byId.get(playlistId);
        if (!playlist) return;

        const previous = playlist.tracks;
        const byId = new Map(previous.map((t) => [t.id, t]));
        const reordered = orderedTrackIds.map((id) => byId.get(id)).filter((t): t is Song => !!t);
        this.update(playlistId, (p) => ({ ...p, tracks: reordered }));
        try {
            await client.musicPlaylistReorder(playlistId, orderedTrackIds);
        } catch (err) {
            this.update(playlistId, (p) => ({ ...p, tracks: previous }));
            toasts.error(err);
        }
    }

    async saveThumbnail(playlistId: string, thumbnailDataURI: string): Promise<Playlist | null> {
        try {
            const updated = await client.musicPlaylistUpdateThumbnail(playlistId, thumbnailDataURI);
            if (updated) this.update(playlistId, () => updated);
            return updated;
        } catch (err) {
            toasts.error(err);
            return null;
        }
    }

    /** Mark a track as downloaded across all playlists (called after it's saved to disk). */
    markDownloaded(trackId: string) {
        let changed = false;
        const next = this.playlists.map((p) => {
            if (!p.tracks.some((t) => t.id === trackId && !t.isDownloaded)) return p;
            changed = true;
            return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, isDownloaded: true } : t)) };
        });
        if (changed) this.playlists = next;
    }
}

export const libraryState = new LibraryStore();
