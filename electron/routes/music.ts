import { Innertube, Platform, type Types } from 'youtubei.js';
import { Song as Saavn } from '@saavn-labs/sdk';

import { dialog } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import type { Playlist, Song, Stream, Library, Thumbnail, MusicProvider } from '../../src/lib/schema';
import { updateThumbnailUrl } from '../../src/lib/utils';

import { createVFS, type VFS } from '../lib/vfs';
import { getConfig, saveConfig } from '../lib/config';
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
    if (!storageReady) storageReady = initStorage();
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

async function init() {
    await ensureStorage();
    if (!yt) yt = await Innertube.create({});
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
    const base = sanitiseFilename(`${title}${artist ? ` | ${artist}` : ''}`) || 'Untitled';
    return `${base} [${id.replaceAll(':', '_')}].m4a`;
}

function isAudioFile(name: string): boolean {
    return AUDIO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

/**
 * Download YouTube audio, preferring a real MP4/AAC (M4A) stream.
 *
 * `quality: 'best'` alone can hand back WebM/Opus, which we'd then save as
 * `.m4a` — a mislabelled container that won't play everywhere and that TagLib
 * can't tag (hence songs with no embedded title/artwork). We explicitly ask for
 * an `mp4` format first (across a couple of clients) and only fall back to any
 * container as a last resort.
 */
async function downloadYtAudio(videoId: string): Promise<ReadableStream<Uint8Array>> {
    const attempts: any[] = [
        { type: 'audio', quality: 'best', format: 'mp4', client: 'ANDROID_VR' },
        { type: 'audio', quality: 'best', format: 'mp4' },
        { type: 'audio', quality: 'best', client: 'ANDROID_VR' },
    ];
    let lastErr: any;
    for (const opts of attempts) {
        try {
            return await yt.download(videoId, opts);
        } catch (err: any) {
            // A genuinely unplayable video won't be fixed by another format/client.
            if (err?.info?.error_type === 'UNPLAYABLE' || /unplayable/i.test(String(err?.message))) throw err;
            lastErr = err;
        }
    }
    throw lastErr;
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
}

/** Build the resource + #EXTINF lines used to represent a song in an m3u8 file. */
function playlistLinesForSong(song: Song, record?: IndexRecord): string {
    const artist = song.artists.map((a) => a.name).join(', ');
    const extinf = `#EXTINF:${Math.round(song.duration || 0)},${artist} - ${song.title}`;
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

async function readPlaylistFile(filename: string): Promise<Playlist> {
    const content = (await vfs.readFile(filename)).toString('utf-8');
    let stat = { birthtimeMs: 0, mtimeMs: 0, size: 0 };
    try {
        stat = await vfs.stat(filename);
    } catch {
        /* stat may be unavailable on some remotes */
    }

    const meta: PlaylistMeta = {
        name: filename.replace('.m3u8', ''),
        isProtected: filename === 'favourites.m3u8',
        thumbnail: '',
    };

    const tracks: Song[] = [];
    const lines = content.split('\n');
    let pendingId: string | null = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXTZETA:')) {
            try {
                const parsed = JSON.parse(line.substring('#EXTZETA:'.length));
                meta.name = parsed.name ?? meta.name;
                meta.isProtected = parsed.isProtected ?? meta.isProtected;
                meta.thumbnail = parsed.thumbnail ?? meta.thumbnail;
            } catch {
                /* ignore malformed header */
            }
        } else if (line.startsWith('#EXTINF-ZETA:')) {
            pendingId = line.substring('#EXTINF-ZETA:'.length).trim();
        } else if (line.startsWith('#')) {
            /* standard m3u directives (#EXTM3U, #EXTINF) — ignored */
        } else {
            const song = await songForPlaylistLine(line, pendingId);
            if (song) tracks.push(song);
            pendingId = null;
        }
    }

    return {
        id: filename,
        name: meta.name,
        tracks,
        createdAt: stat.birthtimeMs || stat.mtimeMs || Date.now(),
        isProtected: meta.isProtected,
        thumbnail: meta.thumbnail || pickBestThumbnail(tracks[0]?.thumbnails || [])?.url,
    };
}

function playlistHeader(meta: PlaylistMeta): string {
    return `#EXTM3U\n#EXTZETA:${JSON.stringify(meta)}\n`;
}

/** Rewrite a playlist file from an ordered list of songs, preserving its header. */
async function writePlaylist(filename: string, songs: Song[], meta: PlaylistMeta): Promise<void> {
    let content = playlistHeader(meta);
    for (const song of songs) {
        const record = await metadata.get(song.id);
        content += `${playlistLinesForSong(song, record)}\n`;
    }
    await vfs.writeFile(filename, content);
}

async function readPlaylistMeta(filename: string): Promise<PlaylistMeta> {
    const meta: PlaylistMeta = {
        name: filename.replace('.m3u8', ''),
        isProtected: filename === 'favourites.m3u8',
        thumbnail: '',
    };
    try {
        const content = (await vfs.readFile(filename)).toString('utf-8');
        const headerLine = content.split('\n').find((l) => l.startsWith('#EXTZETA:'));
        if (headerLine) {
            const parsed = JSON.parse(headerLine.substring('#EXTZETA:'.length));
            meta.name = parsed.name ?? meta.name;
            meta.isProtected = parsed.isProtected ?? meta.isProtected;
            meta.thumbnail = parsed.thumbnail ?? meta.thumbnail;
        }
    } catch {
        /* use defaults */
    }
    return meta;
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

        records.push({
            id,
            file: entry.name,
            title: tags?.title || entry.name.replace(/\.[^.]+$/, ''),
            artists: tags?.artists ?? [{ name: 'Unknown Artist', thumbnails: [] }],
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
        return (await yt.music.getSearchSuggestions(query))[0].contents.map((s: any) => s.suggestion.text);
    },

    async musicSearch(query: string, provider: MusicProvider): Promise<Song[]> {
        await init();

        const downloaded = new Set((await metadata.all()).filter((r) => r.file).map((r) => r.id));

        switch (provider) {
            case 'yt': {
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

                return res.results.map((s) => {
                    const id = `js:${s.id}`;
                    return {
                        id,
                        title: s.title || 'Untitled Song',
                        thumbnails: s.images.map((i) => ({
                            url: i.url,
                            width: parseInt(i.resolution.split('x')[0]),
                            height: parseInt(i.resolution.split('x')[1]),
                        })),
                        artists:
                            s.artists && s.artists.all
                                ? s.artists.all.slice(0, 3).map((a) => ({
                                      name: a.name,
                                      thumbnails: a.images.map((i) => ({
                                          url: i.url,
                                          width: parseInt(i.resolution.split('x')[0]),
                                          height: parseInt(i.resolution.split('x')[1]),
                                      })),
                                  }))
                                : [],
                        album: s.album ? { title: s.album.title || 'Untitled Album', artists: [], thumbnails: [] } : null,
                        duration: s.duration || 0,
                        isDownloaded: downloaded.has(id),
                    };
                });
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
        await init();
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
        await init();

        if (!(await vfs.exists('favourites.m3u8'))) {
            await vfs.writeFile(
                'favourites.m3u8',
                playlistHeader({ name: 'Favourites', isProtected: true, thumbnail: '' }),
            );
        }

        // Pull any pre-rewrite (e.g. .mp3) files into the index so they behave
        // like first-class library entries.
        await migrateLegacyFiles().catch((err) => console.error('[migrate] failed:', err));

        const entries = await vfs.readdir('');
        const playlists: Playlist[] = [];

        for (const entry of entries) {
            if (entry.isFile && entry.name.endsWith('.m3u8')) {
                try {
                    playlists.push(await readPlaylistFile(entry.name));
                } catch (err) {
                    console.error(`[library] Failed to read playlist ${entry.name}:`, err);
                }
            }
        }

        return { playlists, path: vfs.root };
    },

    async musicPlaylistCreate(name: string): Promise<Playlist> {
        await init();
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'playlist';
        const filename = `${safeName}_${Date.now()}.m3u8`;
        await vfs.writeFile(filename, playlistHeader({ name, isProtected: false, thumbnail: '' }));
        return readPlaylistFile(filename);
    },

    async musicPlaylistRename(playlistId: string, name: string): Promise<Playlist | null> {
        await init();
        if (!(await vfs.exists(playlistId))) return null;
        const meta = await readPlaylistMeta(playlistId);
        if (meta.isProtected) throw new Error('This playlist cannot be renamed.');

        const playlist = await readPlaylistFile(playlistId);
        meta.name = name;
        await writePlaylist(playlistId, playlist.tracks, meta);
        return readPlaylistFile(playlistId);
    },

    async musicPlaylistDelete(playlistId: string): Promise<void> {
        await init();
        if (!(await vfs.exists(playlistId))) return;
        const meta = await readPlaylistMeta(playlistId);
        if (meta.isProtected) throw new Error('This playlist cannot be deleted.');
        await vfs.unlink(playlistId);
    },

    async musicPlaylistReorder(playlistId: string, orderedTrackIds: string[]): Promise<Playlist | null> {
        await init();
        if (!(await vfs.exists(playlistId))) return null;

        const playlist = await readPlaylistFile(playlistId);
        const byId = new Map(playlist.tracks.map((t) => [t.id, t]));
        const reordered = orderedTrackIds.map((id) => byId.get(id)).filter((t): t is Song => !!t);
        // Append any tracks that weren't in the provided order (safety).
        for (const track of playlist.tracks) if (!orderedTrackIds.includes(track.id)) reordered.push(track);

        await writePlaylist(playlistId, reordered, await readPlaylistMeta(playlistId));
        return readPlaylistFile(playlistId);
    },

    async musicPlaylistUpdateThumbnail(playlistId: string, thumbnailUrl: string): Promise<Playlist | null> {
        await init();
        if (!(await vfs.exists(playlistId))) return null;

        const meta = await readPlaylistMeta(playlistId);
        const playlist = await readPlaylistFile(playlistId);
        meta.thumbnail = thumbnailUrl;
        await writePlaylist(playlistId, playlist.tracks, meta);

        playlist.thumbnail = thumbnailUrl;
        return playlist;
    },

    /**
     * Download a track into the music directory (storing metadata in the index
     * and, for local storage, embedding native MP4 tags). Returns the resulting
     * downloaded {@link Song}. If the track is already downloaded it is returned
     * as-is without re-fetching.
     */
    async musicDownloadSong(track?: Song, trackId?: string): Promise<Song> {
        await init();

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
        let thumbnails: Thumbnail[] = track?.thumbnails ? [...track.thumbnails] : [];
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
    },

    async musicPlaylistAddTrack(playlistId: string, track?: Song, trackId?: string): Promise<Song> {
        await init();
        if (!(await vfs.exists(playlistId))) throw new Error('Playlist not found');

        // Adding to a playlist is the trigger to actually persist the song.
        const song = await routes.musicDownloadSong(track, trackId);
        const record = await metadata.get(song.id);

        const content = (await vfs.readFile(playlistId)).toString('utf-8');
        const resource = record?.file ? `./${record.file}` : song.id;
        if (!content.split('\n').some((l) => l.trim() === resource || l.trim() === song.id)) {
            await vfs.appendFile(playlistId, `${playlistLinesForSong(song, record)}\n`);
        }

        return song;
    },

    async musicPlaylistRemoveTrack(playlistId: string, trackId: string): Promise<void> {
        await init();
        if (!(await vfs.exists(playlistId))) return;

        const playlist = await readPlaylistFile(playlistId);
        const filtered = playlist.tracks.filter((t) => t.id !== trackId);
        await writePlaylist(playlistId, filtered, await readPlaylistMeta(playlistId));
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

    /** Open a native folder picker (local directories only). Returns null if cancelled. */
    async pickMusicDirectory(): Promise<string | null> {
        const result = await dialog.showOpenDialog({
            title: 'Choose a music directory',
            properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    },

    /* ---------------------------- Muzza interop --------------------------- */

    /**
     * Export the whole library to a Muzza-compatible `.backup` file (a native
     * save dialog picks the destination). Favourites map to Muzza's "liked"
     * songs; other playlists become Muzza playlists.
     */
    async muzzaExport(): Promise<{ path: string; songs: number; playlists: number; liked: number } | null> {
        await init();

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

        const result = await dialog.showSaveDialog({
            title: 'Export to Muzza',
            defaultPath: `Zeta_${backupTimestamp()}.backup`,
            filters: [{ name: 'Muzza backup', extensions: ['backup'] }],
        });
        if (result.canceled || !result.filePath) return null;

        writeFileSync(result.filePath, data);
        log(`Exported Muzza backup to ${result.filePath}`, exportStats);
        return {
            path: result.filePath,
            songs: exportStats.songs,
            playlists: exportStats.playlists,
            liked: exportStats.liked,
        };
    },

    /**
     * Import a Muzza `.backup` file, merging its songs, likes and playlists into
     * the current library. Songs are added "off-disk" (metadata only) — nothing
     * is downloaded; audio streams on demand and is only saved when the user
     * downloads/adds it explicitly.
     */
    async muzzaImport(): Promise<{ songs: number; playlists: number; liked: number } | null> {
        await init();

        const picked = await dialog.showOpenDialog({
            title: 'Import from Muzza',
            properties: ['openFile'],
            filters: [
                { name: 'Muzza backup', extensions: ['backup'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (picked.canceled || picked.filePaths.length === 0) return null;

        const imported = await parseMuzzaBackup(readFileSync(picked.filePaths[0]));

        // 0. Preserve the raw backup so a future export can carry over ALL of
        //    Muzza's data (settings, play history, search history, etc.). The
        //    base becomes the authoritative history, so reset Zeta's own events.
        await vfs.mkdir('.zeta/muzza');
        await vfs.writeFile(MUZZA_BASE_DB, imported.db);
        if (imported.settings) await vfs.writeFile(MUZZA_BASE_SETTINGS, imported.settings);
        else if (await vfs.exists(MUZZA_BASE_SETTINGS)) await vfs.unlink(MUZZA_BASE_SETTINGS).catch(() => {});
        await stats.clear();

        // 1. Merge song metadata (never clobber an already-downloaded record).
        const toAdd: IndexRecord[] = [];
        for (const song of imported.songs) {
            const existing = await metadata.get(song.zetaId);
            if (existing?.file) continue;
            toAdd.push(song.record);
        }
        await metadata.upsertMany(toAdd);

        // 2. Merge favourites (liked songs).
        if (!(await vfs.exists('favourites.m3u8'))) {
            await vfs.writeFile(
                'favourites.m3u8',
                playlistHeader({ name: 'Favourites', isProtected: true, thumbnail: '' }),
            );
        }
        const favMeta = await readPlaylistMeta('favourites.m3u8');
        const favTracks = (await readPlaylistFile('favourites.m3u8')).tracks;
        const favIds = new Set(favTracks.map((t) => t.id));
        for (const zetaId of imported.likedIds) {
            if (favIds.has(zetaId)) continue;
            const record = await metadata.get(zetaId);
            if (record) {
                favTracks.push(MetadataStore.toSong(record));
                favIds.add(zetaId);
            }
        }
        await writePlaylist('favourites.m3u8', favTracks, favMeta);

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
        topArtists: { name: string; playTimeMs: number; plays: number }[];
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
                    thumbnailUrl: pickBestThumbnail(rec.thumbnails)?.url,
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

        const perArtist = new Map<string, { playTimeMs: number; plays: number }>();
        const topSongs = [...perSong.entries()]
            .map(([id, s]) => {
                const n = nameFor(id);
                for (const artist of n.artists) {
                    const a = perArtist.get(artist) ?? { playTimeMs: 0, plays: 0 };
                    a.playTimeMs += s.playTimeMs;
                    a.plays += s.plays;
                    perArtist.set(artist, a);
                }
                return { id, ...n, playTimeMs: s.playTimeMs, plays: s.plays, lastPlayed: s.last };
            })
            .sort((a, b) => b.playTimeMs - a.playTimeMs)
            .slice(0, limit);

        const topArtists = [...perArtist.entries()]
            .map(([name, a]) => ({ name, ...a }))
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

function backupTimestamp(): string {
    const d = new Date();
    const p = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
