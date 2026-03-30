import { client } from "$lib/ephaptic";
import type { AudioStream, SongResult, VideoResult } from "$lib/schema";
import { parseLrc, type LrcLine, shuffle } from "$lib/utils";
import type { PlayableTrack, Playlist } from "$lib/state/library.svelte";
import { parse } from "svelte/compiler";

export interface CacheRecord {
    streams: AudioStream[],
    lyrics: LrcLine[],
}

export const cache = new Map<string, CacheRecord>();

interface PlayerState {
    currentTrack: PlayableTrack | null,
    currentPlaylist: Playlist | null,
    _upcomingTrack: PlayableTrack | null,
    paused: boolean,
    maximised: boolean,
    currentTime: number,
    duration: number,
    isLoading: boolean,
    streams: AudioStream[],
    lyrics: LrcLine[],

    loop: boolean,
    shuffle: boolean,

    _history: string[];
    _historyIndex: number;
}

export const playerState = $state<PlayerState>({
    currentTrack: null,
    currentPlaylist: null,
    _upcomingTrack: null,

    paused: true,
    maximised: false,
    currentTime: 0,
    duration: 0,
    isLoading: true,

    streams: [],
    lyrics: [],

    loop: true,
    shuffle: false,

    _history: [],
    _historyIndex: -1,
});

export function calculateUpcomingTrack() {
    if (!playerState.currentPlaylist) {
        playerState._upcomingTrack = null;
        return;
    }

    if (playerState._historyIndex < playerState._history.length - 1) {
        const nextId = playerState._history[playerState._historyIndex + 1];
        playerState._upcomingTrack = playerState.currentPlaylist.tracks.find(t => t.videoId === nextId) || null;
        if (playerState._upcomingTrack) return;
    }

    if (playerState.shuffle) {
        let candidates = playerState.currentPlaylist.tracks.filter(t => !playerState._history.includes(t.videoId));
        
        if (candidates.length === 0 && playerState.loop) {
            candidates = playerState.currentPlaylist.tracks.filter(t => t.videoId !== playerState.currentTrack?.videoId);
        }
        
        playerState._upcomingTrack = candidates.length > 0 ? shuffle([...candidates])[0] : null;
    } else {
        let index = playerState.currentPlaylist.tracks.findIndex(t => t.videoId === playerState.currentTrack?.videoId) + 1;
        if (index >= playerState.currentPlaylist.tracks.length) {
            index = playerState.loop ? 0 : -1;
        }
        playerState._upcomingTrack = index !== -1 ? playerState.currentPlaylist.tracks[index] : null;
    }
}

export function playTrack(track: PlayableTrack) {
    playerState.currentPlaylist = null;
    playerState.currentTrack = track;
    playerState._history = [track.videoId];
    playerState._historyIndex = 0;
    playerState._upcomingTrack = null; 
}

export function playPlaylist(playlist: Playlist, startIndex: number = 0, shuffleFlag?: boolean) {
    if (!playlist || playlist.tracks.length === 0) return;

    playerState.currentPlaylist = playlist;

    if (shuffleFlag !== undefined) playerState.shuffle = shuffleFlag;
    // otherwise don't modify it

    let start;
    if (playerState.shuffle) start = shuffle([...playlist.tracks])[0];
    else {
        if (startIndex < 0 || startIndex >= playlist.tracks.length) startIndex = 0;
        start = playlist.tracks[startIndex]
    }

    playerState.currentTrack = start;
    playerState._history = [playerState.currentTrack.videoId];
    playerState._historyIndex = 0;

    calculateUpcomingTrack();
}

export function isNextTrackAvailable() { return playerState._upcomingTrack !== null; }

export function isPreviousTrackAvailable() {
    if (!playerState.currentPlaylist) return false;
    return playerState._historyIndex > 0 || (playerState.loop && !playerState.shuffle);
}

export function nextTrack() {
    if (!playerState._upcomingTrack) return;
    
    if (playerState._historyIndex < playerState._history.length - 1) {
        playerState._historyIndex++;
        const nextId = playerState._history[playerState._historyIndex];
        playerState.currentTrack = playerState.currentPlaylist?.tracks.find(t => t.videoId === nextId) || null;
    } else {
        playerState.currentTrack = playerState._upcomingTrack;
        playerState._history.push(playerState.currentTrack.videoId);
        playerState._historyIndex++;
    }

    calculateUpcomingTrack();
}

export function previousTrack() {
    if (!playerState.currentPlaylist) return; // keep these manul checks here isntead of util functions above to satisfy typescript
    
    if (playerState._historyIndex > 0) {
        playerState._historyIndex--;
        const previousId = playerState._history[playerState._historyIndex];
        const previousTrack = playerState.currentPlaylist.tracks.find(t => t.videoId === previousId);

        if (previousTrack) {
            playerState.currentTrack = previousTrack;
            calculateUpcomingTrack();
            return;
        }
    }

    // if no history
    if (!playerState.shuffle) {
        let index = playerState.currentPlaylist.tracks.findIndex(track => track.videoId === playerState.currentTrack?.videoId) - 1;
        if (index < 0) index = playerState.loop ? playerState.currentPlaylist.tracks.length - 1 : -1;
        
        if (index !== -1) {
            playerState.currentTrack = playerState.currentPlaylist.tracks[index];
            playerState._history.unshift(playerState.currentTrack.videoId);
            playerState._historyIndex = 0;
            calculateUpcomingTrack();
        }
    }
}

export async function loadTrack(track: PlayableTrack | null) {
    if (!track || cache.has(track.videoId)) return;

    cache.set(track.videoId, { streams: [], lyrics: [] });

    try {
        const [lyrics = '', streams = []] = await Promise.all([
            client!.music_lyrics(`${track.title} - ${track.artists.map(a => a.name).join(', ')}`).catch(() => ''),
            client!.music_stream(track.videoId).catch(() => []),
        ]);

        cache.set(track.videoId, {
            lyrics: parseLrc(lyrics || ''),
            streams,
        });
    } catch (e) {
        console.error("Loading track failed.", e);
    }
}

export function resetState() {
    playerState.streams = [];
    playerState.lyrics = [];
    playerState.paused = true;
    playerState.currentTime = 0;
    playerState.duration = 0;
    playerState.isLoading = true;
}

export function applyCache(cached?: CacheRecord) {
    if (!cached) cached = cache.get(playerState.currentTrack?.videoId || '');
    if (!cached || !cached.streams || cached.streams.length === 0) return;
    
    playerState.lyrics = cached.lyrics;
    playerState.streams = cached.streams;
    playerState.isLoading = false;
    playerState.paused = false;
}