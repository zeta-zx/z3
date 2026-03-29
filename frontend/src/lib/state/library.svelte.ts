import { browser } from "$app/environment";
import type { SongResult, VideoResult } from "$lib/schema";

export type PlayableTrack = SongResult | VideoResult;

export interface Playlist {
    id: string;
    name: string;
    tracks: PlayableTrack[];
    createdAt: number;
    isProtected?: boolean;
    thumbnail?: string;
}

const STORAGE_KEY = 'library';

class LibraryStore {
    playlists = $state<Playlist[]>([]);

    constructor() {
        if (!browser) return;
        try {
            this.playlists = JSON.parse(localStorage.getItem(STORAGE_KEY) || '?');
        } catch (err) {
            this.playlists = [
                {
                    id: 'favourites',
                    name: 'Favourites',
                    tracks: [],
                    createdAt: Date.now(),
                    isProtected: true,
                }
            ];
            this.save();
        }
    }

    save() {
        if (!browser) return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.playlists));
    }

    isInPlaylist(playlistId: string, videoId: string): boolean {
        const playlist = this.playlists.find(p => p.id === playlistId);

        return playlist?.tracks.some(t => t.videoId === videoId) ?? false;
    }

    addToPlaylist(playlistId: string, track: PlayableTrack) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) {
            console.warn(`Playlist with ID ${playlistId} not found.`);
            return;
        }

        if (playlist.tracks.find(t => t.videoId === track.videoId)) {
            console.warn(`Track with ID ${track.videoId} already found in playlist.`);
            return;
        }

        playlist.tracks.push(track);
        this.save();
    }

    removeFromPlaylist(playlistId: string, videoId: string) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) {
            console.warn(`Playlist with ID ${playlistId} not found.`);
            return;
        }

        playlist.tracks = playlist.tracks.filter(t => t.videoId !== videoId);
        this.save();
    }

    toggleFromPlaylist(playlistId: string, track: PlayableTrack) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) {
            console.warn(`Playlist with ID ${playlistId} not found.`);
            return;
        }

        if (this.isInPlaylist(playlistId, track.videoId)) {
            this.removeFromPlaylist(playlistId, track.videoId);
        } else {
            this.addToPlaylist(playlistId, track);
        }
    }
}

export const libraryState = new LibraryStore();