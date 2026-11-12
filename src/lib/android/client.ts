import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import type { NearbyEndpoint } from '../nearby-pairing';
import type { Routes } from '../../../electron/main';
import type { Library, Song, Stream } from '../schema';
import { androidStorage as storage, MUSIC_PATH, rememberSong, requirePlaylist, type StoredSong } from './storage';
import * as providers from './providers';
import { androidScrobbling } from './scrobbling';
import { getStreamingQuality, type AudioQuality } from '../audio-quality';

type LocatedSong = StoredSong & { directory: Directory };
const rangedDownload = registerPlugin<{
    download(options: { url: string; path: string; size: number }): Promise<void>;
}>('ZetaMediaDownload');
const nearby = registerPlugin<{
    listen(): Promise<NearbyEndpoint>;
    receive(): Promise<{ packets: string[] }>;
    close(): Promise<void>;
    send(options: { addresses: string[]; port: number; packet: string }): Promise<void>;
}>('ZetaNearby');
const downloads = new Map<string, Promise<LocatedSong>>();
const temporary = new Map<string, LocatedSong>();
const files = registerPlugin<{ importAudio(): Promise<{ songs: StoredSong[] }> }>('ZetaFiles');
const onlineBridge = registerPlugin<{
    addListener(eventName: 'onlineSearch', listenerFunc: (request: { requestId: string; query: string }) => void): Promise<PluginListenerHandle>;
    addListener(eventName: 'onlineResolve', listenerFunc: (request: { requestId: string; mediaId: string }) => void): Promise<PluginListenerHandle>;
    setOnlineBridgeReady(options: { ready: boolean }): Promise<void>;
    completeOnlineRequest(options: { requestId: string; result: string }): Promise<void>;
    failOnlineRequest(options: { requestId: string; error: string }): Promise<void>;
}>('ZetaPlayer');
const unsupported = async (): Promise<never> => { throw new Error('This feature is available in the desktop app.'); };
const noop = async () => {};

const songCache = new Map<string, Song>();
function cacheSongs(songs: Song[]) {
    for (const song of songs) songCache.set(song.id, song);
    return songs;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function reportOnlineRequestError(requestId: string, error: unknown) {
    const message = errorMessage(error);
    try {
        await onlineBridge.failOnlineRequest({ requestId, error: message });
    } catch (bridgeError) {
        console.error('[android-auto] Could not report an online request failure:', bridgeError);
    }
}

const onlineBridgeListeners = Promise.all([
    onlineBridge.addListener('onlineSearch', async ({ requestId, query }) => {
        try {
            const results = await Promise.allSettled([
                providers.search(query, 'yt'),
                providers.search(query, 'js'),
            ]);
            const available = results.flatMap((result) => {
                if (result.status === 'fulfilled') return result.value;
                console.warn('[android-auto] One online music provider search failed:', result.reason);
                return [];
            });
            if (!available.length) {
                const failures = results
                    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                    .map((result) => errorMessage(result.reason));
                throw new Error(`Online search failed: ${failures.join('; ')}`);
            }
            const songs = cacheSongs([...new Map(available.map((song) => [song.id, song])).values()]);
            await onlineBridge.completeOnlineRequest({ requestId, result: JSON.stringify(songs) });
        } catch (error) {
            await reportOnlineRequestError(requestId, error);
        }
    }),
    onlineBridge.addListener('onlineResolve', async ({ requestId, mediaId }) => {
        try {
            const stored = await download(mediaId, undefined, false, getStreamingQuality());
            const { uri } = await Filesystem.getUri({ directory: stored.directory, path: stored.file! });
            await onlineBridge.completeOnlineRequest({ requestId, result: JSON.stringify({ url: uri }) });
        } catch (error) {
            await reportOnlineRequestError(requestId, error);
        }
    }),
]).then(async (handles) => {
    await onlineBridge.setOnlineBridgeReady({ ready: true });
    return handles;
}).catch((error) => {
    console.error('[android-auto] Could not initialize online music support:', error);
    void onlineBridge.setOnlineBridgeReady({ ready: false }).catch((bridgeError) => {
        console.error('[android-auto] Could not disable the unavailable online music bridge:', bridgeError);
    });
    return [] as PluginListenerHandle[];
});

void onlineBridgeListeners;

async function library(): Promise<Library> {
    const data = await storage.snapshot();
    // Imported files and explicit downloads also appear outside playlists.
    return {
        playlists: [...data.playlists, {
            id: 'downloads', name: 'Downloads', isProtected: true, createdAt: 0,
            tracks: Object.values(data.songs).filter((s) => s.file).map((s) => s.song),
        }],
        path: 'On this device',
    };
}

async function download(id: string, track?: Song, save = true, quality: AudioQuality = 'best'): Promise<LocatedSong> {
    const requestKey = `${save ? 'saved' : 'cache'}:${id}`;
    const existing = downloads.get(requestKey);
    if (existing) return existing;
    const pending = (async () => {
        const data = await storage.snapshot();
        const stored = data.songs[id];
        if (stored?.file) {
            try {
                await Filesystem.stat({ directory: Directory.Data, path: stored.file });
                return { ...stored, directory: Directory.Data };
            } catch (error) {
                if ((error as { code?: string }).code !== 'OS-PLUG-FILE-0008') throw error;
            }
        }
        const cached = temporary.get(id);
        if (!save && cached?.file) {
            try {
                await Filesystem.stat({ directory: cached.directory, path: cached.file });
                return cached;
            } catch (error) {
                if ((error as { code?: string }).code !== 'OS-PLUG-FILE-0008') throw error;
                temporary.delete(id);
            }
        }
        const song = track ?? stored?.song ?? songCache.get(id);
        if (!song) throw new Error('Search for this song again before downloading it.');
        const directory = save ? Directory.Data : Directory.Cache;
        if (!save) await Filesystem.mkdir({ directory, path: `${MUSIC_PATH}/audio`, recursive: true }).catch((error) => {
            if (error.code !== 'OS-PLUG-FILE-0010') throw error;
        });
        let lastError: unknown;
        for await (const audio of providers.resolveAudioCandidates(id, quality)) {
            const extension = audio.mimetype.includes('webm') ? 'webm' : audio.mimetype.startsWith('video/') ? 'mp4' : 'm4a';
            const path = `${MUSIC_PATH}/audio/${encodeURIComponent(id)}.${extension}`;
            const temp = `${path}.${crypto.randomUUID()}.part`;
            try {
                const destination = await Filesystem.getUri({ directory, path: temp });
                if (id.startsWith('yt:') && audio.contentLength) {
                    await rangedDownload.download({ url: audio.url, path: destination.uri, size: audio.contentLength });
                } else {
                    await FileTransfer.downloadFile({
                        url: audio.url, path: destination.uri,
                        headers: { 'User-Agent': navigator.userAgent, Referer: id.startsWith('yt:') ? 'https://www.youtube.com/' : 'https://www.jiosaavn.com/' },
                        connectTimeout: 10_000, readTimeout: 40_000,
                    });
                }
                if (!(await Filesystem.stat({ directory, path: temp })).size) throw new Error('The provider returned an empty audio file.');
                await Filesystem.rename({ directory, from: temp, to: path });
            } catch (error) {
                lastError = error;
                await Filesystem.deleteFile({ directory, path: temp }).catch(() => {});
                continue;
            }
            const result = { song: { ...song, isDownloaded: save }, file: path, mimetype: audio.mimetype, directory };
            if (save) await storage.edit((state) => rememberSong(state, result));
            else temporary.set(id, result);
            return result;
        }
        if (/403|forbidden/i.test(String((lastError as Error | undefined)?.message ?? lastError))) {
            throw new Error(`${id.startsWith('yt:') ? 'YouTube' : 'JioSaavn'} refused the available audio streams (HTTP 403). Try another recording or an offline copy.`);
        }
        if (lastError) throw lastError;
        throw new Error('The provider returned no playable audio for this track.');
    })();
    downloads.set(requestKey, pending);
    try { return await pending; } finally { downloads.delete(requestKey); }
}

export async function importAudio(): Promise<void> {
    // Initialize directories/index before the native picker copies files.
    await storage.snapshot();
    const { songs } = await files.importAudio();
    for (const { song } of songs) {
        song.thumbnails = song.thumbnails.map((thumb) => ({ ...thumb, url: thumb.url ? Capacitor.convertFileSrc(thumb.url) : undefined }));
    }
    await storage.edit((state) => {
        for (const song of songs) rememberSong(state, song);
    });
}

export const androidClient: Routes = {
    ...androidScrobbling,
    nearbyListen: () => nearby.listen(),
    nearbyReceive: async () => (await nearby.receive()).packets,
    nearbyClose: () => nearby.close(),
    nearbySend: (addresses, port, packet) => nearby.send({ addresses, port, packet }),
    async wayshipConnect(deviceName) {
        const label = (deviceName?.trim() || 'Android').slice(0, 60);
        const url = new URL('https://wayship.link/connect');
        url.searchParams.set('app', 'zeta');
        url.searchParams.set('name', 'Zeta');
        url.searchParams.set('device_name', label);
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url: url.toString() });
        return { token: '', accountId: '', handle: '', connId: null, deviceName: label };
    },
    updateStatus: async () => (await import('./updates')).updateRoutes.updateStatus(),
    checkForZetaUpdate: async () => (await import('./updates')).updateRoutes.checkForZetaUpdate(),
    applyZetaUpdate: async () => (await import('./updates')).updateRoutes.applyZetaUpdate(),
    async openScrobblingLink(url) {
        const target = new URL(url);
        if (target.protocol !== 'https:' || !['www.last.fm', 'last.fm', 'listenbrainz.org'].includes(target.hostname)) throw new Error('Invalid account connection link.');
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url });
    },
    async musicLoadLibrary() { return library(); },
    async musicSearch(query, provider) {
        const data = await storage.snapshot();
        return cacheSongs((await providers.search(query, provider)).map((song) => ({ ...song, isDownloaded: !!data.songs[song.id]?.file })));
    },
    musicSearchExtras: providers.searchExtras,
    musicSearchPlaylists: providers.searchPlaylists,
    musicSearchAlbums: providers.searchAlbums,
    musicSearchVideos: providers.searchVideos,
    musicVideoStream: providers.videoStream,
    async openMusicVideo(videoId) {
        if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid YouTube video ID.');
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url: `https://www.youtube.com/watch?v=${videoId}` });
    },
    async musicArtist(idOrQuery, nameHint) {
        const data = await storage.snapshot();
        const downloaded = new Set(Object.values(data.songs).filter((s) => s.file).map((s) => s.song.id));
        const res = await providers.artist(idOrQuery, nameHint, downloaded);
        cacheSongs(res.topSongs);
        return res;
    },
    async musicArtistSongs(artistId, nameHint) {
        const data = await storage.snapshot();
        const downloaded = new Set(Object.values(data.songs).filter((s) => s.file).map((s) => s.song.id));
        return cacheSongs(await providers.artistSongs(artistId, nameHint, downloaded));
    },
    async musicCollection(id) {
        const data = await storage.snapshot();
        const downloaded = new Set(Object.values(data.songs).filter((s) => s.file).map((s) => s.song.id));
        const res = await providers.collection(id, downloaded);
        cacheSongs(res.tracks);
        return res;
    },
    musicSearchSuggestions: providers.suggestions,
    musicLyrics: providers.lyrics,
    async musicStream(id, _encrypted, persist = true, track, quality: AudioQuality = 'best'): Promise<Stream> {
        const state = await storage.snapshot();
        const save = !!state.songs[id]?.file || (persist && !!state.songs[id]);
        // Search-only/preloaded tracks use disposable cache storage, while
        // library tracks are kept offline just as they are on desktop.
        const stored = await download(id, track, save, quality);
        const uri = await Filesystem.getUri({ directory: stored.directory, path: stored.file! });
        return { data: new Uint8Array(), url: Capacitor.convertFileSrc(uri.uri), nativeUri: uri.uri, mimetype: stored.mimetype!, savedToDisk: stored.directory === Directory.Data };
    },
    async musicDownloadSong(track, id, quality: AudioQuality = 'best') {
        if (!track && !id) throw new Error('Choose a song to download.');
        return (await download(track?.id ?? id!, track, true, quality)).song;
    },
    async musicPlaylistCreate(name) {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Enter a playlist name.');
        return storage.edit((state) => {
            const playlist = { id: `${crypto.randomUUID()}.m3u8`, name: trimmed, tracks: [], createdAt: Date.now() };
            state.playlists.push(playlist);
            return playlist;
        });
    },
    async musicPlaylistRename(id, name) {
        if (!name.trim()) throw new Error('Enter a playlist name.');
        return storage.edit((state) => { const p = requirePlaylist(state, id, true); p.name = name.trim(); return p; });
    },
    async musicPlaylistDelete(id) {
        await storage.edit((state) => {
            requirePlaylist(state, id, true);
            state.playlists = state.playlists.filter((p) => p.id !== id);
        });
    },
    async musicPlaylistAddTrack(id, track, trackId) {
        const data = await storage.snapshot();
        const key = track?.id ?? trackId;
        const song = key ? data.songs[key]?.song ?? track ?? songCache.get(key) : undefined;
        if (!song) throw new Error('Choose a song to add.');
        return storage.edit((state) => {
            const playlist = requirePlaylist(state, id);
            state.songs[song.id] ??= { song };
            const canonical = state.songs[song.id].song;
            if (!playlist.tracks.some((t) => t.id === song.id)) playlist.tracks.push(canonical);
            return canonical;
        });
    },
    async musicPlaylistRemoveTrack(id, trackId) {
        await storage.edit((state) => { const p = requirePlaylist(state, id); p.tracks = p.tracks.filter((t) => t.id !== trackId); });
    },
    async musicPlaylistReorder(id, ids) {
        return storage.edit((state) => {
            const playlist = requirePlaylist(state, id);
            const tracks = new Map(playlist.tracks.map((song) => [song.id, song]));
            if (ids.length !== tracks.size || new Set(ids).size !== tracks.size || ids.some((key) => !tracks.has(key))) {
                throw new Error('The playlist changed. Refresh it before reordering.');
            }
            playlist.tracks = ids.map((key) => tracks.get(key)!);
            return playlist;
        });
    },
    async musicPlaylistUpdateThumbnail(id, thumbnail) {
        return storage.edit((state) => { const p = requirePlaylist(state, id); p.thumbnail = thumbnail; return p; });
    },
    async musicRadio(seed, exclude = []) {
        const data = await storage.snapshot();
        const downloaded = new Set(Object.entries(data.songs).filter(([, song]) => song.file).map(([id]) => id));
        const songs = await providers.radio(seed, exclude, downloaded);
        return cacheSongs(songs.map((song) => ({
            ...song,
            isDownloaded: !!data.songs[song.id]?.file,
        })));
    },
    async musicRepairMetadata() { return { repaired: [], remaining: 0 }; },
    async musicCover() { return null; },
    async fetchImage(url) {
        const response = await fetch(url);
        if (!response.ok) return null;
        return { data: new Uint8Array(await response.arrayBuffer()), mimetype: response.headers.get('content-type') || 'image/jpeg' };
    },
    async getSettings() { return { musicDir: 'On this device', isRemote: false, discordRpcEnabled: false, youtubeCookiesConfigured: false, youtubeBrowserProfileId: null }; },
    async setDiscordRpcEnabled() { return false; },
    setMusicDir: unsupported, pickMusicDirectory: unsupported,
    pickYoutubeCookies: unsupported, clearYoutubeCookies: unsupported,
    listYoutubeBrowserProfiles: unsupported, setYoutubeBrowserProfile: unsupported,
    zetaPickBackup: async () => (await import('./backups')).backupRoutes.zetaPickBackup(),
    zetaBackupBytes: async (audio) => (await import('./backups')).backupRoutes.zetaBackupBytes(audio),
    zetaImportBytes: async (bytes) => (await import('./backups')).backupRoutes.zetaImportBytes(bytes),
    async musicStorage() {
        const data = await storage.snapshot();
        const audio = (await Promise.all(Object.values(data.songs).map(async ({ song, file }) => {
            if (!file) return null;
            const info = await Filesystem.stat({ directory: Directory.Data, path: file }).catch(() => null);
            return info ? { id: song.id, title: song.title, bytes: info.size, removable: /^(yt|js):/.test(song.id) } : null;
        }))).filter((entry) => entry !== null);
        const cached = await Filesystem.readdir({ directory: Directory.Cache, path: `${MUSIC_PATH}/audio` }).catch(() => null);
        return { audio, cacheBytes: cached?.files.reduce((sum, file) => sum + (file.size ?? 0), 0) ?? 0 };
    },
    async musicRemoveDownload(id) {
        if (!/^(yt|js):/.test(id)) throw new Error('Only provider downloads can be removed here.');
        const current = (await storage.snapshot()).songs[id];
        if (!current?.file) return;
        const file = current.file;
        await storage.edit((data) => rememberSong(data, { song: { ...current.song, isDownloaded: false } }));
        try {
            await Filesystem.deleteFile({ directory: Directory.Data, path: file });
        } catch (error) {
            if ((error as { code?: string }).code === 'OS-PLUG-FILE-0008') return;
            await storage.edit((data) => rememberSong(data, current));
            throw error;
        }
    },
    async musicClearCache() {
        const cached = await Filesystem.readdir({ directory: Directory.Cache, path: `${MUSIC_PATH}/audio` }).catch(() => null);
        if (!cached) return;
        const playing = (await import('../state/player.svelte')).playerState.currentTrack?.id;
        const { cache } = await import('../state/player.svelte');
        const protectedFile = playing ? temporary.get(playing)?.file : undefined;
        for (const file of cached.files) {
            if (file.type !== 'file' || file.name.endsWith('.part')) continue;
            const path = `${MUSIC_PATH}/audio/${file.name}`;
            if (path === protectedFile) continue;
            await Filesystem.deleteFile({ directory: Directory.Cache, path });
            for (const [id, item] of temporary) if (item.file === path) { temporary.delete(id); cache.delete(id); }
        }
    },
    zetaExport: async (audio) => (await import('./backups')).backupRoutes.zetaExport(audio),
    zetaImport: async () => (await import('./backups')).backupRoutes.zetaImport(),
    muzzaExport: async () => (await import('./backups')).backupRoutes.muzzaExport(),
    muzzaImport: async () => (await import('./backups')).backupRoutes.muzzaImport(),
    muzzaExportTo: unsupported, muzzaImportFrom: unsupported,
    m3uImport: unsupported, m3uImportFrom: unsupported, spotifyPlaylistImport: unsupported,
    spotifyPlaylistImportFrom: unsupported, youtubePlaylistImport: unsupported,
    async statsRecordEvent(songId, playTimeMs, timestamp = Date.now(), name) {
        if (!songId || !Number.isFinite(playTimeMs) || playTimeMs < 1000) return;
        await storage.edit((state) => {
            state.events.push({ songId, playTimeMs: Math.round(playTimeMs), timestamp });
            if (name) state.names[songId] = name;
        });
    },
    async statsLastPlayed(ids) {
        const wanted = new Set(ids);
        const last = new Map<string, number>();
        for (const { songId, timestamp } of (await storage.snapshot()).events) {
            if (wanted.has(songId)) last.set(songId, Math.max(last.get(songId) ?? 0, timestamp));
        }
        return Object.fromEntries(last);
    },
    async statsSummary(limit = 30, filter) {
        const { summarize } = await import('./stats');
        return summarize(await storage.snapshot(), limit, filter);
    },
    mprisUpdate: noop, clearRPC: noop, async setRPC() { return null; }, async rpcArtwork() { return ''; },
    windowMinimize: noop, async windowMaximizeToggle() { return false; }, async windowIsMaximized() { return false; },
    windowClose: noop, windowResizeStart: noop, windowResizeMove: noop, windowResizeEnd: noop,
};
