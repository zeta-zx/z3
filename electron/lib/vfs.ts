/**
 * Virtual File System abstraction.
 *
 * The rest of the app never touches `node:fs` directly for music storage.
 * Instead it talks to a {@link VFS} rooted at the user's configured music
 * directory. That directory may be a local path, or a remote location
 * addressed by an `sftp://` or `ftp://` URL.
 *
 * All paths passed to a {@link VFS} are POSIX-style and *relative to the root*
 * (e.g. `favourites.m3u8`, `.zeta/index.json`, `Song [yt_abc].m4a`).
 */

import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { Writable, Readable } from 'node:stream';

export interface FileStat {
    size: number;
    birthtimeMs: number;
    mtimeMs: number;
}

export interface DirEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
}

export interface VFS {
    /** Human-readable description of the root (the original URI/path). */
    readonly root: string;
    /** True when files live on the local machine (enables embedded tag writing). */
    readonly isLocal: boolean;

    exists(path: string): Promise<boolean>;
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, data: Buffer | string): Promise<void>;
    appendFile(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    readdir(path: string): Promise<DirEntry[]>;
    stat(path: string): Promise<FileStat>;
    unlink(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;

    /** Absolute on-disk path, when the backing store is local; otherwise null. */
    localPath(path: string): string | null;

    dispose(): Promise<void>;
}

/** Normalise a relative path into clean POSIX segments. */
function posixNormalise(p: string): string {
    return p
        .replace(/\\/g, '/')
        .split('/')
        .filter((seg) => seg && seg !== '.')
        .join('/');
}

function posixJoin(base: string, rel: string): string {
    const cleanBase = base.replace(/\/+$/, '');
    const cleanRel = posixNormalise(rel);
    return cleanRel ? `${cleanBase}/${cleanRel}` : cleanBase || '/';
}

async function collectStream(readable: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
    }
    return Buffer.concat(chunks);
}

/* -------------------------------------------------------------------------- */
/*                                Local adapter                               */
/* -------------------------------------------------------------------------- */

class LocalVFS implements VFS {
    readonly isLocal = true;

    constructor(
        public readonly root: string,
        private readonly baseDir: string,
    ) {}

    private resolve(path: string): string {
        return pathJoin(this.baseDir, posixNormalise(path));
    }

    async exists(path: string): Promise<boolean> {
        return existsSync(this.resolve(path));
    }

    async readFile(path: string): Promise<Buffer> {
        return fs.readFile(this.resolve(path));
    }

    async writeFile(path: string, data: Buffer | string): Promise<void> {
        await fs.writeFile(this.resolve(path), data);
    }

    async appendFile(path: string, data: string): Promise<void> {
        await fs.appendFile(this.resolve(path), data);
    }

    async mkdir(path: string): Promise<void> {
        await fs.mkdir(this.resolve(path), { recursive: true });
    }

    async readdir(path: string): Promise<DirEntry[]> {
        const entries = await fs.readdir(this.resolve(path), { withFileTypes: true });
        return entries.map((e) => ({
            name: e.name,
            isFile: e.isFile(),
            isDirectory: e.isDirectory(),
        }));
    }

    async stat(path: string): Promise<FileStat> {
        const s = await fs.stat(this.resolve(path));
        return { size: s.size, birthtimeMs: s.birthtimeMs, mtimeMs: s.mtimeMs };
    }

    async unlink(path: string): Promise<void> {
        await fs.unlink(this.resolve(path));
    }

    async rename(from: string, to: string): Promise<void> {
        await fs.rename(this.resolve(from), this.resolve(to));
    }

    localPath(path: string): string | null {
        return this.resolve(path);
    }

    async dispose(): Promise<void> {}
}

/* -------------------------------------------------------------------------- */
/*                          Remote connection helpers                         */
/* -------------------------------------------------------------------------- */

/**
 * A tiny serial task queue. Remote protocols (SFTP/FTP) run over a single
 * stateful control connection, so operations must never overlap.
 */
class Mutex {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(task, task);
        // Keep the chain alive even if a task rejects.
        this.tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}

interface RemoteAuth {
    host: string;
    port?: number;
    user?: string;
    password?: string;
    basePath: string;
}

function parseRemote(url: URL): RemoteAuth {
    return {
        host: decodeURIComponent(url.hostname),
        port: url.port ? parseInt(url.port, 10) : undefined,
        user: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        basePath: decodeURIComponent(url.pathname) || '/',
    };
}

/* -------------------------------------------------------------------------- */
/*                                SFTP adapter                                */
/* -------------------------------------------------------------------------- */

class SftpVFS implements VFS {
    readonly isLocal = false;

    private client: any = null;
    private readonly mutex = new Mutex();
    private ClientCtor: any;

    constructor(
        public readonly root: string,
        private readonly auth: RemoteAuth,
    ) {}

    private full(path: string): string {
        return posixJoin(this.auth.basePath, path);
    }

    private async connect(): Promise<any> {
        if (this.client) return this.client;
        if (!this.ClientCtor) {
            const mod = await import('ssh2-sftp-client');
            this.ClientCtor = mod.default ?? mod;
        }
        const client = new this.ClientCtor();
        await client.connect({
            host: this.auth.host,
            port: this.auth.port ?? 22,
            username: this.auth.user,
            password: this.auth.password,
        });
        client.on('end', () => (this.client = null));
        client.on('close', () => (this.client = null));
        this.client = client;
        return client;
    }

    private op<T>(fn: (c: any) => Promise<T>): Promise<T> {
        return this.mutex.run(async () => {
            try {
                return await fn(await this.connect());
            } catch (err: any) {
                // Drop a broken connection so the next call reconnects.
                if (/connect|closed|ECONNRESET|ended|Timeout/i.test(String(err?.message))) {
                    this.client = null;
                }
                throw err;
            }
        });
    }

    async exists(path: string): Promise<boolean> {
        return this.op(async (c) => (await c.exists(this.full(path))) !== false);
    }

    async readFile(path: string): Promise<Buffer> {
        return this.op(async (c) => (await c.get(this.full(path))) as Buffer);
    }

    async writeFile(path: string, data: Buffer | string): Promise<void> {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
        await this.op(async (c) => {
            await c.put(buf, this.full(path));
        });
    }

    async appendFile(path: string, data: string): Promise<void> {
        await this.op(async (c) => {
            if ((await c.exists(this.full(path))) === false) {
                await c.put(Buffer.from(data, 'utf-8'), this.full(path));
            } else {
                await c.append(Buffer.from(data, 'utf-8'), this.full(path));
            }
        });
    }

    async mkdir(path: string): Promise<void> {
        await this.op(async (c) => {
            await c.mkdir(this.full(path), true);
        });
    }

    async readdir(path: string): Promise<DirEntry[]> {
        return this.op(async (c) => {
            const list = await c.list(this.full(path));
            return list.map((f: any) => ({
                name: f.name,
                isFile: f.type === '-',
                isDirectory: f.type === 'd',
            }));
        });
    }

    async stat(path: string): Promise<FileStat> {
        return this.op(async (c) => {
            const s = await c.stat(this.full(path));
            return {
                size: s.size ?? 0,
                mtimeMs: s.modifyTime ?? 0,
                birthtimeMs: s.accessTime ?? s.modifyTime ?? 0,
            };
        });
    }

    async unlink(path: string): Promise<void> {
        await this.op(async (c) => {
            await c.delete(this.full(path), true);
        });
    }

    async rename(from: string, to: string): Promise<void> {
        await this.op(async (c) => {
            await c.rename(this.full(from), this.full(to));
        });
    }

    localPath(): string | null {
        return null;
    }

    async dispose(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) await client.end().catch(() => {});
    }
}

/* -------------------------------------------------------------------------- */
/*                                 FTP adapter                                */
/* -------------------------------------------------------------------------- */

class FtpVFS implements VFS {
    readonly isLocal = false;

    private client: any = null;
    private readonly mutex = new Mutex();

    constructor(
        public readonly root: string,
        private readonly auth: RemoteAuth,
        private readonly secure: boolean,
    ) {}

    private full(path: string): string {
        return posixJoin(this.auth.basePath, path);
    }

    private async connect(): Promise<any> {
        if (this.client && !this.client.closed) return this.client;
        const { Client } = await import('basic-ftp');
        const client = new Client();
        await client.access({
            host: this.auth.host,
            port: this.auth.port ?? 21,
            user: this.auth.user,
            password: this.auth.password,
            secure: this.secure,
        });
        this.client = client;
        return client;
    }

    private op<T>(fn: (c: any) => Promise<T>): Promise<T> {
        return this.mutex.run(async () => {
            try {
                return await fn(await this.connect());
            } catch (err: any) {
                if (this.client?.closed) this.client = null;
                throw err;
            }
        });
    }

    async exists(path: string): Promise<boolean> {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
        try {
            const entries = await this.readdir(dir);
            return entries.some((e) => e.name === name);
        } catch {
            return false;
        }
    }

    async readFile(path: string): Promise<Buffer> {
        return this.op(async (c) => {
            const chunks: Buffer[] = [];
            const sink = new Writable({
                write(chunk, _enc, cb) {
                    chunks.push(Buffer.from(chunk));
                    cb();
                },
            });
            await c.downloadTo(sink, this.full(path));
            return Buffer.concat(chunks);
        });
    }

    async writeFile(path: string, data: Buffer | string): Promise<void> {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
        await this.op(async (c) => {
            await c.uploadFrom(Readable.from(buf), this.full(path));
        });
    }

    async appendFile(path: string, data: string): Promise<void> {
        const existing = (await this.exists(path)) ? await this.readFile(path) : Buffer.alloc(0);
        await this.writeFile(path, Buffer.concat([existing, Buffer.from(data, 'utf-8')]));
    }

    async mkdir(path: string): Promise<void> {
        await this.op(async (c) => {
            await c.ensureDir(this.full(path));
            // ensureDir changes the working dir; reset to root for consistency.
            await c.cd('/');
        });
    }

    async readdir(path: string): Promise<DirEntry[]> {
        return this.op(async (c) => {
            const list = await c.list(this.full(path));
            return list.map((f: any) => ({
                name: f.name,
                isFile: f.isFile,
                isDirectory: f.isDirectory,
            }));
        });
    }

    async stat(path: string): Promise<FileStat> {
        return this.op(async (c) => {
            const size = await c.size(this.full(path)).catch(() => 0);
            const mod = await c.lastMod(this.full(path)).catch(() => null);
            const ms = mod ? new Date(mod).getTime() : 0;
            return { size, mtimeMs: ms, birthtimeMs: ms };
        });
    }

    async unlink(path: string): Promise<void> {
        await this.op(async (c) => {
            await c.remove(this.full(path));
        });
    }

    async rename(from: string, to: string): Promise<void> {
        await this.op(async (c) => {
            await c.rename(this.full(from), this.full(to));
        });
    }

    localPath(): string | null {
        return null;
    }

    async dispose(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) client.close();
    }
}

/* -------------------------------------------------------------------------- */
/*                                  Factory                                   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_MUSIC_DIR = pathJoin(homedir(), 'Music', 'Zeta');

/**
 * Build a {@link VFS} from a music-directory descriptor. Accepts:
 *  - a bare local path (`/home/me/Music/Zeta`, `C:\\Music`)
 *  - `file://` URLs
 *  - `sftp://user:pass@host:port/base/path`
 *  - `ftp://` / `ftps://`
 */
export async function createVFS(descriptor: string): Promise<VFS> {
    const value = (descriptor || '').trim() || DEFAULT_MUSIC_DIR;

    let url: URL | null = null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        try {
            url = new URL(value);
        } catch {
            url = null;
        }
    }

    if (!url || url.protocol === 'file:') {
        const baseDir = url ? fileUrlToPath(url) : value;
        await fs.mkdir(baseDir, { recursive: true });
        return new LocalVFS(value, baseDir);
    }

    switch (url.protocol) {
        case 'sftp:':
            return new SftpVFS(value, parseRemote(url));
        case 'ftp:':
            return new FtpVFS(value, parseRemote(url), false);
        case 'ftps:':
            return new FtpVFS(value, parseRemote(url), true);
        default:
            throw new Error(`Unsupported music directory protocol: ${url.protocol}`);
    }
}

function fileUrlToPath(url: URL): string {
    try {
        return decodeURIComponent(url.pathname);
    } catch {
        return url.pathname;
    }
}
