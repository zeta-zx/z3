import { pipeline, Transform } from 'node:stream';
import prism from 'prism-media';

const FRAME_SIZE_MS = 20;
const STARTUP_BUFFER_FRAMES = 12;

export function discordOpusFrames(packet) {
    if (!packet.length) throw new Error('Empty Opus packet.');
    const header = packet[0];
    const config = header >> 3;
    const duration = config < 12 ? [10, 20, 40, 60][config % 4]
        : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
    if (duration !== FRAME_SIZE_MS) throw new Error('Zeta audio must use 20 ms Opus frames.');

    const code = header & 3;
    if (code === 0) return [packet];

    // RFC 6716's packet framing can group multiple independently encoded
    // frames under one TOC header. Give each frame its own header for Discord.
    let cursor = 1;
    let end = packet.length;
    let count = 2;
    let variable = code === 2;
    if (code === 3) {
        const flags = packet[cursor++];
        count = flags & 63;
        variable = (flags & 128) !== 0;
        if (!count || count > 6) throw new Error('Invalid Opus frame count.');
        if (flags & 64) {
            let size = 255;
            while (size === 255 && cursor < end) {
                size = packet[cursor++];
                end -= size === 255 ? 254 : size;
            }
            if (size === 255 || end < cursor) throw new Error('Invalid Opus packet padding.');
        }
    }

    const sizes = [];
    if (variable) {
        for (let i = 1; i < count; i++) {
            if (cursor >= end) throw new Error('Missing Opus frame length.');
            const size = packet[cursor++];
            if (size >= 252 && cursor >= end) throw new Error('Incomplete Opus frame length.');
            sizes.push(size < 252 ? size : size + 4 * packet[cursor++]);
        }
        sizes.push(end - cursor - sizes.reduce((sum, size) => sum + size, 0));
    } else {
        sizes.push(...Array(count).fill((end - cursor) / count));
    }

    return sizes.map((size) => {
        if (!Number.isInteger(size) || size < 0 || size > 1275 || cursor + size > end) {
            throw new Error('Invalid Opus frame length.');
        }
        const frame = Buffer.allocUnsafe(size + 1);
        frame[0] = header & 252;
        packet.copy(frame, 1, cursor, cursor + size);
        cursor += size;
        return frame;
    });
}

export function createDiscordOpusStream(input, start, onError) {
    let ready = false;
    const output = new Transform({
        objectMode: true,
        transform(packet, _encoding, callback) {
            try {
                for (const frame of discordOpusFrames(packet)) this.push(frame);
                if (!ready && this.readableLength >= STARTUP_BUFFER_FRAMES) {
                    ready = true;
                    queueMicrotask(() => { if (!output.destroyed) start(output); });
                }
                callback();
            } catch (error) {
                callback(error);
            }
        },
    });
    pipeline(input, new prism.opus.WebmDemuxer(), output, (error) => { if (error) onError(error); });
    return output;
}
