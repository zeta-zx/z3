/**
 * Main-process side of the backend utility process (see ../backend.ts).
 *
 * Calls made before the backend has started are queued and sent once it
 * reports ready. If the backend dies, in-flight calls fail and it is restarted.
 */

import { app, utilityProcess, type UtilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

let child: UtilityProcess | null = null;
let ready = false;
let seq = 0;
let stopping = false;
const pending = new Map<number, Pending>();
const queue: Array<{ id: number; name: string; args: unknown[] }> = [];

function start() {
    // This module is bundled into dist-electron/main.js; the backend entry is
    // built alongside it as dist-electron/backend.js.
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'backend.js');
    ready = false;
    child = utilityProcess.fork(entry, [], {
        serviceName: 'Zeta Backend',
        stdio: 'inherit',
        env: { ...process.env, ZETA_CONFIG_DIR: app.getPath('userData') },
    });

    child.on('message', (message: any) => {
        if (message?.ready) {
            ready = true;
            for (const call of queue.splice(0)) child!.postMessage(call);
            return;
        }
        const entry = pending.get(message?.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.result);
        else {
            const err = new Error(message.error?.message ?? 'Backend error');
            if (message.error?.stack) err.stack = message.error.stack;
            entry.reject(err);
        }
    });

    child.on('exit', (code) => {
        child = null;
        ready = false;
        for (const [id, entry] of pending) {
            // Calls still waiting in the queue get retried on the next backend.
            if (queue.some((q) => q.id === id)) continue;
            entry.reject(new Error(`Zeta's backend stopped unexpectedly (exit code ${code}).`));
            pending.delete(id);
        }
        if (!stopping) {
            console.warn(`[backend] exited with code ${code}; restarting`);
            setTimeout(start, 500);
        }
    });
}

export function startBackend() {
    if (!child) start();
}

export function stopBackend() {
    stopping = true;
    child?.kill();
}

export function callBackend<T>(name: string, args: unknown[]): Promise<T> {
    if (!child && !stopping) start();
    return new Promise<T>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        const call = { id, name, args };
        if (ready && child) child.postMessage(call);
        else queue.push(call);
    });
}
