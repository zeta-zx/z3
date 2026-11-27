import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

async function runDownloader(script, verify) {
    const home = await mkdtemp(join(tmpdir(), 'zeta-yt-dlp-test-'));
    try {
        const bin = join(home, '.local', 'bin');
        const profile = 'firefox:' + join(home, 'browser profile');
        await mkdir(bin, { recursive: true });
        await writeFile(join(bin, 'yt-dlp'), '#!/bin/sh\n' + script, { mode: 0o700 });
        const argsLog = join(home, 'args.log');
        const module = new URL('../electron/lib/yt-dlp.ts', import.meta.url).href;
        const { stdout } = await promisify(execFile)(process.execPath, [
            '--experimental-strip-types', '--input-type=module', '-e', `
            import { downloadWithYtDlp } from ${JSON.stringify(module)};
            process.stdout.write(await downloadWithYtDlp('ujUUZpognrY', 'best', {
                cookiesFile: null, browserProfile: ${JSON.stringify(profile)},
            }));
        `,
        ], { env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', ZETA_TEST_ARGS_LOG: argsLog } });
        await verify({ stdout, profile, argsLog });
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}

test('a desktop launch with a minimal PATH finds yt-dlp and passes the selected profile', {
    skip: process.platform === 'win32',
}, async () => {
    await runDownloader('printf "%s\\n" "$@"\n', ({ stdout, profile }) => {
        const args = stdout.trimEnd().split('\n');
        assert.ok(args.includes('--ignore-config'));
        assert.equal(args[args.indexOf('--cookies-from-browser') + 1], profile);
        assert.equal(args.includes('--cookies'), false);
        assert.equal(args.includes('--extractor-args'), false);
    });
});

test('a legacy YouTube solver crash retries with the same browser profile', {
    skip: process.platform === 'win32',
}, async () => {
    await runDownloader(`
        printf '%s\\n' 'run' "$@" >> "$ZETA_TEST_ARGS_LOG"
        for arg do
            if [ "$arg" = 'youtube:player_js_variant=tv' ]; then
                printf 'playable audio'
                exit 0
            fi
        done
        printf '%s\\n' 'TypeError: a.addOnDisposeCallback is not a function' 'Requested format is not available' >&2
        exit 1
    `, async ({ stdout, profile, argsLog }) => {
        assert.equal(stdout, 'playable audio');
        const [, first, retry] = (await readFile(argsLog, 'utf8')).split('run\n');
        const firstArgs = first.trimEnd().split('\n');
        const retryArgs = retry.trimEnd().split('\n');
        assert.equal(firstArgs[firstArgs.indexOf('--cookies-from-browser') + 1], profile);
        assert.deepEqual(retryArgs, [
            ...firstArgs.slice(0, -2),
            '--extractor-args', 'youtube:player_js_variant=tv',
            ...firstArgs.slice(-2),
        ]);
    });
});
