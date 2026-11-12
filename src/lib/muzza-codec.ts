import type { Song, Artist, Thumbnail, AlbumBase } from './schema';
import type { IndexRecord } from '../../electron/lib/metadata';
import { readBackupEntry, MAX_BACKUP_BYTES } from './zeta-backup';

interface Statement {
    all(...params: any[]): unknown[];
    get(...params: any[]): unknown;
    run(...params: any[]): unknown;
}
export interface MuzzaDatabase {
    exec(sql: string): void;
    prepare(sql: string): Statement;
    export(): Uint8Array;
}
export type WithMuzzaDb = <T>(bytes: Uint8Array | undefined, readOnly: boolean, work: (db: MuzzaDatabase) => T) => Promise<T>;

/* -------------------------------------------------------------------------- */
/*                          Muzza schema (version 24)                         */
/* -------------------------------------------------------------------------- */

export const MUZZA_DB_VERSION = 24;
const MUZZA_IDENTITY_HASH = '7c3fb9fe3ffbe91bb0608071ac412db7';
const DB_ENTRY = 'song.db';
const METADATA_ENTRY = 'metadata.txt';
const SETTINGS_ENTRY = 'settings.preferences_pb';

// Exact CREATE statements taken from Muzza's exported Room schema (24.json).
// These must match byte-for-byte so Room accepts the file without migration.
const SCHEMA_SQL: string[] = [
    'CREATE TABLE IF NOT EXISTS `song` (`id` TEXT NOT NULL, `title` TEXT NOT NULL, `duration` INTEGER NOT NULL, `thumbnailUrl` TEXT, `albumId` TEXT, `albumName` TEXT, `liked` INTEGER NOT NULL, `totalPlayTime` INTEGER NOT NULL, `inLibrary` INTEGER, `dateDownload` INTEGER, `artistName` TEXT, `isLocal` INTEGER NOT NULL DEFAULT false, `localPath` TEXT, `contentUri` TEXT, `isVideoSong` INTEGER NOT NULL DEFAULT false, `explicit` INTEGER NOT NULL DEFAULT false, PRIMARY KEY(`id`))',
    'CREATE INDEX IF NOT EXISTS `index_song_albumId` ON `song` (`albumId`)',
    'CREATE TABLE IF NOT EXISTS `artist` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `thumbnailUrl` TEXT, `channelId` TEXT, `lastUpdateTime` INTEGER NOT NULL, `bookmarkedAt` INTEGER, `isProfile` INTEGER NOT NULL DEFAULT false, PRIMARY KEY(`id`))',
    'CREATE TABLE IF NOT EXISTS `album` (`id` TEXT NOT NULL, `playlistId` TEXT, `title` TEXT NOT NULL, `year` INTEGER, `thumbnailUrl` TEXT, `themeColor` INTEGER, `songCount` INTEGER NOT NULL, `duration` INTEGER NOT NULL, `lastUpdateTime` INTEGER NOT NULL, `bookmarkedAt` INTEGER, PRIMARY KEY(`id`))',
    'CREATE TABLE IF NOT EXISTS `playlist` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `browseId` TEXT, `playlistAuthorsId` TEXT, `playlistAuthorName` TEXT, `playlistAuthorAvatarUrl` TEXT, `createdAt` INTEGER, `lastUpdateTime` INTEGER, `isEditable` INTEGER NOT NULL DEFAULT true, `bookmarkedAt` INTEGER, `remoteSongCount` INTEGER, `playEndpointParams` TEXT, `thumbnailUrl` TEXT, `shuffleEndpointParams` TEXT, `radioEndpointParams` TEXT, `description` TEXT, `isLocal` INTEGER NOT NULL DEFAULT false, PRIMARY KEY(`id`))',
    'CREATE TABLE IF NOT EXISTS `song_artist_map` (`songId` TEXT NOT NULL, `artistId` TEXT NOT NULL, `position` INTEGER NOT NULL, PRIMARY KEY(`songId`, `artistId`), FOREIGN KEY(`songId`) REFERENCES `song`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE , FOREIGN KEY(`artistId`) REFERENCES `artist`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )',
    'CREATE INDEX IF NOT EXISTS `index_song_artist_map_songId` ON `song_artist_map` (`songId`)',
    'CREATE INDEX IF NOT EXISTS `index_song_artist_map_artistId` ON `song_artist_map` (`artistId`)',
    'CREATE TABLE IF NOT EXISTS `song_album_map` (`songId` TEXT NOT NULL, `albumId` TEXT NOT NULL, `index` INTEGER NOT NULL, PRIMARY KEY(`songId`, `albumId`), FOREIGN KEY(`songId`) REFERENCES `song`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE , FOREIGN KEY(`albumId`) REFERENCES `album`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )',
    'CREATE INDEX IF NOT EXISTS `index_song_album_map_songId` ON `song_album_map` (`songId`)',
    'CREATE INDEX IF NOT EXISTS `index_song_album_map_albumId` ON `song_album_map` (`albumId`)',
    'CREATE TABLE IF NOT EXISTS `album_artist_map` (`albumId` TEXT NOT NULL, `artistId` TEXT NOT NULL, `order` INTEGER NOT NULL, PRIMARY KEY(`albumId`, `artistId`), FOREIGN KEY(`albumId`) REFERENCES `album`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE , FOREIGN KEY(`artistId`) REFERENCES `artist`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )',
    'CREATE INDEX IF NOT EXISTS `index_album_artist_map_albumId` ON `album_artist_map` (`albumId`)',
    'CREATE INDEX IF NOT EXISTS `index_album_artist_map_artistId` ON `album_artist_map` (`artistId`)',
    'CREATE TABLE IF NOT EXISTS `playlist_song_map` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `playlistId` TEXT NOT NULL, `songId` TEXT NOT NULL, `position` INTEGER NOT NULL, `setVideoId` TEXT, FOREIGN KEY(`playlistId`) REFERENCES `playlist`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE , FOREIGN KEY(`songId`) REFERENCES `song`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )',
    'CREATE INDEX IF NOT EXISTS `index_playlist_song_map_playlistId` ON `playlist_song_map` (`playlistId`)',
    'CREATE INDEX IF NOT EXISTS `index_playlist_song_map_songId` ON `playlist_song_map` (`songId`)',
    'CREATE TABLE IF NOT EXISTS `search_history` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `query` TEXT NOT NULL)',
    'CREATE UNIQUE INDEX IF NOT EXISTS `index_search_history_query` ON `search_history` (`query`)',
    'CREATE TABLE IF NOT EXISTS `format` (`id` TEXT NOT NULL, `itag` INTEGER NOT NULL, `mimeType` TEXT NOT NULL, `codecs` TEXT NOT NULL, `bitrate` INTEGER NOT NULL, `sampleRate` INTEGER, `contentLength` INTEGER NOT NULL, `loudnessDb` REAL, `playbackUrl` TEXT, `perceptualLoudnessDb` REAL, PRIMARY KEY(`id`))',
    "CREATE TABLE IF NOT EXISTS `lyrics` (`id` TEXT NOT NULL, `lyrics` TEXT NOT NULL, `provider` TEXT NOT NULL DEFAULT 'Unknown', PRIMARY KEY(`id`))",
    'CREATE TABLE IF NOT EXISTS `event` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `songId` TEXT NOT NULL, `timestamp` INTEGER NOT NULL, `playTime` INTEGER NOT NULL, FOREIGN KEY(`songId`) REFERENCES `song`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )',
    'CREATE INDEX IF NOT EXISTS `index_event_songId` ON `event` (`songId`)',
    'CREATE TABLE IF NOT EXISTS `related_song_map` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `songId` TEXT NOT NULL, `relatedSongId` TEXT NOT NULL, FOREIGN KEY(`songId`) REFERENCES `song`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE , FOREIGN KEY(`relatedSongId`) REFERENCES `song`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )',
    'CREATE INDEX IF NOT EXISTS `index_related_song_map_songId` ON `related_song_map` (`songId`)',
    'CREATE INDEX IF NOT EXISTS `index_related_song_map_relatedSongId` ON `related_song_map` (`relatedSongId`)',
    'CREATE TABLE IF NOT EXISTS `set_video_id` (`videoId` TEXT NOT NULL, `setVideoId` TEXT, PRIMARY KEY(`videoId`))',
    'CREATE TABLE IF NOT EXISTS `recent_activity` (`id` TEXT NOT NULL, `title` TEXT NOT NULL, `thumbnail` TEXT, `explicit` INTEGER NOT NULL, `playlistAuthor` TEXT, `shareLink` TEXT NOT NULL, `type` TEXT NOT NULL, `playlistId` TEXT, `radioPlaylistId` TEXT, `shufflePlaylistId` TEXT, `date` INTEGER NOT NULL, PRIMARY KEY(`id`))',
    'CREATE TABLE IF NOT EXISTS `speed_dial_item` (`id` TEXT NOT NULL, `secondaryId` TEXT, `title` TEXT NOT NULL, `subtitle` TEXT, `channelId` TEXT, `isProfile` INTEGER NOT NULL, `thumbnailUrl` TEXT, `album` TEXT, `type` TEXT NOT NULL, `explicit` INTEGER NOT NULL, `createDate` INTEGER NOT NULL, PRIMARY KEY(`id`))',
    'CREATE VIEW `sorted_song_artist_map` AS SELECT * FROM song_artist_map ORDER BY position',
    'CREATE VIEW `sorted_song_album_map` AS SELECT * FROM song_album_map ORDER BY `index`',
    'CREATE VIEW `playlist_song_map_preview` AS SELECT * FROM playlist_song_map WHERE position <= 3 ORDER BY position',
];

// Muzza's special virtual playlist ids that are never real playlist rows.
const SPECIAL_PLAYLIST_IDS = new Set(['LP_LIKED', 'LP_DOWNLOADED']);

/* -------------------------------------------------------------------------- */
/*                                   helpers                                  */
/* -------------------------------------------------------------------------- */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function randomId(prefix: string): string {
    let s = prefix;
    for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

function bestThumbnailUrl(thumbnails: Thumbnail[]): string | null {
    const remote = (thumbnails || []).filter((t) => t.url && /^https?:\/\//i.test(t.url));
    if (remote.length) {
        return remote.sort((a, b) => (a.width ?? a.height ?? 0) - (b.width ?? b.height ?? 0)).at(-1)!.url!;
    }
    const dataUri = (thumbnails || []).find((t) => t.url && /^data:image\/(?:jpeg|png|webp|gif|avif);base64,/i.test(t.url));
    if (dataUri?.url) return dataUri.url;
    const embedded = (thumbnails || []).find((t) => t.data instanceof Uint8Array && t.data.length > 0 && t.data.length <= 2 * 1024 * 1024);
    if (embedded?.data) {
        const mime = /^image\/(?:jpeg|png|webp|gif|avif)$/i.test(embedded.mimetype ?? '') ? embedded.mimetype! : 'image/jpeg';
        return `data:${mime};base64,${bytesToBase64(embedded.data)}`;
    }
    return null;
}

function parseMuzzaThumbnail(url: unknown): Thumbnail[] {
    if (typeof url !== 'string' || !url.trim()) return [];
    const match = url.match(/^data:(image\/(?:jpeg|png|webp|gif|avif));base64,([a-z0-9+/]+=*)$/i);
    if (match) {
        try {
            return [{ data: base64ToBytes(match[2]), mimetype: match[1].toLowerCase() }];
        } catch {
            return [];
        }
    }
    if (/^https?:\/\//i.test(url)) return [{ url }];
    return [];
}

/** Zeta canonical id -> Muzza song id. */
function toMuzzaId(zetaId: string): string {
    return zetaId.startsWith('yt:') ? zetaId.slice(3) : zetaId;
}

/** Muzza song row -> Zeta canonical id. */
function toZetaId(muzzaId: string, isLocal: boolean): string {
    if (muzzaId.includes(':')) return muzzaId; // one of ours preserved verbatim (js:/local:)
    if (isLocal) return `local:${muzzaId}`;
    return `yt:${muzzaId}`;
}

/* -------------------------------------------------------------------------- */
/*                                   export                                   */
/* -------------------------------------------------------------------------- */

export interface MuzzaEvent {
    zetaId: string;
    timestamp: number; // epoch ms
    playTimeMs: number;
}

export interface MuzzaExportInput {
    /** Every unique song to include in the backup. */
    songs: Song[];
    /** Zeta ids that are "liked" (members of favourites). */
    likedIds: Set<string>;
    /** User playlists (favourites excluded — that maps to `liked`). */
    playlists: { name: string; createdAt: number; thumbnail?: string; trackIds: string[] }[];
    /** Play events recorded in Zeta since the last import (for stats/history). */
    events?: MuzzaEvent[];
    /**
     * A previously-imported Muzza database to build upon. When present, ALL of
     * its non-library data (settings, event history, search history, formats,
     * lyrics, recent activity, …) is preserved; only the library structure
     * (songs, liked flags, playlists) is overlaid with Zeta's current state.
     */
    base?: { db: Uint8Array; settings?: Uint8Array | null } | null;
}

export interface MuzzaExportStats {
    songs: number;
    playlists: number;
    liked: number;
    bytes: number;
}

/**
 * An INSERT for `table` that adapts to the columns the table actually has. When
 * exporting on top of an imported backup, the database comes from whatever
 * Muzza version the user had, and its schema can differ from ours (older
 * versions lack e.g. `song.contentUri`). Columns the table doesn't have are
 * dropped; NOT NULL columns we don't know about get a neutral default.
 */
function adaptiveInsert(db: MuzzaDatabase, table: string, verb: 'INSERT' | 'INSERT OR IGNORE' | 'INSERT OR REPLACE') {
    const columns = db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
    }[];
    if (!columns.length) throw new Error(`The Muzza database has no "${table}" table.`);
    const statements = new Map<string, Statement>();

    return (row: Record<string, unknown>) => {
        const values: Record<string, unknown> = {};
        for (const column of columns) {
            if (column.name in row) values[column.name] = row[column.name];
            else if (column.notnull && column.dflt_value == null && !column.pk) {
                values[column.name] = /INT|REAL|NUM|BOOL/i.test(column.type) ? 0 : '';
            }
        }
        const names = Object.keys(values);
        const key = names.join(',');
        let statement = statements.get(key);
        if (!statement) {
            statement = db.prepare(
                `${verb} INTO \`${table}\` (${names.map((n) => `\`${n}\``).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
            );
            statements.set(key, statement);
        }
        return statement.run(...names.map((n) => values[n] ?? null));
    };
}

export async function buildMuzzaArchive(input: MuzzaExportInput, withDb: WithMuzzaDb) {
    const fromBase = !!input.base?.db;
    const { dbBytes, dbVersion, playlistCount, likedCount } = await withDb(input.base?.db, false, (db) => {
        db.exec('PRAGMA journal_mode = DELETE');
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('BEGIN');

        if (!fromBase) {
            for (const sql of SCHEMA_SQL) db.exec(sql);
            // Room identity + version bookkeeping (already present in a base DB).
            db.exec('CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY, identity_hash TEXT)');
            db.prepare('INSERT OR REPLACE INTO room_master_table (id, identity_hash) VALUES (42, ?)').run(
                MUZZA_IDENTITY_HASH,
            );
            db.exec('CREATE TABLE IF NOT EXISTS android_metadata (locale TEXT)');
            db.prepare('INSERT INTO android_metadata (locale) VALUES (?)').run('en_US');
        }

        const now = Date.now();

        const songExists = db.prepare('SELECT 1 AS x FROM song WHERE id = ?');
        const insertSong = adaptiveInsert(db, 'song', 'INSERT OR IGNORE');
        const updateLiked = db.prepare('UPDATE song SET liked = ? WHERE id = ?');
        const findArtist = db.prepare('SELECT id AS id FROM artist WHERE name = ? LIMIT 1');
        const insertArtist = adaptiveInsert(db, 'artist', 'INSERT OR REPLACE');
        const insertSongArtist = adaptiveInsert(db, 'song_artist_map', 'INSERT OR IGNORE');
        const insertLyrics = adaptiveInsert(db, 'lyrics', 'INSERT OR REPLACE');

        const artistIds = new Map<string, string>(); // name -> LA id
        let likedCount = 0;

        for (const song of input.songs) {
            const muzzaId = toMuzzaId(song.id);
            const isLocal = song.id.startsWith('local:') ? 1 : 0;
            const liked = input.likedIds.has(song.id) ? 1 : 0;
            if (liked) likedCount++;

            if (song.lyrics) insertLyrics({ id: muzzaId, lyrics: song.lyrics, provider: 'Zeta' });

            // Only insert songs missing from the (base) DB — this preserves the
            // stats/history of songs Muzza already knew about.
            if (!songExists.get(muzzaId)) {
                insertSong({
                    id: muzzaId,
                    title: song.title || 'Untitled',
                    duration: Math.max(0, Math.round(song.duration || 0)),
                    thumbnailUrl: bestThumbnailUrl(song.thumbnails),
                    albumId: null,
                    albumName: song.album?.title ?? null,
                    liked,
                    totalPlayTime: 0,
                    inLibrary: now,
                    dateDownload: song.isDownloaded ? now : null,
                    artistName: song.artists.map((a) => a.name).join(', ') || null,
                    isLocal,
                    localPath: null,
                    contentUri: null,
                    isVideoSong: 0,
                    explicit: 0,
                });

                song.artists.forEach((artist, position) => {
                    const key = artist.name.trim().toLowerCase();
                    if (!key) return;
                    let artistId = artistIds.get(key);
                    if (!artistId) {
                        const found = findArtist.get(artist.name) as { id: string } | undefined;
                        artistId = found?.id ?? randomId('LA');
                        artistIds.set(key, artistId);
                        if (!found) {
                            insertArtist({
                                id: artistId,
                                name: artist.name,
                                thumbnailUrl: bestThumbnailUrl(artist.thumbnails),
                                channelId: null,
                                lastUpdateTime: now,
                                bookmarkedAt: null,
                                isProfile: 0,
                            });
                        }
                    }
                    insertSongArtist({ songId: muzzaId, artistId, position });
                });
            }

            // Liked state is authoritative from Zeta for songs it manages.
            updateLiked.run(liked, muzzaId);
        }

        // Rebuild playlists entirely from Zeta (authoritative for structure).
        db.exec('DELETE FROM playlist_song_map');
        db.exec('DELETE FROM playlist');
        const insertPlaylist = adaptiveInsert(db, 'playlist', 'INSERT');
        const insertPlaylistSong = adaptiveInsert(db, 'playlist_song_map', 'INSERT');

        let playlistCount = 0;
        for (const playlist of input.playlists) {
            const playlistId = randomId('LP');
            insertPlaylist({
                id: playlistId,
                name: playlist.name,
                createdAt: playlist.createdAt || now,
                lastUpdateTime: now,
                isEditable: 1,
                bookmarkedAt: now, // shows in the Muzza library
                thumbnailUrl: playlist.thumbnail ?? null,
                isLocal: 0,
            });
            playlist.trackIds.forEach((zetaId, position) => {
                if (songExists.get(toMuzzaId(zetaId))) {
                    insertPlaylistSong({ playlistId, songId: toMuzzaId(zetaId), position, setVideoId: null });
                }
            });
            playlistCount++;
        }

        // Append Zeta's play events to the history (deduplicated against base), then recompute play totals.
        const existingEventKeys = new Set<string>();
        try {
            for (const row of db.prepare('SELECT songId, timestamp, playTime FROM event').all() as any[]) {
                existingEventKeys.add(`${row.songId}\0${Number(row.timestamp)}\0${Number(row.playTime)}`);
            }
        } catch { /* ignore */ }
        const insertEvent = adaptiveInsert(db, 'event', 'INSERT');
        for (const ev of input.events ?? []) {
            const muzzaId = toMuzzaId(ev.zetaId);
            if (!songExists.get(muzzaId)) continue;
            const ts = Math.round(ev.timestamp);
            const pt = Math.max(0, Math.round(ev.playTimeMs));
            const key = `${muzzaId}\0${ts}\0${pt}`;
            if (existingEventKeys.has(key)) continue;
            existingEventKeys.add(key);
            insertEvent({ songId: muzzaId, timestamp: ts, playTime: pt });
        }
        db.exec(
            'UPDATE song SET totalPlayTime = MAX(COALESCE(totalPlayTime, 0), COALESCE((SELECT SUM(playTime) FROM event WHERE event.songId = song.id), 0))',
        );

        if (!fromBase) db.exec(`PRAGMA user_version = ${MUZZA_DB_VERSION}`);
        db.exec('COMMIT');
        // Declare the schema version the database actually has: an imported
        // base keeps its own (possibly older) one, and Muzza relies on this to
        // run its migrations on restore.
        const dbVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) || MUZZA_DB_VERSION;
        return { dbBytes: db.export(), dbVersion, playlistCount, likedCount };
    });
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file(DB_ENTRY, dbBytes);
    zip.file(METADATA_ENTRY, `db_version=${dbVersion}\n`);
    if (input.base?.settings) zip.file(SETTINGS_ENTRY, input.base.settings);
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const stats: MuzzaExportStats = { songs: input.songs.length, playlists: playlistCount, liked: likedCount, bytes: data.length };
    return { data, stats };
}

export interface ImportedSong {
    zetaId: string;
    record: IndexRecord; // off-disk record (no `file`)
    liked: boolean;
    localPath?: string | null;
}

export interface ImportedPlaylist {
    name: string;
    createdAt: number;
    thumbnail?: string;
    trackIds: string[]; // Zeta canonical ids, in order
}

export interface MuzzaImport {
    songs: ImportedSong[];
    playlists: ImportedPlaylist[];
    likedIds: string[];
    events: MuzzaEvent[];
    /** Raw `song.db` bytes, kept so a later export can preserve everything. */
    db: Uint8Array;
    /** Raw `settings.preferences_pb` bytes, if the backup carried settings. */
    settings: Uint8Array | null;
}

export async function parseMuzzaArchive(backupBytes: Uint8Array, withDb: WithMuzzaDb): Promise<MuzzaImport> {
    if (backupBytes.length > MAX_BACKUP_BYTES) throw new Error('The Muzza backup exceeds 512 MiB.');
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(backupBytes);
    const dbFile = zip.file(DB_ENTRY);
    if (!dbFile) throw new Error('Not a valid Muzza backup: song.db entry is missing.');
    const dbBytes = await readBackupEntry(dbFile, MAX_BACKUP_BYTES);
    const settingsFile = zip.file(SETTINGS_ENTRY);
    const settings = settingsFile ? await readBackupEntry(settingsFile, 4 * 1024 * 1024) : null;
    return withDb(dbBytes, true, (db) => {
        // Artists per song (ordered).
        const artistRows = db
            .prepare(
                'SELECT m.songId AS songId, m.position AS position, a.name AS name, a.thumbnailUrl AS thumbnailUrl ' +
                    'FROM song_artist_map m JOIN artist a ON a.id = m.artistId ORDER BY m.songId, m.position',
            )
            .all() as any[];
        const artistsBySong = new Map<string, Artist[]>();
        for (const row of artistRows) {
            const list = artistsBySong.get(row.songId) ?? [];
            list.push({
                name: row.name,
                thumbnails: row.thumbnailUrl ? [{ url: row.thumbnailUrl }] : [],
            });
            artistsBySong.set(row.songId, list);
        }

        // Stored lyrics (may be synced LRC or plain), keyed by song id.
        const lyricsById = new Map<string, string>();
        try {
            for (const r of db.prepare('SELECT id, lyrics FROM lyrics').all() as any[]) {
                if (r.lyrics && r.lyrics !== 'LYRICS_NOT_FOUND') lyricsById.set(r.id, r.lyrics);
            }
        } catch {
            /* lyrics table absent or unreadable */
        }

        const songCols = new Set(
            (db.prepare('PRAGMA table_info(`song`)').all() as { name: string }[]).map((c) => c.name),
        );
        const selectSongCols = [
            'id',
            'title',
            'duration',
            'thumbnailUrl',
            'albumName',
            songCols.has('artistName') ? 'artistName' : 'NULL AS artistName',
            'liked',
            songCols.has('isLocal') ? 'isLocal' : '0 AS isLocal',
            songCols.has('totalPlayTime') ? 'totalPlayTime' : '0 AS totalPlayTime',
            songCols.has('inLibrary') ? 'inLibrary' : 'NULL AS inLibrary',
            songCols.has('localPath') ? 'localPath' : 'NULL AS localPath',
        ].join(', ');
        const songRows = db.prepare(`SELECT ${selectSongCols} FROM song`).all() as any[];

        const songs: ImportedSong[] = [];
        const likedIds: string[] = [];
        const zetaIdByMuzzaId = new Map<string, string>();
        const songTotals = new Map<string, { totalPlayTimeMs: number; inLibrary: number }>();

        for (const row of songRows) {
            const isLocal = !!row.isLocal;
            const zetaId = toZetaId(row.id, isLocal);
            zetaIdByMuzzaId.set(row.id, zetaId);
            const totalPlayTimeMs = Number(row.totalPlayTime) || 0;
            if (totalPlayTimeMs > 0) {
                songTotals.set(zetaId, {
                    totalPlayTimeMs,
                    inLibrary: Number(row.inLibrary) > 0 ? Number(row.inLibrary) : Date.now(),
                });
            }

            const artists =
                artistsBySong.get(row.id) ??
                (row.artistName
                    ? String(row.artistName)
                          .split(/,\s*/)
                          .filter(Boolean)
                          .map((name: string) => ({ name, thumbnails: [] as Thumbnail[] }))
                    : []);

            const thumbnails: Thumbnail[] = parseMuzzaThumbnail(row.thumbnailUrl);
            const album: AlbumBase | null = row.albumName
                ? { title: row.albumName, artists: [], thumbnails: [] }
                : null;

            const record: IndexRecord = {
                id: zetaId,
                title: row.title || 'Untitled',
                duration: row.duration ?? 0,
                thumbnails,
                artists: artists.length ? artists : [{ name: 'Unknown Artist', thumbnails: [] }],
                album,
                lyrics: lyricsById.get(row.id) ?? null,
            };

            const liked = !!row.liked;
            if (liked) likedIds.push(zetaId);
            songs.push({
                zetaId,
                record,
                liked,
                localPath: typeof row.localPath === 'string' && row.localPath.trim() ? row.localPath.trim() : null,
            });
        }

        const playlistCols = new Set(
            (db.prepare('PRAGMA table_info(`playlist`)').all() as { name: string }[]).map((c) => c.name),
        );
        const playlistRows = db
            .prepare(
                `SELECT id, name, ${playlistCols.has('createdAt') ? 'createdAt' : 'NULL AS createdAt'}, ${
                    playlistCols.has('thumbnailUrl') ? 'thumbnailUrl' : 'NULL AS thumbnailUrl'
                } FROM playlist`,
            )
            .all() as any[];
        const playlists: ImportedPlaylist[] = [];

        for (const row of playlistRows) {
            if (SPECIAL_PLAYLIST_IDS.has(row.id)) continue;
            const mapRows = db
                .prepare('SELECT songId FROM playlist_song_map WHERE playlistId = ? ORDER BY position')
                .all(row.id) as any[];
            const trackIds = mapRows
                .map((m) => zetaIdByMuzzaId.get(m.songId))
                .filter((id): id is string => !!id);
            const thumb = typeof row.thumbnailUrl === 'string' && /^(https?:\/\/|data:image\/)/i.test(row.thumbnailUrl)
                ? row.thumbnailUrl
                : undefined;
            playlists.push({
                name: row.name || 'Imported Playlist',
                createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
                thumbnail: thumb,
                trackIds,
            });
        }

        // Play history / stats (both `event` table rows and any aggregate `song.totalPlayTime` balance).
        let eventRows: any[] = [];
        try {
            eventRows = db.prepare('SELECT songId, timestamp, playTime FROM event').all() as any[];
        } catch { /* event table absent */ }
        const eventSumByZetaId = new Map<string, number>();
        const events: MuzzaEvent[] = [];
        for (const e of eventRows) {
            const zetaId = zetaIdByMuzzaId.get(e.songId);
            const playTimeMs = Number(e.playTime) || 0;
            const timestamp = Number(e.timestamp) || Date.now();
            if (!zetaId || playTimeMs <= 0) continue;
            events.push({ zetaId, timestamp, playTimeMs });
            eventSumByZetaId.set(zetaId, (eventSumByZetaId.get(zetaId) ?? 0) + playTimeMs);
        }
        for (const [zetaId, { totalPlayTimeMs, inLibrary }] of songTotals) {
            const accounted = eventSumByZetaId.get(zetaId) ?? 0;
            if (totalPlayTimeMs - accounted >= 1000) {
                events.push({
                    zetaId,
                    timestamp: inLibrary,
                    playTimeMs: totalPlayTimeMs - accounted,
                });
            }
        }

        return { songs, playlists, likedIds, events, db: dbBytes, settings };
    });
}
