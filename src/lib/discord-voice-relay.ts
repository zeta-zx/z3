export const DISCORD_VOICE_PORT = 32127;
export const DISCORD_VOICE_PATH = '/zeta-voice/';
export const DISCORD_VOICE_BUFFER_LIMIT = 256 * 1024;

export async function voiceProof(key: string, relayId: string, challenge: string, role: 'app' | 'bot') {
    const encoder = new TextEncoder();
    const signingKey = await crypto.subtle.importKey(
        'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(`zeta-voice/${role}/${relayId}/${challenge}`));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
