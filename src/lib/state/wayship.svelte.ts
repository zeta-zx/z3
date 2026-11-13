import { browser } from '$app/environment';
import { client } from '$lib/ephaptic';
import { isAndroid } from '$lib/platform';
import type { PeerMode } from '$lib/peer-connection';
import { peers } from './peers.svelte';
import { toasts } from './toast.svelte';

const STORAGE_KEY = 'zeta:wayship';
const WAYSHIP_API = 'https://wayship.link/api';
const WAYSHIP_WS = 'wss://wayship.link/api/_ephaptic';

export interface WayshipPeer {
    peer_id: string;
    conn_id?: number | null;
    device_name: string;
    meta?: Record<string, unknown> | null;
    updated_at: number;
}

interface StoredWayship {
    token: string;
    accountId: string;
    handle: string;
    displayName: string;
    avatarUrl: string;
    connId: number | null;
    peerId: string;
    deviceName: string;
}

function randomPeerId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    return 'zeta-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function loadStored(): Partial<StoredWayship> {
    if (!browser) return {};
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
        return {};
    }
}

class WayshipState {
    private saved = loadStored();
    token = $state(this.saved.token ?? '');
    accountId = $state(this.saved.accountId ?? '');
    handle = $state(this.saved.handle ?? '');
    displayName = $state(this.saved.displayName ?? '');
    avatarUrl = $state(this.saved.avatarUrl ?? '');
    connId = $state<number | null>(this.saved.connId ?? null);
    peerId = $state(this.saved.peerId && /^[A-Za-z0-9._:-]{4,64}$/.test(this.saved.peerId) ? this.saved.peerId : randomPeerId());
    deviceName = $state(this.saved.deviceName || (isAndroid ? 'Android' : 'Desktop'));

    connecting = $state(false);
    onlinePeers = $state<WayshipPeer[]>([]);
    iceServers = $state<RTCIceServer[]>([
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    ]);

    private announceTimer: ReturnType<typeof setInterval> | undefined;
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private ws: WebSocket | null = null;
    private autoConnectedPeers = new Set<string>();

    readonly connected = $derived(this.token.startsWith('wsa_'));
    diagnostics = $state<string[]>([]);

    private log(event: string, details?: unknown) {
        const line = `${new Date().toLocaleTimeString()} ${event}${details ? ` ${JSON.stringify(details)}` : ''}`;
        this.diagnostics = [...this.diagnostics.slice(-39), line];
        console.log(`[wayship] ${line}`);
    }

    constructor() {
        if (browser && this.token.startsWith('wsa_')) {
            void this.startSession();
        }
    }

    private persist() {
        if (!browser) return;
        const data: StoredWayship = {
            token: this.token,
            accountId: this.accountId,
            handle: this.handle,
            displayName: this.displayName,
            avatarUrl: this.avatarUrl,
            connId: this.connId,
            peerId: this.peerId,
            deviceName: this.deviceName,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    private async api<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await fetch(`${WAYSHIP_API}${path}`, {
            ...init,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json',
                ...(init?.headers ?? {}),
            },
        });
        if (res.status === 401) {
            this.disconnect(false);
            throw new Error('Wayship connection was disconnected or expired.');
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.detail || err?.message || `Wayship returned HTTP ${res.status}`);
        }
        return res.json() as Promise<T>;
    }

    async signInWithBrowser() {
        if (this.connecting) return;
        this.connecting = true;
        try {
            const result = await client.wayshipConnect(this.deviceName);
            if (result.token?.startsWith('wsa_')) {
                await this.useToken(result.token, result.deviceName);
                toasts.success(`Connected to Wayship as @${this.handle || result.handle}`);
            }
        } catch (error) {
            toasts.error(error);
        } finally {
            this.connecting = false;
        }
    }

    async useToken(rawToken: string, customDeviceName?: string) {
        const trimmed = rawToken.trim();
        if (!trimmed.startsWith('wsa_')) {
            throw new Error('Paste a valid Wayship app token starting with wsa_.');
        }
        this.token = trimmed;
        if (customDeviceName?.trim()) this.deviceName = customDeviceName.trim().slice(0, 60);
        await this.startSession();
        this.persist();
    }

    private async startSession() {
        this.stopTimers();
        try {
            const me = await this.api<{
                account_id: string;
                handle: string;
                display_name: string;
                avatar_url: string;
                conn_id: number | null;
                device_name: string;
            }>('/apps/me');
            this.accountId = me.account_id;
            this.handle = me.handle;
            this.displayName = me.display_name || me.handle;
            this.avatarUrl = me.avatar_url || '';
            this.connId = me.conn_id;
            if (me.device_name) this.deviceName = me.device_name;
            this.persist();

            this.log('session ready', { peerId: this.peerId, deviceName: this.deviceName, connId: this.connId });

            await this.announce();
            this.openWebSocket();
            this.announceTimer = setInterval(() => {
                void this.announce().catch(() => {});
            }, 28_000);
            this.pollTimer = setInterval(() => {
                void this.poll().catch(() => {});
            }, 3500);
        } catch (error) {
            console.warn('[wayship] Failed to start session:', error);
        }
    }

    private openWebSocket() {
        if (!browser || !this.token.startsWith('wsa_')) return;
        try {
            this.ws?.close();
            const ws = new WebSocket(WAYSHIP_WS);
            this.ws = ws;
            ws.onopen = () => {
                this.log('websocket open');
                ws.send(JSON.stringify({ type: 'auth', auth: { token: this.token } }));
            };
            ws.onerror = (event) => this.log('websocket error', event);
            ws.onmessage = (ev) => {
                try {
                    const msg = JSON.parse(String(ev.data));
                    if (msg?.event === 'PeerEvent' && msg?.data) {
                        this.handlePeerEvent(msg.data);
                    } else if (msg?.kind && msg?.from_peer) {
                        this.handlePeerEvent(msg);
                    }
                } catch { /* ignore non-JSON frames */ }
            };
            ws.onclose = () => {
                if (this.ws === ws) this.ws = null;
            };
        } catch { /* polling fallback remains active */ }
    }

    async announce() {
        if (!this.token.startsWith('wsa_')) return;
        const out = await this.api<{
            self_peer_id: string;
            peers: WayshipPeer[];
            ice_servers: RTCIceServer[];
        }>('/peers/announce', {
            method: 'POST',
            body: JSON.stringify({
                peer_id: this.peerId,
                device_name: this.deviceName,
                meta: { platform: isAndroid ? 'android' : 'desktop' },
            }),
        });
        this.onlinePeers = out.peers.filter((p) => p.peer_id !== this.peerId);
        this.log('announce', { self: this.peerId, peers: this.onlinePeers.map((peer) => ({ id: peer.peer_id, name: peer.device_name })) });
        if (out.ice_servers?.length) this.iceServers = out.ice_servers;

        // Discovery is passive; the user chooses which device to connect.
        this.autoConnectedPeers.clear();
    }

    private async poll() {
        if (!this.token.startsWith('wsa_')) return;
        const out = await this.api<{ events: any[] }>(`/peers/poll?peer_id=${encodeURIComponent(this.peerId)}`);
        for (const ev of out.events ?? []) {
            this.handlePeerEvent(ev);
        }
    }

    private handlePeerEvent(ev: {
        kind: 'join' | 'heartbeat' | 'leave' | 'signal';
        from_peer: string;
        to_peer?: string | null;
        device_name?: string;
        meta?: Record<string, unknown> | null;
        signal_kind?: string;
        payload?: any;
        ts?: number;
    }) {
        if (!ev || ev.from_peer === this.peerId) return;
        if (ev.to_peer && ev.to_peer !== this.peerId) return;

        if (ev.kind === 'join' || ev.kind === 'heartbeat') {
            const existing = this.onlinePeers.find((p) => p.peer_id === ev.from_peer);
            if (existing) {
                existing.device_name = ev.device_name || existing.device_name;
                existing.updated_at = ev.ts || Date.now();
            } else {
                this.onlinePeers = [
                    ...this.onlinePeers,
                    {
                        peer_id: ev.from_peer,
                        device_name: ev.device_name || 'Zeta device',
                        meta: ev.meta,
                        updated_at: ev.ts || Date.now(),
                    },
                ];
            }
            return;
        }

        if (ev.kind === 'leave') {
            this.onlinePeers = this.onlinePeers.filter((p) => p.peer_id !== ev.from_peer);
            this.autoConnectedPeers.delete(ev.from_peer);
            peers.disconnect(`wayship:${ev.from_peer}`);
            return;
        }

        if (ev.kind === 'signal' && ev.signal_kind) {
            this.log('signal received', { kind: ev.signal_kind, from: ev.from_peer, to: ev.to_peer });
            const peerInfo = this.onlinePeers.find((p) => p.peer_id === ev.from_peer);
            void peers.handleWayshipSignal(
                ev.from_peer,
                peerInfo?.device_name || ev.device_name || 'Wayship device',
                ev.signal_kind,
                ev.payload,
                this.iceServers,
                (toPeer, kind, payload) => this.sendSignal(toPeer, kind, payload),
                this.peerId,
            );
        }
    }

    async sendSignal(toPeer: string, kind: 'offer' | 'answer' | 'ice' | 'data', payload: unknown) {
        this.log('signal sent', { kind, from: this.peerId, to: toPeer, candidate: kind === 'ice' });
        await this.api('/peers/signal', {
            method: 'POST',
            body: JSON.stringify({
                from_peer: this.peerId,
                to_peer: toPeer,
                kind,
                payload,
            }),
        });
    }

    async connectPeer(remotePeerId: string, mode: PeerMode, includeAudio = true) {
        this.log('connect requested', { local: this.peerId, remote: remotePeerId, mode });
        const peerInfo = this.onlinePeers.find((p) => p.peer_id === remotePeerId);
        await peers.connectWayshipPeer(
            remotePeerId,
            peerInfo?.device_name || 'Wayship device',
            mode,
            this.iceServers,
            (toPeer, kind, payload) => this.sendSignal(toPeer, kind, payload),
            mode === 'backup' ? includeAudio : undefined,
            this.peerId,
        );
    }

    private stopTimers() {
        if (this.announceTimer) clearInterval(this.announceTimer);
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.announceTimer = undefined;
        this.pollTimer = undefined;
        try { this.ws?.close(); } catch { /* ignore */ }
        this.ws = null;
    }

    disconnect(notifyServer = true) {
        const prevToken = this.token;
        const prevPeerId = this.peerId;
        this.stopTimers();
        if (notifyServer && prevToken.startsWith('wsa_')) {
            void fetch(`${WAYSHIP_API}/peers/leave`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${prevToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ peer_id: prevPeerId }),
            }).catch(() => {});
        }
        for (const p of this.onlinePeers) {
            peers.disconnect(`wayship:${p.peer_id}`);
        }
        this.token = '';
        this.accountId = '';
        this.handle = '';
        this.displayName = '';
        this.avatarUrl = '';
        this.connId = null;
        this.onlinePeers = [];
        this.autoConnectedPeers.clear();
        if (browser) localStorage.removeItem(STORAGE_KEY);
    }
}

export const wayship = new WayshipState();
