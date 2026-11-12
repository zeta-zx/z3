const PREFIX = 'zeta-peer:2:';
export const PAIRING_PACKET_LIMIT = 16_384;
export const INVITE_LIFETIME = 120_000;
export const DISCOVERY_PORT = 42534;

export function isTailscaleAddress(address: string): boolean {
    const parts = address.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
    const [first, second] = parts.map(Number);
    // Tailscale uses the RFC 6598 CGNAT range 100.64.0.0/10.
    return first === 100 && second >= 64 && second <= 127;
}

export function isNearbyAddress(address: string): boolean {
    const parts = address.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
    const [first, second] = parts.map(Number);
    return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) || (first === 169 && second === 254) ||
        (first === 100 && second >= 64 && second <= 127);
}

function base64(bytes: Uint8Array) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64(value: string) {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}

export interface NearbyEndpoint { addresses: string[]; port: number }

export function makeNearbyInvite(endpoint: NearbyEndpoint, offer: string) {
    const secret = base64(crypto.getRandomValues(new Uint8Array(32)));
    const code = PREFIX + [endpoint.addresses.join(','), endpoint.port, secret, offer.slice('zeta-peer:1:'.length)].join(':');
    return { code, secret };
}

export function readNearbyInvite(code: string) {
    const value = code.trim();
    if (!value.startsWith(PREFIX) || value.length > PAIRING_PACKET_LIMIT) throw new Error('Use a nearby invitation from Zeta 0.5.3 or newer.');
    const [hosts, rawPort, secret, offer, extra] = value.slice(PREFIX.length).split(':');
    const addresses = hosts.split(',');
    const port = Number(rawPort);
    if (extra !== undefined || addresses.length > 12 || addresses.some((address) => !isNearbyAddress(address)) ||
        !/^\d{4,5}$/.test(rawPort) || port < 1024 || port > 65535 ||
        !/^[\w-]{43}$/.test(secret) || !/^[\w-]+$/.test(offer)) throw new Error('This Zeta invitation is invalid.');
    return { addresses, port, secret, offer: 'zeta-peer:1:' + offer };
}

async function answerKey(secret: string) {
    return crypto.subtle.importKey('raw', unbase64(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealNearbyAnswer(secret: string, answer: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await answerKey(secret), new TextEncoder().encode(answer));
    const packet = base64(iv) + '.' + base64(new Uint8Array(ciphertext));
    if (packet.length > PAIRING_PACKET_LIMIT) throw new Error('This network has too many addresses for pairing.');
    return packet;
}

export async function openNearbyAnswer(secret: string, packet: string) {
    if (packet.length > PAIRING_PACKET_LIMIT || !/^[\w-]{16}\.[\w-]+$/.test(packet)) throw new Error('Invalid pairing reply.');
    const [nonce, body] = packet.split('.');
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(nonce) }, await answerKey(secret), unbase64(body));
    return new TextDecoder().decode(data);
}
