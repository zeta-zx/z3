import { Innertube, Platform, type Types } from 'youtubei.js';
import { Song as Saavn } from '@saavn-labs/sdk';

import { dialog } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';

import type { Playlist, Song, Stream, Library, Thumbnail, MusicProvider } from '../../src/lib/schema';
import { updateThumbnailUrl } from '../../src/lib/utils';

import { createVFS, type VFS } from '../lib/vfs';
import { getConfig, saveConfig } from '../lib/config';
import { MetadataStore, embedMp4Tags, readMp4Tags, type IndexRecord } from '../lib/metadata';
import { buildMuzzaBackup, parseMuzzaBackup } from '../lib/muzza';

const DEBUG = !!process.env.ZETA_DEBUG;
function log(...args: any[]) {
    if (DEBUG) console.log(...args);
}

const AUDIO_EXTENSIONS = ['.m4a', '.mp4'];

/* -------------------------------------------------------------------------- */
/*                              storage bootstrap                             */
/* -------------------------------------------------------------------------- */

let vfs: VFS;
let metadata: MetadataStore;
let storageReady: Promise<void> | null = null;

async function initStorage(): Promise<void> {
    const created = await createVFS(getConfig().musicDir);
    if (vfs) await vfs.dispose().catch(() => {});
    vfs = created;
    if (metadata) metadata.setVfs(vfs);
    else metadata = new MetadataStore(vfs);
    // Make sure the root directory exists (esp. for freshly-configured remotes).
    await vfs.mkdir('').catch(() => {});
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

/** Resolve cover-art bytes for embedding, from thumbnail data or by fetching a URL. */
async function resolveCover(thumbnails: Thumbnail[]): Promise<{ data: Uint8Array; mimetype: string } | null> {
    const withData = (thumbnails || []).find((t) => t.data?.length);
    if (withData?.data) return { data: withData.data, mimetype: withData.mimetype || 'image/jpeg' };

    const best = pickBestThumbnail(thumbnails);
    if (best?.url) {
        try {
            const res = await fetch(updateThumbnailUrl(best.url), {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                redirect: 'follow',
            });
            if (res.ok) {
                return {
                    data: new Uint8Array(await res.arrayBuffer()),
                    mimetype: res.headers.get('Content-Type') || 'image/jpeg',
                };
            }
        } catch {
            /* ignore unreachable thumbnail URLs */
        }
    }
    return null;
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
    const resource = record?.file ? `./${record.file}` : song.id;
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

    // A file reference (downloaded track).
    if (trimmed.startsWith('./') || isAudioFile(trimmed)) {
        const file = trimmed.replace(/^\.\//, '');
        const record = await metadata.getByFile(file);
        if (record) return MetadataStore.toSong(record);

        // File exists but isn't indexed: read its embedded tags (local only).
        if (vfs.isLocal && (await vfs.exists(file))) {
            const local = vfs.localPath(file);
            const tags = local ? await readMp4Tags(local) : null;
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

/* -------------------------------------------------------------------------- */
/*                                   routes                                   */
/* -------------------------------------------------------------------------- */

export const routes = {
    async musicLyrics(track: Song): Promise<string | null> {
        try {
            const res = await fetch(
                `https://lrclib.net/api/get?artist_name=${encodeURIComponent(track.artists.map((a) => a.name).join(', '))}&track_name=${encodeURIComponent(track.title)}&duration=${Math.round(track.duration)}`,
                { headers: { 'User-Agent': 'Zeta Music (https://github.com/zeta-zx/z3)' } },
            );

            if (!res.ok) return null;

            const data = (await res.json()) as any;
            return data.syncedLyrics || data.plainLyrics || null;
        } catch (err) {
            console.error('LrcLib fetch failed:', err);
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
     * Downloaded tracks are read from the music directory. Remote (yt/js)
     * tracks that aren't downloaded are streamed straight through and returned
     * WITHOUT being written to disk — they only live in the frontend cache
     * until the user explicitly adds them to a playlist.
     */
    async musicStream(id: string, encryptedJioSaavnUrl?: string): Promise<Stream> {
        await init();
        const { protocol, cleanId } = splitId(id);

        log(`Requested stream for ${id} (${protocol}/${cleanId})`);

        // Already downloaded? Serve from storage.
        const record = await metadata.get(id);
        if (record?.file && (await vfs.exists(record.file))) {
            return { data: new Uint8Array(await vfs.readFile(record.file)), mimetype: 'audio/mp4' };
        }

        switch (protocol) {
            case 'fs':
            case 'local': {
                const file = cleanId;
                if (!(await vfs.exists(file))) throw new Error(`Track ${file} not found in music directory`);
                return { data: new Uint8Array(await vfs.readFile(file)), mimetype: 'audio/mp4' };
            }
            case 'yt': {
                const stream = await yt.download(cleanId, { type: 'audio', quality: 'best', client: 'ANDROID_VR' });
                return { data: new Uint8Array(await webStreamToBuffer(stream)), mimetype: 'audio/mp4' };
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
                return {
                    data: new Uint8Array(await res.arrayBuffer()),
                    mimetype: res.headers.get('Content-Type') || 'audio/mp4',
                };
            }
        }

        throw new Error(`Track protocol for ID ${id} not supported by Zeta. Are you using a wrong version?`);
    },

    async musicLoadLibrary(): Promise<Library> {
        await init();

        if (!(await vfs.exists('favourites.m3u8'))) {
            await vfs.writeFile(
                'favourites.m3u8',
                playlistHeader({ name: 'Favourites', isProtected: true, thumbnail: '' }),
            );
        }

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
            const stream = await yt.download(cleanId, { type: 'audio', quality: 'best', client: 'ANDROID_VR' });
            audio = await webStreamToBuffer(stream);
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

            const stream = await routes.musicStream(id, meta?.media?.encryptedUrl);
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
                const cover = await resolveCover(thumbnails);
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

        const { data, stats } = await buildMuzzaBackup({ songs: [...songMap.values()], likedIds, playlists });

        const result = await dialog.showSaveDialog({
            title: 'Export to Muzza',
            defaultPath: `Zeta_${backupTimestamp()}.backup`,
            filters: [{ name: 'Muzza backup', extensions: ['backup'] }],
        });
        if (result.canceled || !result.filePath) return null;

        writeFileSync(result.filePath, data);
        log(`Exported Muzza backup to ${result.filePath}`, stats);
        return { path: result.filePath, songs: stats.songs, playlists: stats.playlists, liked: stats.liked };
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
};

function backupTimestamp(): string {
    const d = new Date();
    const p = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
