import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_BITRATE_KBPS, type AudioQuality } from '../../src/lib/audio-quality.ts';

const execFileAsync = promisify(execFile);
const MAX_COOKIE_FILE_BYTES = 1024 * 1024;
const LEGACY_PLAYER_ERROR = /addOnDisposeCallback is not a function/i;

function downloaderEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const home = homedir();
    const windows = process.platform === 'win32';
    const pathKey = windows ? Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path' : 'PATH';
    // GUI launches can miss the directories that the user's shell adds to PATH.
    const userBins = windows ? [
        join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
        join(env.SCOOP || join(home, 'scoop'), 'shims'),
    ] : [join(home, '.local', 'bin')];
    const systemBins = windows ? [
        join(env.ChocolateyInstall || join(env.ProgramData || 'C:\\ProgramData', 'chocolatey'), 'bin'),
        join(env.SystemRoot || 'C:\\Windows', 'System32'),
    ] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
    const inherited = (env[pathKey] ?? '').split(delimiter);
    const missingUserBins = userBins.filter((bin) => !inherited.some((entry) =>
        windows ? entry.toLowerCase() === bin.toLowerCase() : entry === bin,
    ));
    env[pathKey] = [...new Set([...missingUserBins, ...inherited, ...systemBins].filter(isAbsolute))].join(delimiter);
    return env;
}

export async function readYoutubeCookies(path: string): Promise<string> {
    let contents: string;
    try {
        if (!isAbsolute(path)) throw new Error();
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_COOKIE_FILE_BYTES) throw new Error();
        contents = await readFile(path, 'utf8');
    } catch {
        throw new Error('Could not read the YouTube cookies file. Choose it again in Settings.');
    }

    const [header, ...lines] = contents.split(/\r?\n/);
    if (header !== '# Netscape HTTP Cookie File' && header !== '# HTTP Cookie File') {
        throw new Error('Choose a Netscape-format cookies.txt file.');
    }
    const cookies = lines.filter((line) => {
        const fields = line.replace(/^#HttpOnly_/, '').split('\t');
        return fields.length === 7 && /^(?:\.?youtube\.com|\.?[\w.-]+\.youtube\.com)$/i.test(fields[0]);
    });
    if (!cookies.length) throw new Error('The selected file contains no YouTube cookies.');
    return [header, ...cookies, ''].join('\n');
}

export async function downloadWithYtDlp(
    videoId: string,
    quality: AudioQuality,
    source: { cookiesFile: string | null; browserProfile?: string },
): Promise<Buffer> {
    const { cookiesFile, browserProfile } = source;
    if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid YouTube video ID.');

    const temp = await mkdtemp(join(tmpdir(), 'zeta-youtube-'));
    try {
        const args = [
            '--ignore-config', '--no-playlist', '--no-progress', '--js-runtimes', 'node',
            '--format', 'bestaudio[ext=m4a][protocol=https]',
            '--format-sort-force',
            '--format-sort', quality === 'best' ? 'abr' : `abr:${MAX_BITRATE_KBPS[quality]}`,
            '--output', '-',
        ];

        if (browserProfile) {
            args.push('--cookies-from-browser', browserProfile, '--no-plugin-dirs');
        } else if (cookiesFile) {
            // yt-dlp can write refreshed cookies back to its input. Give each
            // download its own copy and keep unrelated browser cookies out.
            const cookies = await readYoutubeCookies(cookiesFile);
            const privateCopy = join(temp, 'cookies.txt');
            await writeFile(privateCopy, cookies, { mode: 0o600 });
            args.push('--cookies', privateCopy);
        }

        const executable = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const options = {
            cwd: temp,
            env: downloaderEnvironment(),
            encoding: 'buffer' as const,
            maxBuffer: 128 * 1024 * 1024,
            timeout: 90_000,
            windowsHide: true,
        };
        const downloadAudio = (extraArgs: string[] = []) =>
            execFileAsync(executable, [...args, ...extraArgs, '--', url], options);
        const download = downloadAudio().catch((error: NodeJS.ErrnoException & { stderr?: Buffer; killed?: boolean }) => {
            if (error.killed || !LEGACY_PLAYER_ERROR.test(error.stderr?.toString() ?? '')) throw error;
            // yt-dlp 2026.11.23 switched player JS variants to fix this solver crash.
            // Apply the same switch on older versions, retaining the selected cookies.
            return downloadAudio(['--extractor-args', 'youtube:player_js_variant=tv']);
        });
        const { stdout } = await download.catch((error: NodeJS.ErrnoException & { stderr?: Buffer; killed?: boolean }) => {
            if (error.code === 'ENOENT') {
                throw new Error('Zeta could not find yt-dlp. Install it in a standard location or add it to your PATH, then reopen Zeta.');
            }
            if (error.killed) throw new Error('The YouTube download via yt-dlp timed out.');
            const stderr = error.stderr?.toString() ?? '';
            if (browserProfile && /decrypt|could not copy|cookie database|file is not a database|failed to load (?:browser )?cookies|failed to extract|keychain|keyring/i.test(stderr)) {
                throw new Error('yt-dlp could not read cookies from this browser profile. Close the browser and retry, or choose Firefox or a cookies file in Settings.');
            }
            if (/sign in|log in|cookies.*(?:expired|invalid)/i.test(stderr)) {
                if (browserProfile) throw new Error('YouTube requested sign-in. Sign in to YouTube in the selected browser profile and retry.');
                throw new Error(cookiesFile
                    ? 'YouTube rejected the session. Choose a fresh cookies.txt file in Settings.'
                    : 'YouTube requested sign-in. Choose a signed-in browser profile or a YouTube cookies file in Settings.');
            }
            // CLI errors may include signed media URLs or local file paths.
            if (LEGACY_PLAYER_ERROR.test(stderr)) {
                throw new Error('This version of yt-dlp cannot handle the current YouTube player. Update yt-dlp to 2026.11.23 or newer and retry.');
            }
            if (/no supported JavaScript runtime|challenge solver script|signature solving failed|n challenge solving failed/i.test(stderr)) {
                throw new Error('yt-dlp could not resolve YouTube audio. Use a current yt-dlp build with its YouTube challenge scripts and Node.js 22+ or Deno.');
            }
            if (/HTTP (?:Error )?403|Requested format is not available|No (?:audio|video) formats found/i.test(stderr)) {
                throw new Error('YouTube did not provide playable audio to yt-dlp. Update yt-dlp and retry.');
            }
            throw new Error('yt-dlp could not download YouTube audio. Check that yt-dlp and Node.js 22+ or Deno are up to date.');
        });
        if (!stdout.length) throw new Error('yt-dlp returned empty YouTube audio.');
        return stdout;
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}
