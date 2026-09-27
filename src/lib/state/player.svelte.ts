import { browser } from "$app/environment";
import { client } from "$lib/ephaptic";
import type { Stream, Song, Playlist } from "$lib/schema";
import { shuffle, isSyncedLyrics, songKey, slimSong } from "$lib/utils";
import { libraryState } from "$lib/state/library.svelte";

export interface CacheRecord {
    stream: Stream,
    // Raw lyrics text (synced LRC or plain); turned into timed lines for display
    // where the actual audio duration is known.
    lyrics: string | null,
}

/** off → stop at the end, all → wrap the context, one → repeat the current track. */
export type RepeatMode = "off" | "all" | "one";

/** A track we moved away from, so "previous" can restore exactly where we were. */
interface HistoryEntry {
    track: Song;
    anchorId: string | null;
    anchorIndex: number;
    fromQueue: boolean;
}

interface PlayerState {
    currentTrack: Song | null,
    /** The collection being played through (a playlist, search results, …). */
    currentPlaylist: Playlist | null,
    paused: boolean,
    currentTime: number,
    duration: number,
    isLoading: boolean,
    stream: Stream | null,
    lyrics: string | null,

    repeat: RepeatMode,
    shuffle: boolean,
    volume: number,
    muted: boolean,

    /** Manually queued tracks ("Play next" / "Add to queue"); played before the context continues. */
    upNext: Song[],

    /** Keep playing similar songs once the queue and context run out (like Spotify). */
    autoplay: boolean,
    /** Suggested tracks waiting to play when the context ends. */
    autoplayTracks: Song[],
    /** The track the current suggestions were based on. */
    autoplaySeed: Song | null,

    /** Shuffled play order (track ids) for the context. Unused when not shuffling. */
    _order: string[],
    /** Id of the last *context* track played — where the context resumes from. */
    _anchorId: string | null,
    /** Position the anchor had, used if the anchor is removed from the playlist mid-play. */
    _anchorIndex: number,
    /** Whether the current track was taken from `upNext` rather than the context. */
    _fromQueue: boolean,
    _history: HistoryEntry[],
}

const HISTORY_LIMIT = 200;
const PREFS_KEY = "zeta:player-prefs";

function loadPrefs(): Partial<Pick<PlayerState, "repeat" | "shuffle" | "volume" | "muted" | "autoplay">> {
    if (!browser) return {};
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    } catch {
        return {};
    }
}

const prefs = loadPrefs();

export const playerState = $state<PlayerState>({
    currentTrack: null,
    currentPlaylist: null,

    paused: true,
    currentTime: 0,
    duration: 0,
    isLoading: true,

    stream: null,
    lyrics: null,

    repeat: prefs.repeat === "off" || prefs.repeat === "one" ? prefs.repeat : "all",
    shuffle: !!prefs.shuffle,
    volume: typeof prefs.volume === "number" ? Math.min(1, Math.max(0, prefs.volume)) : 1,
    muted: !!prefs.muted,

    upNext: [],

    autoplay: prefs.autoplay !== false,
    autoplayTracks: [],
    autoplaySeed: null,

    _order: [],
    _anchorId: null,
    _anchorIndex: -1,
    _fromQueue: false,
    _history: [],
});

export function savePlayerPrefs() {
    if (!browser) return;
    const { repeat, shuffle, volume, muted, autoplay } = playerState;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ repeat, shuffle, volume, muted, autoplay }));
}

/* -------------------------------------------------------------------------- */
/*                               context ordering                             */
/* -------------------------------------------------------------------------- */

/**
 * The playlist being played, as it is *now*. Library playlists are replaced
 * (not mutated) when edited, so look the live copy up by id; other contexts
 * (radio, search results) are owned by the player itself.
 */
function contextPlaylist(): Playlist | null {
    const playlist = playerState.currentPlaylist;
    if (!playlist) return null;
    return libraryState.getPlaylist(playlist.id) ?? playlist;
}

// Per-playlist id → track lookup. Library playlists are immutable snapshots, so
// the index stays valid for as long as that playlist object does.
const trackIndexes = new WeakMap<Song[], { length: number; map: Map<string, Song> }>();

function trackById(id: string | null | undefined): Song | null {
    if (!id) return null;
    const tracks = contextPlaylist()?.tracks;
    if (!tracks) return null;
    let index = trackIndexes.get(tracks);
    // Radio contexts grow in place; rebuild when the length has changed.
    if (!index || index.length !== tracks.length) {
        index = { length: tracks.length, map: new Map(tracks.map((t) => [t.id, t])) };
        trackIndexes.set(tracks, index);
    }
    return index.map.get(id) ?? null;
}

/**
 * The context's play order as track ids. Unshuffled, this is read live from the
 * playlist so reorders/additions/removals are respected immediately. Shuffled,
 * it's the stored order minus anything that has since been removed.
 */
function contextIds(): string[] {
    const playlist = contextPlaylist();
    if (!playlist) return [];
    if (!playerState.shuffle) return playlist.tracks.map((t) => t.id);
    const present = new Set(playlist.tracks.map((t) => t.id));
    return playerState._order.filter((id) => present.has(id));
}

/** Index of the anchor within `ids`; -1 means "before the start". */
function anchorPosition(ids: string[]): number {
    const idx = playerState._anchorId ? ids.indexOf(playerState._anchorId) : -1;
    if (idx !== -1) return idx;
    // The anchor was removed from the playlist: resume at the slot it occupied.
    return Math.max(-1, Math.min(playerState._anchorIndex, ids.length) - 1);
}

/**
 * Fold tracks added to the playlist since we shuffled into the not-yet-played
 * part of the order, at random positions. (Mutates; not for use in deriveds.)
 */
function syncShuffledOrder() {
    const playlist = contextPlaylist();
    if (!playlist || !playerState.shuffle) return;

    const present = new Set(playlist.tracks.map((t) => t.id));
    const order = playerState._order.filter((id) => present.has(id));
    const known = new Set(order);
    const missing = playlist.tracks.map((t) => t.id).filter((id) => !known.has(id));

    const start = Math.max(0, order.indexOf(playerState._anchorId ?? "") + 1);
    for (const id of missing) {
        const at = start + Math.floor(Math.random() * (order.length - start + 1));
        order.splice(at, 0, id);
    }
    playerState._order = order;
}

/** Build a shuffled order, optionally pinning `firstId` to the front. */
function buildShuffledOrder(playlist: Playlist, firstId?: string | null): string[] {
    const ids = playlist.tracks.map((t) => t.id);
    if (!firstId || !ids.includes(firstId)) return shuffle(ids);
    return [firstId, ...shuffle(ids.filter((id) => id !== firstId))];
}

/* -------------------------------------------------------------------------- */
/*                                  queries                                   */
/* -------------------------------------------------------------------------- */

/**
 * The track that will play after the current one (for preloading and UI).
 * Pure: safe to call from templates, deriveds and effects.
 */
export function getUpcomingTrack(): Song | null {
    if (playerState.upNext.length) return playerState.upNext[0];

    const ids = contextIds();
    if (!ids.length) return autoplayCandidate();
    const pos = anchorPosition(ids);
    if (pos + 1 < ids.length) return trackById(ids[pos + 1]);

    // End of the context: only wraps when repeating. A shuffled wrap reshuffles,
    // so we can't know the next track yet.
    if (playerState.repeat === "all") return playerState.shuffle ? null : trackById(ids[0]);
    return autoplayCandidate();
}

/** The suggestion that would play once everything else runs out, if any. */
function autoplayCandidate(): Song | null {
    return playerState.autoplay ? playerState.autoplayTracks[0] ?? null : null;
}

/** Upcoming context tracks (after the manual queue), for the queue panel. */
export function getUpcomingContext(limit = 50): Song[] {
    const ids = contextIds();
    if (!ids.length) return [];
    const pos = anchorPosition(ids);
    let upcoming = ids.slice(pos + 1);
    if (playerState.repeat === "all" && !playerState.shuffle) upcoming = upcoming.concat(ids.slice(0, pos + 1));
    return upcoming
        .slice(0, limit)
        .map(trackById)
        .filter((t): t is Song => !!t);
}

export function isNextTrackAvailable() {
    if (getUpcomingTrack()) return true;
    return playerState.repeat === "all" && contextIds().length > 0;
}

export function isPreviousTrackAvailable() {
    return !!playerState.currentTrack;
}

/* -------------------------------------------------------------------------- */
/*                                 transitions                                */
/* -------------------------------------------------------------------------- */

function pushHistory() {
    const current = playerState.currentTrack;
    if (!current) return;
    playerState._history.push({
        track: current,
        anchorId: playerState._anchorId,
        anchorIndex: playerState._anchorIndex,
        fromQueue: playerState._fromQueue,
    });
    if (playerState._history.length > HISTORY_LIMIT) playerState._history.splice(0, playerState._history.length - HISTORY_LIMIT);
}

/** Replay from the top — used when "moving" to the track that's already current. */
function restartCurrent() {
    playerState.currentTime = 0;
    playerState.paused = false;
}

function setCurrent(track: Song) {
    if (playerState.currentTrack?.id === track.id) {
        playerState.currentTrack = track;
        restartCurrent();
    } else {
        playerState.currentTrack = track;
    }
}

/** Move to a context track by id, recording where we came from. */
function goToContextTrack(id: string) {
    const track = trackById(id);
    if (!track) return;
    pushHistory();
    playerState._anchorId = id;
    playerState._anchorIndex = contextIds().indexOf(id);
    playerState._fromQueue = false;
    setCurrent(track);
}

/** Play a single track with no surrounding context. The manual queue is kept. */
export function playTrack(track: Song) {
    pushHistory();
    playerState.currentPlaylist = null;
    playerState.autoplayTracks = [];
    playerState.autoplaySeed = null;
    playerState._order = [];
    playerState._anchorId = null;
    playerState._anchorIndex = -1;
    playerState._fromQueue = false;
    setCurrent(track);
    // A one-off song ends immediately, so line up what plays after it now.
    queueMicrotask(refreshAutoplay);
}

/**
 * Start playing a playlist.
 *
 * - `startIndex` given: that exact track plays first — even with shuffle on (the
 *   rest of the playlist is then shuffled after it).
 * - `startIndex` omitted: the first track, or a random one when shuffling.
 * - `shuffleFlag` given: forces shuffle on/off before starting.
 */
export function playPlaylist(playlist: Playlist, startIndex?: number, shuffleFlag?: boolean) {
    if (!playlist || playlist.tracks.length === 0) return;

    if (shuffleFlag !== undefined) {
        playerState.shuffle = shuffleFlag;
        savePlayerPrefs();
    }

    let start: Song;
    if (startIndex !== undefined && startIndex >= 0 && startIndex < playlist.tracks.length) {
        start = playlist.tracks[startIndex];
    } else if (playerState.shuffle) {
        start = playlist.tracks[Math.floor(Math.random() * playlist.tracks.length)];
    } else {
        start = playlist.tracks[0];
    }

    pushHistory();
    playerState.currentPlaylist = playlist;
    playerState.autoplayTracks = [];
    playerState.autoplaySeed = null;
    playerState._order = playerState.shuffle ? buildShuffledOrder(playlist, start.id) : [];
    playerState._anchorId = start.id;
    playerState._anchorIndex = contextIds().indexOf(start.id);
    playerState._fromQueue = false;
    setCurrent(start);
}

export function nextTrack() {
    syncShuffledOrder();

    if (playerState.upNext.length) {
        const next = playerState.upNext[0];
        pushHistory();
        playerState.upNext = playerState.upNext.slice(1);
        playerState._fromQueue = true;
        setCurrent(next);
        return;
    }

    const ids = contextIds();
    const pos = anchorPosition(ids);

    if (pos + 1 < ids.length) {
        goToContextTrack(ids[pos + 1]);
        return;
    }

    if (playerState.repeat !== "all" || !ids.length) {
        startAutoplay();
        return;
    }

    const live = contextPlaylist();
    if (playerState.shuffle && live) {
        // Fresh shuffle for the next pass, avoiding an immediate repeat.
        let order = buildShuffledOrder(live);
        if (order.length > 1 && order[0] === playerState.currentTrack?.id) order = [...order.slice(1), order[0]];
        playerState._order = order;
        goToContextTrack(order[0]);
    } else {
        goToContextTrack(ids[0]);
    }
}

/* -------------------------------------------------------------------------- */
/*                                  autoplay                                  */
/* -------------------------------------------------------------------------- */

export const RADIO_PREFIX = "radio:";

export function isRadioContext(playlist: Playlist | null = playerState.currentPlaylist) {
    return !!playlist?.id.startsWith(RADIO_PREFIX);
}

/** Continue into an "Autoplay" radio context built from the pending suggestions. */
function startAutoplay() {
    const first = autoplayCandidate();
    if (!first) return;
    const seed = playerState.autoplaySeed;
    const radio: Playlist = {
        id: `${RADIO_PREFIX}${Date.now()}`,
        name: seed ? `Autoplay · like “${seed.title}”` : "Autoplay",
        tracks: [...playerState.autoplayTracks],
        createdAt: Date.now(),
        isProtected: true,
    };
    playerState.autoplayTracks = [];
    pushHistory();
    playerState.currentPlaylist = radio;
    playerState._order = playerState.shuffle ? buildShuffledOrder(radio, first.id) : [];
    playerState._anchorId = first.id;
    playerState._anchorIndex = 0;
    playerState._fromQueue = false;
    setCurrent(first);
}

/** How many tracks are left before playback would stop (ignoring autoplay). */
function remainingBeforeEnd(): number {
    if (playerState.repeat !== "off" && contextIds().length) return Infinity;
    const ids = contextIds();
    return playerState.upNext.length + Math.max(0, ids.length - 1 - anchorPosition(ids));
}

let autoplayFetching: string | null = null;
let autoplayRetried: string | null = null;

/**
 * Keep suggestions topped up: once fewer than two tracks remain, fetch songs
 * similar to the current one. In a radio context they're appended to it so the
 * station just keeps going. Safe to call often (it no-ops when not needed).
 */
export async function refreshAutoplay() {
    const seed = playerState.currentTrack;
    if (!playerState.autoplay || !seed) return;
    if (remainingBeforeEnd() >= 2) return;
    const inRadio = isRadioContext();
    if (!inRadio && playerState.autoplaySeed?.id === seed.id && playerState.autoplayTracks.length) return;
    if (autoplayFetching === seed.id) return;

    autoplayFetching = seed.id;
    try {
        const known = [
            ...playerState._history.slice(-100).map((h) => h.track),
            ...(contextPlaylist()?.tracks ?? []),
            ...playerState.upNext,
            seed,
        ];
        const exclude = new Set(known.map((t) => t.id));
        // The same song often exists under several uploads/ids; match by name too.
        const knownKeys = new Set(known.map(songKey));
        const suggestions = await client.musicRadio(slimSong($state.snapshot(seed) as Song), [...exclude]);
        const fresh = suggestions.filter((t) => !exclude.has(t.id) && !knownKeys.has(songKey(t))).slice(0, 25);
        if (playerState.currentTrack?.id !== seed.id || !fresh.length) return;

        if (isRadioContext()) {
            playerState.currentPlaylist!.tracks.push(...fresh);
        } else {
            playerState.autoplaySeed = seed;
            playerState.autoplayTracks = fresh;
        }
    } catch (err) {
        console.warn("[autoplay] Could not fetch suggestions:", err);
        // Transient failures (network, backend still starting): try once more.
        if (autoplayRetried !== seed.id) {
            autoplayRetried = seed.id;
            setTimeout(() => {
                if (playerState.currentTrack?.id === seed.id) refreshAutoplay();
            }, 8000);
        }
    } finally {
        autoplayFetching = null;
    }
}

export function setAutoplay(enabled: boolean) {
    playerState.autoplay = enabled;
    if (!enabled) playerState.autoplayTracks = [];
    savePlayerPrefs();
    if (enabled) refreshAutoplay();
}

/** Start a radio station seeded from a track ("Go to song radio"). */
export async function startRadio(seed: Song) {
    const suggestions = await client.musicRadio(slimSong($state.snapshot(seed) as Song), []);
    const radio: Playlist = {
        id: `${RADIO_PREFIX}${Date.now()}`,
        name: `${seed.title} Radio`,
        tracks: [seed, ...suggestions.filter((t) => t.id !== seed.id)],
        createdAt: Date.now(),
        isProtected: true,
    };
    playPlaylist(radio, 0);
}

/** Called when a track finishes on its own (vs. the user pressing next). */
export function handleTrackEnded() {
    if (playerState.repeat === "one") {
        restartCurrent();
        return;
    }
    if (isNextTrackAvailable()) {
        nextTrack();
    } else {
        // End of everything: rewind and stop so pressing play starts over.
        playerState.paused = true;
        playerState.currentTime = 0;
    }
}

export function previousTrack() {
    // Like every other player: a few seconds in, "previous" restarts the song.
    if ((playerState.currentTime || 0) > 3) {
        playerState.currentTime = 0;
        return;
    }

    const entry = playerState._history.pop();
    if (entry) {
        // A queued track we back out of goes back to the front of the queue.
        if (playerState._fromQueue && playerState.currentTrack) {
            playerState.upNext = [playerState.currentTrack, ...playerState.upNext];
        }
        playerState._anchorId = entry.anchorId;
        playerState._anchorIndex = entry.anchorIndex;
        playerState._fromQueue = entry.fromQueue;
        setCurrent(entry.track);
        return;
    }

    // No history (e.g. started mid-playlist): step back through the context.
    const ids = contextIds();
    const pos = anchorPosition(ids);
    let target = pos - 1;
    if (target < 0 && playerState.repeat === "all") target = ids.length - 1;
    const track = target >= 0 ? trackById(ids[target]) : null;
    if (!track) {
        playerState.currentTime = 0;
        return;
    }
    playerState._anchorId = track.id;
    playerState._anchorIndex = target;
    playerState._fromQueue = false;
    setCurrent(track);
}

export function setShuffle(enabled: boolean) {
    if (playerState.shuffle === enabled) return;
    playerState.shuffle = enabled;
    savePlayerPrefs();

    const playlist = contextPlaylist();
    if (!playlist) return;

    if (enabled) {
        // Keep the current position and shuffle everything else after it, so
        // the very next track is already a shuffled one.
        playerState._order = buildShuffledOrder(playlist, playerState._anchorId);
        playerState._anchorIndex = 0;
    } else {
        playerState._order = [];
        playerState._anchorIndex = playlist.tracks.findIndex((t) => t.id === playerState._anchorId);
    }
}

export function toggleShuffle() {
    setShuffle(!playerState.shuffle);
}

export function setRepeat(mode: RepeatMode) {
    playerState.repeat = mode;
    savePlayerPrefs();
}

export function cycleRepeat() {
    const order: RepeatMode[] = ["off", "all", "one"];
    setRepeat(order[(order.indexOf(playerState.repeat) + 1) % order.length]);
}

export function togglePlay() {
    if (!playerState.currentTrack || playerState.isLoading) return;
    playerState.paused = !playerState.paused;
}

export function seek(seconds: number) {
    const max = playerState.duration || 0;
    playerState.currentTime = Math.min(Math.max(0, seconds), max);
}

export function seekBy(delta: number) {
    seek((playerState.currentTime || 0) + delta);
}

export function setVolume(volume: number) {
    playerState.volume = Math.min(1, Math.max(0, volume));
    if (playerState.volume > 0) playerState.muted = false;
    savePlayerPrefs();
}

export function toggleMute() {
    playerState.muted = !playerState.muted;
    savePlayerPrefs();
}

/* -------------------------------------------------------------------------- */
/*                                manual queue                                */
/* -------------------------------------------------------------------------- */

export function addToQueue(track: Song) {
    if (!playerState.currentTrack) {
        playTrack(track);
        return;
    }
    playerState.upNext = [...playerState.upNext, track];
}

export function playNext(track: Song) {
    if (!playerState.currentTrack) {
        playTrack(track);
        return;
    }
    playerState.upNext = [track, ...playerState.upNext];
}

export function removeFromQueue(index: number) {
    playerState.upNext = playerState.upNext.filter((_, i) => i !== index);
}

export function moveInQueue(from: number, to: number) {
    const list = [...playerState.upNext];
    const [moved] = list.splice(from, 1);
    if (!moved) return;
    list.splice(to, 0, moved);
    playerState.upNext = list;
}

export function clearQueue() {
    playerState.upNext = [];
}

/** Jump straight to a queued track, dropping the ones queued before it. */
export function playFromQueue(index: number) {
    const track = playerState.upNext[index];
    if (!track) return;
    pushHistory();
    playerState.upNext = playerState.upNext.slice(index + 1);
    playerState._fromQueue = true;
    setCurrent(track);
}

/** Jump to an upcoming context track (from the queue panel). */
export function playFromContext(trackId: string) {
    syncShuffledOrder();
    goToContextTrack(trackId);
}

/* -------------------------------------------------------------------------- */
/*                                   loading                                  */
/* -------------------------------------------------------------------------- */

// Decoded audio is kept for a handful of tracks only — each entry holds the
// whole file in memory, so an unbounded cache grows by megabytes per song.
export const cache = new Map<string, CacheRecord>();
const CACHE_LIMIT = 6;
const inflight = new Map<string, Promise<void>>();

function trimCache() {
    const keep = new Set([playerState.currentTrack?.id, getUpcomingTrack()?.id]);
    for (const key of cache.keys()) {
        if (cache.size <= CACHE_LIMIT) break;
        if (!keep.has(key)) cache.delete(key);
    }
}

export function loadTrack(track: Song | null): Promise<void> {
    if (!track) return Promise.resolve();
    const hit = cache.get(track.id);
    if (hit) {
        // Refresh LRU position.
        cache.delete(track.id);
        cache.set(track.id, hit);
        return Promise.resolve();
    }
    // Preload and play can ask for the same track at once; share one fetch.
    const pending = inflight.get(track.id);
    if (pending) return pending;

    const promise = (async () => {
        // If the track already carries synced lyrics (e.g. imported from Muzza),
        // use them and skip the network lookup. Plain embedded lyrics are still
        // worth an online lookup in case a synced version exists.
        const embedded = track.lyrics ?? null;
        const hasSynced = isSyncedLyrics(embedded);

        // Lyrics are optional; a failure there must not block playback. A stream
        // failure, however, propagates so callers can surface it to the user.
        const [lyrics, stream] = await Promise.all([
            hasSynced ? Promise.resolve(embedded) : client.musicLyrics(slimSong($state.snapshot(track) as Song)).catch(() => null),
            client.musicStream(track.id),
        ]);

        // If fetching this track also saved it to disk, reflect that in the library.
        if (stream.savedToDisk) libraryState.markDownloaded(track.id);

        // Keep the raw text; fall back to any embedded (plain) lyrics we were given.
        cache.set(track.id, { lyrics: lyrics ?? embedded, stream });
        trimCache();
    })().finally(() => inflight.delete(track.id));

    inflight.set(track.id, promise);
    return promise;
}

export function resetState() {
    playerState.stream = null;
    playerState.lyrics = null;
    playerState.currentTime = 0;
    playerState.duration = 0;
    playerState.isLoading = true;
}

export function applyCache(cached?: CacheRecord) {
    if (!cached) cached = cache.get(playerState.currentTrack?.id || '');
    if (!cached) return;

    playerState.stream = cached.stream;
    playerState.lyrics = cached.lyrics;
    playerState.isLoading = false;
    playerState.paused = false;
}
