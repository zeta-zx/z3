import { BrowserWindow, dialog } from 'electron';

import type { routes as MusicRoutes } from './music';
import { routes as mpris } from './mpris';
import { callBackend } from '../lib/backend';

import { Client, type SetActivity, type SetActivityResponse } from '@xhayper/discord-rpc';

/* ---------------------------------- music --------------------------------- */
// The music routes run in the backend utility process (see ../backend.ts);
// here they're thin typed proxies. `import type` keeps the heavy backend code
// out of the main process entirely.

type Music = typeof MusicRoutes;

const MUSIC_ROUTES = [
    'musicLyrics',
    'musicSearchSuggestions',
    'musicSearch',
    'musicStream',
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
    'setMusicDir',
    'muzzaExportTo',
    'muzzaImportFrom',
    'statsRecordEvent',
    'statsSummary',
] as const satisfies readonly (keyof Music)[];

// Compile-time check that every backend route above is listed (and so exposed).
type Unlisted = Exclude<keyof Music, (typeof MUSIC_ROUTES)[number]>;
const _everyRouteListed: [Unlisted] extends [never] ? true : Unlisted = true;
void _everyRouteListed;

const music = Object.fromEntries(
    MUSIC_ROUTES.map((name) => [name, (...args: unknown[]) => callBackend(name, args)]),
) as unknown as Music;

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
    /** Open a native folder picker (local directories only). Returns null if cancelled. */
    async pickMusicDirectory(): Promise<string | null> {
        const result = await dialog.showOpenDialog(parentWindow(), {
            title: 'Choose a music directory',
            properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
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
};

/* ------------------------------- Discord RPC ------------------------------ */

const rpc = new Client({ clientId: '1499408750526595152' });

rpc.login().catch(err => console.warn("Discord RPC failed to connect (is Discord running?):", err));

export const routes = {
    async clearRPC() {
        if (!rpc.user) return;
        await rpc.user.clearActivity();
    },
    async setRPC(activity: SetActivity): Promise<SetActivityResponse | null> {
        if (!rpc.user) return null;
        return await rpc.user.setActivity(activity);
    },
    ...music,
    ...dialogs,
    ...mpris,
};
