import { client } from '$lib/ephaptic';
import { activityCover, boundedActivityLyrics } from '$lib/activity-media';
import type { Song, Thumbnail } from '$lib/schema';
import { bestThumbnailUrl, buildLyricLines, slimSong } from '$lib/utils';
import type { DiscordAlbum, DiscordCommand, DiscordPlayback, DiscordResult, DiscordTrack } from '$lib/wayship-discord';
import { libraryState } from './library.svelte';
import { artworkState } from './artwork.svelte';
import { lyricsState } from './lyrics.svelte';
import { discordVoice } from './discord-voice.svelte';
import { peers } from './peers.svelte';
import {
    addToQueue, getUpcomingTracks, isNextTrackAvailable, nextTrack, playerState,
    playNext, playTrack, previousTrack, seek, setVolume,
} from './player.svelte';

function controllable() {
    return !peers.links.some((link) => link.connected && !link.host &&
        (link.mode === 'remote' || (link.mode === 'party' && peers.following)));
}

function publicCover(thumbnails?: Thumbnail[]) {
    return bestThumbnailUrl(thumbnails?.filter((thumb) => thumb.url?.startsWith('https://') && thumb.url.length < 2000)) || undefined;
}

function trackSummary(song: Song): DiscordTrack {
    const videoId = /^yt:([\w-]{11})$/.exec(song.id)?.[1];
    return {
        title: song.title.slice(0, 200),
        artist: song.artists.map(({ name }) => name).join(', ').slice(0, 150),
        album: song.album?.title.slice(0, 200),
        year: (song.album?.year || song.year)?.slice(0, 12),
        coverUrl: publicCover(song.album?.thumbnails) || publicCover(song.thumbnails),
        url: videoId ? `https://music.youtube.com/watch?v=${videoId}` : undefined,
        duration: Number.isFinite(song.duration) && song.duration > 0 ? song.duration : undefined,
    };
}

async function albumSummary(song: Song): Promise<DiscordAlbum | undefined> {
    if (!song.album) return undefined;
    const details = song.album.id ? await client.musicCollection(song.album.id).catch(() => null) : null;
    const album = details?.kind === 'playlist' ? null : details;
    const source = album ?? song.album;
    const browseId = /^yt:(MPREb_[\w-]+)$/.exec(source.id ?? '')?.[1];
    return {
        title: source.title.slice(0, 200),
        artist: (source.artists.length ? source.artists : song.artists).map(({ name }) => name).join(', ').slice(0, 150),
        year: (source.year || song.year)?.slice(0, 12),
        coverUrl: publicCover(source.thumbnails) || publicCover(song.thumbnails),
        url: browseId ? `https://music.youtube.com/browse/${browseId}` : undefined,
        tracks: album?.tracks.slice(0, 5).map(trackSummary),
        trackCount: album?.tracks.length,
    };
}

let activityTrack: { id: string; key: string } | undefined;

function trackKey(track: Song | null) {
    if (!track) activityTrack = undefined;
    else if (activityTrack?.id !== track.id) activityTrack = { id: track.id, key: crypto.randomUUID() };
    return activityTrack?.key;
}

function playback(): DiscordPlayback {
    const { currentTrack, currentTime, duration, isLoading, paused } = playerState;
    return {
        track: currentTrack ? trackSummary(currentTrack) : null,
        phase: !currentTrack ? 'idle' : isLoading ? 'loading' : paused ? 'paused' : 'playing',
        controllable: controllable(),
        voiceAvailable: discordVoice.available,
        position: Number.isFinite(currentTime) ? currentTime : 0,
        duration: Number.isFinite(duration) ? duration : 0,
        sampledAt: Date.now(),
        trackKey: trackKey(currentTrack),
        queue: getUpcomingTracks(5).map(trackSummary),
    };
}

async function searchTrack(query: string): Promise<Song | undefined> {
    const found = (await client.musicSearch(query.trim(), 'yt'))[0];
    return found && (libraryState.findLocalTrack(found) ?? found);
}

export async function runDiscordCommand(command: DiscordCommand, isCurrent: () => boolean): Promise<DiscordResult> {
    if (command.action === 'status') return { ok: true, playback: playback() };
    if (command.action === 'activity-media') {
        const track = playerState.currentTrack;
        if (!track || trackKey(track) !== command.trackKey) return { ok: false, error: 'The current track changed.' };
        const art = artworkState.artworkFor(track.id);
        const cover = await activityCover(art.url);
        if (!isCurrent() || trackKey(playerState.currentTrack) !== command.trackKey) {
            return { ok: false, error: 'The current track changed.' };
        }
        return {
            ok: true,
            activityMedia: {
                trackKey: command.trackKey,
                cover,
                lyrics: boundedActivityLyrics(lyricsState.raw),
                pending: playerState.lyricsPending || art.pending,
            },
        };
    }
    if (command.action === 'lyrics' || command.action === 'album') {
        const song = command.query ? await searchTrack(command.query) : playerState.currentTrack;
        if (!song) return { ok: false, error: 'No track found. Try providing a song title and artist.' };
        if (command.action === 'album') return { ok: true, track: trackSummary(song), album: await albumSummary(song) };
        const lyrics = (playerState.currentTrack?.id === song.id && playerState.lyrics) || song.lyrics
            || await client.musicLyrics(slimSong($state.snapshot(song) as Song));
        const lines = buildLyricLines(lyrics, song.duration).map(({ text }) => text).join('\n').slice(0, 12_000);
        if (!lines) return { ok: false, error: 'Zeta could not find lyrics for this track.' };
        return { ok: true, track: trackSummary(song), lyrics: lines };
    }

    if (!controllable()) return { ok: false, error: 'This device is following another player. Choose the playback host.' };
    if (command.action === 'voice-start') {
        try {
            await discordVoice.start(command, isCurrent);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Could not share Zeta audio to Discord.' };
        }
    }
    if (command.action === 'play' || command.action === 'playnext' || command.action === 'enqueue') {
        const song = await searchTrack(command.query);
        if (!song) return { ok: false, error: 'No matching track found. Try the song title and artist.' };
        // Search can finish after the request expired, the account changed, or
        // the device started following another player.
        if (!isCurrent() || !controllable()) return { ok: false, error: 'The player changed while searching. Try again.' };
        if (command.action === 'play') playTrack(song);
        else {
            if (playerState.upNext.length >= 100) return { ok: false, error: 'The player queue is full.' };
            if (command.action === 'playnext') playNext(song);
            else addToQueue(song);
        }
        return { ok: true, track: trackSummary(song) };
    }

    if (command.action === 'volume') {
        setVolume(command.value / 100);
        return { ok: true };
    }
    if (!playerState.currentTrack) return { ok: false, error: 'No track is loaded on this device.' };
    switch (command.action) {
        case 'pause': case 'unpause':
            if (playerState.isLoading) return { ok: false, error: 'Zeta is still loading the track. Try again in a moment.' };
            playerState.paused = command.action === 'pause';
            break;
        case 'seek':
            if (playerState.isLoading) return { ok: false, error: 'Zeta is still loading the track. Try again in a moment.' };
            seek(command.value);
            break;
        case 'skip':
            if (!isNextTrackAvailable()) return { ok: false, error: 'There is no next track in Zeta.' };
            nextTrack();
            break;
        case 'previous':
            previousTrack();
            break;
    }
    return { ok: true };
}
