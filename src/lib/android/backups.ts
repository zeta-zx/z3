import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { Song, Thumbnail } from '../schema';
import { buildMuzzaArchive, parseMuzzaArchive } from '../muzza-codec';
import {
    audioExtension, backupAudioMime, BACKUP_AUDIO_LIMIT_MESSAGE, backupCounts, backupImage, backupPlaylistId, makeZetaBackup, MAX_BACKUP_BYTES,
    mergeBackupEvents, openZetaBackup, type BackupManifest, type BackupPlaylist,
} from '../zeta-backup';
import { androidStorage as storage, FAVOURITES_ID, MUSIC_PATH, rememberSong, requirePlaylist, type MobileLibrary, type StoredSong } from './storage';

const picker = registerPlugin<{
    pickBackup(options: { key: string }): Promise<{ selected: boolean }>;
    saveBackup(options: { key: string; muzza: boolean }): Promise<{ selected: boolean }>;
}>('ZetaBackups');

const CHUNK_BYTES = 1024 * 1024;

async function readBytes(directory: Directory, path: string): Promise<Uint8Array> {
    const { size } = await Filesystem.stat({ directory, path });
    if (size > MAX_BACKUP_BYTES) throw new Error('The file exceeds 512 MiB.');
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
        const length = Math.min(CHUNK_BYTES, size - offset);
        const { data } = await Filesystem.readFile({ directory, path, offset, length });
        const chunk = typeof data === 'string' ? atob(data) : new Uint8Array(await data.arrayBuffer());
        if (chunk.length !== length) throw new Error('The file changed while Zeta was reading it.');
        if (typeof chunk === 'string') {
            for (let index = 0; index < length; index++) bytes[offset + index] = chunk.charCodeAt(index);
        } else {
            bytes.set(chunk, offset);
        }
    }
    return bytes;
}

async function writeBytes(directory: Directory, path: string, bytes: Uint8Array) {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const chunk = Uint8Array.from(bytes.subarray(offset, offset + CHUNK_BYTES));
        const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
            reader.readAsDataURL(new Blob([chunk.buffer], { type: 'application/octet-stream' }));
        });
        if (offset === 0) await Filesystem.writeFile({ directory, path, data, recursive: true });
        else await Filesystem.appendFile({ directory, path, data });
    }
}

async function pickedBackup(): Promise<Uint8Array | null> {
    const key = crypto.randomUUID();
    const path = `backups/${key}`;
    try {
        if (!(await picker.pickBackup({ key })).selected) return null;
        return await readBytes(Directory.Cache, path);
    } finally {
        await Filesystem.deleteFile({ directory: Directory.Cache, path }).catch(() => {});
    }
}

async function saveBackup(bytes: Uint8Array, muzza: boolean): Promise<boolean> {
    if (bytes.length > MAX_BACKUP_BYTES) throw new Error('The backup exceeds 512 MiB.');
    const key = crypto.randomUUID();
    const path = `backups/${key}`;
    try {
        await writeBytes(Directory.Cache, path, bytes);
        return (await picker.saveBackup({ key, muzza })).selected;
    } finally {
        await Filesystem.deleteFile({ directory: Directory.Cache, path }).catch(() => {});
    }
}

async function portableThumbnails(stored: StoredSong): Promise<Thumbnail[]> {
    if (!stored.file) return stored.song.thumbnails;
    const cover = stored.file.replace(/\.[^.]+$/, '.cover');
    try {
        const bytes = await readBytes(Directory.Data, cover);
        return [{ data: bytes, mimetype: stored.song.thumbnails[0]?.mimetype || 'image/jpeg' }, ...stored.song.thumbnails];
    } catch {
        return stored.song.thumbnails;
    }
}

async function portableLibrary(data: MobileLibrary, includeAudio: boolean): Promise<BackupManifest> {
    const songs = new Map<string, BackupManifest['songs'][number]>();
    for (const stored of Object.values(data.songs)) {
        songs.set(stored.song.id, {
            song: includeAudio ? { ...stored.song, thumbnails: await portableThumbnails(stored) } : stored.song,
            audio: includeAudio ? stored.file : undefined,
        });
    }
    for (const list of data.playlists) {
        for (const song of list.tracks) if (!songs.has(song.id)) songs.set(song.id, { song });
    }
    return {
        songs: [...songs.values()],
        playlists: data.playlists.filter(({ isProtected }) => !isProtected).map((playlist) => ({
            id: playlist.id, name: playlist.name, createdAt: playlist.createdAt,
            thumbnail: backupImage(playlist.thumbnail), trackIds: playlist.tracks.map(({ id }) => id),
        })),
        favourites: requirePlaylist(data, FAVOURITES_ID).tracks.map(({ id }) => id),
        events: data.events, names: data.names,
    };
}

function mergeLists(data: MobileLibrary, favourites: string[], playlists: BackupPlaylist[]) {
    const liked = requirePlaylist(data, FAVOURITES_ID).tracks;
    const alreadyLiked = new Set(liked.map(({ id }) => id));
    for (const id of favourites) {
        if (alreadyLiked.has(id) || !data.songs[id]) continue;
        liked.push(data.songs[id].song);
        alreadyLiked.add(id);
    }
    for (const list of playlists) {
        const existing = data.playlists.find(({ id }) => id === list.id);
        const tracks = list.trackIds.flatMap((id) => data.songs[id]?.song ?? []);
        if (existing) {
            const ids = new Set(existing.tracks.map(({ id }) => id));
            for (const track of tracks) {
                if (ids.has(track.id)) continue;
                existing.tracks.push(track);
                ids.add(track.id);
            }
        } else {
            data.playlists.push({ id: list.id, name: list.name, createdAt: list.createdAt, thumbnail: list.thumbnail, tracks });
        }
    }
}

async function restoreCover(song: Song, path: string, staged: Set<string>) {
    const { thumbnails } = song;
    const embedded = thumbnails.find((item) => item.data?.length);
    song.thumbnails = thumbnails.filter((item) => item.url).map(({ data: _data, ...item }) => item);
    if (!embedded?.data) return;
    staged.add(path);
    await writeBytes(Directory.Data, path, embedded.data);
    const { uri } = await Filesystem.getUri({ directory: Directory.Data, path });
    song.thumbnails.unshift({ url: Capacitor.convertFileSrc(uri), mimetype: embedded.mimetype });
}

async function zetaBackupBytes(includeAudio: boolean) {
    const manifest = await portableLibrary(await storage.snapshot(), includeAudio);
    const bytes = await makeZetaBackup(manifest, async ({ audio }) => {
        if (!audio) return;
        const found = await Filesystem.stat({ directory: Directory.Data, path: audio }).catch((error) => {
            if (error.code !== 'OS-PLUG-FILE-0008') throw error;
            return null;
        });
        if (found && found.size > MAX_BACKUP_BYTES) throw new Error(BACKUP_AUDIO_LIMIT_MESSAGE);
        if (found) return readBytes(Directory.Data, audio);
    }, includeAudio);
    return { bytes, ...backupCounts(manifest) };
}

async function zetaExport(includeAudio: boolean) {
    const { bytes, ...counts } = await zetaBackupBytes(includeAudio);
    return await saveBackup(bytes, false) ? { path: '', ...counts } : null;
}

async function zetaImport() {
    const bytes = await pickedBackup();
    return bytes ? zetaImportBytes(bytes) : null;
}

async function zetaImportBytes(bytes: Uint8Array) {
    const { manifest, readAudio } = await openZetaBackup(bytes);
    const data = await storage.snapshot();
    const staged = new Set<string>();
    const entries = new Map<string, StoredSong>();
    const kept = new Set<string>();
    const missingFiles = new Map<string, string>();
    try {
        for (const { song, audio } of manifest.songs) {
            const previousFile = data.songs[song.id]?.file;
            if (previousFile) {
                try {
                    await Filesystem.stat({ directory: Directory.Data, path: previousFile });
                    continue;
                } catch (error) {
                    if ((error as { code?: string }).code !== 'OS-PLUG-FILE-0008') throw error;
                    missingFiles.set(song.id, previousFile);
                }
            }
            const key = `${MUSIC_PATH}/audio/${crypto.randomUUID()}`;
            const file = audio ? `${key}.${audioExtension(audio)}` : undefined;
            if (file) await restoreCover(song, `${key}.cover`, staged);
            else song.thumbnails = song.thumbnails.filter(({ url }) => url).map(({ data: _data, ...thumb }) => thumb);
            for (const item of [...song.artists, ...(song.album?.artists ?? []), ...(song.album ? [song.album] : [])]) {
                item.thumbnails = item.thumbnails.filter(({ url }) => url).map(({ data: _data, ...thumb }) => thumb);
            }
            if (file && audio) {
                staged.add(file);
                await writeBytes(Directory.Data, file, await readAudio(audio));
            }
            song.isDownloaded = !!file;
            entries.set(song.id, { song, file, mimetype: file ? backupAudioMime(file) : undefined });
        }
        const playlistIds = new Map(await Promise.all(data.playlists.map(async ({ id }) => [await backupPlaylistId(id), id] as const)));
        const playlists = await Promise.all(manifest.playlists.map(async (list) => {
            const stableId = await backupPlaylistId(list.id);
            return { ...list, id: playlistIds.get(stableId) ?? stableId };
        }));
        const used = await storage.edit((state) => {
            const written: string[] = [];
            for (const entry of entries.values()) {
                const existing = state.songs[entry.song.id];
                if (existing && (!entry.file || (existing.file && existing.file !== missingFiles.get(entry.song.id)))) continue;
                rememberSong(state, entry);
                written.push(entry.song.id);
            }
            mergeLists(state, manifest.favourites, playlists);
            state.events.push(...mergeBackupEvents(state.events, manifest.events));
            state.names = { ...manifest.names, ...state.names };
            return written;
        });
        for (const id of used) {
            const entry = entries.get(id)!;
            if (entry.file) kept.add(entry.file);
            // A retained thumbnail can be backed by a separate .cover file.
            const cover = entry.file?.replace(/\.[^.]+$/, '.cover');
            if (cover) kept.add(cover);
        }
        return backupCounts(manifest);
    } finally {
        await Promise.allSettled([...staged].filter((path) => !kept.has(path)).map((path) =>
            Filesystem.deleteFile({ directory: Directory.Data, path })));
    }
}

async function muzzaExport() {
    const { withAndroidMuzzaDb } = await import('./muzza-db');
    const data = await storage.snapshot();
    const manifest = await portableLibrary(data, false);
    const base = data.muzzaBase
        ? await parseMuzzaArchive(await readBytes(Directory.Data, data.muzzaBase), withAndroidMuzzaDb)
        : null;
    const events = mergeBackupEvents(base?.events.map(({ zetaId, ...event }) => ({ songId: zetaId, ...event })) ?? [], manifest.events)
        .map(({ songId, ...event }) => ({ zetaId: songId, ...event }));
    const { data: bytes, stats } = await buildMuzzaArchive({
        songs: manifest.songs.map(({ song }) => song),
        likedIds: new Set(manifest.favourites), playlists: manifest.playlists, events, base,
    }, withAndroidMuzzaDb);
    return await saveBackup(bytes, true) ? { path: '', songs: stats.songs, playlists: stats.playlists, liked: stats.liked } : null;
}

async function muzzaImport() {
    const bytes = await pickedBackup();
    if (!bytes) return null;
    const { withAndroidMuzzaDb } = await import('./muzza-db');
    const imported = await parseMuzzaArchive(bytes, withAndroidMuzzaDb);
    const playlists = await Promise.all(imported.playlists.map(async (list) => ({
        ...list, id: await backupPlaylistId(JSON.stringify([list.name, list.createdAt, list.trackIds])),
    })));
    const path = `${MUSIC_PATH}/muzza-${crypto.randomUUID()}.backup`;
    try {
        await writeBytes(Directory.Data, path, bytes);
        const prior = await storage.edit((data) => {
            const previous = data.muzzaBase;
            data.muzzaBase = path;
            for (const { record } of imported.songs) {
                if (!data.songs[record.id]) rememberSong(data, { song: { ...record, isDownloaded: false } });
                data.names[record.id] ??= {
                    title: record.title,
                    artists: record.artists.map((a) => a.name),
                    thumbnailUrl: record.thumbnails.find((t) => t.url)?.url,
                };
            }
            mergeLists(data, imported.likedIds, playlists);
            data.events.push(...mergeBackupEvents(data.events, imported.events.map(({ zetaId, ...event }) => ({ songId: zetaId, ...event }))));
            return previous;
        });
        if (prior) await Filesystem.deleteFile({ directory: Directory.Data, path: prior }).catch(() => {});
    } catch (error) {
        await Filesystem.deleteFile({ directory: Directory.Data, path }).catch(() => {});
        throw error;
    }
    return { songs: imported.songs.length, playlists: imported.playlists.length, liked: imported.likedIds.length };
}

export const backupRoutes = { zetaExport, zetaImport, zetaBackupBytes, zetaImportBytes, zetaPickBackup: pickedBackup, muzzaExport, muzzaImport };
