/**
 * Persisted application configuration.
 *
 * Stored as JSON in Electron's per-user `userData` directory so it survives
 * app updates and lives outside the (possibly remote) music directory.
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_MUSIC_DIR } from './vfs';

export interface AppConfig {
    /**
     * Where music is stored. Either a local path or a remote URL
     * (`sftp://` / `ftp://` / `ftps://` / `file://`).
     */
    musicDir: string;
}

const defaults: AppConfig = {
    musicDir: DEFAULT_MUSIC_DIR,
};

function configPath(): string {
    const dir = app.getPath('userData');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'config.json');
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
    if (cached) return cached;

    const path = configPath();
    if (existsSync(path)) {
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf-8'));
            cached = { ...defaults, ...parsed };
            return cached!;
        } catch (err) {
            console.warn('[config] Failed to parse config.json, using defaults:', err);
        }
    }

    cached = { ...defaults };
    return cached;
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
    const next = { ...getConfig(), ...partial };
    cached = next;
    try {
        writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8');
    } catch (err) {
        console.error('[config] Failed to write config.json:', err);
    }
    return next;
}
