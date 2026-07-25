/**
 * Muzza backup interoperability.
 *
 * Muzza (https://github.com/Maloy-Android/Muzza) stores its data in an Android
 * Room database. Its `.backup` files are plain ZIP archives containing:
 *
 *   - `song.db`                 raw SQLite3 file (Room schema v24)
 *   - `metadata.txt`            `db_version=24\n`
 *   - `settings.preferences_pb` (optional) Jetpack DataStore blob
 *
 * This module produces backups that Muzza can restore ("Export to Muzza") and
 * reads Muzza backups into Zeta's library ("Import from Muzza"), aiming for
 * 100% format compatibility with schema version 24.
 *
 * SQLite is handled with Electron's built-in `node:sqlite`, so no native module
 * needs compiling. ZIP handling uses `jszip` (pure JS, reads Muzza's deflated
 * archives and writes our own).
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import type { Song, Artist, Thumbnail, AlbumBase } from '../../src/lib/schema';
import type { IndexRecord } from './metadata';

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

// Load node:sqlite via a runtime require rather than a static/dynamic import.
// `node:sqlite` is new enough that the bundler doesn't recognise it as a Node
// builtin and would otherwise stub it out as a browser-external module (making
// `DatabaseSync` undefined). createRequire resolves it against the real Node
// runtime at call time, bypassing the bundler entirely.
const nodeRequire = createRequire(import.meta.url);
function openSqlite() {
    // node:sqlite is built into Electron's Node runtime.
    return nodeRequire('node:sqlite') as any;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function randomId(prefix: string): string {
    let s = prefix;
    for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
}

function bestThumbnailUrl(thumbnails: Thumbnail[]): string | null {
    const withUrl = (thumbnails || []).filter((t) => t.url);
    if (!withUrl.length) return null;
    return withUrl.sort((a, b) => (a.width ?? a.height ?? 0) - (b.width ?? b.height ?? 0)).at(-1)!.url!;
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
    playlists: { name: string; createdAt: number; trackIds: string[] }[];
    /** Play events recorded in Zeta since the last import (for stats/history). */
    events?: MuzzaEvent[];
    /**
     * A previously-imported Muzza database to build upon. When present, ALL of
     * its non-library data (settings, event history, search history, formats,
     * lyrics, recent activity, …) is preserved; only the library structure
     * (songs, liked flags, playlists) is overlaid with Zeta's current state.
     */
    base?: { db: Buffer; settings?: Buffer | null } | null;
}

export interface MuzzaExportStats {
    songs: number;
    playlists: number;
    liked: number;
    bytes: number;
}

/** Build a Muzza-compatible `.backup` archive. Returns the zip bytes + stats. */
export async function buildMuzzaBackup(
    input: MuzzaExportInput,
): Promise<{ data: Buffer; stats: MuzzaExportStats }> {
    const { DatabaseSync } = await openSqlite();

    const tmp = mkdtempSync(join(tmpdir(), 'zeta-muzza-'));
    const dbPath = join(tmp, 'song.db');

    try {
        const fromBase = !!input.base?.db;
        if (fromBase) writeFileSync(dbPath, input.base!.db);

        const db = new DatabaseSync(dbPath);
        try {
            db.exec('PRAGMA journal_mode = DELETE');
            db.exec('PRAGMA foreign_keys = OFF');

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
            const insertSong = db.prepare(
                'INSERT OR IGNORE INTO song (id, title, duration, thumbnailUrl, albumId, albumName, liked, totalPlayTime, inLibrary, dateDownload, artistName, isLocal, localPath, contentUri, isVideoSong, explicit) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            );
            const updateLiked = db.prepare('UPDATE song SET liked = ? WHERE id = ?');
            const findArtist = db.prepare('SELECT id AS id FROM artist WHERE name = ? LIMIT 1');
            const insertArtist = db.prepare(
                'INSERT OR REPLACE INTO artist (id, name, thumbnailUrl, channelId, lastUpdateTime, bookmarkedAt, isProfile) VALUES (?, ?, ?, ?, ?, ?, ?)',
            );
            const insertSongArtist = db.prepare(
                'INSERT OR IGNORE INTO song_artist_map (songId, artistId, position) VALUES (?, ?, ?)',
            );
            const insertLyrics = db.prepare(
                "INSERT OR REPLACE INTO lyrics (id, lyrics, provider) VALUES (?, ?, 'Zeta')",
            );

            const artistIds = new Map<string, string>(); // name -> LA id
            let likedCount = 0;

            for (const song of input.songs) {
                const muzzaId = toMuzzaId(song.id);
                const isLocal = song.id.startsWith('local:') ? 1 : 0;
                const liked = input.likedIds.has(song.id) ? 1 : 0;
                if (liked) likedCount++;

                if (song.lyrics) insertLyrics.run(muzzaId, song.lyrics);

                // Only insert songs missing from the (base) DB — this preserves the
                // stats/history of songs Muzza already knew about.
                if (!songExists.get(muzzaId)) {
                    insertSong.run(
                        muzzaId,
                        song.title || 'Untitled',
                        Math.max(0, Math.round(song.duration || 0)),
                        bestThumbnailUrl(song.thumbnails),
                        null,
                        song.album?.title ?? null,
                        liked,
                        0,
                        now, // inLibrary
                        song.isDownloaded ? now : null,
                        song.artists.map((a) => a.name).join(', ') || null,
                        isLocal,
                        null,
                        null,
                        0,
                        0,
                    );

                    song.artists.forEach((artist, position) => {
                        const key = artist.name.trim().toLowerCase();
                        if (!key) return;
                        let artistId = artistIds.get(key);
                        if (!artistId) {
                            const found = findArtist.get(artist.name) as { id: string } | undefined;
                            artistId = found?.id ?? randomId('LA');
                            artistIds.set(key, artistId);
                            if (!found)
                                insertArtist.run(artistId, artist.name, bestThumbnailUrl(artist.thumbnails), null, now, null, 0);
                        }
                        insertSongArtist.run(muzzaId, artistId, position);
                    });
                }

                // Liked state is authoritative from Zeta for songs it manages.
                updateLiked.run(liked, muzzaId);
            }

            // Rebuild playlists entirely from Zeta (authoritative for structure).
            db.exec('DELETE FROM playlist_song_map');
            db.exec('DELETE FROM playlist');
            const insertPlaylist = db.prepare(
                'INSERT INTO playlist (id, name, browseId, playlistAuthorsId, playlistAuthorName, playlistAuthorAvatarUrl, createdAt, lastUpdateTime, isEditable, bookmarkedAt, remoteSongCount, playEndpointParams, thumbnailUrl, shuffleEndpointParams, radioEndpointParams, description, isLocal) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            );
            const insertPlaylistSong = db.prepare(
                'INSERT INTO playlist_song_map (playlistId, songId, position, setVideoId) VALUES (?, ?, ?, ?)',
            );

            let playlistCount = 0;
            for (const playlist of input.playlists) {
                const playlistId = randomId('LP');
                insertPlaylist.run(
                    playlistId,
                    playlist.name,
                    null, null, null, null,
                    playlist.createdAt || now,
                    now,
                    1, // isEditable
                    now, // bookmarkedAt -> shows in Muzza library
                    null, null, null, null, null, null,
                    0,
                );
                playlist.trackIds.forEach((zetaId, position) => {
                    if (songExists.get(toMuzzaId(zetaId))) {
                        insertPlaylistSong.run(playlistId, toMuzzaId(zetaId), position, null);
                    }
                });
                playlistCount++;
            }

            // Append Zeta's play events to the history, then recompute play totals.
            const insertEvent = db.prepare('INSERT INTO event (songId, timestamp, playTime) VALUES (?, ?, ?)');
            for (const ev of input.events ?? []) {
                const muzzaId = toMuzzaId(ev.zetaId);
                if (!songExists.get(muzzaId)) continue;
                insertEvent.run(muzzaId, Math.round(ev.timestamp), Math.max(0, Math.round(ev.playTimeMs)));
            }
            db.exec(
                'UPDATE song SET totalPlayTime = COALESCE((SELECT SUM(playTime) FROM event WHERE event.songId = song.id), 0)',
            );

            if (!fromBase) db.exec(`PRAGMA user_version = ${MUZZA_DB_VERSION}`);
            db.close();

            const dbBytes = readFileSync(dbPath);

            const { default: JSZip } = await import('jszip');
            const zip = new JSZip();
            zip.file(DB_ENTRY, dbBytes);
            zip.file(METADATA_ENTRY, `db_version=${MUZZA_DB_VERSION}\n`);
            // Preserve Muzza's settings blob verbatim when we have one.
            if (input.base?.settings) zip.file(SETTINGS_ENTRY, input.base.settings);
            const data = await zip.generateAsync({
                type: 'nodebuffer',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 },
            });

            return {
                data,
                stats: { songs: input.songs.length, playlists: playlistCount, liked: likedCount, bytes: data.length },
            };
        } catch (err) {
            try {
                db.close();
            } catch {
                /* already closed */
            }
            throw err;
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/* -------------------------------------------------------------------------- */
/*                                   import                                   */
/* -------------------------------------------------------------------------- */

export interface ImportedSong {
    zetaId: string;
    record: IndexRecord; // off-disk record (no `file`)
    liked: boolean;
}

export interface ImportedPlaylist {
    name: string;
    createdAt: number;
    trackIds: string[]; // Zeta canonical ids, in order
}

export interface MuzzaImport {
    songs: ImportedSong[];
    playlists: ImportedPlaylist[];
    likedIds: string[];
    events: MuzzaEvent[];
    /** Raw `song.db` bytes, kept so a later export can preserve everything. */
    db: Buffer;
    /** Raw `settings.preferences_pb` bytes, if the backup carried settings. */
    settings: Buffer | null;
}

/** Parse a Muzza `.backup` archive into Zeta-shaped data (no side effects). */
export async function parseMuzzaBackup(backupBytes: Buffer): Promise<MuzzaImport> {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(backupBytes);

    const dbFile = zip.file(DB_ENTRY);
    if (!dbFile) throw new Error('Not a valid Muzza backup: song.db entry is missing.');
    const dbBytes = await dbFile.async('nodebuffer');

    const settingsFile = zip.file(SETTINGS_ENTRY);
    const settings = settingsFile ? await settingsFile.async('nodebuffer') : null;

    const { DatabaseSync } = await openSqlite();
    const tmp = mkdtempSync(join(tmpdir(), 'zeta-muzza-'));
    const dbPath = join(tmp, 'song.db');

    try {
        writeFileSync(dbPath, dbBytes);
        const db = new DatabaseSync(dbPath, { readOnly: true });

        try {
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

            const songRows = db
                .prepare(
                    'SELECT id, title, duration, thumbnailUrl, albumName, artistName, liked, isLocal FROM song',
                )
                .all() as any[];

            const songs: ImportedSong[] = [];
            const likedIds: string[] = [];
            const zetaIdByMuzzaId = new Map<string, string>();

            for (const row of songRows) {
                const isLocal = !!row.isLocal;
                const zetaId = toZetaId(row.id, isLocal);
                zetaIdByMuzzaId.set(row.id, zetaId);

                const artists =
                    artistsBySong.get(row.id) ??
                    (row.artistName
                        ? String(row.artistName)
                              .split(/,\s*/)
                              .filter(Boolean)
                              .map((name: string) => ({ name, thumbnails: [] as Thumbnail[] }))
                        : []);

                const thumbnails: Thumbnail[] = row.thumbnailUrl ? [{ url: row.thumbnailUrl }] : [];
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
                songs.push({ zetaId, record, liked });
            }

            const playlistRows = db.prepare('SELECT id, name, createdAt FROM playlist').all() as any[];
            const playlists: ImportedPlaylist[] = [];

            for (const row of playlistRows) {
                if (SPECIAL_PLAYLIST_IDS.has(row.id)) continue;
                const mapRows = db
                    .prepare('SELECT songId FROM playlist_song_map WHERE playlistId = ? ORDER BY position')
                    .all(row.id) as any[];
                const trackIds = mapRows
                    .map((m) => zetaIdByMuzzaId.get(m.songId))
                    .filter((id): id is string => !!id);
                playlists.push({
                    name: row.name || 'Imported Playlist',
                    createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
                    trackIds,
                });
            }

            // Play history / stats.
            const eventRows = db.prepare('SELECT songId, timestamp, playTime FROM event').all() as any[];
            const events: MuzzaEvent[] = eventRows
                .map((e) => {
                    const zetaId = zetaIdByMuzzaId.get(e.songId);
                    return zetaId ? { zetaId, timestamp: Number(e.timestamp), playTimeMs: Number(e.playTime) } : null;
                })
                .filter((e): e is MuzzaEvent => !!e);

            db.close();
            return { songs, playlists, likedIds, events, db: dbBytes, settings };
        } catch (err) {
            try {
                db.close();
            } catch {
                /* ignore */
            }
            throw err;
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/**
 * Read just the play-history events out of a raw Muzza `song.db`, mapped to Zeta
 * ids. Used by the stats page to combine Muzza's history with Zeta's own.
 */
export async function readMuzzaEventsFromDb(dbBytes: Buffer): Promise<MuzzaEvent[]> {
    const { DatabaseSync } = await openSqlite();
    const tmp = mkdtempSync(join(tmpdir(), 'zeta-muzza-'));
    const dbPath = join(tmp, 'song.db');
    try {
        writeFileSync(dbPath, dbBytes);
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const localById = new Map<string, boolean>();
            for (const r of db.prepare('SELECT id, isLocal FROM song').all() as any[]) {
                localById.set(r.id, !!r.isLocal);
            }
            const rows = db.prepare('SELECT songId, timestamp, playTime FROM event').all() as any[];
            return rows.map((e) => ({
                zetaId: toZetaId(e.songId, localById.get(e.songId) ?? false),
                timestamp: Number(e.timestamp),
                playTimeMs: Number(e.playTime),
            }));
        } finally {
            db.close();
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
