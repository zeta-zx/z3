/**
 * YouTube PoToken (Proof-of-Origin) minting.
 *
 * YouTube now gates its media CDN behind BotGuard: without a per-video PoToken
 * the `googlevideo.com/videoplayback` GET returns `403 Forbidden`, which surfaces
 * as youtubei.js `FETCH_FAILED`. The old `ANDROID_VR` client used to sidestep
 * this but is now blocked too, so every playback/download attempt fails.
 *
 * This module runs Google's BotGuard VM (via `bgutils-js` inside a `jsdom`
 * sandbox) to obtain an integrity token, then mints short-lived, content-bound
 * WebPO tokens keyed on a video id. The token is appended to the deciphered
 * stream URL as `&pot=` (see `music.ts`).
 *
 * The integrity token is cached and transparently refreshed when it nears its
 * TTL, so the expensive BotGuard handshake only happens occasionally.
 */

import { BotGuardClient } from 'bgutils-js/botguard';
import { buildURL, parseLooseJSON, getHeaders, USER_AGENT } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM, VirtualConsole } from 'jsdom';

const DEBUG = !!process.env.ZETA_DEBUG;
function log(...args: any[]) {
    if (DEBUG) console.log('[potoken]', ...args);
}

// Public request key used by YouTube's web player for the WebPO flow.
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

interface MinterState {
    minter: WebPoMinter;
    // Wall-clock ms after which the integrity token should be refreshed.
    expiresAt: number;
}

let current: MinterState | null = null;
let pending: Promise<MinterState> | null = null;

/**
 * Run the full BotGuard handshake and build a {@link WebPoMinter}.
 *
 * Steps mirror YouTube's web player: load the page to grab the BotGuard
 * challenge + interpreter, execute the interpreter to expose the VM, snapshot it
 * to get a BotGuard response, exchange that for an integrity token, and hand the
 * token to the WebPO minter.
 */
async function createMinter(): Promise<MinterState> {
    // BotGuard pokes at browser APIs jsdom doesn't implement (e.g. canvas
    // fingerprinting); those failures are expected and harmless, so keep the
    // virtual console quiet unless debugging.
    const virtualConsole = new VirtualConsole();
    if (DEBUG) virtualConsole.on('jsdomError', (err) => log('jsdom:', err?.message ?? err));

    const dom = new JSDOM(
        '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
        { url: 'https://www.youtube.com', referrer: 'https://www.youtube.com/', virtualConsole },
    );

    const pageHtml = await (
        await fetch('https://www.youtube.com', {
            headers: { accept: '*/*', 'accept-language': 'en-US,en;q=0.7', 'user-agent': USER_AGENT },
        })
    ).text();

    const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
    if (!ytConfig) throw new Error('PoToken: could not find ytcfg in YouTube page');

    // BotGuard's interpreter expects a browser-like global environment.
    (dom.window as any).yt = { config_: JSON.parse(ytConfig) };
    Object.assign(globalThis, {
        yt: (dom.window as any).yt,
        window: dom.window,
        document: dom.window.document,
        location: dom.window.location,
        origin: dom.window.origin,
    });
    if (!('navigator' in globalThis)) {
        Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
    }

    const initial = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
    if (!initial) throw new Error('PoToken: could not find BotGuard challenge in YouTube page');

    const challengeResponse = parseLooseJSON(initial[1]).R;
    if (!challengeResponse?.bgChallenge) throw new Error('PoToken: challenge response missing bgChallenge');

    const interpreterUrl =
        challengeResponse.bgChallenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    const interpreterJavascript = await (await fetch(`https:${interpreterUrl}`)).text();
    if (!interpreterJavascript) throw new Error('PoToken: failed to load BotGuard interpreter');
    // eslint-disable-next-line no-new-func
    new Function(interpreterJavascript)();

    const botGuardClient = await BotGuardClient.create({
        program: challengeResponse.bgChallenge.program,
        globalName: challengeResponse.bgChallenge.globalName,
        globalObject: globalThis,
    });

    const webPoSignalOutput: any[] = [];
    const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

    const integrityRes = await fetch(buildURL('GenerateIT', true), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify([REQUEST_KEY, botguardResponse]),
    });
    const integrityJson = (await integrityRes.json()) as [string, number, number, string];
    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = integrityJson;
    if (!integrityToken) throw new Error('PoToken: WAA server did not return an integrity token');

    const minter = await WebPoMinter.create(
        { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
        webPoSignalOutput,
    );

    // Refresh a minute before the server's estimate to avoid using a stale token.
    const ttlMs = Math.max(60, (estimatedTtlSecs || 3600) - 60) * 1000;
    log(`minted integrity token, valid ~${Math.round(ttlMs / 1000)}s`);
    return { minter, expiresAt: Date.now() + ttlMs };
}

/** Get a valid minter, (re)building the integrity token when needed. */
async function getMinter(): Promise<WebPoMinter> {
    if (current && Date.now() < current.expiresAt) return current.minter;
    if (!pending) {
        pending = createMinter()
            .then((state) => {
                current = state;
                return state;
            })
            .finally(() => {
                pending = null;
            });
    }
    return (await pending).minter;
}

/**
 * Mint a content-bound PoToken for a YouTube video id.
 *
 * Append the result to a deciphered stream URL as `&pot=<token>` to satisfy
 * BotGuard on the media CDN.
 */
export async function mintPoToken(videoId: string): Promise<string> {
    const minter = await getMinter();
    try {
        return await minter.mintAsWebsafeString(videoId);
    } catch (err) {
        // A minting failure usually means the integrity token went stale early;
        // rebuild once and retry before giving up.
        log('mint failed, rebuilding minter:', err);
        current = null;
        const fresh = await getMinter();
        return fresh.mintAsWebsafeString(videoId);
    }
}
