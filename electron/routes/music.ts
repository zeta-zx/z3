import { Innertube, Platform, type Types } from 'youtubei.js';
import { Song as Saavn } from '@saavn-labs/sdk';

import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import type { Playlist, Song, Stream, Library, Thumbnail, MusicProvider } from '../../src/lib/schema';
import { updateThumbnailUrl } from '../../src/lib/utils';
import { COVER_SCHEME, coverUrl } from '../../src/lib/covers';

import { createVFS, type VFS } from '../lib/vfs';
import { getConfig, saveConfig } from '../lib/config';
import { mintPoToken } from '../lib/potoken';
import { MetadataStore, embedMp4Tags, readAudioTags, type IndexRecord } from '../lib/metadata';
import { buildMuzzaBackup, parseMuzzaBackup, readMuzzaEventsFromDb, type MuzzaEvent } from '../lib/muzza';
import { StatsStore } from '../lib/stats';

const DEBUG = !!process.env.ZETA_DEBUG;
function log(...args: any[]) {
    if (DEBUG) console.log(...args);
}

// Extensions Zeta recognises as playable audio. `.m4a` is what new downloads
// use; the rest are accepted so pre-rewrite libraries (e.g. `.mp3`) keep working.
const AUDIO_EXTENSIONS = ['.m4a', '.mp4', '.mp3', '.flac', '.ogg', '.opus', '.wav', '.aac', '.webm'];

/** Best-effort audio MIME type from a filename extension. */
function audioMimetype(file: string): string {
    const dot = file.lastIndexOf('.');
    switch (dot === -1 ? '' : file.slice(dot).toLowerCase()) {
        case '.mp3':
            return 'audio/mpeg';
        case '.flac':
            return 'audio/flac';
        case '.ogg':
        case '.opus':
            return 'audio/ogg';
        case '.wav':
            return 'audio/wav';
        case '.aac':
            return 'audio/aac';
        case '.webm':
            return 'audio/webm';
        default:
            return 'audio/mp4';
    }
}

/* -------------------------------------------------------------------------- */
/*                              storage bootstrap                             */
/* -------------------------------------------------------------------------- */

let vfs: VFS;
let metadata: MetadataStore;
let stats: StatsStore;
let storageReady: Promise<void> | null = null;

// Where an imported Muzza backup is preserved so a later export can carry over
// everything Zeta doesn't itself model (settings, history, search history, …).
const MUZZA_BASE_DB = '.zeta/muzza/base.db';
const MUZZA_BASE_SETTINGS = '.zeta/muzza/settings.preferences_pb';

async function initStorage(): Promise<void> {
    const created = await createVFS(getConfig().musicDir);
    if (vfs) await vfs.dispose().catch(() => {});
    vfs = created;
    if (metadata) metadata.setVfs(vfs);
    else metadata = new MetadataStore(vfs);
    if (stats) stats.setVfs(vfs);
    else stats = new StatsStore(vfs);
    // Make sure the root directory exists (esp. for freshly-configured remotes).
    await vfs.mkdir('').catch(() => {});
}

/** Read the preserved Muzza base DB + settings, if the user imported one. */
async function readMuzzaBase(): Promise<{ db: Buffer; settings: Buffer | null } | null> {
    if (!(await vfs.exists(MUZZA_BASE_DB))) return null;
    const db = await vfs.readFile(MUZZA_BASE_DB);
    const settings = (await vfs.exists(MUZZA_BASE_SETTINGS)) ? await vfs.readFile(MUZZA_BASE_SETTINGS) : null;
    return { db, settings };
}

function ensureStorage(): Promise<void> {
    // Don't cache a failure: a transient error (e.g. remote unreachable at
    // startup) would otherwise break every route until the app restarts.
    if (!storageReady) storageReady = initStorage().catch((err) => {
        storageReady = null;
        throw err;
    });
    return storageReady;
}

async function reloadStorage(): Promise<void> {
    storageReady = initStorage();
    await storageReady;
}

/* -------------------------------------------------------------------------- */
/*                                  youtube                                   */
/* -------------------------------------------------------------------------- */

let yt: Innertube;
let ytReady: Promise<Innertube> | null = null;

async function init() {
    await ensureStorage();
    if (!yt) {
        ytReady ??= Innertube.create({}).catch((err) => {
            ytReady = null;
            throw err;
        });
        yt = await ytReady;
    }
}

Platform.shim.eval = async (data: Types.BuildScriptResult) => new Function(data.output)();

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

function splitId(id: string): { protocol: string; cleanId: string } {
    const [protocol, ...rest] = id.split(':');
    return { protocol, cleanId: rest.join(':') };
}

function sanitiseFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '');
}

function buildFilename(title: string, artist: string, id: string): string {
    let base = sanitiseFilename(oneLine(`${title}${artist ? ` | ${artist}` : ''}`)) || 'Untitled';
    // Stay well under the common 255-byte filename limit (multi-byte titles!).
    while (Buffer.byteLength(base) > 150) base = base.slice(0, -1);
    base = base.replace(/[. ]+$/, '') || 'Untitled';
    return `${base} [${id.replaceAll(':', '_')}].m4a`;
}

function isAudioFile(name: string): boolean {
    return AUDIO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

// Bytes per ranged request when pulling audio off the CDN. YouTube throttles or
// rejects unbounded GETs, so we page through the file in chunks (mirroring what
// the web player does).
const YT_STREAM_CHUNK = 5 * 1024 * 1024;

/**
 * Stream a deciphered googlevideo URL by paging through it with `&range=`
 * requests. Returns a WHATWG `ReadableStream` so callers can treat it exactly
 * like the stream `yt.download()` used to hand back.
 */
function streamRangedUrl(url: string, contentLength: number): ReadableStream<Uint8Array> {
    let position = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (position >= contentLength) {
                controller.close();
                return;
            }
            const end = Math.min(position + YT_STREAM_CHUNK - 1, contentLength - 1);
            const res = await fetch(`${url}&range=${position}-${end}`);
            if (!res.ok) {
                controller.error(new Error(`YouTube stream returned ${res.status} for range ${position}-${end}`));
                return;
            }
            const chunk = new Uint8Array(await res.arrayBuffer());
            if (chunk.length === 0) {
                controller.close();
                return;
            }
            controller.enqueue(chunk);
            position += chunk.length;
        },
    });
}

/**
 * Download YouTube audio, preferring a real MP4/AAC (M4A) stream.
 *
 * YouTube gates its media CDN behind BotGuard: a bare `videoplayback` GET now
 * 403s (surfacing as `FETCH_FAILED`), and the old `ANDROID_VR` bypass is dead.
 * So instead of `yt.download()` we resolve the format ourselves, decipher its
 * URL, and append a per-video PoToken (`&pot=`) — the only combination that
 * reliably fetches audio, including for tracks that otherwise fail on every
 * client. See {@link mintPoToken}.
 *
 * `quality: 'best'` alone can hand back WebM/Opus, which we'd then save as
 * `.m4a` — a mislabelled container that won't play everywhere and that TagLib
 * can't tag. We ask for `mp4` first and only fall back to any container.
 */
async function downloadYtAudio(videoId: string): Promise<ReadableStream<Uint8Array>> {
    // Prefer YouTube Music's client (clean audio-only formats), then plain web.
    const clients: Array<'YTMUSIC' | 'WEB'> = ['YTMUSIC', 'WEB'];
    const formatAttempts: Array<Record<string, unknown>> = [
        { type: 'audio', quality: 'best', format: 'mp4' },
        { type: 'audio', quality: 'best' },
    ];

    const pot = await mintPoToken(videoId);
    let lastErr: any;

    for (const client of clients) {
        let info;
        try {
            info = await yt.getBasicInfo(videoId, { client });
        } catch (err: any) {
            if (err?.info?.error_type === 'UNPLAYABLE' || /unplayable/i.test(String(err?.message))) throw err;
            lastErr = err;
            continue;
        }

        for (const opts of formatAttempts) {
            try {
                const format = info.chooseFormat(opts as any);
                const url = `${await format.decipher(yt.session.player)}&pot=${pot}`;
                const contentLength = Number(format.content_length) || 0;
                if (!contentLength) {
                    // Without a known length we can't page ranges; fetch whole.
                    const res = await fetch(`${url}`);
                    if (!res.ok || !res.body) throw new Error(`YouTube stream returned ${res.status}`);
                    return res.body;
                }
                return streamRangedUrl(url, contentLength);
            } catch (err: any) {
                lastErr = err;
            }
        }
    }
    throw lastErr ?? new Error(`Could not resolve a playable audio format for ${videoId}`);
}

async function webStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

function pickBestThumbnail(thumbnails: Thumbnail[]): Thumbnail | undefined {
    return [...(thumbnails || [])].sort((a, b) => (a.width ?? a.height ?? 0) - (b.width ?? b.height ?? 0)).at(-1);
}

/**
 * Resolve cover-art bytes for embedding. Prefers already-fetched thumbnail data,
 * then tries a series of candidate URLs (best-first), falling through on failure.
 *
 * For YouTube we prepend `i.ytimg.com` JPEG thumbnails: they're reliable, always
 * present (hqdefault), and — unlike the WebP thumbnails YouTube Music search
 * returns — embed as cover art that music players actually render. This is why
 * some downloads previously ended up with no visible artwork.
 */
async function resolveCover(
    thumbnails: Thumbnail[],
    ytVideoId?: string,
): Promise<{ data: Uint8Array; mimetype: string } | null> {
    const withData = (thumbnails || []).find((t) => t.data?.length);
    if (withData?.data) return { data: withData.data, mimetype: withData.mimetype || 'image/jpeg' };

    const candidates: string[] = [];
    if (ytVideoId) {
        candidates.push(`https://i.ytimg.com/vi/${ytVideoId}/maxresdefault.jpg`);
        candidates.push(`https://i.ytimg.com/vi/${ytVideoId}/hqdefault.jpg`);
    }
    const best = pickBestThumbnail(thumbnails);
    if (best?.url) candidates.push(updateThumbnailUrl(best.url));
    for (const t of thumbnails || []) if (t.url) candidates.push(updateThumbnailUrl(t.url));

    const seen = new Set<string>();
    for (const url of candidates) {
        if (!url || seen.has(url)) continue;
        seen.add(url);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
            if (!res.ok) continue;
            const data = new Uint8Array(await res.arrayBuffer());
            if (data.length === 0) continue;
            const ct = res.headers.get('Content-Type') || '';
            return { data, mimetype: ct.startsWith('image/') ? ct : 'image/jpeg' };
        } catch {
            /* try next candidate */
        }
    }
    return null;
}

/**
 * Save an already-fetched, indexed (off-disk) song to disk so future plays are
 * local. The file write + index update are awaited (so the caller can report it
 * saved); native MP4 tag embedding + cover fetch run in the background so they
 * don't delay playback.
 */
async function persistLibrarySong(id: string, record: IndexRecord, audio: Buffer): Promise<void> {
    const { protocol, cleanId } = splitId(id);

    const file = buildFilename(record.title, record.artists[0]?.name ?? '', id);
    await vfs.writeFile(file, audio);
    record.file = file;
    await metadata.upsert(record);
    log(`Saved streamed library song ${id} -> ${file}`);

    if (!vfs.isLocal) return; // remote stores rely on the index only
    const local = vfs.localPath(file);
    if (!local) return;

    // Embed tags + artwork in the background.
    void (async () => {
        try {
            const cover = await resolveCover(record.thumbnails, protocol === 'yt' ? cleanId : undefined);
            await embedMp4Tags(local, {
                title: record.title,
                artists: record.artists.map((a) => a.name),
                album: record.album?.title,
                year: record.year,
                lyrics: record.lyrics,
                cover,
            });
            if (cover && !record.thumbnails.some((t) => t.data)) {
                record.thumbnails = [...record.thumbnails, { data: cover.data, mimetype: cover.mimetype }];
                await metadata.upsert(record);
            }
        } catch (err) {
            console.warn('[metadata] Background tag embed failed:', err);
        }
    })();
}

/* --------------------------- playlist file model -------------------------- */

interface PlaylistMeta {
    name: string;
    isProtected: boolean;
    thumbnail: string;
    /** Epoch ms. Stored in the header because file birth/mtime are unreliable. */
    createdAt?: number;
}

/** One track reference in a playlist file, kept verbatim so rewrites are lossless. */
interface PlaylistEntry {
    /** Canonical id from `#EXTINF-ZETA`, if present. */
    id: string | null;
    /** The raw resource line (file path or id). */
    resource: string;
    /** All lines making up this entry (directives + resource), exactly as read. */
    block: string;
}

interface ParsedPlaylist {
    meta: PlaylistMeta;
    entries: PlaylistEntry[];
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

/** Playlist ids are bare `.m3u8` filenames in the music directory root. */
function assertPlaylistId(id: string) {
    if (typeof id !== 'string' || !id.endsWith('.m3u8') || /[\\/]/.test(id) || id.startsWith('.')) {
        throw new Error(`Invalid playlist id: ${id}`);
    }
}

// Serialise every read-modify-write of a given playlist file, so concurrent
// adds/removes/reorders can't clobber each other.
const playlistLocks = new Map<string, Promise<unknown>>();
function withPlaylistLock<T>(filename: string, fn: () => Promise<T>): Promise<T> {
    const previous = playlistLocks.get(filename) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    playlistLocks.set(filename, tail);
    tail.then(() => {
        if (playlistLocks.get(filename) === tail) playlistLocks.delete(filename);
    });
    return run;
}

/** Build the resource + #EXTINF lines used to represent a song in an m3u8 file. */
function playlistLinesForSong(song: Song, record?: IndexRecord): string {
    const artist = oneLine(song.artists.map((a) => a.name).join(', '));
    const extinf = `#EXTINF:${Math.round(song.duration || 0)},${artist} - ${oneLine(song.title)}`;
    // Downloaded songs are referenced by their file so external players work too.
    // Fall back to the file encoded in a `local:` id even when it isn't indexed,
    // so legacy tracks aren't lost when a playlist is rewritten.
    let resource: string;
    if (record?.file) resource = `./${record.file}`;
    else if (song.id.startsWith('local:')) resource = `./${song.id.slice('local:'.length)}`;
    else resource = song.id;
    return `#EXTINF-ZETA:${song.id}\n${extinf}\n${resource}`;
}

async function songForPlaylistLine(resource: string, knownId: string | null): Promise<Song | null> {
    const trimmed = resource.trim();
    if (!trimmed) return null;

    // Prefer the canonical id captured from the #EXTINF-ZETA directive.
    if (knownId) {
        const record = await metadata.get(knownId);
        if (record) return MetadataStore.toSong(record);
    }

    // A file reference (downloaded track): "./file", "file.mp3" or "local:file.mp3".
    if (trimmed.startsWith('./') || trimmed.startsWith('local:') || isAudioFile(trimmed)) {
        const file = trimmed.replace(/^\.\//, '').replace(/^local:/, '');
        const record = await metadata.getByFile(file);
        if (record) return MetadataStore.toSong(record);

        // File exists but isn't indexed: read its embedded tags (local only).
        if (vfs.isLocal && (await vfs.exists(file))) {
            const local = vfs.localPath(file);
            const tags = local ? await readAudioTags(local) : null;
            if (tags) {
                return {
                    id: `local:${file}`,
                    title: tags.title || file,
                    thumbnails: tags.thumbnails,
                    artists: tags.artists,
                    album: tags.album,
                    duration: tags.duration,
                    year: tags.year,
                    lyrics: tags.lyrics,
                    isDownloaded: true,
                };
            }
        }
        return null;
    }

    // A bare canonical id (off-disk / not downloaded).
    const record = await metadata.get(trimmed);
    if (record) return MetadataStore.toSong(record);

    // Nothing indexed — we cannot rebuild rich metadata, so drop it.
    return null;
}

/** Parse playlist text into its header meta and verbatim track entries. */
function parsePlaylistText(filename: string, content: string): ParsedPlaylist {
    const meta: PlaylistMeta = {
        name: filename.replace('.m3u8', ''),
        isProtected: filename === 'favourites.m3u8',
        thumbnail: '',
    };

    const entries: PlaylistEntry[] = [];
    let pendingId: string | null = null;
    let pendingLines: string[] = [];

    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXTZETA:')) {
            try {
                const parsed = JSON.parse(line.substring('#EXTZETA:'.length));
                meta.name = parsed.name ?? meta.name;
                meta.isProtected = parsed.isProtected ?? meta.isProtected;
                meta.thumbnail = parsed.thumbnail ?? meta.thumbnail;
                if (typeof parsed.createdAt === 'number') meta.createdAt = parsed.createdAt;
            } catch {
                /* ignore malformed header */
            }
        } else if (line === '#EXTM3U') {
            /* file header */
        } else if (line.startsWith('#')) {
            if (line.startsWith('#EXTINF-ZETA:')) pendingId = line.substring('#EXTINF-ZETA:'.length).trim();
            pendingLines.push(line);
        } else {
            entries.push({ id: pendingId, resource: line, block: [...pendingLines, line].join('\n') });
            pendingId = null;
            pendingLines = [];
        }
    }

    return { meta, entries };
}

async function readParsedPlaylist(filename: string): Promise<ParsedPlaylist> {
    return parsePlaylistText(filename, (await vfs.readFile(filename)).toString('utf-8'));
}

/** Resolve each entry to a song (null when it can't be resolved right now). */
async function resolveEntries(entries: PlaylistEntry[]): Promise<Array<{ entry: PlaylistEntry; song: Song | null }>> {
    const out = [];
    for (const entry of entries) out.push({ entry, song: await songForPlaylistLine(entry.resource, entry.id) });
    return out;
}

/** The id an entry refers to, whether or not it currently resolves. */
function entryId(entry: PlaylistEntry, song: Song | null): string {
    return song?.id ?? entry.id ?? entry.resource;
}

/** When a playlist was created: header, then the `_<ms>.m3u8` suffix, then stat. */
async function playlistCreatedAt(filename: string, meta: PlaylistMeta): Promise<number> {
    if (meta.createdAt) return meta.createdAt;
    const fromName = filename.match(/_(\d{12,14})\.m3u8$/);
    if (fromName) return Number(fromName[1]);
    try {
        const stat = await vfs.stat(filename);
        return stat.birthtimeMs || stat.mtimeMs || 0;
    } catch {
        return 0; // stat may be unavailable on some remotes
    }
}

async function readPlaylistFile(filename: string): Promise<Playlist> {
    const { meta, entries } = await readParsedPlaylist(filename);
    const tracks = (await resolveEntries(entries)).map((r) => r.song).filter((s): s is Song => !!s);

    return {
        id: filename,
        name: meta.name,
        tracks,
        createdAt: await playlistCreatedAt(filename, meta),
        isProtected: meta.isProtected,
        thumbnail: meta.thumbnail || firstTrackCover(tracks[0]),
    };
}

/**
 * A displayable image URL for a song: its best web thumbnail, else a
 * zeta-cover:// reference to its embedded cover.
 */
function songImageUrl(songId: string, thumbnails: Thumbnail[] | undefined): string | undefined {
    const withUrl = pickBestThumbnail((thumbnails ?? []).filter((t) => t.url));
    if (withUrl?.url) return withUrl.url;
    return thumbnails?.some((t) => t.data?.length) ? coverUrl(songId) : undefined;
}

/** A playlist without its own image shows its first track's cover. */
function firstTrackCover(track: Song | undefined): string | undefined {
    return track ? songImageUrl(track.id, track.thumbnails) : undefined;
}

function playlistHeader(meta: PlaylistMeta): string {
    return `#EXTM3U\n#EXTZETA:${JSON.stringify(meta)}\n`;
}

/** Rewrite a playlist file from its header meta and verbatim entry blocks. */
async function writePlaylistEntries(filename: string, meta: PlaylistMeta, blocks: string[]): Promise<void> {
    await vfs.writeFile(filename, playlistHeader(meta) + blocks.map((b) => `${b}\n`).join(''));
}

/** Rewrite a playlist file from an ordered list of songs (used for freshly-built playlists). */
async function writePlaylist(filename: string, songs: Song[], meta: PlaylistMeta): Promise<void> {
    const blocks: string[] = [];
    for (const song of songs) blocks.push(playlistLinesForSong(song, await metadata.get(song.id)));
    await writePlaylistEntries(filename, meta, blocks);
}

async function readPlaylistMeta(filename: string): Promise<PlaylistMeta> {
    try {
        return (await readParsedPlaylist(filename)).meta;
    } catch {
        return { name: filename.replace('.m3u8', ''), isProtected: filename === 'favourites.m3u8', thumbnail: '' };
    }
}

/** Update only the header of a playlist, leaving every entry untouched. */
async function updatePlaylistMeta(filename: string, update: (meta: PlaylistMeta) => void): Promise<void> {
    const { meta, entries } = await readParsedPlaylist(filename);
    update(meta);
    await writePlaylistEntries(filename, meta, entries.map((e) => e.block));
}

async function ensureFavourites(): Promise<void> {
    if (await vfs.exists('favourites.m3u8')) return;
    await vfs.writeFile(
        'favourites.m3u8',
        playlistHeader({ name: 'Favourites', isProtected: true, thumbnail: '', createdAt: Date.now() }),
    );
}

/* ------------------------- legacy library migration ----------------------- */

/**
 * Recover the canonical source id from a pre-rewrite filename. The old version
 * named downloaded files like `Title | Artist [yt_VIDEOID].mp3` (or `[js_ID]`),
 * so we can restore `yt:`/`js:` ids and keep dedupe/streaming working.
 */
function parseLegacyId(filename: string): string | null {
    const m = filename.match(/\[(yt|js)_([^\]]+)\]\.[a-z0-9]+$/i);
    return m ? `${m[1].toLowerCase()}:${m[2]}` : null;
}

/**
 * Title and artist from a pre-rewrite filename, for files without tags. The old
 * scheme was `Title | Artist [yt_ID].ext`; filename sanitising later turned the
 * `|` into `_` (and e.g. `/\` into `__`).
 */
function parseLegacyName(filename: string): { title: string; artist: string | null } {
    const base = filename.replace(/\.[a-z0-9]+$/i, '').replace(/\s*\[(yt|js)_[^\]]+\]\s*$/i, '').trim();
    const split = base.match(/^(.*\S)\s+[|_]\s+(\S.*)$/);
    if (!split) return { title: base || filename, artist: null };
    return { title: split[1].trim(), artist: split[2].replace(/_{2,}/g, ' / ').trim() };
}

/** Records whose metadata came from a filename rather than real tags/sources. */
function needsMetadataRepair(record: IndexRecord): boolean {
    return /\[(yt|js)_[^\]]+\]\s*$/i.test(record.title) || record.artists[0]?.name === 'Unknown Artist' || !record.thumbnails.length;
}

/**
 * One-time (idempotent) migration: index any audio files sitting in the music
 * directory that aren't in `.zeta/index.json` yet — e.g. `.mp3`s downloaded
 * before the MP4 rewrite. Reads their tags and restores canonical ids so they
 * become first-class, de-duplicated, round-trippable library entries.
 */
async function migrateLegacyFiles(): Promise<void> {
    if (!vfs.isLocal) return; // needs random-access tag reads

    let entries;
    try {
        entries = await vfs.readdir('');
    } catch {
        return;
    }

    const all = await metadata.all();
    const indexedFiles = new Set(all.map((r) => r.file).filter((f): f is string => !!f));
    const indexedIds = new Set(all.map((r) => r.id));

    const records: IndexRecord[] = [];
    for (const entry of entries) {
        if (!entry.isFile || !isAudioFile(entry.name)) continue;
        if (indexedFiles.has(entry.name)) continue;

        const id = parseLegacyId(entry.name) ?? `local:${entry.name}`;
        if (indexedIds.has(id)) continue;

        const local = vfs.localPath(entry.name);
        const tags = local ? await readAudioTags(local) : null;
        const fromName = parseLegacyName(entry.name);

        records.push({
            id,
            file: entry.name,
            title: tags?.title || fromName.title,
            artists: tags?.artists?.length
                ? tags.artists
                : [{ name: fromName.artist ?? 'Unknown Artist', thumbnails: [] }],
            album: tags?.album ?? null,
            duration: tags?.duration ?? 0,
            year: tags?.year,
            lyrics: tags?.lyrics ?? null,
            thumbnails: tags?.thumbnails ?? [],
        });
        indexedIds.add(id);
    }

    if (records.length) {
        await metadata.upsertMany(records);
        log(`[migrate] Indexed ${records.length} pre-existing audio file(s).`);
    }
}

/* ------------------------------ lyrics sources ---------------------------- */

const LRCLIB_HEADERS = { 'User-Agent': 'Zeta Music (https://github.com/zeta-zx/z3)' };
const SYNCED_LRC = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/; // looks like [mm:ss.xx]

/** Query lrclib for a track. Prefers an exact get, then a fuzzy search. */
async function fetchLrclib(track: Song): Promise<{ synced?: string; plain?: string } | null> {
    const artist = track.artists.map((a) => a.name).join(', ');
    const enc = encodeURIComponent;

    try {
        const res = await fetch(
            `https://lrclib.net/api/get?artist_name=${enc(artist)}&track_name=${enc(track.title)}&duration=${Math.round(track.duration)}`,
            { headers: LRCLIB_HEADERS },
        );
        if (res.ok) {
            const d = (await res.json()) as any;
            if (d.syncedLyrics || d.plainLyrics) return { synced: d.syncedLyrics || undefined, plain: d.plainLyrics || undefined };
        }
    } catch {
        /* fall through to search */
    }

    try {
        const res = await fetch(`https://lrclib.net/api/search?track_name=${enc(track.title)}&artist_name=${enc(artist)}`, {
            headers: LRCLIB_HEADERS,
        });
        if (res.ok) {
            const arr = (await res.json()) as any[];
            const synced = arr.find((x) => x.syncedLyrics)?.syncedLyrics;
            const plain = arr.find((x) => x.plainLyrics)?.plainLyrics;
            if (synced || plain) return { synced: synced || undefined, plain: plain || undefined };
        }
    } catch {
        /* ignore */
    }

    return null;
}

// undefined = not yet probed, null = unavailable, string = the python command.
let pythonCmd: string | null | undefined;

/** Detect a python with the `syncedlyrics` package importable (probed once). */
async function detectSyncedLyrics(): Promise<string | null> {
    if (pythonCmd !== undefined) return pythonCmd;
    for (const cmd of ['python3', 'python']) {
        try {
            await execFileAsync(cmd, ['-c', 'import syncedlyrics'], { timeout: 8000 });
            pythonCmd = cmd;
            return cmd;
        } catch {
            /* try next */
        }
    }
    pythonCmd = null;
    return null;
}

/** Fetch synced lyrics via the python `syncedlyrics` package (broad providers). */
async function fetchSyncedLyricsPython(query: string): Promise<string | null> {
    const cmd = await detectSyncedLyrics();
    if (!cmd) return null;
    try {
        const { stdout } = await execFileAsync(
            cmd,
            ['-c', "import sys,syncedlyrics; sys.stdout.write(syncedlyrics.search(sys.argv[1], synced_only=True) or '')", query],
            { timeout: 25000, maxBuffer: 4 * 1024 * 1024 },
        );
        const out = stdout.trim();
        return out && SYNCED_LRC.test(out) ? out : null;
    } catch {
        return null;
    }
}

/** Map a JioSaavn SDK song to Zeta's {@link Song}. */
function saavnToSong(s: any, downloaded: Set<string>): Song {
    const id = `js:${s.id}`;
    const images = (list: any[] | undefined) =>
        (list ?? []).map((i) => ({
            url: i.url,
            width: parseInt(i.resolution.split('x')[0]),
            height: parseInt(i.resolution.split('x')[1]),
        }));
    return {
        id,
        title: s.title || 'Untitled Song',
        thumbnails: images(s.images),
        artists: s.artists?.all ? s.artists.all.slice(0, 3).map((a: any) => ({ name: a.name, thumbnails: images(a.images) })) : [],
        album: s.album ? { title: s.album.title || 'Untitled Album', artists: [], thumbnails: [] } : null,
        duration: s.duration || 0,
        isDownloaded: downloaded.has(id),
    };
}

/* -------------------------------------------------------------------------- */
/*                                   routes                                   */
/* -------------------------------------------------------------------------- */

export const routes = {
    /**
     * Resolve lyrics for a track, preferring time-synced (LRC) lyrics.
     *
     * Sources, in order: lrclib (exact get, then fuzzy search); then — if a
     * python with the `syncedlyrics` package is available — its aggregated
     * providers (Musixmatch, NetEase, Megalobiz, lrclib, Genius); finally any
     * plain lyrics found. Embedded lyrics stored on the track (e.g. imported
     * from Muzza) are handled on the frontend and take precedence when synced.
     */
    async musicLyrics(track: Song): Promise<string | null> {
        try {
            const lrc = await fetchLrclib(track);
            if (lrc?.synced) return lrc.synced;

            const query = `${track.title} ${track.artists.map((a) => a.name).join(' ')}`.trim();
            const synced = await fetchSyncedLyricsPython(query);
            if (synced) return synced;

            return lrc?.plain ?? null;
        } catch (err) {
            console.error('Lyrics lookup failed:', err);
            return null;
        }
    },

    async musicSearchSuggestions(query: string): Promise<string[]> {
        await init();
        const sections = await yt.music.getSearchSuggestions(query);
        return (sections?.[0]?.contents ?? [])
            .map((s: any) => s?.suggestion?.text)
            .filter((t: unknown): t is string => typeof t === 'string' && !!t);
    },

    async musicSearch(query: string, provider: MusicProvider): Promise<Song[]> {
        await ensureStorage();

        const downloaded = new Set((await metadata.all()).filter((r) => r.file).map((r) => r.id));

        switch (provider) {
            case 'yt': {
                await init();
                const res = await yt.music.search(query, { type: 'song' });

                return (res.songs?.contents || []).map((song) => {
                    const id = `yt:${song.id}`;
                    return {
                        id,
                        title: song.title || 'Untitled',
                        thumbnails: song.thumbnails.map((t) => ({ url: t.url, width: t.width, height: t.height })),
                        artists: (song.artists || []).map((a) => ({ name: a.name, thumbnails: [] })),
                        album: song.album ? { title: song.album.name, artists: [], thumbnails: [] } : null,
                        duration: song.duration?.seconds || 0,
                        isDownloaded: downloaded.has(id),
                    };
                });
            }

            case 'js': {
                const res = await Saavn.search({ query, limit: 30 });

                return res.results.map((s) => saavnToSong(s, downloaded));
            }
        }

        throw new Error(`Provider '${provider}' not supported for searching.`);
    },

    /**
     * Return playable audio bytes for a track.
     *
     * Downloaded tracks are read from the music directory. Remote (yt/js) tracks
     * are fetched from the source; if the track is part of the library (i.e. it
     * has an index record — e.g. imported from a Muzza backup or added to a
     * playlist), it is ALSO saved to disk on this first fetch so future plays are
     * local. Pure search results (no index record) stay off-disk — they only
     * live in the frontend cache until explicitly added to a playlist.
     */
    async musicStream(id: string, encryptedJioSaavnUrl?: string, persist: boolean = true): Promise<Stream> {
        // Downloaded/local songs must not wait on the YouTube client starting up.
        await ensureStorage();
        const { protocol, cleanId } = splitId(id);

        log(`Requested stream for ${id} (${protocol}/${cleanId})`);

        // Already downloaded? Serve from storage.
        const record = await metadata.get(id);
        if (record?.file && (await vfs.exists(record.file))) {
            return {
                data: new Uint8Array(await vfs.readFile(record.file)),
                mimetype: audioMimetype(record.file),
                savedToDisk: true,
            };
        }

        let audio: Buffer;
        let mimetype = 'audio/mp4';

        switch (protocol) {
            case 'fs':
            case 'local': {
                const file = cleanId;
                if (!(await vfs.exists(file))) throw new Error(`Track ${file} not found in music directory`);
                return { data: new Uint8Array(await vfs.readFile(file)), mimetype: audioMimetype(file), savedToDisk: true };
            }
            case 'yt': {
                await init();
                try {
                    audio = await webStreamToBuffer(await downloadYtAudio(cleanId));
                } catch (err: any) {
                    if (err?.info?.error_type === 'UNPLAYABLE' || /unplayable/i.test(String(err?.message))) {
                        throw new Error(
                            'This track is unplayable on YouTube — it may be region-locked, age-restricted, private, or removed.',
                        );
                    }
                    throw err;
                }
                break;
            }
            case 'js': {
                if (!encryptedJioSaavnUrl) {
                    const song = (await Saavn.getById({ songIds: cleanId })).songs?.[0];
                    if (!song) throw new Error(`JioSaavn song not found for ID ${cleanId}.`);
                    encryptedJioSaavnUrl = song.media?.encryptedUrl;
                    if (!encryptedJioSaavnUrl) throw new Error('No encrypted media URL found for the song!');
                }

                const url = (await Saavn.experimental.fetchStreamUrls(encryptedJioSaavnUrl, 'edge', true))
                    .toSorted((a, b) => parseInt(a.bitrate) - parseInt(b.bitrate))
                    .at(-1);

                if (!url) throw new Error('Failed to decrypt the JioSaavn media URL.');

                const res = await fetch(url.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
                // Never save/play an error page as audio.
                if (!res.ok) throw new Error(`JioSaavn stream returned ${res.status}`);
                audio = Buffer.from(await res.arrayBuffer());
                mimetype = res.headers.get('Content-Type') || 'audio/mp4';
                break;
            }
            default:
                throw new Error(`Track protocol for ID ${id} not supported by Zeta. Are you using a wrong version?`);
        }

        // Persist library songs (those we already track) to disk on first fetch.
        let savedToDisk = false;
        if (persist && record && !record.file) {
            try {
                await persistLibrarySong(id, record, audio);
                savedToDisk = true;
            } catch (err) {
                console.warn('[persist] Failed to save streamed song to disk:', err);
            }
        }

        return { data: new Uint8Array(audio), mimetype, savedToDisk };
    },

    async musicLoadLibrary(): Promise<Library> {
        await ensureStorage();

        await ensureFavourites();

        // Pull any pre-rewrite (e.g. .mp3) files into the index so they behave
        // like first-class library entries.
        await migrateLegacyFiles().catch((err) => console.error('[migrate] failed:', err));

        const entries = await vfs.readdir('');
        const playlists: Playlist[] = [];

        for (const entry of entries) {
            if (entry.isFile && entry.name.endsWith('.m3u8') && !entry.name.startsWith('.')) {
                try {
                    playlists.push(await readPlaylistFile(entry.name));
                } catch (err) {
                    console.error(`[library] Failed to read playlist ${entry.name}:`, err);
                }
            }
        }

        // Stable order: Favourites first, then oldest → newest.
        playlists.sort((a, b) =>
            a.id === 'favourites.m3u8' ? -1 : b.id === 'favourites.m3u8' ? 1 : a.createdAt - b.createdAt,
        );

        return { playlists, path: vfs.root };
    },

    async musicPlaylistCreate(name: string): Promise<Playlist> {
        await ensureStorage();
        name = oneLine(name).trim() || 'Untitled playlist';
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'playlist';
        const createdAt = Date.now();
        let filename = `${safeName}_${createdAt}.m3u8`;
        // Different names can sanitise to the same string; never overwrite.
        for (let n = 2; await vfs.exists(filename); n++) filename = `${safeName}_${createdAt}_${n}.m3u8`;
        await vfs.writeFile(filename, playlistHeader({ name, isProtected: false, thumbnail: '', createdAt }));
        return readPlaylistFile(filename);
    },

    async musicPlaylistRename(playlistId: string, name: string): Promise<Playlist | null> {
        await ensureStorage();
        assertPlaylistId(playlistId);
        return withPlaylistLock(playlistId, async () => {
            if (!(await vfs.exists(playlistId))) return null;
            const meta = await readPlaylistMeta(playlistId);
            if (meta.isProtected) throw new Error('This playlist cannot be renamed.');
            await updatePlaylistMeta(playlistId, (m) => (m.name = oneLine(name).trim() || m.name));
            return readPlaylistFile(playlistId);
        });
    },

    async musicPlaylistDelete(playlistId: string): Promise<void> {
        await ensureStorage();
        assertPlaylistId(playlistId);
        return withPlaylistLock(playlistId, async () => {
            if (!(await vfs.exists(playlistId))) return;
            const meta = await readPlaylistMeta(playlistId);
            if (meta.isProtected) throw new Error('This playlist cannot be deleted.');
            await vfs.unlink(playlistId);
        });
    },

    async musicPlaylistReorder(playlistId: string, orderedTrackIds: string[]): Promise<Playlist | null> {
        await ensureStorage();
        assertPlaylistId(playlistId);
        return withPlaylistLock(playlistId, async () => {
            if (!(await vfs.exists(playlistId))) return null;

            const { meta, entries } = await readParsedPlaylist(playlistId);
            const resolved = await resolveEntries(entries);

            // Reorder the entries named in `orderedTrackIds` among the slots they
            // occupy; anything else (incl. unresolvable entries) stays put.
            const rank = new Map(orderedTrackIds.map((id, i) => [id, i]));
            const movable = resolved.filter((r) => rank.has(entryId(r.entry, r.song)));
            movable.sort((a, b) => rank.get(entryId(a.entry, a.song))! - rank.get(entryId(b.entry, b.song))!);
            let next = 0;
            const blocks = resolved.map((r) => (rank.has(entryId(r.entry, r.song)) ? movable[next++].entry.block : r.entry.block));

            await writePlaylistEntries(playlistId, meta, blocks);
            return readPlaylistFile(playlistId);
        });
    },

    async musicPlaylistUpdateThumbnail(playlistId: string, thumbnailUrl: string): Promise<Playlist | null> {
        await ensureStorage();
        assertPlaylistId(playlistId);
        return withPlaylistLock(playlistId, async () => {
            if (!(await vfs.exists(playlistId))) return null;
            await updatePlaylistMeta(playlistId, (m) => (m.thumbnail = thumbnailUrl));
            return readPlaylistFile(playlistId);
        });
    },

    /**
     * Download a track into the music directory (storing metadata in the index
     * and, for local storage, embedding native MP4 tags). Returns the resulting
     * downloaded {@link Song}. If the track is already downloaded it is returned
     * as-is without re-fetching.
     */
    async musicDownloadSong(track?: Song, trackId?: string): Promise<Song> {
        const id = track?.id ?? trackId;
        if (!id) throw new Error('At least one of `track` or `trackId` must be given.');
        // One download per song at a time: concurrent requests share it rather
        // than writing the same file twice (and racing the tag embedder).
        let pending = downloadsInFlight.get(id);
        if (!pending) {
            pending = downloadSong(track, trackId).finally(() => downloadsInFlight.delete(id));
            downloadsInFlight.set(id, pending);
        }
        return pending;
    },

    async musicPlaylistAddTrack(playlistId: string, track?: Song, trackId?: string): Promise<Song> {
        await ensureStorage();
        assertPlaylistId(playlistId);
        if (!(await vfs.exists(playlistId))) throw new Error('Playlist not found');

        // Adding to a playlist is the trigger to actually persist the song.
        // (Downloaded outside the lock so a slow download doesn't block edits.)
        const song = await routes.musicDownloadSong(track, trackId);
        const record = await metadata.get(song.id);

        await withPlaylistLock(playlistId, async () => {
            const { meta, entries } = await readParsedPlaylist(playlistId);
            const resource = record?.file ? `./${record.file}` : song.id;
            const bare = (r: string) => r.replace(/^\.\//, '').replace(/^local:/, '');
            const duplicate = entries.some(
                (e) => e.id === song.id || e.resource === song.id || (!!record?.file && bare(e.resource) === bare(resource)),
            );
            if (duplicate) return;
            await writePlaylistEntries(playlistId, meta, [...entries.map((e) => e.block), playlistLinesForSong(song, record)]);
        });

        return song;
    },

    async musicPlaylistRemoveTrack(playlistId: string, trackId: string): Promise<void> {
        await ensureStorage();
        assertPlaylistId(playlistId);
        await withPlaylistLock(playlistId, async () => {
            if (!(await vfs.exists(playlistId))) return;
            const { meta, entries } = await readParsedPlaylist(playlistId);
            const resolved = await resolveEntries(entries);
            const kept = resolved.filter((r) => entryId(r.entry, r.song) !== trackId && r.entry.id !== trackId);
            await writePlaylistEntries(playlistId, meta, kept.map((r) => r.entry.block));
        });
    },

    /**
     * Autoplay / radio: songs similar to `seed`, from YouTube Music's automix
     * "up next" engine. Non-YouTube seeds (JioSaavn, local files) are first
     * matched to a YouTube Music song by title + artist. Ids in `exclude`
     * (recently played / already queued) are filtered out.
     */
    async musicRadio(seed: Song, exclude: string[] = []): Promise<Song[]> {
        await init();

        // JioSaavn seeds: use JioSaavn's own recommendations first.
        if (seed.id.startsWith('js:')) {
            try {
                const downloaded = new Set((await metadata.all()).filter((r) => r.file).map((r) => r.id));
                const skip = new Set([...exclude, seed.id]);
                const recos = (await Saavn.getRecommendations({ songId: seed.id.slice(3) }))
                    .map((r) => saavnToSong(r, downloaded))
                    .filter((r) => !skip.has(r.id));
                if (recos.length) return recos;
            } catch (err) {
                console.warn('[radio] JioSaavn recommendations failed, falling back to YouTube Music:', err);
            }
        }

        let videoId = seed.id.startsWith('yt:') ? seed.id.slice(3) : null;
        if (!videoId) {
            const query = `${seed.title} ${seed.artists.map((a) => a.name).join(' ')}`.trim();
            const res = await yt.music.search(query, { type: 'song' });
            videoId = res.songs?.contents?.[0]?.id ?? null;
        }
        if (!videoId) return [];

        const panel = await yt.music.getUpNext(videoId, true);
        const skip = new Set([...exclude, seed.id, `yt:${videoId}`]);
        const downloaded = new Set((await metadata.all()).filter((r) => r.file).map((r) => r.id));
        const seenTitles = new Set<string>();
        const songs: Song[] = [];

        for (const item of (panel?.contents ?? []) as any[]) {
            // Automix panels can wrap items (e.g. PlaylistPanelVideoWrapper).
            const video = item?.video_id ? item : item?.primary ?? item?.content;
            if (!video?.video_id) continue;
            const id = `yt:${video.video_id}`;
            const title: string = video.title?.toString?.() || 'Untitled';
            const artists = (video.artists?.length ? video.artists : [{ name: video.author || 'Unknown Artist' }]).map(
                (a: any) => ({ name: a.name, thumbnails: [] }),
            );
            // Skip repeats and alternate uploads of the same song.
            const titleKey = `${title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').trim()}|${artists[0]?.name?.toLowerCase()}`;
            if (skip.has(id) || seenTitles.has(titleKey)) continue;
            seenTitles.add(titleKey);
            songs.push({
                id,
                title,
                thumbnails: (video.thumbnail || []).map((t: any) => ({ url: t.url, width: t.width, height: t.height })),
                artists,
                album: video.album?.name ? { title: video.album.name, artists: [], thumbnails: [] } : null,
                duration: video.duration?.seconds || 0,
                isDownloaded: downloaded.has(id),
            });
        }
        return songs;
    },

    /**
     * The embedded cover of a song, answering `zeta-cover://` requests (see
     * src/lib/covers.ts). Songs sent to the renderer carry only that URL.
     */
    async musicCover(songId: string): Promise<{ data: Uint8Array; mimetype: string } | null> {
        await ensureStorage();
        const pick = (thumbs: Thumbnail[] | undefined) =>
            [...(thumbs ?? [])].filter((t) => t.data?.length).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];

        const record = await metadata.get(songId);
        let thumb = pick(record?.thumbnails);

        // Unindexed local files: read the cover straight from the file's tags.
        if (!thumb && songId.startsWith('local:') && vfs.isLocal) {
            const local = vfs.localPath(songId.slice('local:'.length));
            thumb = pick(local ? (await readAudioTags(local))?.thumbnails : undefined);
        }
        return thumb?.data ? { data: thumb.data, mimetype: thumb.mimetype || 'image/jpeg' } : null;
    },

    /**
     * Fix songs whose metadata was derived from a filename (old downloads with
     * no tags): real title/artists/album/duration and cover art from their
     * source, stored in the index and embedded into the file itself so it stays
     * fixed (and shows correctly in other players too). Works in small batches;
     * call again while `remaining` > 0. Each song is attempted once per run.
     */
    async musicRepairMetadata(limit: number = 8): Promise<{ repaired: Song[]; remaining: number }> {
        await ensureStorage();
        const candidates = (await metadata.all()).filter((r) => needsMetadataRepair(r) && !repairAttempted.has(r.id));
        const batch = candidates.slice(0, limit);
        const repaired: IndexRecord[] = [];

        for (const record of batch) {
            repairAttempted.add(record.id);
            const { protocol, cleanId } = splitId(record.id);
            const next: IndexRecord = { ...record, artists: [...record.artists], thumbnails: [...record.thumbnails] };

            // Offline first: at least undo the filename mangling.
            if (/\[(yt|js)_[^\]]+\]\s*$/i.test(next.title)) {
                const parsed = parseLegacyName(record.file ?? `${next.title}.m4a`);
                next.title = parsed.title;
                if (parsed.artist && next.artists[0]?.name === 'Unknown Artist') next.artists = [{ name: parsed.artist, thumbnails: [] }];
            }

            // Then the real metadata from the source.
            try {
                if (protocol === 'yt') {
                    await init();
                    const info = (await yt.music.getInfo(cleanId)).basic_info;
                    if (info.title) next.title = info.title;
                    const author = (info.author ?? info.channel?.name ?? '').replace(/\s*-\s*Topic$/i, '').trim();
                    if (author) next.artists = [{ name: author, thumbnails: [] }];
                    if (info.duration) next.duration = info.duration;
                    if (info.thumbnail?.length) {
                        next.thumbnails = [
                            ...next.thumbnails.filter((t) => t.data?.length),
                            ...info.thumbnail.map((t) => ({ url: t.url, width: t.width, height: t.height })),
                        ];
                    }
                } else if (protocol === 'js') {
                    const song = (await Saavn.getById({ songIds: cleanId })).songs?.[0];
                    if (song) {
                        const fresh = saavnToSong(song, new Set());
                        next.title = fresh.title;
                        if (fresh.artists.length) next.artists = fresh.artists;
                        next.album = fresh.album ?? next.album;
                        next.duration = fresh.duration || next.duration;
                        next.thumbnails = [...next.thumbnails.filter((t) => t.data?.length), ...fresh.thumbnails];
                    }
                }
            } catch (err) {
                log(`[repair] Could not fetch metadata for ${record.id}:`, err);
            }

            // Keep a cover on disk so it works offline.
            if (!next.thumbnails.some((t) => t.data?.length)) {
                const cover = await resolveCover(next.thumbnails, protocol === 'yt' ? cleanId : undefined).catch(() => null);
                if (cover) next.thumbnails.push({ data: cover.data, mimetype: cover.mimetype });
            }

            const changed =
                next.title !== record.title ||
                next.duration !== record.duration ||
                next.thumbnails.length !== record.thumbnails.length ||
                next.artists.map((a) => a.name).join('\u0000') !== record.artists.map((a) => a.name).join('\u0000');
            if (!changed) continue;

            // Write the tags into the file so it's fixed for good.
            const local = record.file && vfs.isLocal && /\.(m4a|mp4)$/i.test(record.file) ? vfs.localPath(record.file) : null;
            if (local) {
                const cover = next.thumbnails.find((t) => t.data?.length);
                await embedMp4Tags(local, {
                    title: next.title,
                    artists: next.artists.map((a) => a.name),
                    album: next.album?.title,
                    year: next.year,
                    lyrics: next.lyrics,
                    cover: cover?.data ? { data: cover.data, mimetype: cover.mimetype || 'image/jpeg' } : null,
                }).catch((err) => console.warn('[repair] Could not embed tags:', err));
            }

            repaired.push(next);
        }

        if (repaired.length) {
            await metadata.upsertMany(repaired);
            log(`[repair] Fixed metadata for ${repaired.length} song(s).`);
        }
        return { repaired: repaired.map((r) => MetadataStore.toSong(r)), remaining: candidates.length - batch.length };
    },

    /**
     * Fetch an image (cover art) and hand its bytes to the renderer. Remote
     * artwork isn't CORS-readable, so the renderer can't sample it for colours
     * or upload it to WebGL; same-origin blob bytes can be.
     */
    async fetchImage(url: string): Promise<{ data: Uint8Array; mimetype: string } | null> {
        if (!/^https?:\/\//i.test(url)) return null;
        const cached = imageCache.get(url);
        if (cached) return cached;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
            if (!res.ok) return null;
            const mimetype = res.headers.get('Content-Type') || 'image/jpeg';
            if (!mimetype.startsWith('image/')) return null;
            const result = { data: new Uint8Array(await res.arrayBuffer()), mimetype };
            imageCache.set(url, result);
            if (imageCache.size > 64) imageCache.delete(imageCache.keys().next().value as string);
            return result;
        } catch {
            return null;
        }
    },

    /* ------------------------------ settings ------------------------------ */

    async getSettings(): Promise<{ musicDir: string; isRemote: boolean }> {
        const { musicDir } = getConfig();
        return { musicDir, isRemote: /^(sftp|ftp|ftps):\/\//i.test(musicDir) };
    },

    /** Switch the music directory. Validates connectivity, then reloads. */
    async setMusicDir(musicDir: string): Promise<Library> {
        const previous = getConfig().musicDir;
        saveConfig({ musicDir });
        try {
            await reloadStorage();
            return await routes.musicLoadLibrary();
        } catch (err) {
            // Roll back on failure so the app isn't left pointing at a dead store.
            saveConfig({ musicDir: previous });
            await reloadStorage().catch(() => {});
            throw new Error(`Could not use "${musicDir}": ${(err as Error)?.message ?? err}`);
        }
    },

    /* ---------------------------- Muzza interop --------------------------- */
    // Native file dialogs live in the main process (see routes/index.ts); these
    // routes receive the chosen path.

    /**
     * Export the whole library to a Muzza-compatible `.backup` file at
     * `filePath`. Favourites map to Muzza's "liked" songs; other playlists
     * become Muzza playlists.
     */
    async muzzaExportTo(filePath: string): Promise<{ path: string; songs: number; playlists: number; liked: number }> {
        await ensureStorage();

        const library = await routes.musicLoadLibrary();

        // Collect every unique song: indexed records (downloaded + off-disk) plus
        // whatever is referenced by playlists.
        const songMap = new Map<string, Song>();
        for (const record of await metadata.all()) songMap.set(record.id, MetadataStore.toSong(record));

        const likedIds = new Set<string>();
        const playlists: { name: string; createdAt: number; trackIds: string[] }[] = [];

        for (const playlist of library.playlists) {
            for (const track of playlist.tracks) if (!songMap.has(track.id)) songMap.set(track.id, track);

            if (playlist.id === 'favourites.m3u8') {
                for (const track of playlist.tracks) likedIds.add(track.id);
            } else {
                playlists.push({
                    name: playlist.name,
                    createdAt: playlist.createdAt,
                    trackIds: playlist.tracks.map((t) => t.id),
                });
            }
        }

        // Carry over Zeta's own play events and build on the preserved Muzza base
        // (if any) so settings/history/etc. survive the round-trip.
        const events: MuzzaEvent[] = (await stats.events()).map((e) => ({
            zetaId: e.songId,
            timestamp: e.timestamp,
            playTimeMs: e.playTimeMs,
        }));
        const base = await readMuzzaBase();

        const { data, stats: exportStats } = await buildMuzzaBackup({
            songs: [...songMap.values()],
            likedIds,
            playlists,
            events,
            base,
        });

        writeFileSync(filePath, data);
        log(`Exported Muzza backup to ${filePath}`, exportStats);
        return {
            path: filePath,
            songs: exportStats.songs,
            playlists: exportStats.playlists,
            liked: exportStats.liked,
        };
    },

    /**
     * Import the Muzza `.backup` file at `filePath`, merging its songs, likes
     * and playlists into the current library. Songs are added "off-disk"
     * (metadata only) — nothing is downloaded; audio streams on demand and is
     * only saved when the user downloads/adds it explicitly.
     */
    async muzzaImportFrom(filePath: string): Promise<{ songs: number; playlists: number; liked: number }> {
        await ensureStorage();

        const imported = await parseMuzzaBackup(readFileSync(filePath));

        // 0. Preserve the raw backup so a future export can carry over ALL of
        //    Muzza's data (settings, play history, search history, etc.). The
        //    base becomes the authoritative history, so reset Zeta's own events.
        await vfs.mkdir('.zeta/muzza');
        await vfs.writeFile(MUZZA_BASE_DB, imported.db);
        if (imported.settings) await vfs.writeFile(MUZZA_BASE_SETTINGS, imported.settings);
        else if (await vfs.exists(MUZZA_BASE_SETTINGS)) await vfs.unlink(MUZZA_BASE_SETTINGS).catch(() => {});

        // 1. Merge song metadata (never clobber an already-downloaded record).
        const toAdd: IndexRecord[] = [];
        for (const song of imported.songs) {
            const existing = await metadata.get(song.zetaId);
            if (existing?.file) continue;
            toAdd.push(song.record);
        }
        await metadata.upsertMany(toAdd);

        // 2. Merge favourites (liked songs), keeping every existing entry as-is.
        await ensureFavourites();
        await withPlaylistLock('favourites.m3u8', async () => {
            const { meta, entries } = await readParsedPlaylist('favourites.m3u8');
            const resolved = await resolveEntries(entries);
            const favIds = new Set(resolved.map((r) => entryId(r.entry, r.song)));
            const blocks = entries.map((e) => e.block);
            for (const zetaId of imported.likedIds) {
                if (favIds.has(zetaId)) continue;
                const record = await metadata.get(zetaId);
                if (record) {
                    blocks.push(playlistLinesForSong(MetadataStore.toSong(record), record));
                    favIds.add(zetaId);
                }
            }
            await writePlaylistEntries('favourites.m3u8', meta, blocks);
        });

        // 3. Recreate playlists.
        for (const playlist of imported.playlists) {
            const created = await routes.musicPlaylistCreate(playlist.name);
            const tracks: Song[] = [];
            for (const zetaId of playlist.trackIds) {
                const record = await metadata.get(zetaId);
                if (record) tracks.push(MetadataStore.toSong(record));
            }
            await writePlaylist(created.id, tracks, await readPlaylistMeta(created.id));
        }

        // Only now that everything merged: the imported base becomes the
        // authoritative history, so reset Zeta's own events.
        await stats.clear();

        log('Imported Muzza backup', {
            songs: toAdd.length,
            playlists: imported.playlists.length,
            liked: imported.likedIds.length,
        });
        return { songs: toAdd.length, playlists: imported.playlists.length, liked: imported.likedIds.length };
    },

    /* ------------------------------- stats -------------------------------- */

    /** Record a listening event (called by the player as songs are played). */
    async statsRecordEvent(
        songId: string,
        playTimeMs: number,
        timestamp?: number,
        name?: { title: string; artists: string[]; thumbnailUrl?: string },
    ): Promise<void> {
        await ensureStorage();
        if (!songId || !(playTimeMs >= 1000)) return; // ignore trivial/blip plays
        await stats.record({ songId, playTimeMs: Math.round(playTimeMs), timestamp: timestamp ?? Date.now() }, name);
    },

    /**
     * Aggregate listening stats, combining Zeta's own play events with the
     * history from an imported Muzza backup (if any).
     */
    async statsSummary(limit: number = 30): Promise<{
        topSongs: { id: string; title: string; artists: string[]; thumbnailUrl?: string; playTimeMs: number; plays: number; lastPlayed: number }[];
        topArtists: { name: string; playTimeMs: number; plays: number; thumbnailUrl?: string }[];
        history: { id: string; title: string; artists: string[]; thumbnailUrl?: string; timestamp: number; playTimeMs: number }[];
        totals: { totalPlayTimeMs: number; totalPlays: number; uniqueSongs: number };
    }> {
        await ensureStorage();

        const zetaEvents = await stats.events();
        const base = await readMuzzaBase();
        const baseEvents = base ? await readMuzzaEventsFromDb(base.db).catch(() => []) : [];
        const events: { songId: string; timestamp: number; playTimeMs: number }[] = [
            ...baseEvents.map((e) => ({ songId: e.zetaId, timestamp: e.timestamp, playTimeMs: e.playTimeMs })),
            ...zetaEvents,
        ];

        // Resolve display names: prefer the library index, fall back to the
        // stats name cache (for played-but-unsaved songs).
        const byId = new Map((await metadata.all()).map((r) => [r.id, r]));
        const nameCache = await stats.names();
        const nameFor = (id: string): { title: string; artists: string[]; thumbnailUrl?: string } => {
            const rec = byId.get(id);
            if (rec) {
                return {
                    title: rec.title,
                    artists: rec.artists.map((a) => a.name),
                    thumbnailUrl: songImageUrl(rec.id, rec.thumbnails),
                };
            }
            const cached = nameCache[id];
            return { title: cached?.title ?? id, artists: cached?.artists ?? [], thumbnailUrl: cached?.thumbnailUrl };
        };

        const perSong = new Map<string, { playTimeMs: number; plays: number; last: number }>();
        for (const e of events) {
            const s = perSong.get(e.songId) ?? { playTimeMs: 0, plays: 0, last: 0 };
            s.playTimeMs += e.playTimeMs;
            s.plays += 1;
            s.last = Math.max(s.last, e.timestamp);
            perSong.set(e.songId, s);
        }

        // Artists are pictured by the cover of their most-played song.
        const perArtist = new Map<string, { playTimeMs: number; plays: number; bestSongMs: number; thumbnailUrl?: string }>();
        const topSongs = [...perSong.entries()]
            .map(([id, s]) => {
                const n = nameFor(id);
                for (const artist of n.artists) {
                    const a = perArtist.get(artist) ?? { playTimeMs: 0, plays: 0, bestSongMs: -1 };
                    a.playTimeMs += s.playTimeMs;
                    a.plays += s.plays;
                    if (n.thumbnailUrl && s.playTimeMs > a.bestSongMs) {
                        a.bestSongMs = s.playTimeMs;
                        a.thumbnailUrl = n.thumbnailUrl;
                    }
                    perArtist.set(artist, a);
                }
                return { id, ...n, playTimeMs: s.playTimeMs, plays: s.plays, lastPlayed: s.last };
            })
            .sort((a, b) => b.playTimeMs - a.playTimeMs)
            .slice(0, limit);

        const topArtists = [...perArtist.entries()]
            .map(([name, a]) => ({ name, playTimeMs: a.playTimeMs, plays: a.plays, thumbnailUrl: a.thumbnailUrl }))
            .sort((a, b) => b.playTimeMs - a.playTimeMs)
            .slice(0, limit);

        const history = [...events]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit)
            .map((e) => ({ id: e.songId, ...nameFor(e.songId), timestamp: e.timestamp, playTimeMs: e.playTimeMs }));

        const totals = {
            totalPlayTimeMs: events.reduce((s, e) => s + e.playTimeMs, 0),
            totalPlays: events.length,
            uniqueSongs: perSong.size,
        };

        return { topSongs, topArtists, history, totals };
    },
};

const downloadsInFlight = new Map<string, Promise<Song>>();
/** Songs already given a metadata repair attempt this run (see musicRepairMetadata). */
const repairAttempted = new Set<string>();
const imageCache = new Map<string, { data: Uint8Array; mimetype: string }>();

/**
 * Download a track into the music directory (storing metadata in the index
 * and, for local storage, embedding native MP4 tags). Returns the resulting
 * downloaded {@link Song}. If the track is already downloaded it is returned
 * as-is without re-fetching.
 */
async function downloadSong(track?: Song, trackId?: string): Promise<Song> {
    await ensureStorage();

    if (!track && !trackId) throw new Error('At least one of `track` or `trackId` must be given.');

    const id = track ? track.id : trackId!;
    const { protocol, cleanId } = splitId(id);

    // Fast path: already downloaded.
    const existing = await metadata.get(id);
    if (existing?.file && (await vfs.exists(existing.file))) {
        return MetadataStore.toSong(existing);
    }

    log(`Downloading song ${id} (${protocol}/${cleanId})`);

    let title = track?.title || 'Untitled';
    let artists = track?.artists ? [...track.artists] : [];
    let album = track?.album ?? null;
    let year = track?.year;
    let duration = track?.duration ?? 0;
    let lyrics: string | null | undefined = track?.lyrics;
    // The renderer only ever sees cover *references* (zeta-cover://); keep any
    // cover bytes the index already has for this song.
    let thumbnails: Thumbnail[] = [
        ...(existing?.thumbnails.filter((t) => t.data?.length) ?? []),
        ...(track?.thumbnails ?? []).filter((t) => !t.url?.startsWith(COVER_SCHEME)),
    ];
    let audio: Buffer;

    if (protocol === 'fs' || protocol === 'local') {
        // Already a local file — just index it.
        const file = cleanId;
        if (!(await vfs.exists(file))) throw new Error(`Local file ${file} not found.`);
        const record: IndexRecord = {
            id: `local:${file}`,
            file,
            title,
            artists: artists.length ? artists : [{ name: 'Unknown Artist', thumbnails: [] }],
            album,
            duration,
            year,
            lyrics: lyrics ?? null,
            thumbnails,
        };
        await metadata.upsert(record);
        return MetadataStore.toSong(record);
    } else if (protocol === 'yt') {
        await init();
        const info = await yt.music.getInfo(cleanId);
        title = track?.title || info.basic_info.title || 'Untitled';
        const author = info.basic_info.author ?? info.basic_info.channel?.name ?? 'Unknown Artist';
        if (!artists.length) artists = [{ name: author, thumbnails: [] }];
        duration = track?.duration || info.basic_info.duration || 0;
        if (!thumbnails.length && info.basic_info.thumbnail?.length) {
            thumbnails = info.basic_info.thumbnail.map((t) => ({ url: t.url, width: t.width, height: t.height }));
        }
        if (!lyrics) {
            try {
                lyrics = (await info.getLyrics())?.description.text ?? null;
            } catch {
                /* no lyrics */
            }
        }
        audio = await webStreamToBuffer(await downloadYtAudio(cleanId));
    } else if (protocol === 'js') {
        const meta = (await Saavn.getById({ songIds: cleanId })).songs?.[0];
        title = track?.title || meta?.title || 'Untitled';
        if (!artists.length && meta?.artists?.all) {
            artists = meta.artists.all.slice(0, 3).map((a) => ({
                name: a.name,
                thumbnails: a.images.map((i) => ({
                    url: i.url,
                    width: parseInt(i.resolution.split('x')[0]),
                    height: parseInt(i.resolution.split('x')[1]),
                })),
            }));
        }
        duration = track?.duration || meta?.duration || 0;
        if (!album && meta?.album) album = { title: meta.album.title || 'Untitled Album', artists: [], thumbnails: [] };
        if (!thumbnails.length && meta?.images) {
            thumbnails = meta.images.map((i) => ({
                url: i.url,
                width: parseInt(i.resolution.split('x')[0]),
                height: parseInt(i.resolution.split('x')[1]),
            }));
        }
        if (!lyrics) lyrics = meta?.lyrics?.snippet ?? null;

        const stream = await routes.musicStream(id, meta?.media?.encryptedUrl, false);
        audio = Buffer.from(stream.data);
    } else {
        throw new Error('Unsupported ID protocol. Maybe you are using a wrong version.');
    }

    if (!artists.length) artists = [{ name: 'Unknown Artist', thumbnails: [] }];

    const file = buildFilename(title, artists[0]?.name ?? '', id);
    await vfs.writeFile(file, audio);

    // Embed native MP4 tags when we have local random access.
    if (vfs.isLocal) {
        const local = vfs.localPath(file);
        if (local) {
            const cover = await resolveCover(thumbnails, protocol === 'yt' ? cleanId : undefined);
            await embedMp4Tags(local, {
                title,
                artists: artists.map((a) => a.name),
                album: album?.title,
                year,
                lyrics,
                cover,
            }).catch((err) => console.warn('[metadata] tag embed failed:', err));
        }
    }

    const record: IndexRecord = {
        id,
        file,
        title,
        artists,
        album,
        duration,
        year,
        lyrics: lyrics ?? null,
        thumbnails: thumbnails.map((t) => ({ url: t.url, width: t.width, height: t.height, mimetype: t.mimetype, data: t.data })),
    };
    await metadata.upsert(record);

    log(`Downloaded and indexed ${id} -> ${file}`);
    return MetadataStore.toSong(record);
}
