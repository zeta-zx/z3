/**
 * Zeta's backend, running in an Electron utility process.
 *
 * Everything heavy lives here: the metadata index, playlist parsing, tag
 * reading, YouTube / JioSaavn / lyrics requests, PoToken minting and audio
 * reads. Keeping it off the main process matters because the main process's
 * thread also routes the window's input — any long task there freezes the UI.
 *
 * Protocol (over process.parentPort):
 *   main → backend  { id, name, args }
 *   backend → main  { id, ok: true, result } | { id, ok: false, error }
 *   backend → main  { ready: true } once the routes are loaded
 */

import type { MessageEvent } from 'electron';
import { routes } from './routes/music';
import { coverUrl } from '../src/lib/covers';

interface ParentPort {
    on(event: 'message', listener: (event: MessageEvent) => void): void;
    postMessage(message: unknown): void;
}

const port = (process as unknown as { parentPort: ParentPort }).parentPort;

const table = routes as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * Replace byte views that are windows onto a larger buffer with standalone
 * copies. Serialising a view copies its *entire* underlying buffer, so one
 * small cover sliced out of a 20 MB file would otherwise ship all 20 MB — once
 * per cover, per message. This guards every response, whatever produced it.
 */
function detachViews(value: unknown, seen = new Set<object>()): unknown {
    if (!value || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) {
        const view = value as Uint8Array;
        return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : new Uint8Array(view);
    }
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = detachViews(value[i], seen);
    } else {
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) record[key] = detachViews(record[key], seen);
    }
    return value;
}

type ThumbLike = { url?: string; data?: Uint8Array; width?: number; height?: number };

/**
 * Songs leave the backend with cover *references* instead of cover bytes (see
 * src/lib/covers.ts). Returns copies: the objects may be the index's cached
 * records, which must keep their bytes.
 */
function externalizeCovers(value: unknown, seen = new Map<object, unknown>()): unknown {
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
    if (seen.has(value)) return seen.get(value);

    if (Array.isArray(value)) {
        const out: unknown[] = [];
        seen.set(value, out);
        for (const item of value) out.push(externalizeCovers(item, seen));
        return out;
    }

    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, v] of Object.entries(record)) out[key] = externalizeCovers(v, seen);

    const thumbs = record.thumbnails as ThumbLike[] | undefined;
    if (!Array.isArray(thumbs) || !thumbs.some((t) => t?.data?.length)) return out;

    // Albums/artists: the UI never shows their embedded bytes (they duplicate
    // the song's cover), so just drop them.
    if (typeof record.id !== 'string') {
        out.thumbnails = thumbs.filter((t) => !t?.data?.length);
        return out;
    }

    const embedded = thumbs.filter((t) => t?.data?.length);
    out.thumbnails = [
        ...thumbs.filter((t) => !t?.data?.length),
        {
            url: coverUrl(record.id),
            width: Math.max(...embedded.map((t) => t.width ?? 0)) || undefined,
            height: Math.max(...embedded.map((t) => t.height ?? 0)) || undefined,
        },
    ];
    return out;
}

port.on('message', async (event) => {
    const { id, name, args } = event.data as { id: number; name: string; args: unknown[] };
    try {
        const fn = table[name];
        if (typeof fn !== 'function') throw new Error(`Unknown backend route: ${name}`);
        const started = performance.now();
        const raw = await fn(...args);
        // The cover route is the one place bytes are meant to leave.
        const result = detachViews(name === 'musicCover' ? raw : externalizeCovers(raw));
        const worked = performance.now();
        port.postMessage({ id, ok: true, result });
        const done = performance.now();
        if (done - started > 250) {
            console.log(`[backend] slow route ${name}: ${Math.round(worked - started)}ms work + ${Math.round(done - worked)}ms sending`);
        }
    } catch (err) {
        const e = err as Error;
        port.postMessage({ id, ok: false, error: { message: e?.message ?? String(err), stack: e?.stack } });
    }
});

port.postMessage({ ready: true });
