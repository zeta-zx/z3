/**
 * Song metadata storage.
 *
 * Songs are stored on disk as raw `.m4a` (MP4/AAC) files — no transcoding.
 * Since ID3 tags only apply to MP3, metadata is handled two ways:
 *
 *   1. A central JSON index (`.zeta/index.json`) inside the music directory is
 *      the source of truth. It is a single small file that lists every
 *      downloaded song's metadata keyed by its canonical id. This also works
 *      transparently over remote (SFTP/FTP) storage.
 *
 *   2. When storage is local, native MP4 "iTunes" atom tags (title, artist,
 *      album, year, lyrics, cover art) are also embedded into the file via
 *      TagLib# so the files remain portable to other players. Remote stores
 *      skip embedding (no cheap random access) and rely solely on the index.
 *
 * Songs that are merely searched + played once are never written here at all —
 * they stream straight through and are only cached in the frontend.
 *
 * Alternative approaches considered: per-file `.json` sidecars (clutter, no
 * off-disk story) and stuffing everything into the m3u8 `#EXTINF`/`#EXTZETA`
 * lines (fragile, duplicated across playlists). The central index won out.
 */

import type { Song, Thumbnail, Artist, AlbumBase } from '../../src/lib/schema';
import type { VFS } from './vfs';

const INDEX_PATH = '.zeta/index.json';
const INDEX_DIR = '.zeta';
const INDEX_VERSION = 1;

export interface IndexRecord {
    id: string; // canonical id: yt:.. / js:.. / local:..
    /**
     * Relative filename within the music dir. Absent for "off-disk" records —
     * songs whose metadata we know (e.g. imported from a Muzza backup) but whose
     * audio hasn't been downloaded yet. These stream on demand and only get a
     * `file` once actually downloaded.
     */
    file?: string;
    title: string;
    artists: Artist[];
    album: AlbumBase | null;
    duration: number;
    year?: string;
    lyrics?: string | null;
    thumbnails: Thumbnail[];
}

interface IndexFile {
    version: number;
    records: Record<string, IndexRecord>;
}

/* --------------------------- (de)serialisation ---------------------------- */

// JSON cannot represent Uint8Array, so raw thumbnail bytes are base64-encoded
// on write and rehydrated on read.
function serialiseThumbnails(thumbs: Thumbnail[]): any[] {
    return (thumbs || []).map((t) => ({
        url: t.url,
        mimetype: t.mimetype,
        width: t.width,
        height: t.height,
        data: t.data ? Buffer.from(t.data).toString('base64') : undefined,
    }));
}

function deserialiseThumbnails(raw: any[]): Thumbnail[] {
    return (raw || []).map((t) => ({
        url: t.url,
        mimetype: t.mimetype,
        width: t.width,
        height: t.height,
        data: typeof t.data === 'string' ? new Uint8Array(Buffer.from(t.data, 'base64')) : undefined,
    }));
}

/* ------------------------------- the store -------------------------------- */

export class MetadataStore {
    private cache: IndexFile | null = null;

    constructor(private vfs: VFS) {}

    /** Point the store at a new VFS (e.g. after the music dir changes). */
    setVfs(vfs: VFS) {
        this.vfs = vfs;
        this.cache = null;
    }

    private async load(): Promise<IndexFile> {
        if (this.cache) return this.cache;

        if (await this.vfs.exists(INDEX_PATH)) {
            try {
                const parsed = JSON.parse((await this.vfs.readFile(INDEX_PATH)).toString('utf-8'));
                const records: Record<string, IndexRecord> = {};
                for (const [id, rec] of Object.entries(parsed.records || {})) {
                    const r = rec as any;
                    records[id] = { ...r, thumbnails: deserialiseThumbnails(r.thumbnails) };
                }
                this.cache = { version: parsed.version || INDEX_VERSION, records };
                return this.cache;
            } catch (err) {
                console.warn('[metadata] Corrupt index.json, starting fresh:', err);
            }
        }

        this.cache = { version: INDEX_VERSION, records: {} };
        return this.cache;
    }

    private async persist(): Promise<void> {
        if (!this.cache) return;
        await this.vfs.mkdir(INDEX_DIR);
        const out = {
            version: this.cache.version,
            records: Object.fromEntries(
                Object.entries(this.cache.records).map(([id, r]) => [
                    id,
                    { ...r, thumbnails: serialiseThumbnails(r.thumbnails) },
                ]),
            ),
        };
        await this.vfs.writeFile(INDEX_PATH, JSON.stringify(out, null, 2));
    }

    async get(id: string): Promise<IndexRecord | undefined> {
        return (await this.load()).records[id];
    }

    /** Find a record by the file it is stored in. */
    async getByFile(file: string): Promise<IndexRecord | undefined> {
        const { records } = await this.load();
        return Object.values(records).find((r) => r.file != null && r.file === file);
    }

    async all(): Promise<IndexRecord[]> {
        return Object.values((await this.load()).records);
    }

    async upsert(record: IndexRecord): Promise<void> {
        const index = await this.load();
        index.records[record.id] = record;
        await this.persist();
    }

    /** Insert/replace many records with a single persist (efficient for imports). */
    async upsertMany(records: IndexRecord[]): Promise<void> {
        if (!records.length) return;
        const index = await this.load();
        for (const record of records) index.records[record.id] = record;
        await this.persist();
    }

    async remove(id: string): Promise<void> {
        const index = await this.load();
        if (index.records[id]) {
            delete index.records[id];
            await this.persist();
        }
    }

    /** Convert an index record into a full {@link Song}. */
    static toSong(record: IndexRecord): Song {
        return {
            id: record.id,
            title: record.title,
            thumbnails: record.thumbnails,
            artists: record.artists,
            album: record.album,
            duration: record.duration,
            year: record.year,
            lyrics: record.lyrics,
            isDownloaded: !!record.file,
        };
    }
}

/* ------------------------- native MP4 tag embedding ----------------------- */

/**
 * Embed metadata into a local `.m4a`/`.mp4` file as native MP4 atom tags.
 * No-op friendly: throws are caught by callers so a tagging failure never
 * blocks a successful download (the index remains authoritative).
 */
export async function embedMp4Tags(
    localPath: string,
    meta: {
        title: string;
        artists: string[];
        album?: string | null;
        year?: string | number;
        lyrics?: string | null;
        cover?: { data: Uint8Array; mimetype: string } | null;
    },
): Promise<void> {
    const taglib = await import('node-taglib-sharp');
    const { File, Picture, PictureType, ByteVector } = taglib;

    const file = File.createFromPath(localPath);
    try {
        file.tag.title = meta.title;
        if (meta.artists?.length) file.tag.performers = meta.artists;
        if (meta.album) file.tag.album = meta.album;
        const yearNum = meta.year ? parseInt(String(meta.year), 10) : NaN;
        if (!isNaN(yearNum)) file.tag.year = yearNum;
        if (meta.lyrics) file.tag.lyrics = meta.lyrics;

        if (meta.cover?.data?.length) {
            const picture = Picture.fromFullData(
                ByteVector.fromByteArray(meta.cover.data),
                PictureType.FrontCover,
                meta.cover.mimetype || 'image/jpeg',
                'cover',
            );
            file.tag.pictures = [picture];
        }

        file.save();
    } finally {
        file.dispose();
    }
}

/**
 * Read metadata from a local MP4 file that isn't in the index (e.g. a file the
 * user dropped into the music dir manually). Returns null if it can't be read.
 */
export async function readMp4Tags(
    localPath: string,
): Promise<Pick<IndexRecord, 'title' | 'artists' | 'album' | 'duration' | 'year' | 'lyrics' | 'thumbnails'> | null> {
    try {
        const taglib = await import('node-taglib-sharp');
        const { File } = taglib;
        const file = File.createFromPath(localPath);
        try {
            const tag = file.tag;
            const artists: Artist[] = (tag.performers || []).map((name) => ({ name, thumbnails: [] }));
            const thumbnails: Thumbnail[] = (tag.pictures || []).map((p) => ({
                data: new Uint8Array(p.data.toByteArray()),
                mimetype: p.mimeType || 'image/jpeg',
            }));
            return {
                title: tag.title || '',
                artists: artists.length ? artists : [{ name: 'Unknown Artist', thumbnails: [] }],
                album: tag.album ? { title: tag.album, artists, thumbnails, year: tag.year ? String(tag.year) : undefined } : null,
                duration: (file.properties?.durationMilliseconds || 0) / 1000,
                year: tag.year ? String(tag.year) : undefined,
                lyrics: tag.lyrics || null,
                thumbnails,
            };
        } finally {
            file.dispose();
        }
    } catch (err) {
        console.warn(`[metadata] Could not read tags from ${localPath}:`, err);
        return null;
    }
}
