import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextWayshipRetry, WayshipSignalInbox } from '../src/lib/wayship-recovery.ts';

test('a duplicate WebRTC offer or answer only gets through once', () => {
    const inbox = new WayshipSignalInbox();
    const offer = { sdp: 'first-offer' };
    assert.equal(inbox.accept('phone', 'offer', offer, 1000), true);
    assert.equal(inbox.accept('phone', 'offer', { ...offer }, 1001), false);
    assert.equal(inbox.accept('desktop', 'offer', offer, 1001), true);
    assert.equal(inbox.accept('phone', 'offer', { sdp: 'new-offer' }, 1001), true);
    assert.equal(inbox.accept('phone', 'answer', offer, 1001), true);
    assert.equal(inbox.accept('phone', 'answer', offer, 1002), false);
    assert.equal(inbox.accept('phone', 'offer', offer, 61_000), true);
});

test('a Wayship reconnect starts quickly and caps the retry delay', () => {
    let delay = 0;
    const timeline = Array.from({ length: 8 }, () => (delay = nextWayshipRetry(delay)));
    assert.deepEqual(timeline, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});
