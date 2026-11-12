import { CapacitorHttp } from '@capacitor/core';
import { Song as Saavn } from '@saavn-labs/sdk';
import { Innertube, Parser, Platform } from 'youtubei.js/web';
import type { ArtistDetails, CollectionDetails, MusicProvider, SearchExtras, Song, VideoStreamInfo } from '../schema';
import { chooseAudioFormat, MAX_BITRATE_KBPS, type AudioQuality } from '../audio-quality';
import {
    fetchArtistAllSongs,
    fetchArtistDetails,
    fetchCollectionDetails,
    saavnToSong,
    searchMusicAlbums,
    searchMusicExtras,
    searchMusicPlaylists,
    searchMusicSongs,
    searchMusicVideos,
    ytSearchItems,
    ytToSong,
} from '../music-catalog';
import { fetchLrclib } from '../../../electron/lib/lyricsfile';

// Use the native HTTP API explicitly for YouTube: Request/Headers in a WebView
// otherwise discard the Origin/User-Agent headers the service expects.
const nativeFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const headers = Object.fromEntries(new Headers(init?.headers ?? request.headers));
    headers.origin ??= 'https://www.youtube.com';
    headers['user-agent'] ??= navigator.userAgent;
    const method = init?.method ?? request.method;
    const body = init?.body ?? (method !== 'GET' && method !== 'HEAD' ? await request.clone().text() : undefined);
    const response = await CapacitorHttp.request({
        url: request.url, method, headers, data: body,
        responseType: 'arraybuffer', connectTimeout: 20_000, readTimeout: 30_000,
    });
    // Capacitor returns parsed objects for application/json even when an
    // arraybuffer was requested; other successful responses are base64.
    const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
    const bodyData = contentType.includes('application/json') || response.status >= 400
        ? (typeof response.data === 'string' ? response.data : JSON.stringify(response.data))
        : Uint8Array.from(atob(response.data as string), (c) => c.charCodeAt(0));
    return new Response([204, 205, 304].includes(response.status) ? null : bodyData, {
        status: response.status, headers: response.headers,
    });
};

// youtubei's web entry has no Node imports and uses the real WebView for its
// player interpreter. No desktop utility process is needed on the phone.
Platform.shim.eval = async (data) => new Function(data.output)();
Parser.setParserErrorHandler(() => {});
let youtube: Promise<Innertube> | undefined;
function yt() {
    return youtube ??= Innertube.create({ fetch: nativeFetch }).catch((error) => {
        youtube = undefined;
        throw error;
    });
}

export async function search(query: string, provider: MusicProvider): Promise<Song[]> {
    return searchMusicSongs(async () => (await yt()).music, new Set<string>(), query, provider);
}

export async function videoStream(videoId: string): Promise<VideoStreamInfo> {
    if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid YouTube video ID.');
    const tube = await yt();
    const token = await (await import('./potoken')).mintPoToken(videoId);
    const info = await tube.getInfo(videoId, { client: 'YTMUSIC' }).catch(() => tube.getBasicInfo(videoId, { client: 'YTMUSIC' }));
    const adaptive = info.streaming_data?.adaptive_formats ?? [];
    const muxed = info.streaming_data?.formats ?? [];

    const vp9 = adaptive
        .filter((f: any) => f.has_video && !f.has_audio && f.mime_type?.includes('video/webm') && (f.height ?? 0) <= 720)
        .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const mp4Video = adaptive
        .filter((f: any) => f.has_video && !f.has_audio && f.mime_type?.includes('video/mp4') && (f.height ?? 0) <= 720)
        .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const progVideo = muxed
        .filter((f: any) => f.has_video && f.has_audio)
        .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0));

    const videoFmt = progVideo[0] ?? vp9[0] ?? mp4Video[0];
    if (!videoFmt) throw new Error('No playable video stream was found for this song.');

    const videoUrl = `${await videoFmt.decipher(tube.session.player)}&pot=${encodeURIComponent(token)}`;
    let audioUrl: string | undefined;
    if (!videoFmt.has_audio) {
        const audioFmt = adaptive
            .filter((f: any) => f.has_audio && !f.has_video)
            .sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
        if (audioFmt) {
            audioUrl = `${await audioFmt.decipher(tube.session.player)}&pot=${encodeURIComponent(token)}`;
        }
    }

    return {
        videoId,
        videoUrl,
        audioUrl,
        width: Number(videoFmt.width) || 1280,
        height: Number(videoFmt.height) || 720,
        duration: Number(info.basic_info?.duration) || 0,
    };
}

export async function radio(seed: Song, exclude: string[] = [], downloaded = new Set<string>()): Promise<Song[]> {
    const omitted = new Set([...exclude, seed.id]);
    if (seed.id.startsWith('js:')) {
        try {
            const recommendations = await Saavn.getRecommendations({ songId: seed.id.slice(3) });
            const songs = (recommendations ?? [])
                .map((song) => saavnToSong(song, downloaded))
                .filter((song) => !omitted.has(song.id));
            if (songs.length) return songs;
        } catch (error) {
            console.warn('[radio] JioSaavn recommendations failed, falling back to YouTube Music:', error);
        }
    }

    const tube = await yt();
    let videoId = seed.id.startsWith('yt:') ? seed.id.slice(3) : null;
    if (!videoId) {
        const query = `${seed.title} ${seed.artists.map((artist) => artist.name).join(' ')}`.trim();
        const result = await tube.music.search(query, { type: 'song' });
        const candidates = ytSearchItems(result, 'song', 'songs')
            .map((item) => ytToSong(item, downloaded))
            .filter((song): song is Song => song !== null);
        const title = normalizeRadioText(seed.title);
        const artists = new Set(seed.artists.map((artist) => normalizeRadioText(artist.name)));
        const match = candidates.find((candidate) =>
            normalizeRadioText(candidate.title) === title
            && candidate.artists.some((artist) => artists.has(normalizeRadioText(artist.name))),
        );
        videoId = match?.id.startsWith('yt:') ? match.id.slice(3) : null;
    }
    if (!videoId) return [];

    const panel = await tube.music.getUpNext(videoId, true);
    return (panel?.contents ?? []).flatMap((item: any) => {
        const video = item?.video_id ? item : item?.primary ?? item?.content;
        if (!video?.video_id || omitted.has(`yt:${video.video_id}`)) return [];
        const song = ytToSong({ ...video, id: video.video_id }, downloaded);
        return song ? [song] : [];
    });
}

function normalizeRadioText(value: string) {
    return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export async function searchExtras(query: string, provider: MusicProvider): Promise<SearchExtras> {
    return searchMusicExtras(async () => (await yt()).music, query, provider);
}

export async function searchPlaylists(query: string, provider: MusicProvider) {
    return searchMusicPlaylists(async () => (await yt()).music, query, provider);
}

export async function searchAlbums(query: string, provider: MusicProvider) {
    return searchMusicAlbums(async () => (await yt()).music, query, provider);
}

export async function searchVideos(query: string) {
    return searchMusicVideos(async () => (await yt()).music, new Set<string>(), query);
}

export async function artist(idOrQuery: string, nameHint?: string, downloaded = new Set<string>()): Promise<ArtistDetails> {
    return fetchArtistDetails(async () => (await yt()).music, downloaded, idOrQuery, nameHint);
}

export async function artistSongs(artistId: string, nameHint?: string, downloaded = new Set<string>()): Promise<Song[]> {
    return fetchArtistAllSongs(async () => (await yt()).music, downloaded, artistId, nameHint);
}

export async function collection(id: string, downloaded = new Set<string>()): Promise<CollectionDetails> {
    return fetchCollectionDetails(async () => (await yt()).music, downloaded, id);
}

export async function suggestions(query: string): Promise<string[]> {
    const sections = await (await yt()).music.getSearchSuggestions(query);
    return (sections?.[0]?.contents ?? []).flatMap((s) => {
        const suggestion = (s as { suggestion?: { text?: string } }).suggestion?.text;
        return suggestion ? [suggestion] : [];
    });
}

export interface AudioCandidate { url: string; mimetype: string; contentLength?: number }

function audioOrder<T>(formats: T[], quality: AudioQuality, bitrate: (format: T) => number): T[] {
    const best = chooseAudioFormat(formats, quality, bitrate);
    const cap = MAX_BITRATE_KBPS[quality];
    const rank = (value: number) => value <= cap ? -value : value;
    return [...new Set([...(best ? [best] : []), ...formats.toSorted((a, b) => rank(bitrate(a)) - rank(bitrate(b)))])];
}

export async function* resolveAudioCandidates(id: string, quality: AudioQuality = 'best'): AsyncGenerator<AudioCandidate> {
    if (id.startsWith('js:')) {
        const song = (await Saavn.getById({ songIds: id.slice(3) })).songs?.[0];
        const encrypted = song?.media?.encryptedUrl;
        if (!encrypted) throw new Error('JioSaavn did not return audio for this song.');
        const formats = await Saavn.experimental.fetchStreamUrls(encrypted, 'edge', true);
        for (const format of audioOrder(formats, quality, (value) => Number.parseInt(value.bitrate, 10))) {
            yield { url: format.url, mimetype: 'audio/mp4' };
        }
        return;
    }
    if (!/^yt:[\w-]{11}$/.test(id)) throw new Error('This song is not available on the phone. Import its audio file first.');
    const videoId = id.slice(3);
    const tube = await yt();
    for (const client of ['TV_SIMPLY', 'MWEB', 'WEB_EMBEDDED', 'VISIONOS', 'YTMUSIC', 'WEB', 'ANDROID_VR'] as const) {
        try {
            const info = await tube.getBasicInfo(videoId, { client });
            const data = info.streaming_data;
            if (!data) continue;
            const audio = data.adaptive_formats.filter((format) => format.has_audio && !format.has_video);
            const mp4 = audio.filter(({ mime_type }) => mime_type.includes('audio/mp4'));
            const muxed = data.formats.filter(({ has_audio, mime_type }) => has_audio && mime_type.includes('video/mp4'));
            const options = [...new Set([
                ...audioOrder(mp4, quality, (format) => format.bitrate / 1000),
                ...audioOrder(audio, quality, (format) => format.bitrate / 1000),
            ])].slice(0, 4).concat(muxed.slice(0, 1))
                .filter((format) => format.url || format.signature_cipher || format.cipher);
            if (!options.length) continue;
            const token = client === 'YTMUSIC' || client === 'WEB'
                ? await (await import('./potoken')).mintPoToken(videoId) : null;
            for (const format of options) {
                try {
                    const url = await format.decipher(tube.session.player);
                    // Keep the provider's signed query intact. Range requests,
                    // when needed, are sent in HTTP headers by the player.
                    yield {
                        url: token ? `${url}&pot=${encodeURIComponent(token)}` : url,
                        mimetype: format.mime_type.split(';')[0],
                        contentLength: Number(format.content_length ?? new URL(url).searchParams.get('clen')) || undefined,
                    };
                } catch {
                    // Try the next format if this player signature is unusable.
                }
            }
        } catch {
            // Player clients differ in regional availability and returned formats.
        }
    }
}

export async function lyrics(track: Song): Promise<string | null> {
    const lrc = await fetchLrclib(track);
    if (lrc?.wordSynced) return lrc.wordSynced;
    if (lrc?.synced) return lrc.synced;
    return lrc?.plain ?? track.lyrics ?? null;
}
