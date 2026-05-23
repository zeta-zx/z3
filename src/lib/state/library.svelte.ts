import { browser } from "$app/environment";
import { client } from "$lib/ephaptic";
import type { Playlist, Song } from "$lib/schema";

export function isPlayableTrack(song: Song): boolean {
    // For backwards compatibility I guess?
    // Once search results start including playlists this will have a purpose again.
    return true;
}

class LibraryStore {
    playlists = $state<Playlist[]>([]);

    constructor() {
        if (!browser) return;
        this.init();
    }

    async init() {
        const { playlists } = await client.musicLoadLibrary();
        this.playlists = playlists;
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

        if (playlist.tracks.find(t => t.id === track.id)) {
            console.warn(`Track with ID ${track.id} already found in playlist.`);
            return;
        }

        playlist.tracks.push(track);
        await client.musicPlaylistAddTrack(playlistId, $state.snapshot(track));
    }

    async removeFromPlaylist(playlistId: string, trackId: string) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) {
            console.warn(`Playlist with ID ${playlistId} not found.`);
            return;
        }

        playlist.tracks = playlist.tracks.filter(t => t.id !== trackId);
        await client.musicPlaylistRemoveTrack(playlistId, trackId);
    }

    async toggleFromPlaylist(playlistId: string, track: Song) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) {
            console.warn(`Playlist with ID ${playlistId} not found.`);
            return;
        }

        if (this.isInPlaylist(playlistId, track.id)) {
            await this.removeFromPlaylist(playlistId, track.id);
        } else {
            await this.addToPlaylist(playlistId, track);
        }
    }
}

export const libraryState = new LibraryStore();