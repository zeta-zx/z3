import { client } from "$lib/ephaptic";
import type { AudioStream, SongResult, VideoResult } from "$lib/schema";
import { parseLrc, type LrcLine } from "$lib/utils";
import type { PlayableTrack } from "$lib/state/library.svelte";

interface PlayerState {
    currentTrack: PlayableTrack | null,
    paused: boolean,
    maximised: boolean,
    currentTime: number,
    duration: number,
    isLoading: boolean,
    streams: AudioStream[],
    lyrics: LrcLine[],
}

export const playerState = $state<PlayerState>({
    currentTrack: null,

    paused: true,
    maximised: false,
    currentTime: 0,
    duration: 0,
    isLoading: true,

    streams: [],
    lyrics: [],
});