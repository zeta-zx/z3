import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zetaActivity } from './activity-server.mjs';

test('Activity serves the Zeta UI and only forwards controls for a linked Discord account', async (context) => {
    const calls = [];
    const trackKey = '3cedecda-5e81-40c5-aab7-c81ed2efbaf3';
    const activity = zetaActivity({
        accounts: { get: (owner) => owner === '123' ? { wayship: { token: 'private-wayship-token' } } : {} },
        voice: { deviceForOwner: () => 'desktop-id' },
        wayship: { run: async (credential, command, device) => {
            calls.push({ credential, command, device });
            if (command.action === 'activity-media') {
                return { result: { activityMedia: {
                    trackKey, lyrics: '[00:04.50]Test line', cover: 'data:image/jpeg;base64,/9j/AA==', pending: false,
                } } };
            }
            return { id: 'desktop-id', name: 'Desktop', result: { playback: {
                phase: 'playing', trackKey, sampledAt: Date.now() - 500, track: { title: 'Local track' }, queue: [],
            } } };
        } },
    });
    const server = await activity.start('456', 0);
    context.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.match(await (await fetch(base)).text(), /Now playing/);
    assert.equal((await fetch(base + '/activity.js')).status, 200);
    const { ticket, code } = await (await fetch(base + '/api/link', { method: 'POST' })).json();
    const headers = { Authorization: `Bearer ${ticket}`, 'Content-Type': 'application/json' };
    const player = (options = {}) => fetch(base + '/api/player', { headers, ...options });
    const media = (key = trackKey) => fetch(`${base}/api/media?track=${key}`, { headers });

    assert.equal((await player()).status, 403);
    assert.equal((await media()).status, 403);
    assert.equal((await fetch(base + '/api/player')).status, 401);
    assert.throws(() => activity.link(code, '456'), /Wayship/);
    activity.link(code, '123');
    assert.throws(() => activity.link(code, '123'), /used/);
    const first = await (await player()).json();
    assert.deepEqual(first.track, { title: 'Local track' });
    assert.equal(first.device, 'Desktop');
    assert.ok(first.ageMs >= 500);
    assert.ok(!JSON.stringify(first).includes('private-wayship-token'));
    await player();
    assert.equal(calls.length, 1);
    assert.equal((await media('stale-track')).status, 409);
    const nowPlayingMedia = await (await media()).json();
    assert.match(nowPlayingMedia.lyrics, /\[00:04.50\]/);
    assert.equal(nowPlayingMedia.cover, 'data:image/jpeg;base64,/9j/AA==');
    assert.deepEqual(calls.at(-1), {
        credential: 'private-wayship-token', command: { action: 'activity-media', trackKey }, device: 'desktop-id',
    });
    await media();
    assert.equal(calls.length, 2);

    assert.equal((await player({ method: 'POST', body: JSON.stringify({ action: 'voice-start' }) })).status, 400);
    await player({ method: 'POST', body: JSON.stringify({ action: 'play', query: 'From Activity' }) });
    assert.deepEqual(calls.at(-1), {
        credential: 'private-wayship-token', command: { action: 'play', query: 'From Activity' }, device: 'desktop-id',
    });

    await fetch(base + '/api/link', { method: 'DELETE', headers });
    assert.equal((await player()).status, 401);
    assert.equal((await media()).status, 401);
});
