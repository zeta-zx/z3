import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface BrowserRoot {
    browser: string;
    extractor: string;
    path: string;
}

export interface BrowserProfile {
    id: string;
    browser: string;
    name: string;
    ytDlpSource: string;
    youtubeLoggedIn: boolean;
    email?: string;
}

function browserRoots(): BrowserRoot[] {
    const home = homedir();
    const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const mac = join(home, 'Library', 'Application Support');
    const roots: BrowserRoot[] = [];
    const add = (browser: string, extractor: string, base: string, ...paths: string[]) => {
        for (const path of paths) roots.push({ browser, extractor, path: join(base, path) });
    };

    switch (process.platform) {
        case 'win32':
            add('Helium', 'chromium', local, 'imput/Helium/User Data', 'Helium/User Data');
            add('Firefox', 'firefox', roaming, 'Mozilla/Firefox/Profiles');
            add('Firefox', 'firefox', local, 'Packages/Mozilla.Firefox_n80bbvh6b1yt2/LocalCache/Roaming/Mozilla/Firefox/Profiles');
            add('Chrome', 'chrome', local, 'Google/Chrome/User Data');
            add('Brave', 'brave', local, 'BraveSoftware/Brave-Browser/User Data');
            add('Chromium', 'chromium', local, 'Chromium/User Data');
            add('Edge', 'edge', local, 'Microsoft/Edge/User Data');
            add('Vivaldi', 'vivaldi', local, 'Vivaldi/User Data');
            add('Opera', 'opera', roaming, 'Opera Software/Opera Stable');
            break;
        case 'darwin':
            add('Helium', 'chromium', mac, 'net.imput.helium', 'Helium');
            add('Firefox', 'firefox', mac, 'Firefox/Profiles');
            add('Chrome', 'chrome', mac, 'Google/Chrome');
            add('Brave', 'brave', mac, 'BraveSoftware/Brave-Browser');
            add('Chromium', 'chromium', mac, 'Chromium');
            add('Edge', 'edge', mac, 'Microsoft Edge');
            add('Vivaldi', 'vivaldi', mac, 'Vivaldi');
            add('Opera', 'opera', mac, 'com.operasoftware.Opera');
            break;
        default:
            add('Helium', 'chromium', config, 'net.imput.helium', 'helium');
            add('Firefox', 'firefox', config, 'mozilla/firefox');
            add('Firefox', 'firefox', home, '.mozilla/firefox', 'snap/firefox/common/.mozilla/firefox',
                '.var/app/org.mozilla.firefox/.mozilla/firefox', '.var/app/org.mozilla.firefox/config/mozilla/firefox');
            add('Chrome', 'chrome', config, 'google-chrome');
            add('Brave', 'brave', config, 'BraveSoftware/Brave-Browser');
            add('Chromium', 'chromium', config, 'chromium');
            add('Edge', 'edge', config, 'microsoft-edge');
            add('Vivaldi', 'vivaldi', config, 'vivaldi');
            add('Opera', 'opera', config, 'opera');
            add('Helium', 'chromium', home, '.var/app/net.imput.helium/config/net.imput.helium');
            add('Chrome', 'chrome', home, '.var/app/com.google.Chrome/config/google-chrome');
            add('Brave', 'brave', home, '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser',
                'snap/brave/current/.config/BraveSoftware/Brave-Browser');
            add('Chromium', 'chromium', home, '.var/app/org.chromium.Chromium/config/chromium',
                'snap/chromium/common/chromium');
    }
    return roots;
}

const YT_AUTH_COOKIES = [
    'SAPISID',
    '__Secure-3PAPISID',
    '__Secure-1PAPISID',
    '__Secure-3PSID',
    '__Secure-1PSID',
    'SID',
    'HSID',
    'SSID',
    'LOGIN_INFO',
];

function validEmail(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined;
}

async function readProfileAccount(root: BrowserRoot, profilePath: string): Promise<{ email?: string; label?: string }> {
    const dirName = basename(profilePath);
    if (root.extractor === 'firefox') {
        try {
            const signedIn = JSON.parse(await readFile(join(profilePath, 'signedInUser.json'), 'utf8'));
            const email = validEmail(signedIn?.accountData?.email);
            if (email) return { email };
        } catch { /* ignore */ }
        try {
            const prefs = await readFile(join(profilePath, 'prefs.js'), 'utf8');
            const match = prefs.match(/user_pref\("services\.sync\.username",\s*"([^"]+)"\)/);
            const email = validEmail(match?.[1]);
            if (email) return { email };
        } catch { /* ignore */ }
        return {};
    }

    let email: string | undefined;
    let label: string | undefined;
    try {
        const prefs = JSON.parse(await readFile(join(profilePath, 'Preferences'), 'utf8'));
        if (Array.isArray(prefs?.account_info)) {
            for (const entry of prefs.account_info) {
                email = validEmail(entry?.email);
                if (email) break;
            }
        }
        email ??= validEmail(prefs?.google?.services?.username)
            ?? validEmail(prefs?.google?.services?.last_username)
            ?? validEmail(prefs?.signin?.allowed_username);
        if (typeof prefs?.profile?.name === 'string' && prefs.profile.name.trim()) {
            label = prefs.profile.name.trim();
        }
    } catch { /* ignore */ }

    if (!email || !label) {
        try {
            const localState = JSON.parse(await readFile(join(root.path, 'Local State'), 'utf8'));
            const cached = localState?.profile?.info_cache?.[dirName];
            email ??= validEmail(cached?.user_name);
            if (!label && typeof cached?.name === 'string' && cached.name.trim()) {
                label = cached.name.trim();
            }
        } catch { /* ignore */ }
    }
    return { email, label };
}

async function checkYoutubeCookies(cookieDbPath: string, isFirefox: boolean): Promise<{ loggedIn: boolean; cookieEmail?: string }> {
    const tempDir = await mkdtemp(join(tmpdir(), 'zeta-cookies-'));
    const tempDb = join(tempDir, 'cookies.sqlite');
    try {
        await copyFile(cookieDbPath, tempDb);
        for (const suffix of ['-wal', '-shm']) {
            await copyFile(cookieDbPath + suffix, tempDb + suffix).catch(() => {});
        }
        const db = new DatabaseSync(tempDb, { open: true, readOnly: true });
        try {
            const placeholders = YT_AUTH_COOKIES.map(() => '?').join(', ');
            if (isFirefox) {
                const row = db.prepare(
                    `SELECT COUNT(*) AS cnt FROM moz_cookies WHERE (host LIKE '%youtube.com' OR baseDomain = 'youtube.com') AND name IN (${placeholders})`,
                ).get(...YT_AUTH_COOKIES) as { cnt?: number } | undefined;
                return { loggedIn: Number(row?.cnt ?? 0) > 0 };
            }
            const row = db.prepare(
                `SELECT COUNT(*) AS cnt FROM cookies WHERE host_key LIKE '%youtube.com' AND name IN (${placeholders})`,
            ).get(...YT_AUTH_COOKIES) as { cnt?: number } | undefined;
            return { loggedIn: Number(row?.cnt ?? 0) > 0 };
        } finally {
            db.close();
        }
    } catch {
        return { loggedIn: false };
    } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function profilesInRoot(root: BrowserRoot): Promise<BrowserProfile[]> {
    const children = await readdir(root.path, { withFileTypes: true }).catch(() => []);
    const directories = children
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .filter((entry) => root.extractor === 'firefox' || /^(Default|Profile \d+)$/.test(entry.name))
        .map((entry) => join(root.path, entry.name));
    if (root.extractor === 'opera') directories.push(root.path);

    const profiles = await Promise.all(directories.map(async (path) => {
        const candidates = root.extractor === 'firefox' ? ['cookies.sqlite'] : ['Network/Cookies', 'Cookies'];
        for (const candidate of candidates) {
            const cookiePath = join(path, candidate);
            const file = await stat(cookiePath).catch(() => null);
            if (!file?.isFile()) continue;
            const [{ loggedIn, cookieEmail }, account] = await Promise.all([
                checkYoutubeCookies(cookiePath, root.extractor === 'firefox'),
                readProfileAccount(root, path),
            ]);
            const rawName = basename(path);
            const displayName = account.label && account.label !== rawName
                ? `${account.label} (${rawName})`
                : rawName;
            return {
                id: createHash('sha256').update(root.browser + '\0' + path).digest('hex'),
                browser: root.browser,
                name: displayName,
                ytDlpSource: `${root.extractor}:${path}`,
                youtubeLoggedIn: loggedIn,
                email: account.email ?? cookieEmail,
            };
        }
        return null;
    }));
    return profiles.filter((profile) => profile !== null);
}

export async function findBrowserProfiles(): Promise<BrowserProfile[]> {
    const profiles = (await Promise.all(browserRoots().map(profilesInRoot))).flat();
    return [...new Map(profiles.map((profile) => [profile.id, profile])).values()]
        .sort((a, b) =>
            Number(b.youtubeLoggedIn) - Number(a.youtubeLoggedIn) ||
            a.browser.localeCompare(b.browser) ||
            a.name.localeCompare(b.name, undefined, { numeric: true }),
        );
}
