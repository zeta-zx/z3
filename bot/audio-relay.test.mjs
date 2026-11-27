import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { DISCORD_VOICE_PATH, voiceProof } from '../src/lib/discord-voice-relay.ts';
import { openAudioRelay } from './audio-relay.mjs';

test('audio only enters the relay after both ends authenticate', { timeout: 3000 }, async () => {
    const relayId = randomBytes(16).toString('hex');
    const key = randomBytes(32).toString('hex');
    let finish;
    const ended = new Promise((resolve) => { finish = resolve; });
    const relay = await openAudioRelay({ relayId, key }, finish, 0);
    const url = `ws://127.0.0.1:${relay.port}${DISCORD_VOICE_PATH}${relayId}`;
    let socket;
    try {
        const stranger = new WebSocket(url);
        await once(stranger, 'message');
        stranger.send('0'.repeat(64));
        assert.equal((await once(stranger, 'close'))[0], 1008);
        assert.equal(relay.connected, false);

        socket = new WebSocket(url);
        const [handshake] = await once(socket, 'message');
        const { challenge, proof } = JSON.parse(handshake);
        assert.equal(proof, await voiceProof(key, relayId, challenge, 'bot'));
        socket.send(await voiceProof(key, relayId, challenge, 'app'));
        assert.equal((await once(socket, 'message'))[0].toString(), 'ready');
        assert.equal(relay.connected, true);

        const received = once(relay.stream, 'data');
        const audio = Buffer.from([1, 2, 3]);
        socket.send(audio);
        assert.deepEqual((await received)[0], audio);
        socket.close();
        await ended;
        assert.equal(relay.connected, false);
    } finally {
        socket?.terminate();
        relay.close();
    }
});
