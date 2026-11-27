import { once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';
import {
    DISCORD_VOICE_BUFFER_LIMIT, DISCORD_VOICE_PATH, DISCORD_VOICE_PORT, voiceProof,
} from '../src/lib/discord-voice-relay.ts';

export async function openAudioRelay({ relayId, key }, onEnded, port = DISCORD_VOICE_PORT) {
    const stream = new PassThrough();
    const server = new WebSocketServer({
        host: '127.0.0.1', port, path: DISCORD_VOICE_PATH + relayId,
        perMessageDeflate: false, maxPayload: DISCORD_VOICE_BUFFER_LIMIT,
    });
    let source = null;
    let closed = false;

    function close() {
        if (closed) return;
        closed = true;
        stream.end();
        for (const socket of server.clients) socket.close(1000);
        server.close();
    }

    server.on('connection', async (socket) => {
        const challenge = randomBytes(16).toString('hex');
        let authenticated = false;
        const timeout = setTimeout(() => socket.close(1008), 5000);
        socket.on('error', () => socket.terminate());
        socket.once('close', () => {
            clearTimeout(timeout);
            if (source === socket && !closed) {
                close();
                onEnded();
            }
        });

        try {
            const [proof, expected] = await Promise.all([
                voiceProof(key, relayId, challenge, 'bot'),
                voiceProof(key, relayId, challenge, 'app'),
            ]);
            if (socket.readyState !== socket.OPEN) return;

            socket.on('message', (data, binary) => {
                if (!authenticated) {
                    if (binary || source || data.length !== expected.length ||
                        !timingSafeEqual(data, Buffer.from(expected))) {
                        socket.close(1008);
                        return;
                    }
                    source = socket;
                    authenticated = true;
                    clearTimeout(timeout);
                    socket.send('ready');
                    return;
                }

                if (!binary || stream.writableLength + stream.readableLength + data.length > DISCORD_VOICE_BUFFER_LIMIT) {
                    socket.close(1008);
                    return;
                }
                stream.write(data);
            });
            socket.send(JSON.stringify({ challenge, proof }));
        } catch {
            socket.close(1011);
        }
    });
    try {
        await once(server, 'listening');
    } catch (error) {
        close();
        throw error;
    }
    server.on('error', () => {
        close();
        onEnded();
    });

    return {
        stream, close,
        get connected() { return !closed && source !== null; },
        port: server.address().port,
    };
}
