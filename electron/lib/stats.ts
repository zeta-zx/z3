/**
 * Zeta play-history / listening stats.
 *
 * Stores the play events generated *inside Zeta* as MessagePack at
 * `.zeta/stats.msgpack`. This is intentionally separate from any imported Muzza
 * history: when a Muzza backup is imported, its `event` table is preserved as
 * the authoritative base (see muzza.ts) and this store is reset, so combining
 * the two for display or export never double-counts.
 *
 * A lightweight name cache lets the stats page label songs that were played but
 * never saved to the library/index (e.g. a one-off search result).
 */

import { encode, decode } from '@msgpack/msgpack';

import type { VFS } from './vfs';

const STATS_DIR = '.zeta';
const STATS_PATH = '.zeta/stats.msgpack';
const STATS_VERSION = 1;

export interface ZetaEvent {
    songId: string; // Zeta canonical id
    timestamp: number; // epoch ms
    playTimeMs: number;
}

export interface SongName {
    title: string;
    artists: string[];
    thumbnailUrl?: string;
}

interface StatsFile {
    version: number;
    events: ZetaEvent[];
    names: Record<string, SongName>;
}

export class StatsStore {
    private cache: StatsFile | null = null;
    private loading: Promise<StatsFile> | null = null;
    private writing: Promise<void> = Promise.resolve();

    constructor(private vfs: VFS) {}

    setVfs(vfs: VFS) {
        this.vfs = vfs;
        this.cache = null;
        this.loading = null;
    }

    private load(): Promise<StatsFile> {
        if (this.cache) return Promise.resolve(this.cache);
        if (!this.loading) {
            this.loading = this.readStats()
                .then((stats) => (this.cache = stats))
                .finally(() => (this.loading = null));
        }
        return this.loading;
    }

    private async readStats(): Promise<StatsFile> {
        // Read errors propagate (a flaky remote must not look like "no history").
        if (await this.vfs.exists(STATS_PATH)) {
            const raw = await this.vfs.readFile(STATS_PATH);
            try {
                const decoded = decode(raw) as any;
                return {
                    version: decoded?.version || STATS_VERSION,
                    events: Array.isArray(decoded?.events) ? decoded.events : [],
                    names: decoded?.names || {},
                };
            } catch (err) {
                console.warn('[stats] Corrupt stats.msgpack, backing it up and starting fresh:', err);
                await this.vfs.rename(STATS_PATH, `${STATS_PATH}.corrupt-${Date.now()}.bak`).catch(() => {});
            }
        }
        return { version: STATS_VERSION, events: [], names: {} };
    }

    private persist(): Promise<void> {
        const run = async () => {
            if (!this.cache) return;
            await this.vfs.mkdir(STATS_DIR);
            const enc = encode(this.cache, { ignoreUndefined: true });
            await this.vfs.writeFile(STATS_PATH, Buffer.from(enc.buffer, enc.byteOffset, enc.byteLength));
        };
        const next = this.writing.then(run, run);
        this.writing = next.catch(() => {});
        return next;
    }

    async record(event: ZetaEvent, name?: SongName): Promise<void> {
        const stats = await this.load();
        stats.events.push(event);
        if (name) stats.names[event.songId] = name;
        await this.persist();
    }

    async events(): Promise<ZetaEvent[]> {
        return [...(await this.load()).events];
    }

    async names(): Promise<Record<string, SongName>> {
        return (await this.load()).names;
    }

    /** Wipe Zeta-side history (used after importing a Muzza backup). */
    async clear(): Promise<void> {
        this.cache = { version: STATS_VERSION, events: [], names: {} };
        await this.persist();
    }
}
