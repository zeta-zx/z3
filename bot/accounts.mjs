import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function accounts(directory) {
    const path = join(directory, 'accounts.json');
    let entries = {};
    try {
        entries = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    return {
        get(userId) {
            return entries[userId] ?? {};
        },
        set(userId, key, value) {
            const account = { ...entries[userId] };
            if (value == null) delete account[key];
            else account[key] = value;

            const snapshot = { ...entries };
            if (Object.keys(account).length) snapshot[userId] = account;
            else delete snapshot[userId];

            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const temporary = join(directory, `accounts-${randomUUID()}.tmp`);
            try {
                writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
                renameSync(temporary, path);
            } finally {
                rmSync(temporary, { force: true });
            }
            entries = snapshot;
        },
    };
}
