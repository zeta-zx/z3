import { browser } from "$app/environment";
import { client } from "$lib/ephaptic";
import type { Playlist, Song } from "$lib/schema";
import { toasts } from "$lib/state/toast.svelte";

export function isPlayableTrack(song: Song): boolean {
    // For backwards compatibility I guess?
    // Once search results start including playlists this will have a purpose again.
    return true;
}

class LibraryStore {
    playlists = $state<Playlist[]>([]);
    path = $state<string>("");
    loading = $state<boolean>(true);

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
    }

    /** Reload the whole library from disk. */
    async refresh() {
        await this.init();
    }

    isInPlaylist(playlistId: string, trackId: string): boolean {
        const playlist = this.playlists.find(p => p.id === playlistId);
        return playlist?.tracks.some(t => t.id === trackId) ?? false;
    }

    async addToPlaylist(playlistId: string, track: Song) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) {
            console.warn(`Playlist with ID ${playlistId} not found.`);
            return;
        }

        if (playlist.tracks.find(t => t.id === track.id)) return;

        // Optimistic insert.
        playlist.tracks.push(track);
        try {
            const saved = await client.musicPlaylistAddTrack(playlistId, $state.snapshot(track));
            // Replace with the server's canonical (downloaded) version.
            const idx = playlist.tracks.findIndex(t => t.id === track.id);
            if (idx !== -1) playlist.tracks[idx] = saved;
            if (!playlist.thumbnail) playlist.thumbnail = saved.thumbnails.find(t => t.url)?.url;
        } catch (err) {
            playlist.tracks = playlist.tracks.filter(t => t.id !== track.id);
            toasts.error(err);
        }
    }

    async removeFromPlaylist(playlistId: string, trackId: string) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) {
            console.warn(`Playlist with ID ${playlistId} not found.`);
            return;
        }

        const previous = playlist.tracks;
        playlist.tracks = playlist.tracks.filter(t => t.id !== trackId);
        try {
            await client.musicPlaylistRemoveTrack(playlistId, trackId);
        } catch (err) {
            playlist.tracks = previous;
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
            this.playlists.push(playlist);
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
            if (updated) this.replacePlaylist(updated);
        } catch (err) {
            toasts.error(err);
        }
    }

    async deletePlaylist(playlistId: string) {
        try {
            await client.musicPlaylistDelete(playlistId);
            this.playlists = this.playlists.filter(p => p.id !== playlistId);
            toasts.success("Playlist deleted.");
        } catch (err) {
            toasts.error(err);
        }
    }

    async reorderPlaylist(playlistId: string, orderedTrackIds: string[]) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) return;

        const previous = playlist.tracks;
        const byId = new Map(previous.map(t => [t.id, t]));
        playlist.tracks = orderedTrackIds.map(id => byId.get(id)).filter((t): t is Song => !!t);
        try {
            await client.musicPlaylistReorder(playlistId, orderedTrackIds);
        } catch (err) {
            playlist.tracks = previous;
            toasts.error(err);
        }
    }

    async saveThumbnail(playlistId: string, thumbnailDataURI: string): Promise<Playlist | null> {
        try {
            const updated = await client.musicPlaylistUpdateThumbnail(playlistId, thumbnailDataURI);
            if (updated) this.replacePlaylist(updated);
            return updated;
        } catch (err) {
            toasts.error(err);
            return null;
        }
    }

    private replacePlaylist(updated: Playlist) {
        const idx = this.playlists.findIndex(p => p.id === updated.id);
        if (idx !== -1) this.playlists[idx] = updated;
    }

    /** Mark a track as downloaded across all playlists (called after it's saved to disk). */
    markDownloaded(trackId: string) {
        for (const playlist of this.playlists) {
            for (const track of playlist.tracks) {
                if (track.id === trackId && !track.isDownloaded) track.isDownloaded = true;
            }
        }
    }
}

export const libraryState = new LibraryStore();
