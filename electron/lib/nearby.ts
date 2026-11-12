import { execFile } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { DISCOVERY_PORT, INVITE_LIFETIME, isNearbyAddress, isTailscaleAddress, PAIRING_PACKET_LIMIT } from '../../src/lib/nearby-pairing';

const execFileAsync = promisify(execFile);

type Listener = { socket: Socket; discovery?: Socket; packets: string[]; timer: ReturnType<typeof setTimeout> };
let listener: Listener | undefined;
let tailscaleCache: { expires: number; peers: string[] } | null = null;

function close() {
    const current = listener;
    listener = undefined;
    if (current) {
        clearTimeout(current.timer);
        current.socket.close();
        try { current.discovery?.close(); } catch { /* ignore */ }
    }
}

function subnetBroadcast(address: string, netmask: string): string | null {
    const ip = address.split('.').map(Number);
    const mask = netmask.split('.').map(Number);
    if (ip.length !== 4 || mask.length !== 4 || ip.some((n) => !Number.isInteger(n)) || mask.some((n) => !Number.isInteger(n))) {
        return null;
    }
    return ip.map((octet, i) => (octet | (~mask[i] & 0xff))).join('.');
}

async function getTailscalePeerIps(): Promise<string[]> {
    if (tailscaleCache && Date.now() < tailscaleCache.expires) return tailscaleCache.peers;
    const peers: string[] = [];
    const bins = process.platform === 'darwin'
        ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
        : ['tailscale'];
    for (const bin of bins) {
        try {
            const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 1500, windowsHide: true });
            const parsed = JSON.parse(stdout);
            for (const peer of Object.values(parsed?.Peer ?? {}) as any[]) {
                if (peer?.Online === false) continue;
                for (const ip of peer?.TailscaleIPs ?? []) {
                    if (typeof ip === 'string' && isTailscaleAddress(ip)) peers.push(ip);
                }
            }
            break;
        } catch { /* tailscale CLI not running or unavailable */ }
    }
    tailscaleCache = { expires: Date.now() + 15_000, peers: [...new Set(peers)].slice(0, 24) };
    return tailscaleCache.peers;
}

export const nearbyRoutes = {
    async nearbyListen() {
        close();
        const addresses = [...new Set(Object.values(networkInterfaces()).flatMap((entries) =>
            (entries ?? []).filter(({ family, address }) => family === 'IPv4' && isNearbyAddress(address)).map(({ address }) => address),
        ))].slice(0, 12);
        if (!addresses.length) throw new Error('Connect this device to a local network or Tailscale to pair.');
        const socket = createSocket('udp4');
        await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.bind(0, '0.0.0.0', () => {
                socket.removeListener('error', reject);
                resolve();
            });
        }).catch((error) => { socket.close(); throw error; });

        let discovery: Socket | undefined;
        try {
            const disc = createSocket({ type: 'udp4', reuseAddr: true });
            await new Promise<void>((resolve, reject) => {
                disc.once('error', reject);
                disc.bind(DISCOVERY_PORT, '0.0.0.0', () => {
                    disc.removeListener('error', reject);
                    try { disc.setBroadcast(true); } catch { /* ignore */ }
                    resolve();
                });
            });
            discovery = disc;
        } catch {
            /* discovery port may already be bound by another instance on the same host */
        }

        const current: Listener = { socket, discovery, packets: [], timer: setTimeout(close, INVITE_LIFETIME) };
        listener = current;
        const onPacket = (packet: Buffer, remote: { address: string }) => {
            if (packet.length <= PAIRING_PACKET_LIMIT && isNearbyAddress(remote.address) && current.packets.length < 32) {
                current.packets.push(packet.toString('ascii'));
            }
        };
        socket.on('error', () => { if (listener === current) close(); });
        socket.on('message', onPacket);
        discovery?.on('error', () => {});
        discovery?.on('message', onPacket);
        return { addresses, port: socket.address().port };
    },
    async nearbyReceive(): Promise<string[]> { return listener?.packets.splice(0) ?? []; },
    async nearbyClose(): Promise<void> { close(); },
    async nearbySend(addresses: string[], port: number, packet: string): Promise<void> {
        const isDiscovery = port === DISCOVERY_PORT;
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Array.isArray(addresses) ||
            (!isDiscovery && (!addresses.length || addresses.length > 12 || addresses.some((ip) => typeof ip !== 'string' || !isNearbyAddress(ip)))) ||
            typeof packet !== 'string' || packet.length > PAIRING_PACKET_LIMIT || !/^[\w.:,-]+$/.test(packet)) {
            throw new Error('Invalid nearby pairing destination.');
        }
        const targets = new Set<string>(addresses.filter((ip) => typeof ip === 'string' && isNearbyAddress(ip)));
        if (isDiscovery) {
            targets.add('255.255.255.255');
            for (const entries of Object.values(networkInterfaces())) {
                for (const entry of entries ?? []) {
                    if (entry.family === 'IPv4' && isNearbyAddress(entry.address) && !isTailscaleAddress(entry.address)) {
                        const bcast = subnetBroadcast(entry.address, entry.netmask);
                        if (bcast) targets.add(bcast);
                    }
                }
            }
            for (const peerIp of await getTailscalePeerIps()) targets.add(peerIp);
        }
        const socket = createSocket('udp4');
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject);
                socket.bind(0, '0.0.0.0', () => {
                    socket.removeListener('error', reject);
                    if (isDiscovery) {
                        try { socket.setBroadcast(true); } catch { /* ignore */ }
                    }
                    resolve();
                });
            });
            await Promise.all([...targets].map((address) => new Promise<void>((resolve) => {
                socket.send(packet, port, address, () => resolve());
            })));
        } finally { socket.close(); }
    },
};
