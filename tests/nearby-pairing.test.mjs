import test from 'node:test';
import assert from 'node:assert/strict';
import { isNearbyAddress, isTailscaleAddress, makeNearbyInvite, openNearbyAnswer, readNearbyInvite, sealNearbyAnswer } from '../src/lib/nearby-pairing.ts';

test('one invitation authenticates the automatic reply', async () => {
    const endpoint = { addresses: ['192.168.1.10', '10.0.0.8', '100.92.41.15'], port: 5000 };
    const offer = 'zeta-peer:1:offer';
    const answer = 'zeta-peer:1:answer';
    const invite = makeNearbyInvite(endpoint, offer);
    assert.deepEqual(readNearbyInvite(invite.code), { ...endpoint, offer, secret: invite.secret });
    const reply = await sealNearbyAnswer(invite.secret, answer);
    assert.equal(await openNearbyAnswer(invite.secret, reply), answer);
    await assert.rejects(openNearbyAnswer(makeNearbyInvite(endpoint, offer).secret, reply));
    assert.throws(() => readNearbyInvite(invite.code.replace(endpoint.addresses[0], '8.8.8.8')), /invalid/i);
});

test('accepts Tailscale CGNAT 100.64.0.0/10 addresses and rejects public IPs', () => {
    assert.equal(isTailscaleAddress('100.64.0.1'), true);
    assert.equal(isTailscaleAddress('100.127.255.254'), true);
    assert.equal(isTailscaleAddress('100.128.0.1'), false);
    assert.equal(isNearbyAddress('100.101.102.103'), true);
    assert.equal(isNearbyAddress('8.8.8.8'), false);
});
