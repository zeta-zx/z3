import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildMuzzaArchive, parseMuzzaArchive, type MuzzaEvent, type MuzzaExportInput, type WithMuzzaDb } from '../../src/lib/muzza-codec';

export type { MuzzaEvent };

const nodeRequire = createRequire(import.meta.url);
const withDb: WithMuzzaDb = async (bytes, readOnly, work) => {
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
    const tmp = mkdtempSync(join(tmpdir(), 'zeta-muzza-'));
    const path = join(tmp, 'song.db');
    try {
        if (bytes) writeFileSync(path, bytes);
        const db = new DatabaseSync(path, { readOnly });
        try {
            db.exec('PRAGMA trusted_schema = OFF');
            return work({ exec: db.exec.bind(db), prepare: db.prepare.bind(db), export: () => readFileSync(path) });
        } finally {
            db.close();
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
};

export async function buildMuzzaBackup(input: MuzzaExportInput) {
    return buildMuzzaArchive(input, withDb);
}

export async function parseMuzzaBackup(bytes: Uint8Array) {
    return parseMuzzaArchive(bytes, withDb);
}

export async function readMuzzaEventsFromDb(dbBytes: Uint8Array): Promise<MuzzaEvent[]> {
    return withDb(dbBytes, true, (db) => {
        const songCols = new Set(
            (db.prepare('PRAGMA table_info(`song`)').all() as { name: string }[]).map((c) => c.name),
        );
        const localById = new Map<string, boolean>();
        const totalsByZetaId = new Map<string, { totalPlayTimeMs: number; inLibrary: number }>();
        const selectCols = [
            'id',
            songCols.has('isLocal') ? 'isLocal' : '0 AS isLocal',
            songCols.has('totalPlayTime') ? 'totalPlayTime' : '0 AS totalPlayTime',
            songCols.has('inLibrary') ? 'inLibrary' : 'NULL AS inLibrary',
        ].join(', ');
        for (const r of db.prepare(`SELECT ${selectCols} FROM song`).all() as any[]) {
            const isLocal = !!r.isLocal;
            localById.set(r.id, isLocal);
            const zetaId = r.id.includes(':') ? r.id : `${isLocal ? 'local' : 'yt'}:${r.id}`;
            const totalPlayTimeMs = Number(r.totalPlayTime) || 0;
            if (totalPlayTimeMs > 0) {
                totalsByZetaId.set(zetaId, {
                    totalPlayTimeMs,
                    inLibrary: Number(r.inLibrary) > 0 ? Number(r.inLibrary) : Date.now(),
                });
            }
        }
        const rows = db.prepare('SELECT songId, timestamp, playTime FROM event').all() as any[];
        const sumByZetaId = new Map<string, number>();
        const events: MuzzaEvent[] = [];
        for (const e of rows) {
            const zetaId = e.songId.includes(':') ? e.songId : `${localById.get(e.songId) ? 'local' : 'yt'}:${e.songId}`;
            const playTimeMs = Number(e.playTime) || 0;
            const timestamp = Number(e.timestamp) || Date.now();
            if (playTimeMs <= 0) continue;
            events.push({ zetaId, timestamp, playTimeMs });
            sumByZetaId.set(zetaId, (sumByZetaId.get(zetaId) ?? 0) + playTimeMs);
        }
        for (const [zetaId, { totalPlayTimeMs, inLibrary }] of totalsByZetaId) {
            const accounted = sumByZetaId.get(zetaId) ?? 0;
            if (totalPlayTimeMs - accounted >= 1000) {
                events.push({ zetaId, timestamp: inLibrary, playTimeMs: totalPlayTimeMs - accounted });
            }
        }
        return events;
    });
}
