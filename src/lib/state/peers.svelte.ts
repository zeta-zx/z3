import { client } from '$lib/ephaptic';
import { DISCOVERY_PORT, INVITE_LIFETIME, makeNearbyInvite, openNearbyAnswer, readNearbyInvite, sealNearbyAnswer } from '$lib/nearby-pairing';
import { createPeer, decodeSignal, acceptPeer, sendPeerBytes, type PeerMode } from '$lib/peer-connection';
import { addToQueue, nextTrack, previousTrack, playerState, playTrack, setVolume, togglePlay } from './player.svelte';
import { libraryState } from './library.svelte';
import { settingsState } from './settings.svelte';
import { ui } from './ui.svelte';
import { toasts } from './toast.svelte';
import { BACKUP_AUDIO_LIMIT_MESSAGE, MAX_BACKUP_BYTES } from '$lib/zeta-backup';
import type { Song } from '$lib/schema';

type Command = 'toggle' | 'next' | 'previous' | 'seek' | 'volume';
type RemotePlayback = { song: Song | null; paused: boolean; position: number; duration: number; volume: number; queue: string[] };
type Link = {
    id: string;
    mode: PeerMode;
    peer: RTCPeerConnection;
    channel?: RTCDataChannel;
    host: boolean;
    connected: boolean;
    backupAudio?: boolean;
    wayshipPeerId?: string;
    deviceName?: string;
    connectTimeout?: ReturnType<typeof setTimeout>;
};
type IncomingBackup = { id: string; bytes: Uint8Array; offset: number; digest: string; silentSync?: boolean };

function wireSong(input: unknown, remote = false): Song | null {
    const song = input as Song | null;
    if (!song || typeof song.id !== 'string' || typeof song.title !== 'string' || !Array.isArray(song.artists)) return null;
    if (remote && !/^yt:[\w-]{11}$|^js:[\w-]{1,64}$/.test(song.id)) return null;
    if (!/^(yt|js|local|fs):/.test(song.id) || song.id.length > 1024) return null;
    return {
        id: song.id, title: song.title.slice(0, 300),
        thumbnails: song.thumbnails.filter((thumb) => typeof thumb?.url === 'string' && /^https?:\/\//i.test(thumb.url)).slice(0, 4),
        artists: song.artists.slice(0, 8).flatMap((artist) => typeof artist?.name === 'string'
            ? [{ name: artist.name.slice(0, 120), thumbnails: [] }] : []),
        duration: Number.isFinite(song.duration) ? Math.max(0, song.duration) : 0,
        album: null, isDownloaded: false,
    };
}

async function digest(bytes: Uint8Array<ArrayBuffer>) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('');
}

class Peers {
    links = $state<Link[]>([]);
    pending = $state<{ id: string; mode: PeerMode; code?: string; host: boolean } | null>(null);
    remote = $state<RemotePlayback | null>(null);
    busy = $state(false);
    following = $state(false);
    partyControls = $state(false);
    progress = $state<number | null>(null);
    diagnostics = $state<string[]>([]);
    private listenerId: string | undefined;
    private incoming: IncomingBackup | null = null;
    private timer: ReturnType<typeof setInterval> | undefined;
    private librarySyncTimer: ReturnType<typeof setInterval> | undefined;
    private pendingIce = new Map<string, RTCIceCandidateInit[]>();

    private log(event: string, details?: unknown) {
        const line = `${new Date().toLocaleTimeString()} ${event}${details ? ` ${JSON.stringify(details)}` : ''}`;
        this.diagnostics = [...this.diagnostics.slice(-39), line];
        console.log(`[wayship-peer] ${line}`);
    }

    private async flushIce(id: string, peer: RTCPeerConnection) {
        const queued = this.pendingIce.get(id);
        if (!queued?.length || !peer.remoteDescription) return;
        this.pendingIce.delete(id);
        for (const candidate of queued) await peer.addIceCandidate(candidate).catch(() => {});
    }

    private waitForIceGathering(peer: RTCPeerConnection, timeoutMs = 1500): Promise<void> {
        if (peer.iceGatheringState === 'complete') return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.log('ICE gathering timeout; using candidates gathered so far');
                resolve();
            }, timeoutMs);
            const done = () => {
                if (peer.iceGatheringState !== 'complete') return;
                clearTimeout(timer);
                peer.removeEventListener('icegatheringstatechange', done);
                resolve();
            };
            peer.addEventListener('icegatheringstatechange', done);
        });
    }

    private startBroadcast() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            const hosts = this.links.filter((link) => link.host && link.connected && link.mode !== 'backup');
            if (!hosts.length) return;
            const data = {
                type: 'playback', song: wireSong(playerState.currentTrack), paused: playerState.paused,
                position: playerState.currentTime, duration: playerState.duration, volume: playerState.volume,
                queue: playerState.upNext.slice(0, 25).map(({ title }) => title),
            };
            for (const link of hosts) this.send(link, data);
        }, 1200);
        this.librarySyncTimer = setInterval(() => {
            for (const link of this.links.filter((item) => item.host && item.connected && item.mode !== 'backup')) {
                void this.syncLibrary(link.id).catch(() => {});
            }
        }, 30_000);
    }

    private send(link: Link, message: object) {
        if (link.channel?.readyState === 'open') link.channel.send(JSON.stringify(message));
    }

    private attach(link: Link, channel: RTCDataChannel) {
        link.channel = channel;
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => {
            this.log('data channel open', { id: link.id, host: link.host });
            link.connected = true;
            if (link.connectTimeout) clearTimeout(link.connectTimeout);
            link.connectTimeout = undefined;
            // Reassign the collection so connection status updates immediately
            // in the Wayship device list and title-bar indicator.
            this.links = this.links.map((item) => item.id === link.id ? { ...item, connected: true, connectTimeout: undefined } : item);
            this.closeListener(link.id);
            if (this.pending?.id === link.id) this.pending = null;
            if (link.backupAudio !== undefined) {
                void this.sendBackup(link.id).catch((error) => toasts.error(error));
            } else {
                // The host sends first. The joining device replies after it
                // has imported that transfer, avoiding two binary streams
                // colliding on the same ordered data channel.
                if (link.host) void this.syncLibrary(link.id, true).catch(() => {});
            }
        };
        channel.onclose = () => { this.log('data channel closed', { id: link.id }); this.disconnect(link.id); };
        channel.onmessage = ({ data }) => { void this.receive(link, data).catch((error) => {
            this.incoming = null;
            this.progress = null;
            toasts.error(error);
        }); };
    }

    private closeListener(id: string) {
        if (this.listenerId !== id) return;
        this.listenerId = undefined;
        void client.nearbyClose().catch(() => {});
    }

    private async exchangeAnswer(link: Link, exchange: () => Promise<void>, lifetime: number) {
        const deadline = Date.now() + lifetime;
        try {
            while (this.pending?.id === link.id && Date.now() < deadline) {
                await exchange();
                await new Promise((resolve) => setTimeout(resolve, 400));
            }
            if (this.pending?.id === link.id) {
                throw new Error('Pairing timed out. Check that both devices are on the same local network.');
            }
        } catch (error) {
            if (this.pending?.id !== link.id) return;
            this.disconnect(link.id);
            toasts.error(error);
        } finally {
            this.closeListener(link.id);
        }
    }

    private async pair(mode: PeerMode, code?: string, backupAudio?: boolean) {
        if (this.pending || this.busy) throw new Error('Finish or cancel the current pairing first.');
        if (this.links.length >= 6) throw new Error('Disconnect a device before adding another.');
        if (code && this.links.some((link) => !link.host)) throw new Error('Disconnect the previous host first.');
        this.busy = true;
        const id = crypto.randomUUID();
        let peer: RTCPeerConnection | undefined;
        try {
            const invite = code ? readNearbyInvite(code) : undefined;
            const offer = invite ? await decodeSignal(invite.offer) : undefined;
            mode = offer?.mode ?? mode;
            let channel: RTCDataChannel | undefined;
            const result = await createPeer(mode, (incoming) => {
                channel = incoming;
                const link = this.links.find((item) => item.id === id);
                if (link) this.attach(link, incoming);
            }, offer);
            peer = result.peer;
            const reply = invite ? await sealNearbyAnswer(invite.secret, result.code) : undefined;
            const endpoint = invite ? undefined : await client.nearbyListen();
            const hostInvite = endpoint ? makeNearbyInvite(endpoint, result.code) : undefined;
            if (hostInvite) this.listenerId = id;
            this.links.push({ id, mode, peer, host: !invite, connected: false, backupAudio });
            const link = this.links.at(-1)!;
            if (channel) this.attach(link, channel);
            peer.onconnectionstatechange = () => {
                if (link.peer.connectionState === 'failed') {
                    this.disconnect(id);
                    toasts.error('Could not reach the other device. Check that both are on the same network or Tailscale.');
                }
            };
            this.pending = { id, mode, code: hostInvite?.code, host: !invite };
            this.startBroadcast();
            if (invite && reply) {
                void this.exchangeAnswer(link, async () => {
                    await client.nearbySend(invite.addresses, invite.port, reply);
                }, 18_000);
            } else if (hostInvite && endpoint) {
                let accepted = false;
                let tick = 0;
                void this.exchangeAnswer(link, async () => {
                    if (accepted) return;
                    // Broadcast our invitation over LAN + Tailscale so clicking "Pair" on both devices pairs automatically.
                    if (tick++ % 2 === 0) {
                        await client.nearbySend(endpoint.addresses, DISCOVERY_PORT, hostInvite.code).catch(() => {});
                    }
                    for (const packet of await client.nearbyReceive()) {
                        if (this.pending?.id !== id) break;
                        if (packet.startsWith('zeta-peer:2:')) {
                            try {
                                const other = readNearbyInvite(packet);
                                // Deterministic tie-breaker when both devices tap Pair simultaneously.
                                if (other.secret !== hostInvite.secret && hostInvite.secret < other.secret && !this.links.some((l) => !l.host)) {
                                    accepted = true;
                                    this.disconnect(id);
                                    void this.join(packet).catch((err) => toasts.error(err));
                                    return;
                                }
                            } catch { /* ignore invalid broadcast */ }
                            continue;
                        }
                        try {
                            const answer = await openNearbyAnswer(hostInvite.secret, packet);
                            if (this.pending?.id !== id) break;
                            await acceptPeer(link.peer, mode, answer);
                            accepted = true;
                            this.closeListener(id);
                            break;
                        } catch { /* Unauthenticated LAN packets cannot complete the invitation. */ }
                    }
                }, INVITE_LIFETIME);
            }
        } catch (error) {
            this.closeListener(id);
            peer?.close();
            throw error;
        } finally {
            this.busy = false;
        }
    }

    invite(mode: PeerMode, includeAudio = true) { return this.pair(mode, undefined, mode === 'backup' ? includeAudio : undefined); }
    join(code: string) { return this.pair('backup', code); }

    async connectWayshipPeer(
        remotePeerId: string,
        deviceName: string,
        mode: PeerMode,
        iceServers: RTCIceServer[],
        sendSignal: (toPeer: string, kind: 'offer' | 'answer' | 'ice' | 'data', payload: unknown) => Promise<void>,
        backupAudio?: boolean,
        localPeerId?: string,
    ) {
        const existing = this.links.find((l) => l.wayshipPeerId === remotePeerId);
        if (existing) {
            existing.mode = mode;
            if (existing.connected) {
                if (mode === 'backup') void this.sendBackup(existing.id).catch((err) => toasts.error(err));
                else void this.syncLibrary(existing.id, true);
                return;
            }
            this.disconnect(existing.id);
        }
        const id = `wayship:${remotePeerId}`;
        this.pendingIce.delete(id);
        const peer = new RTCPeerConnection({ iceServers });
        this.log('peer created', { id, remotePeerId, iceServers: iceServers.map((server) => server.urls) });
        const channel = peer.createDataChannel('zeta', { ordered: true });
        const link: Link = { id, mode, peer, host: true, connected: false, backupAudio, wayshipPeerId: remotePeerId, deviceName };
        this.links.push(link);
        this.attach(link, channel);
        link.connectTimeout = setTimeout(() => {
            if (!link.connected && this.links.some((item) => item.id === id)) {
                this.disconnect(id);
                toasts.error('Wayship could not establish a direct device connection. Try Connect again.');
            }
        }, 20_000);
        this.startBroadcast();

        peer.onicecandidate = ({ candidate }) => {
            if (!candidate) this.log('local ICE gathering complete', { id });
        };
        peer.onicegatheringstatechange = () => this.log('ICE gathering state', { id, state: peer.iceGatheringState });
        peer.oniceconnectionstatechange = () => this.log('ICE connection state', { id, state: peer.iceConnectionState });
        peer.onsignalingstatechange = () => this.log('signaling state', { id, state: peer.signalingState });
        peer.onconnectionstatechange = () => {
            this.log('peer connection state', { id, state: peer.connectionState });
            if (peer.connectionState === 'failed') this.disconnect(id);
        };

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await this.waitForIceGathering(peer);
        await sendSignal(remotePeerId, 'offer', { sdp: peer.localDescription?.sdp, mode });
    }

    async handleWayshipSignal(
        remotePeerId: string,
        deviceName: string,
        kind: string,
        payload: any,
        iceServers: RTCIceServer[],
        sendSignal: (toPeer: string, kind: 'offer' | 'answer' | 'ice' | 'data', payload: unknown) => Promise<void>,
        localPeerId?: string,
    ) {
        const id = `wayship:${remotePeerId}`;
        if (kind !== 'ice') this.log('signal handling', { id, kind, hasPayload: !!payload });
        if (kind === 'offer' && payload && typeof payload.sdp === 'string') {
            const existing = this.links.find((l) => l.id === id);
            // If both devices were clicked at once, keep one deterministic
            // offer instead of letting the two SDP negotiations collide.
            if (existing?.host && localPeerId && localPeerId < remotePeerId) return;
            if (existing) this.disconnect(id);
            this.pendingIce.delete(id);
            const mode: PeerMode = ['backup', 'remote', 'party'].includes(payload.mode) ? payload.mode : 'remote';
            const peer = new RTCPeerConnection({ iceServers });
            this.log('peer created for offer', { id, remotePeerId, iceServers: iceServers.map((server) => server.urls) });
            const link: Link = { id, mode, peer, host: false, connected: false, wayshipPeerId: remotePeerId, deviceName };
            this.links.push(link);
            this.startBroadcast();
            link.connectTimeout = setTimeout(() => {
                if (!link.connected && this.links.some((item) => item.id === id)) {
                    this.disconnect(id);
                    toasts.error('Wayship could not establish a direct device connection. Try Connect again.');
                }
            }, 20_000);

            peer.ondatachannel = ({ channel }) => this.attach(link, channel);
            peer.onicecandidate = ({ candidate }) => {
                if (!candidate) this.log('local ICE gathering complete', { id });
            };
            peer.onicegatheringstatechange = () => this.log('ICE gathering state', { id, state: peer.iceGatheringState });
            peer.oniceconnectionstatechange = () => this.log('ICE connection state', { id, state: peer.iceConnectionState });
            peer.onsignalingstatechange = () => this.log('signaling state', { id, state: peer.signalingState });
            peer.onconnectionstatechange = () => {
                this.log('peer connection state', { id, state: peer.connectionState });
                if (peer.connectionState === 'failed') this.disconnect(id);
            };

            await peer.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
            await this.flushIce(id, peer);
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            await this.waitForIceGathering(peer);
            await sendSignal(remotePeerId, 'answer', { sdp: peer.localDescription?.sdp, mode });
            return;
        }
        const link = this.links.find((l) => l.id === id);
        if (!link) {
            if (kind === 'ice' && payload && typeof payload.candidate === 'string') {
                const queued = this.pendingIce.get(id) ?? [];
                queued.push(payload);
                this.pendingIce.set(id, queued);
            }
            return;
        }
        if (kind === 'answer' && payload && typeof payload.sdp === 'string') {
            if (link.peer.signalingState === 'have-local-offer') {
                await link.peer.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
                await this.flushIce(id, link.peer);
            }
        } else if (kind === 'ice' && payload && typeof payload.candidate === 'string') {
            if (!link.peer.remoteDescription) {
                const queued = this.pendingIce.get(id) ?? [];
                queued.push(payload);
                this.pendingIce.set(id, queued);
            } else {
                await link.peer.addIceCandidate(payload).catch(() => {});
            }
        }
    }

    disconnect(id: string) {
        const link = this.links.find((item) => item.id === id);
        if (!link) return;
        this.closeListener(id);
        this.links = this.links.filter((item) => item.id !== id);
        this.pendingIce.delete(id);
        if (link.connectTimeout) clearTimeout(link.connectTimeout);
        if (this.pending?.id === id) this.pending = null;
        if (!link.host) { this.remote = null; this.following = false; }
        if (this.incoming?.id === id) { this.incoming = null; this.progress = null; }
        if (!this.links.length) { clearInterval(this.timer); this.timer = undefined; }
        if (!this.links.length) { clearInterval(this.librarySyncTimer); this.librarySyncTimer = undefined; }
        if (link.channel) { link.channel.onclose = null; link.channel.close(); }
        link.peer.close();
    }

    async sendBackup(id: string) {
        const link = this.links.find((item) => item.id === id && item.host && item.mode === 'backup');
        if (!link?.connected || !link.channel || this.progress !== null) return;
        this.progress = 0;
        try {
            let backup;
            try {
                backup = await client.zetaBackupBytes(link.backupAudio ?? true);
            } catch (error) {
                if (link.backupAudio === false || !String(error).includes(BACKUP_AUDIO_LIMIT_MESSAGE)) throw error;
                const sendLibrary = await ui.confirm('Send a library-only backup?', {
                    message: 'The offline audio exceeds 512 MiB. Your songs, playlists, favourites, and listening history can still be transferred.',
                    confirmLabel: 'Send library backup',
                });
                if (!sendLibrary || link.channel.readyState !== 'open') return;
                backup = await client.zetaBackupBytes(false);
            }
            const { bytes } = backup;
            const data = Uint8Array.from(bytes);
            this.send(link, { type: 'backup-start', size: data.length, digest: await digest(data) });
            await sendPeerBytes(link.channel, data, (fraction) => { this.progress = fraction; });
            this.send(link, { type: 'backup-end' });
            toasts.success('Backup sent. Confirm the preview on the receiving device.');
        } finally { this.progress = null; }
    }

    async syncLibrary(id: string, showToast = false) {
        const link = this.links.find((item) => item.id === id && item.connected && item.channel);
        if (!link?.channel || this.progress !== null) return;
        try {
            const { bytes } = await client.zetaBackupBytes(false);
            const data = Uint8Array.from(bytes);
            this.send(link, { type: 'sync-start', size: data.length, digest: await digest(data) });
            await sendPeerBytes(link.channel, data, () => {});
            this.send(link, { type: 'sync-end' });
            if (showToast) toasts.success('Synced stats, playlists, and favourites with paired device.');
        } catch (error) {
            if (showToast) toasts.error(error);
        }
    }

    command(command: Command, value?: number) {
        const link = this.links.find((item) => !item.host && item.connected && item.mode !== 'backup');
        if (link) this.send(link, { type: 'command', command, value });
    }

    setFollowing(enabled: boolean) {
        this.following = enabled;
        const link = this.links.find((item) => !item.host && item.connected && item.mode === 'remote');
        if (link) this.send(link, { type: enabled ? 'takeover' : 'release' });
    }

    takeoverGuest(id: string) {
        const link = this.links.find((item) => item.id === id && item.host && item.connected && item.mode === 'remote');
        if (!link) return;
        playerState.paused = true;
        this.send(link, { type: 'takeover' });
    }

    playHere(id: string) {
        const link = this.links.find((item) => item.id === id && item.host && item.connected && item.mode === 'remote');
        if (link) this.send(link, { type: 'release' });
    }

    queue(song: Song) {
        const link = this.links.find((item) => !item.host && item.connected && item.mode === 'party');
        const clean = wireSong(song, true);
        if (link && clean) this.send(link, { type: 'queue', song: clean });
    }

    private async receive(link: Link, data: unknown) {
        if (data instanceof ArrayBuffer) {
            const backup = this.incoming;
            if (!backup || backup.id !== link.id || backup.offset + data.byteLength > backup.bytes.length) return;
            backup.bytes.set(new Uint8Array(data), backup.offset);
            backup.offset += data.byteLength;
            if (!backup.silentSync) this.progress = backup.offset / backup.bytes.length;
            return;
        }
        if (typeof data !== 'string' || data.length > 32_000) return;
        const message = JSON.parse(data);
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'sync-start' && !this.incoming && Number.isSafeInteger(message.size) &&
            message.size > 0 && message.size <= MAX_BACKUP_BYTES && /^[a-f0-9]{64}$/.test(message.digest)) {
            this.incoming = { id: link.id, bytes: new Uint8Array(message.size), offset: 0, digest: message.digest, silentSync: true };
            return;
        }
        if (message.type === 'sync-end' && this.incoming?.id === link.id && this.incoming.silentSync) {
            const sync = this.incoming;
            this.incoming = null;
            if (sync.offset === sync.bytes.length && await digest(Uint8Array.from(sync.bytes)) === sync.digest) {
                await client.zetaImportBytes(sync.bytes);
                await libraryState.refresh();
                if (!link.host) void this.syncLibrary(link.id, true).catch(() => {});
            }
            return;
        }
        if (link.mode === 'backup') {
            if (link.host) return;
            if (message.type === 'backup-start' && !this.incoming && Number.isSafeInteger(message.size) &&
                message.size > 0 && message.size <= MAX_BACKUP_BYTES && /^[a-f0-9]{64}$/.test(message.digest)) {
                this.incoming = { id: link.id, bytes: new Uint8Array(message.size), offset: 0, digest: message.digest };
                this.progress = 0;
            } else if (message.type === 'backup-end' && this.incoming?.id === link.id) {
                const backup = this.incoming;
                this.incoming = null;
                this.progress = null;
                if (backup.offset !== backup.bytes.length || await digest(Uint8Array.from(backup.bytes)) !== backup.digest) {
                    throw new Error('The transferred backup is incomplete.');
                }
                await settingsState.previewZetaBackup(backup.bytes);
            }
            return;
        }
        if (link.host) {
            if (message.type === 'takeover') {
                playerState.paused = true;
                return;
            }
            if (link.mode === 'party' && message.type === 'queue') {
                const song = wireSong(message.song, true);
                if (song && playerState.upNext.length < 100) addToQueue(song);
            }
            if (message.type === 'command' && (link.mode === 'remote' || this.partyControls)) {
                if (message.command === 'toggle') togglePlay();
                if (message.command === 'next') nextTrack();
                if (message.command === 'previous') previousTrack();
                if (message.command === 'volume' && Number.isFinite(message.value)) setVolume(message.value);
                if (message.command === 'seek' && Number.isFinite(message.value)) {
                    playerState.currentTime = Math.min(playerState.duration, Math.max(0, message.value));
                }
            }
            return;
        }
        if (message.type === 'takeover') {
            this.following = true;
            return;
        }
        if (message.type === 'release') {
            this.following = false;
            playerState.paused = true;
            return;
        }
        if (message.type !== 'playback' || !Number.isFinite(message.position) || !Number.isFinite(message.duration)) return;
        const song = wireSong(message.song);
        this.remote = {
            song, paused: !!message.paused, position: Math.max(0, message.position), duration: Math.max(0, message.duration),
            volume: Number.isFinite(message.volume) ? Math.min(1, Math.max(0, message.volume)) : playerState.volume,
            queue: Array.isArray(message.queue) ? message.queue.filter((title: unknown) => typeof title === 'string').slice(0, 25) : [],
        };
        // Wayship remote links mirror the host just like listening-party links.
        // The old check only handled `party`, so a successfully connected
        // Wayship phone received playback messages but never applied them.
        if ((link.mode === 'party' || link.mode === 'remote') && this.following) {
            if (!song || !/^(yt|js):/.test(song.id)) {
                playerState.paused = true;
                return;
            }
            if (playerState.currentTrack?.id !== song.id) playTrack(song);
            else if (!playerState.isLoading && playerState.stream) {
                if (Math.abs(playerState.currentTime - message.position) > 2) playerState.currentTime = message.position;
                playerState.paused = !!message.paused;
            }
            playerState.volume = this.remote.volume;
        }
    }
}

export const peers = new Peers();
