import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BotError } from './wayship.mjs';
import { DISCORD_ACTIVITY_COVER_LIMIT, DISCORD_QUERY_LIMIT } from '../src/lib/wayship-discord.ts';

const LINK_LIFETIME = 3 * 60_000;
const SESSION_LIFETIME = 6 * 60 * 60_000;
const POLL_INTERVAL = 6500;
const MAX_SESSIONS = 256;
const TRANSPORT = new Set(['play', 'playnext', 'pause', 'unpause', 'skip', 'previous']);

function prune(sessions) {
    const now = Date.now();
    for (const [ticket, session] of sessions) {
        if (session.expires <= now) sessions.delete(ticket);
    }
}

async function readSmallJson(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 2048) throw new BotError('The Activity request is too large.');
    }
    try { return JSON.parse(body); }
    catch { throw new BotError('Invalid Activity request.'); }
}

function send(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
}

function sendSnapshot(response, snapshot) {
    if (snapshot.status !== 200) return send(response, snapshot.status, snapshot.data);
    const ageAtReceipt = snapshot.received - snapshot.data.sampledAt;
    // A phone's clock can disagree with the bot host. Use the app's sample
    // when the offset is plausible, with receipt time as the fallback.
    const age = ageAtReceipt >= 0 && ageAtReceipt <= 5000 ? ageAtReceipt : 0;
    send(response, 200, { ...snapshot.data, ageMs: age + Math.max(0, Date.now() - snapshot.received) });
}

export function zetaActivity({ accounts, wayship, voice }) {
    const sessions = new Map();

    function link(code, owner) {
        prune(sessions);
        const session = [...sessions.values()].find((entry) => !entry.owner && entry.code === code.trim().toUpperCase());
        if (!session) throw new BotError('That Activity code expired or has already been used.');
        if (!accounts.get(owner).wayship?.token) throw new BotError('Link your Wayship account with /wayship first.');
        for (const [ticket, entry] of sessions) if (entry.owner === owner) sessions.delete(ticket);
        session.owner = owner;
        session.expires = Date.now() + SESSION_LIFETIME;
    }

    function linkedSession(request, response) {
        prune(sessions);
        const ticket = /^Bearer ([a-f0-9]{48})$/.exec(request.headers.authorization ?? '')?.[1];
        const session = sessions.get(ticket);
        if (!session) {
            send(response, 401, { error: 'Open a new Activity code to reconnect.' });
            return null;
        }
        return session;
    }

    async function player(request, response) {
        const session = linkedSession(request, response);
        if (!session) return;
        const token = session.owner && accounts.get(session.owner).wayship?.token;
        if (!token) {
            send(response, 403, { error: 'Connect your Discord account to Wayship first.' });
            return;
        }

        const device = voice?.deviceForOwner(session.owner);
        if (request.method === 'GET') {
            if (session.updated && Date.now() - session.updated < POLL_INTERVAL) {
                sendSnapshot(response, session.snapshot);
                return;
            }
            if (!session.loading) {
                session.loading = wayship.run(token, { action: 'status' }, device)
                    .then(({ id, name, result }) => ({
                        status: 200, received: Date.now(), deviceId: id, data: { device: name, ...result.playback },
                    }))
                    .catch((error) => ({
                        status: 503,
                        data: { error: error instanceof BotError ? error.message : 'Could not reach the Zeta player.' },
                    })).then((snapshot) => {
                        session.snapshot = snapshot;
                        session.updated = Date.now();
                        return snapshot;
                    }).finally(() => { session.loading = null; });
            }
            sendSnapshot(response, await session.loading);
            return;
        }

        if (session.controlling || Date.now() < (session.controlAt ?? 0)) {
            send(response, 429, { error: 'Wait for the current player command to finish.' });
            return;
        }
        const body = await readSmallJson(request);
        const action = body?.action;
        const query = typeof body?.query === 'string' ? body.query.trim() : '';
        if (!TRANSPORT.has(action) || query.length > DISCORD_QUERY_LIMIT ||
            (['play', 'playnext'].includes(action) && !query)) {
            throw new BotError('Choose a supported player action and enter a song when needed.');
        }
        if (session.controlling) {
            send(response, 429, { error: 'Wait for the current player command to finish.' });
            return;
        }
        session.controlling = true;
        session.controlAt = Date.now() + 1000;
        try {
            const { result } = await wayship.run(token, { action, ...(query && { query }) }, device);
            if (session.loading) await session.loading;
            session.updated = 0;
            send(response, 200, { track: result.track });
        } finally {
            session.controlling = false;
        }
    }

    async function media(request, response, trackKey) {
        const session = linkedSession(request, response);
        if (!session) return;
        const token = session.owner && accounts.get(session.owner).wayship?.token;
        if (!token) return send(response, 403, { error: 'Connect your Discord account to Wayship first.' });

        const snapshot = session.snapshot;
        if (!trackKey || snapshot?.status !== 200 || snapshot.data.trackKey !== trackKey) {
            return send(response, 409, { error: 'The current track changed.' });
        }

        if (session.media?.trackKey !== trackKey) session.media = { trackKey };
        const entry = session.media;
        if (entry.result && (!entry.result.pending || Date.now() - entry.updated < POLL_INTERVAL)) {
            return send(response, 200, entry.result);
        }
        if (!entry.loading) {
            entry.loading = wayship.run(token, { action: 'activity-media', trackKey }, snapshot.deviceId)
                .then(({ result }) => {
                    const data = result.activityMedia;
                    if (data?.trackKey !== trackKey) throw new BotError('Zeta did not return track media.');
                    const cover = typeof data.cover === 'string' && data.cover.length <= DISCORD_ACTIVITY_COVER_LIMIT &&
                        /^data:image\/jpeg;base64,[a-z0-9+/]+={0,2}$/i.test(data.cover) ? data.cover : null;
                    entry.result = { trackKey, cover, lyrics: typeof data.lyrics === 'string' ? data.lyrics : null, pending: !!data.pending };
                    entry.updated = Date.now();
                    return entry.result;
                }).finally(() => { entry.loading = null; });
        }
        const result = await entry.loading;
        if (session.snapshot?.data?.trackKey !== trackKey) {
            return send(response, 409, { error: 'The current track changed.' });
        }
        send(response, 200, result);
    }

    async function start(applicationId, port) {
        const assets = new Map(await Promise.all([
            ['/', 'text/html; charset=utf-8', './activity/index.html'],
            ['/style.css', 'text/css; charset=utf-8', './activity/style.css'],
            ['/activity.js', 'text/javascript; charset=utf-8', './.activity-dist/activity.js'],
            ['/zeta.png', 'image/png', '../static/zeta.png'],
        ].map(async ([url, contentType, file]) => [
            url, { contentType, data: await readFile(new URL(file, import.meta.url)) },
        ])));

        const server = createServer(async (request, response) => {
            try {
                const url = new URL(request.url, 'http://127.0.0.1');
                const path = url.pathname;
                const { method } = request;
                const asset = (method === 'GET' || method === 'HEAD') && assets.get(path);
                if (asset) {
                    response.writeHead(200, {
                        'Content-Type': asset.contentType,
                        'Cache-Control': 'no-store',
                        'X-Content-Type-Options': 'nosniff',
                        'Referrer-Policy': 'no-referrer',
                    });
                    response.end(method === 'HEAD' ? undefined : asset.data);
                } else if (method === 'GET' && path === '/api/config') {
                    send(response, 200, { applicationId });
                } else if (method === 'POST' && path === '/api/link') {
                    prune(sessions);
                    if (sessions.size >= MAX_SESSIONS) {
                        send(response, 429, { error: 'Too many open Activities. Try again in a few minutes.' });
                        return;
                    }
                    const ticket = randomBytes(24).toString('hex');
                    let code;
                    do {
                        code = randomBytes(4).toString('hex').toUpperCase();
                    } while ([...sessions.values()].some((session) => session.code === code));
                    sessions.set(ticket, { code, expires: Date.now() + LINK_LIFETIME });
                    send(response, 201, { ticket, code });
                } else if (method === 'GET' && path === '/api/link') {
                    const session = linkedSession(request, response);
                    if (session) send(response, 200, { linked: !!session.owner, code: session.owner ? undefined : session.code });
                } else if (method === 'DELETE' && path === '/api/link') {
                    const ticket = /^Bearer ([a-f0-9]{48})$/.exec(request.headers.authorization ?? '')?.[1];
                    sessions.delete(ticket);
                    send(response, 200, { ok: true });
                } else if (path === '/api/player' && (method === 'GET' || method === 'POST')) {
                    await player(request, response);
                } else if (method === 'GET' && path === '/api/media') {
                    await media(request, response, url.searchParams.get('track'));
                } else {
                    send(response, 404, { error: 'Activity page not found.' });
                }
            } catch (error) {
                const expected = error instanceof BotError;
                send(response, expected ? 400 : 500, { error: expected ? error.message : 'Zeta could not complete the Activity request.' });
            }
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', resolve);
        });
        return server;
    }

    return { link, start };
}
