import { decode, encode } from '@msgpack/msgpack';
import type { JSZipObject } from 'jszip';
import type { Artist, Song, Thumbnail } from './schema';

export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
export const BACKUP_AUDIO_LIMIT_MESSAGE = 'Offline audio exceeds the 512 MiB backup limit.';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MANIFEST = 'zeta.msgpack';
const AUDIO_TYPES: Record<string, string> = {
    m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', flac: 'audio/flac',
    ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm',
};

export interface BackupPlaylist {
    id: string;
    name: string;
    createdAt: number;
    thumbnail?: string;
    trackIds: string[];
}

export interface BackupEvent {
    songId: string;
    timestamp: number;
    playTimeMs: number;
}

interface BackupSong {
    song: Song;
    audio?: string;
}

export interface BackupSongName {
    title: string;
    artists: string[];
    thumbnailUrl?: string;
}

export interface BackupManifest {
    songs: BackupSong[];
    favourites: string[];
    playlists: BackupPlaylist[];
    events: BackupEvent[];
    names?: Record<string, BackupSongName>;
}

export interface BackupCounts {
    songs: number;
    playlists: number;
    liked: number;
}

export function backupCounts(data: BackupManifest): BackupCounts {
    return { songs: data.songs.length, playlists: data.playlists.length, liked: data.favourites.length };
}

export function mergeBackupEvents(existing: BackupEvent[], incoming: BackupEvent[]): BackupEvent[] {
    const key = (e: BackupEvent) => JSON.stringify([e.songId, e.timestamp, e.playTimeMs]);
    const seen = new Set(existing.map(key));
    return incoming.filter((event) => {
        const id = key(event);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

export function backupImage(url?: string, includeEmbedded = true): string | undefined {
    if (typeof url !== 'string') return undefined;
    // Keep remote artwork URLs portable across desktop and Android. Older
    // libraries can contain http thumbnails even though new providers prefer
    // https; dropping those made playlist covers disappear after sync.
    if (/^https?:\/\//i.test(url)) return url;
    if (includeEmbedded && /^data:image\/(?:jpeg|png|webp|gif|avif);base64,[a-z0-9+/]+=*$/i.test(url)) return url;
    return undefined;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function cleanThumbnails(value: unknown, embedded: boolean): Thumbnail[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((thumb: Thumbnail | null) => {
        if (!thumb) return [];
        const url = backupImage(thumb.url, embedded);
        const data = embedded && thumb.data instanceof Uint8Array && thumb.data.length ? thumb.data : undefined;
        if (!url && !data) return [];
        const mimetype = /^image\/(?:jpeg|png|webp|gif|avif)$/i.test(thumb.mimetype ?? '') ? thumb.mimetype : 'image/jpeg';
        return [{ url, data, mimetype, width: Number(thumb.width) || undefined, height: Number(thumb.height) || undefined }];
    });
}

function cleanArtists(value: unknown, embedded: boolean): Artist[] {
    return Array.isArray(value) ? value.filter((artist) => artist && typeof artist.name === 'string')
        .map((artist) => ({ id: text(artist.id) || undefined, name: artist.name, thumbnails: cleanThumbnails(artist.thumbnails, embedded) })) : [];
}

function cleanSong(song: Song, embedded = true): Song {
    if (!song || typeof song.id !== 'string' || !/^(yt|js|local|fs):[^\x00-\x1f\x7f]+$/.test(song.id) ||
        song.id.length > 2048 || /^(local|fs):([/\\]|[a-z]:)/i.test(song.id) ||
        song.id.slice(song.id.indexOf(':') + 1).split(/[/\\]/).includes('..')) {
        throw new Error('The backup contains an invalid song ID.');
    }
    const album = song.album;
    return {
        id: song.id, title: text(song.title) || 'Untitled', artists: cleanArtists(song.artists, embedded),
        album: album && typeof album.title === 'string' ? {
            title: album.title, id: text(album.id) || undefined, year: text(album.year) || undefined,
            artists: cleanArtists(album.artists, embedded), thumbnails: cleanThumbnails(album.thumbnails, embedded),
        } : null,
        thumbnails: cleanThumbnails(song.thumbnails, embedded),
        duration: Number.isFinite(song.duration) ? Math.max(0, song.duration) : 0,
        year: text(song.year) || undefined, lyrics: text(song.lyrics) || undefined, isDownloaded: false,
    };
}

export function audioExtension(path: string): string | undefined {
    const extension = path.split('.').at(-1)?.toLowerCase();
    return extension && Object.hasOwn(AUDIO_TYPES, extension) ? extension : undefined;
}

export async function backupPlaylistId(id: string): Promise<string> {
    if (/^zeta-restore-[a-f0-9]{64}\.m3u8$/.test(id)) return id;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
    const key = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `zeta-restore-${key}.m3u8`;
}

export function backupAudioMime(path: string): string {
    return AUDIO_TYPES[audioExtension(path) ?? 'm4a'];
}

interface ZipByteStream {
    on(event: 'data', listener: (bytes: Uint8Array) => void): ZipByteStream;
    on(event: 'error', listener: (error: Error) => void): ZipByteStream;
    on(event: 'end', listener: () => void): ZipByteStream;
    pause(): void;
    resume(): void;
}

/** Read ZIP entries with a limit on expanded data, including misleading ZIP headers. */
export function readBackupEntry(file: JSZipObject, limit: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const stream = (file as JSZipObject & {
            internalStream(type: 'uint8array'): ZipByteStream;
        }).internalStream('uint8array');
        const chunks: Uint8Array[] = [];
        let size = 0;
        stream.on('data', (chunk: Uint8Array) => {
            size += chunk.byteLength;
            if (size > limit) {
                stream.pause();
                reject(new Error('The backup exceeds the supported size.'));
            } else {
                chunks.push(chunk);
            }
        }).on('error', reject).on('end', () => {
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            resolve(bytes);
        }).resume();
    });
}

export async function makeZetaBackup(
    data: BackupManifest,
    getAudio: (entry: BackupSong) => Promise<Uint8Array | undefined>,
    includeArtwork = true,
): Promise<Uint8Array> {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const songs: BackupSong[] = [];
    let size = 0;
    for (const entry of data.songs) {
        const extension = entry.audio && audioExtension(entry.audio);
        const bytes = extension ? await getAudio(entry) : undefined;
        const audio = bytes?.length ? `audio/${songs.length}.${extension}` : undefined;
        if (audio && bytes) {
            size += bytes.length;
            if (size >= MAX_BACKUP_BYTES) throw new Error(BACKUP_AUDIO_LIMIT_MESSAGE);
            zip.file(audio, bytes);
        }
        songs.push({ song: cleanSong(entry.song, includeArtwork), audio });
    }
    const encodeManifest = (content: BackupManifest) => encode({ version: 1, ...content }, { ignoreUndefined: true });
    let manifest = encodeManifest({ ...data, songs });
    if (manifest.length > MAX_MANIFEST_BYTES || manifest.length + size > MAX_BACKUP_BYTES) {
        manifest = encodeManifest({
            ...data,
            songs: songs.map(({ song, audio }) => ({ song: cleanSong(song, false), audio })),
            playlists: data.playlists.map((list) => ({ ...list, thumbnail: backupImage(list.thumbnail, false) })),
            names: data.names && Object.fromEntries(Object.entries(data.names).map(([id, name]) =>
                [id, { ...name, thumbnailUrl: backupImage(name.thumbnailUrl, false) }],
            )),
        });
    }
    if (manifest.length > MAX_MANIFEST_BYTES) throw new Error('The library metadata exceeds the 16 MiB backup limit.');
    if (manifest.length + size > MAX_BACKUP_BYTES) throw new Error(BACKUP_AUDIO_LIMIT_MESSAGE);
    zip.file(MANIFEST, manifest, { compression: 'DEFLATE' });
    const result = await zip.generateAsync({ type: 'uint8array' });
    if (result.length > MAX_BACKUP_BYTES) throw new Error(BACKUP_AUDIO_LIMIT_MESSAGE);
    return result;
}

export async function openZetaBackup(bytes: Uint8Array) {
    if (bytes.length > MAX_BACKUP_BYTES) throw new Error('The backup exceeds 512 MiB.');
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(bytes);
    const file = zip.file(MANIFEST);
    if (!file) throw new Error('This file is not a Zeta backup.');
    const manifestBytes = await readBackupEntry(file, MAX_MANIFEST_BYTES);
    const data = decode(manifestBytes) as BackupManifest & { version: number };
    if (data?.version !== 1 || ![data.songs, data.playlists, data.favourites, data.events].every(Array.isArray)) {
        throw new Error('Unsupported Zeta backup format.');
    }
    const songs = data.songs.map((entry, index) => {
        const song = cleanSong(entry.song);
        const audio = entry.audio;
        if (audio !== undefined && (typeof audio !== 'string' || audio !== `audio/${index}.${audioExtension(audio)}` ||
            !audioExtension(audio) || !zip.file(audio))) throw new Error('The backup contains an invalid audio entry.');
        return { song, audio };
    });
    const ids = new Set(songs.map(({ song }) => song.id));
    if (ids.size !== songs.length) throw new Error('The backup contains duplicate song IDs.');
    const playlists = data.playlists.map((playlist) => {
        if (!playlist || typeof playlist.id !== 'string' || !Array.isArray(playlist.trackIds)) {
            throw new Error('The backup contains an invalid playlist.');
        }
        return { id: playlist.id, name: text(playlist.name) || 'Imported playlist', createdAt: Number(playlist.createdAt) || 0,
            thumbnail: backupImage(playlist.thumbnail), trackIds: playlist.trackIds.filter((id) => ids.has(id)) };
    });
    const events = data.events.filter((event) => event && typeof event.songId === 'string' &&
        Number.isFinite(event.timestamp) && Number.isFinite(event.playTimeMs) && event.playTimeMs >= 0);
    const eventIds = new Set(events.map(({ songId }) => songId));
    const names = Object.fromEntries(Object.entries(data.names ?? {}).flatMap(([id, name]) =>
        eventIds.has(id) && /^(yt|js|local|fs):/.test(id) && name && Array.isArray(name.artists)
            ? [[id, { title: text(name.title), artists: name.artists.filter((artist) => typeof artist === 'string'),
                thumbnailUrl: backupImage(name.thumbnailUrl) }]]
            : [],
    ));
    let remaining = MAX_BACKUP_BYTES - manifestBytes.length;
    return {
        manifest: { songs, playlists, favourites: data.favourites.filter((id) => ids.has(id)), events, names } satisfies BackupManifest,
        async readAudio(audio: string): Promise<Uint8Array> {
            const bytes = await readBackupEntry(zip.file(audio)!, remaining);
            if (!bytes.length) throw new Error('The backup contains empty audio.');
            remaining -= bytes.length;
            return bytes;
        },
    };
}
