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

    constructor(private vfs: VFS) {}

    setVfs(vfs: VFS) {
        this.vfs = vfs;
        this.cache = null;
    }

    private async load(): Promise<StatsFile> {
        if (this.cache) return this.cache;

        if (await this.vfs.exists(STATS_PATH)) {
            try {
                const decoded = decode(await this.vfs.readFile(STATS_PATH)) as any;
                this.cache = {
                    version: decoded?.version || STATS_VERSION,
                    events: Array.isArray(decoded?.events) ? decoded.events : [],
                    names: decoded?.names || {},
                };
                return this.cache;
            } catch (err) {
                console.warn('[stats] Corrupt stats.msgpack, starting fresh:', err);
            }
        }

        this.cache = { version: STATS_VERSION, events: [], names: {} };
        return this.cache;
    }

    private async persist(): Promise<void> {
        if (!this.cache) return;
        await this.vfs.mkdir(STATS_DIR);
        const enc = encode(this.cache, { ignoreUndefined: true });
        await this.vfs.writeFile(STATS_PATH, Buffer.from(enc.buffer, enc.byteOffset, enc.byteLength));
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
