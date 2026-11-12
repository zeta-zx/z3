import { BrowserWindow, dialog, screen } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { MAX_BACKUP_BYTES } from '../../src/lib/zeta-backup';

import type { routes as MusicRoutes } from './music';
import { routes as mpris } from './mpris';
import { callBackend } from '../lib/backend';
import { updateRoutes } from '../lib/updates';
import { nearbyRoutes } from '../lib/nearby';
import { wayshipRoutes } from '../lib/wayship';

import { Client, type SetActivity, type SetActivityResponse } from '@xhayper/discord-rpc';

/* ---------------------------------- music --------------------------------- */
// The music routes run in the backend utility process (see ../backend.ts);
// here they're thin typed proxies. `import type` keeps the heavy backend code
// out of the main process entirely.

type Music = typeof MusicRoutes;

const MUSIC_ROUTES = [
    'scrobbleStatus', 'scrobbleTaste', 'scrobbleSimilarArtists', 'scrobbleLastfmStart', 'scrobbleLastfmFinish', 'scrobbleListenbrainzConnect',
    'scrobbleSetEnabled', 'scrobbleDisconnect', 'scrobbleNowPlaying', 'scrobbleSubmit', 'scrobbleRetry',
    'musicLyrics',
    'musicSearchSuggestions',
    'musicSearch',
    'musicSearchExtras',
    'musicSearchPlaylists',
    'musicSearchAlbums',
    'musicSearchVideos',
    'musicVideoStream',
    'musicArtist',
    'musicArtistSongs',
    'musicCollection',
    'musicStream',
    'musicStorage',
    'musicRemoveDownload',
    'musicClearCache',
    'zetaBackupBytes',
    'zetaImportBytes',
    'musicLoadLibrary',
    'musicPlaylistCreate',
    'musicPlaylistRename',
    'musicPlaylistDelete',
    'musicPlaylistReorder',
    'musicPlaylistUpdateThumbnail',
    'musicDownloadSong',
    'musicPlaylistAddTrack',
    'musicPlaylistRemoveTrack',
    'musicRadio',
    'musicCover',
    'musicRepairMetadata',
    'fetchImage',
    'getSettings',
    'listYoutubeBrowserProfiles',
    'setYoutubeBrowserProfile',
    'setMusicDir',
    'setDiscordRpcEnabled',
    'muzzaExportTo',
    'muzzaImportFrom',
    'm3uImportFrom',
    'spotifyPlaylistImportFrom',
    'youtubePlaylistImport',
    'statsRecordEvent',
    'statsSummary',
    'statsLastPlayed',
] as const satisfies readonly (keyof Music)[];

// Cookie settings are reached through the native file dialog below.
// Require every other backend route to be listed here.
type Unlisted = Exclude<keyof Music, (typeof MUSIC_ROUTES)[number] | 'setYoutubeCookiesFile' | 'zetaExportTo' | 'zetaImportFrom'>;
const _everyRouteListed: [Unlisted] extends [never] ? true : Unlisted = true;
void _everyRouteListed;

const music = Object.fromEntries(
    MUSIC_ROUTES.map((name) => [name, (...args: unknown[]) => callBackend(name, args)]),
) as unknown as Pick<Music, (typeof MUSIC_ROUTES)[number]>;

/* --------------------------------- dialogs -------------------------------- */
// Native dialogs need the main process; the backend then does the actual work.

function parentWindow() {
    return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function backupTimestamp(): string {
    const d = new Date();
    const p = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const dialogs = {
    async pickYoutubeCookies(): Promise<boolean | null> {
        const picked = await dialog.showOpenDialog(parentWindow(), {
            title: 'Choose a YouTube cookies.txt file',
            properties: ['openFile'],
            filters: [{ name: 'Cookies text file', extensions: ['txt'] }],
        });
        if (picked.canceled || picked.filePaths.length === 0) return null;
        return callBackend<boolean>('setYoutubeCookiesFile', [picked.filePaths[0]]);
    },

    async clearYoutubeCookies(): Promise<void> {
        await callBackend('setYoutubeCookiesFile', [null]);
    },

    /** Open a native folder picker (local directories only). Returns null if cancelled. */
    async pickMusicDirectory(): Promise<string | null> {
        const result = await dialog.showOpenDialog(parentWindow(), {
            title: 'Choose a music directory',
            properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    },

    async zetaExport(includeAudio: boolean) {
        const picked = await dialog.showSaveDialog(parentWindow(), {
            title: 'Save Zeta backup',
            defaultPath: `Zeta_${backupTimestamp()}.zetabackup`,
            filters: [{ name: 'Zeta backup', extensions: ['zetabackup'] }],
        });
        if (picked.canceled || !picked.filePath) return null;
        return callBackend<Awaited<ReturnType<Music['zetaExportTo']>>>('zetaExportTo', [picked.filePath, includeAudio]);
    },

    async zetaPickBackup(): Promise<Uint8Array | null> {
        const picked = await dialog.showOpenDialog(parentWindow(), {
            title: 'Preview Zeta backup',
            properties: ['openFile'],
            filters: [{ name: 'Zeta backup', extensions: ['zetabackup'] }],
        });
        const path = picked.filePaths[0];
        if (picked.canceled || !path) return null;
        if ((await stat(path)).size > MAX_BACKUP_BYTES) throw new Error('The backup exceeds 512 MiB.');
        return new Uint8Array(await readFile(path));
    },

    async zetaImport() {
        const picked = await dialog.showOpenDialog(parentWindow(), {
            title: 'Import Zeta backup',
            properties: ['openFile'],
            filters: [{ name: 'Zeta backup', extensions: ['zetabackup'] }],
        });
        if (picked.canceled || !picked.filePaths.length) return null;
        return callBackend<Awaited<ReturnType<Music['zetaImportFrom']>>>('zetaImportFrom', [picked.filePaths[0]]);
    },

    /** Export the library to a Muzza `.backup` file. Returns null if cancelled. */
    async muzzaExport() {
        const result = await dialog.showSaveDialog(parentWindow(), {
            title: 'Export to Muzza',
            defaultPath: `Zeta_${backupTimestamp()}.backup`,
            filters: [{ name: 'Muzza backup', extensions: ['backup'] }],
        });
        if (result.canceled || !result.filePath) return null;
        return music.muzzaExportTo(result.filePath);
    },

    /** Import a Muzza `.backup` file. Returns null if cancelled. */
    async muzzaImport() {
        const picked = await dialog.showOpenDialog(parentWindow(), {
            title: 'Import from Muzza',
            properties: ['openFile'],
            filters: [
                { name: 'Muzza backup', extensions: ['backup'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (picked.canceled || picked.filePaths.length === 0) return null;
        return music.muzzaImportFrom(picked.filePaths[0]);
    },

    /** Import a local `.m3u` or `.m3u8` playlist. */
    async m3uImport() {
        const picked = await dialog.showOpenDialog(parentWindow(), {
            title: 'Import playlist',
            properties: ['openFile'],
            filters: [
                { name: 'M3U playlists', extensions: ['m3u', 'm3u8'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (picked.canceled || picked.filePaths.length === 0) return null;
        return music.m3uImportFrom(picked.filePaths[0]);
    },

    /** Import an Exportify Spotify playlist CSV. */
    async spotifyPlaylistImport() {
        const picked = await dialog.showOpenDialog(parentWindow(), {
            title: 'Import Spotify playlist CSV',
            properties: ['openFile'],
            filters: [
                { name: 'CSV files', extensions: ['csv'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (picked.canceled || picked.filePaths.length === 0) return null;
        return music.spotifyPlaylistImportFrom(picked.filePaths[0]);
    },
};

/* ------------------------------ window chrome ----------------------------- */
// On Linux the OS title bar and its window buttons are gone, so the renderer
// draws its own (TitleBar.svelte) and calls these. Edge resizing is driven from
// here too, because a frameless transparent window has no native resize border.

function appWindow(): BrowserWindow | null {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return win && !win.isDestroyed() ? win : null;
}

let resizing: { edge: string; from: ReturnType<BrowserWindow['getBounds']>; start: { x: number; y: number } } | null =
    null;

const windowChrome = {
    async windowMinimize(): Promise<void> {
        appWindow()?.minimize();
    },
    async windowMaximizeToggle(): Promise<boolean> {
        const win = appWindow();
        if (!win) return false;
        const maximised = win.isMaximized();
        if (maximised) win.unmaximize();
        else win.maximize();
        return !maximised;
    },
    async windowClose(): Promise<void> {
        appWindow()?.close();
    },
    async windowIsMaximized(): Promise<boolean> {
        return appWindow()?.isMaximized() ?? false;
    },
    async windowResizeStart(edge: string): Promise<void> {
        const win = appWindow();
        if (!win) return;
        resizing = { edge, from: win.getBounds(), start: screen.getCursorScreenPoint() };
    },
    /** Called as the pointer moves; the renderer sends screen coordinates. */
    async windowResizeMove(x: number, y: number): Promise<void> {
        const win = appWindow();
        if (!win || !resizing || win.isDestroyed()) return;
        const { edge, from, start } = resizing;
        const [minW, minH] = win.getMinimumSize();
        const dx = x - start.x;
        const dy = y - start.y;
        let { x: left, y: top, width, height } = from;
        if (edge.includes('e')) width = Math.max(minW, from.width + dx);
        if (edge.includes('s')) height = Math.max(minH, from.height + dy);
        if (edge.includes('w')) {
            width = Math.max(minW, from.width - dx);
            left = from.x + from.width - width;
        }
        if (edge.includes('n')) {
            height = Math.max(minH, from.height - dy);
            top = from.y + from.height - height;
        }
        win.setBounds({ x: left, y: top, width, height });
    },
    async windowResizeEnd(): Promise<void> {
        resizing = null;
    },
};

/* ------------------------------- Discord RPC ------------------------------ */

let rpc: Client;
let rpcActivity: SetActivity | null = null;
let rpcLoginPromise: Promise<void> | null = null;
let rpcRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRPCReconnect() {
    if (rpcRetryTimer) return;
    rpcRetryTimer = setTimeout(() => {
        rpcRetryTimer = null;
        void connectRPC();
    }, 10_000);
    rpcRetryTimer.unref?.();
}

function createRPCClient(): Client {
    const client = new Client({ clientId: '1499408750526595152' });
    client.on('ready', () => {
        if (client !== rpc || !rpcActivity) return;
        client.user?.setActivity(rpcActivity).catch((err) => console.warn('[discord-rpc] Failed to restore activity:', err));
    });
    client.on('disconnected', () => {
        if (client !== rpc) return;
        rpc = createRPCClient();
        scheduleRPCReconnect();
    });
    return client;
}

async function connectRPC(): Promise<void> {
    if (rpcRetryTimer) {
        clearTimeout(rpcRetryTimer);
        rpcRetryTimer = null;
    }
    if (rpc.isConnected) return;
    if (rpcLoginPromise) return rpcLoginPromise;

    const client = rpc;
    rpcLoginPromise = client.login().catch((err) => {
        if (client !== rpc) return;
        console.warn('[discord-rpc] Failed to connect, retrying:', err);
        rpc = createRPCClient();
        scheduleRPCReconnect();
    }).finally(() => {
        rpcLoginPromise = null;
    });
    return rpcLoginPromise;
}

rpc = createRPCClient();
void connectRPC();

/**
 * Discord's servers fetch rich-presence artwork themselves, so only a public
 * http(s) URL can be shown. Library songs usually only carry their embedded
 * cover (`zeta-cover://…`), which Discord can't reach, so the presence fell
 * back to the app icon. They do remember the YouTube video they came from,
 * though, and that video's thumbnail is public. Use the sharpest one that
 * actually exists: maxres is missing on older/low-res uploads, and `mqdefault`
 * always exists (16:9, no letterbox bars).
 */
const ytArtCache = new Map<string, string>();
const YT_VARIANTS = ['maxresdefault', 'hq720', 'mqdefault'] as const;
const appleArtCache = new Map<string, string>();

function artworkMatchText(value: string): string {
    return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

async function youtubeArtwork(videoId: string): Promise<string> {
    const cached = ytArtCache.get(videoId);
    if (cached !== undefined) return cached;
    for (const variant of YT_VARIANTS) {
        const url = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${variant}.jpg`;
        try {
            const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
            if (!res.ok) continue;
            if (ytArtCache.size > 500) ytArtCache.delete(ytArtCache.keys().next().value as string);
            ytArtCache.set(videoId, url);
            return url;
        } catch {
            /* try the next variant */
        }
    }
    ytArtCache.set(videoId, '');
    return '';
}

async function appleMusicArtwork(title: string, artists: string[], album?: string): Promise<string> {
    const query = [title, ...artists, album].filter(Boolean).join(' ').trim();
    if (!title.trim() || !artists.some((artist) => artist.trim())) return '';
    const cacheKey = artworkMatchText(query);
    const cached = appleArtCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({ term: query, entity: 'song', limit: '15' }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Apple Music artwork search returned ${response.status}.`);
    const result = await response.json();
    const wantedTitle = artworkMatchText(title);
    const wantedArtists = artists.map(artworkMatchText).filter(Boolean);
    const wantedAlbum = artworkMatchText(album ?? '');
    const matches = (result.results ?? [])
        .map((item: { trackName?: string; artistName?: string; collectionName?: string; artworkUrl100?: string }) => {
            const candidateTitle = artworkMatchText(item.trackName ?? '');
            const candidateArtist = artworkMatchText(item.artistName ?? '');
            const candidateAlbum = artworkMatchText(item.collectionName ?? '');
            if (!candidateTitle || !candidateArtist) return { score: 0, artwork: '' };
            const titleMatches = candidateTitle === wantedTitle || candidateTitle.startsWith(`${wantedTitle} `) || wantedTitle.startsWith(`${candidateTitle} `);
            const artistMatches = wantedArtists.some((artist) => candidateArtist === artist || candidateArtist.includes(artist) || artist.includes(candidateArtist));
            if (!titleMatches || !artistMatches) return { score: 0, artwork: '' };
            const score =
                (candidateTitle === wantedTitle ? 4 : 2) +
                (wantedAlbum && candidateAlbum === wantedAlbum ? 2 : 0) +
                (wantedAlbum && candidateAlbum && candidateAlbum !== wantedAlbum ? -1 : 0);
            return { score, artwork: item.artworkUrl100 ?? '' };
        })
        .filter((match: { score: number; artwork: string }) => match.score > 0 && match.artwork)
        .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

    const artwork = matches[0]?.artwork.replace(/\d+x\d+bb(?=\.)/, '1200x1200bb') ?? '';
    if (appleArtCache.size > 500) appleArtCache.delete(appleArtCache.keys().next().value as string);
    appleArtCache.set(cacheKey, artwork);
    return artwork;
}

export const routes = {
    ...updateRoutes,
    ...nearbyRoutes,
    ...wayshipRoutes,
    async openScrobblingLink(url: string): Promise<void> {
        const target = new URL(url);
        if (target.protocol !== 'https:' || !['www.last.fm', 'last.fm', 'listenbrainz.org'].includes(target.hostname)) throw new Error('Invalid account connection link.');
        const { shell } = await import('electron');
        await shell.openExternal(url);
    },
    async openMusicVideo(videoId: string): Promise<void> {
        if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid YouTube video ID.');
        const { shell } = await import('electron');
        await shell.openExternal(`https://www.youtube.com/watch?v=${videoId}`);
    },
    ...windowChrome,
    async clearRPC() {
        rpcActivity = null;
        if (!rpc.user) return;
        await rpc.user.clearActivity();
    },
    /** A public image URL for Discord, using Apple Music lookup only for local tracks. */
    async rpcArtwork(trackId: string, urls: string[], title: string, artists: string[], album?: string): Promise<string> {
        const remote = urls.find((url) => /^https?:\/\//i.test(url));
        if (remote) return remote;
        if (trackId.startsWith('yt:')) return youtubeArtwork(trackId.slice(3));
        if (trackId.startsWith('local:') || trackId.startsWith('fs:')) {
            try {
                return await appleMusicArtwork(title, artists, album);
            } catch (err) {
                console.warn('[discord-rpc] Apple Music artwork lookup failed:', err);
            }
        }
        return '';
    },
    async setRPC(activity: SetActivity): Promise<SetActivityResponse | null> {
        rpcActivity = activity;
        if (!rpc.user) {
            void connectRPC();
            return null;
        }
        return await rpc.user.setActivity(activity);
    },
    ...music,
    ...dialogs,
    ...mpris,
};
