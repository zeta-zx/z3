import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discordOpusFrames } from './discord-opus.mjs';

test('splits a Chromium 60 ms packet into three original stereo 20 ms frames without decoding', () => {
    const frames = [Buffer.alloc(319, 0x11), Buffer.alloc(319, 0x22), Buffer.alloc(319, 0x33)];
    const packet = Buffer.concat([Buffer.from([0xff, 3]), ...frames]);
    assert.deepEqual(discordOpusFrames(packet), frames.map((frame) => Buffer.concat([Buffer.from([0xfc]), frame])));
});

test('handles variable-length frames and Opus padding', () => {
    const first = Buffer.alloc(253, 0x65);
    const next = Buffer.from([11, 22]);
    const packet = Buffer.concat([Buffer.from([0xff, 0xc2, 2, 253, 0]), first, next, Buffer.alloc(2)]);
    assert.deepEqual(discordOpusFrames(packet), [
        Buffer.concat([Buffer.from([0xfc]), first]),
        Buffer.concat([Buffer.from([0xfc]), next]),
    ]);
});

test('leaves one 20 ms packet intact and rejects truncated or unsupported framing', () => {
    const packet = Buffer.from([0xfc, 62]);
    assert.equal(discordOpusFrames(packet)[0], packet);
    assert.throws(() => discordOpusFrames(Buffer.from([0xff, 0xc2, 255])), /padding/);
    assert.throws(() => discordOpusFrames(Buffer.from([0xff, 3, 0])), /length/);
    assert.throws(() => discordOpusFrames(Buffer.from([0xf0, 0])), /20 ms/);
});
