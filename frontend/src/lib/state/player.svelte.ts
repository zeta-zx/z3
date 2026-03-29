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

    _alreadyPlayed: string[];
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

    _alreadyPlayed: [],
});

export function calculateUpcomingTrack() {
    if (!playerState.currentPlaylist) {
        playerState._upcomingTrack = null;
        return;
    }

    if (playerState.shuffle) {
        let candidates = playerState.currentPlaylist.tracks.filter(t => !playerState._alreadyPlayed.includes(t.videoId));
        
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
    playerState._alreadyPlayed = [track.videoId];
    playerState._upcomingTrack = null; 
}

export function playPlaylist(playlist: Playlist, startIndex: number = 0, shuffle?: boolean) {
    if (!playlist || playlist.tracks.length === 0) return;

    if (startIndex < 0 || startIndex >= playlist.tracks.length) startIndex = 0;

    playerState.currentPlaylist = playlist;
    playerState._alreadyPlayed =[]; 

    playerState.currentTrack = playlist.tracks[startIndex];
    
    playerState._alreadyPlayed.push(playerState.currentTrack.videoId);

    if (shuffle !== undefined) playerState.shuffle = shuffle;
    // otherwise don't modify it

    calculateUpcomingTrack();
}

export function isNextTrackAvailable() { return playerState._upcomingTrack !== null; }

export function isPreviousTrackAvailable() {
    if (!playerState.currentPlaylist) return false;
    return playerState._alreadyPlayed.length > 1 || (playerState.loop && !playerState.shuffle);
}

export function nextTrack() {
    if (!playerState._upcomingTrack) return;
    
    if (playerState.shuffle && playerState._alreadyPlayed.includes(playerState._upcomingTrack.videoId)) {
        playerState._alreadyPlayed =[];
    }

    playerState.currentTrack = playerState._upcomingTrack;
    playerState._alreadyPlayed.push(playerState.currentTrack.videoId);
    calculateUpcomingTrack();
}

export function previousTrack() {
    if (!playerState.currentPlaylist) return; // keep these manul checks here isntead of util functions above to satisfy typescript
    if (playerState._alreadyPlayed.length > 1) {
        playerState._alreadyPlayed.pop(); // currently playin
        const previous = playerState._alreadyPlayed.pop();

        const previousTrack = playerState.currentPlaylist.tracks.find(t => t.videoId === previous);

        if (previousTrack) {
            playerState.currentTrack = previousTrack;
            playerState._alreadyPlayed.push(previousTrack.videoId); // becuz we just popped it off to find it
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
            playerState._alreadyPlayed.push(playerState.currentTrack.videoId);
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
    playerState.maximised = true;
}

export function applyCache(cached: CacheRecord) {
    playerState.lyrics = cached.lyrics;
    playerState.streams = cached.streams;
    playerState.isLoading = false;
    playerState.paused = false;
}