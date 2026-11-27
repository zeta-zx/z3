import { browser } from '$app/environment';
import { client } from '$lib/ephaptic';
import { isAndroid } from '$lib/platform';
import type { PeerMode } from '$lib/peer-connection';
import { DISCORD_PEER_PREFIX, DISCORD_PROTOCOL, DiscordRequests } from '$lib/wayship-discord';
import { nextWayshipRetry, WayshipHttpError, WayshipSignalInbox } from '$lib/wayship-recovery';
import { runDiscordCommand } from './discord-remote.svelte';
import { discordVoice } from './discord-voice.svelte';
import { peers } from './peers.svelte';
import { toasts } from './toast.svelte';

const STORAGE_KEY = 'zeta:wayship';
const WAYSHIP_API = 'https://wayship.link/api';
const WAYSHIP_WS = 'wss://wayship.link/api/_ephaptic';
const ANNOUNCE_INTERVAL = 28_000;

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

interface WayshipSession {
    token: string;
    controller: AbortController;
    signals: WayshipSignalInbox;
    authenticated: boolean;
    rejectedProfiles: number;
    announceAt: number;
    announceDelay: number;
    announcing?: Promise<void>;
    pollAt: number;
    polling?: Promise<void>;
    socketAt: number;
    socketDelay: number;
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
    reconnecting = $state(false);
    onlinePeers = $state<WayshipPeer[]>([]);
    iceServers = $state<RTCIceServer[]>([
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    ]);

    private timer: ReturnType<typeof setInterval> | undefined;
    private session: WayshipSession | undefined;
    private ws: WebSocket | null = null;
    private discordRequests = new DiscordRequests();

    readonly connected = $derived(this.token.startsWith('wsa_'));
    diagnostics = $state<string[]>([]);

    private log(event: string, details?: unknown) {
        const line = `${new Date().toLocaleTimeString('en-GB', { hour12: false })}.${String(Date.now() % 1000).padStart(3, '0')} ${event}${details ? ` ${JSON.stringify(details)}` : ''}`;
        this.diagnostics = [...this.diagnostics.slice(-39), line];
        console.log(`[wayship] ${line}`);
    }

    constructor() {
        if (!browser) return;
        window.addEventListener('online', () => this.wake());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.wake();
        });
        if (this.connected) void this.startSession().catch(() => {});
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

    private async api<T>(session: WayshipSession, path: string, init?: RequestInit): Promise<T> {
        const { signal } = session.controller;
        const res = await fetch(`${WAYSHIP_API}${path}`, {
            ...init,
            signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
            headers: {
                'Authorization': `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
        });
        signal.throwIfAborted();
        if (res.status === 401) {
            // An expired peer or stale signaling request should not erase a
            // saved account. Revalidate the token at the account endpoint.
            if (path !== '/apps/me' && session.authenticated) {
                session.authenticated = false;
                session.announceAt = 0;
                this.reconnecting = true;
            }
            throw new WayshipHttpError(401, 'Wayship could not authorize this request.');
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new WayshipHttpError(res.status, err?.detail || err?.message || `Wayship returned HTTP ${res.status}`);
        }
        const data = await res.json();
        signal.throwIfAborted();
        return data;
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
        if (this.token && this.token !== trimmed) this.disconnect(false);
        this.token = trimmed;
        if (customDeviceName?.trim()) this.deviceName = customDeviceName.trim().slice(0, 60);
        this.persist();
        await this.startSession();
    }

    private startSession() {
        this.stopSession();
        this.reconnecting = true;
        const session: WayshipSession = {
            token: this.token, controller: new AbortController(), signals: new WayshipSignalInbox(),
            authenticated: false, rejectedProfiles: 0, announceAt: 0, announceDelay: 0, pollAt: 0, socketAt: 0, socketDelay: 0,
        };
        this.session = session;
        this.timer = setInterval(() => void this.maintain(session), 1000);
        return this.announce(session);
    }

    private wake() {
        const session = this.session;
        if (!session) return;
        session.announceAt = session.pollAt = session.socketAt = 0;
        void this.maintain(session);
    }

    private async maintain(session: WayshipSession) {
        if (session.controller.signal.aborted || !navigator.onLine) return;
        if (Date.now() >= session.announceAt) {
            await this.announce(session).catch(() => {});
        }
        if (session.controller.signal.aborted || !session.authenticated) return;
        if (!this.ws && Date.now() >= session.socketAt) this.openWebSocket(session);
        if (!session.polling && Date.now() >= session.pollAt) {
            session.polling = this.poll(session).catch((error) => {
                if (session.controller.signal.aborted) return;
                session.pollAt = Date.now() + 3000;
                if (error instanceof WayshipHttpError && error.status === 404) session.announceAt = 0;
            }).finally(() => { session.polling = undefined; });
        }
    }

    private retrySocket(session: WayshipSession) {
        session.socketDelay = nextWayshipRetry(session.socketDelay);
        session.socketAt = Date.now() + session.socketDelay;
    }

    private openWebSocket(session: WayshipSession) {
        try {
            const ws = new WebSocket(WAYSHIP_WS);
            this.ws = ws;
            const isCurrent = () => this.ws === ws && !session.controller.signal.aborted;
            const openedAt = Date.now();
            const connectTimeout = setTimeout(() => {
                if (isCurrent() && ws.readyState === WebSocket.CONNECTING) ws.close();
            }, 8000);
            ws.onopen = () => {
                clearTimeout(connectTimeout);
                if (!isCurrent()) return;
                this.log('websocket open');
                ws.send(JSON.stringify({ type: 'auth', auth: { token: session.token } }));
            };
            ws.onerror = () => { if (isCurrent()) this.log('websocket error'); };
            ws.onmessage = (ev) => {
                if (!isCurrent()) return;
                try {
                    const msg = JSON.parse(String(ev.data));
                    if (msg?.event === 'PeerEvent' && msg?.data) {
                        this.handlePeerEvent(session, msg.data);
                    } else if (msg?.kind && msg?.from_peer) {
                        this.handlePeerEvent(session, msg);
                    }
                } catch { /* ignore non-JSON frames */ }
            };
            ws.onclose = () => {
                clearTimeout(connectTimeout);
                if (!isCurrent()) return;
                this.ws = null;
                if (Date.now() - openedAt > 30_000) session.socketDelay = 0;
                this.retrySocket(session);
            };
        } catch {
            this.ws = null;
            this.retrySocket(session);
        }
    }

    announce(session = this.session) {
        if (!session || session.controller.signal.aborted) return Promise.resolve();
        if (session.announcing) return session.announcing;
        session.announcing = this.announceSession(session).then(() => {
            session.controller.signal.throwIfAborted();
            session.announceDelay = 0;
            session.announceAt = Date.now() + ANNOUNCE_INTERVAL;
            this.reconnecting = false;
            if (!this.ws && Date.now() >= session.socketAt) this.openWebSocket(session);
        }).catch((error) => {
            if (!session.controller.signal.aborted) {
                this.reconnecting = true;
                session.announceDelay = nextWayshipRetry(session.announceDelay);
                session.announceAt = Date.now() + session.announceDelay;
                this.log('presence retry scheduled', { inMs: session.announceDelay, error: String(error) });
            }
            throw error;
        }).finally(() => { session.announcing = undefined; });
        return session.announcing;
    }

    private async authenticate(session: WayshipSession) {
        const me = await this.api<{
            account_id: string;
            handle: string;
            display_name: string;
            avatar_url: string;
            conn_id: number | null;
            device_name: string;
        }>(session, '/apps/me').catch((error) => {
            if (session.controller.signal.aborted) throw error;
            session.rejectedProfiles = error instanceof WayshipHttpError && error.status === 401
                ? session.rejectedProfiles + 1 : 0;
            if (session.rejectedProfiles >= 2) {
                const message = 'Wayship authorization expired. Connect your account again.';
                if (this.accountId) toasts.error(message);
                this.disconnect(false);
                throw new Error(message);
            }
            throw error;
        });
        session.controller.signal.throwIfAborted();
        session.rejectedProfiles = 0;
        this.accountId = me.account_id;
        this.handle = me.handle;
        this.displayName = me.display_name || me.handle;
        this.avatarUrl = me.avatar_url || '';
        this.connId = me.conn_id;
        if (me.device_name) this.deviceName = me.device_name;
        session.authenticated = true;
        this.persist();
        this.log('session ready', { peerId: this.peerId, deviceName: this.deviceName, connId: this.connId });
    }

    private async announceSession(session: WayshipSession) {
        if (!session.authenticated) await this.authenticate(session);
        const out = await this.api<{
            self_peer_id: string;
            peers: WayshipPeer[];
            ice_servers: RTCIceServer[];
        }>(session, '/peers/announce', {
            method: 'POST',
            body: JSON.stringify({
                peer_id: this.peerId,
                device_name: this.deviceName,
                meta: { platform: isAndroid ? 'android' : 'desktop' },
            }),
        });
        session.controller.signal.throwIfAborted();
        this.onlinePeers = out.peers.filter((p) => p.peer_id !== this.peerId && !p.peer_id.startsWith(DISCORD_PEER_PREFIX));
        this.log('announce', { self: this.peerId, peers: this.onlinePeers.map((peer) => ({ id: peer.peer_id, name: peer.device_name })) });
        if (out.ice_servers?.length) this.iceServers = out.ice_servers;

        this.autoConnect(session);
    }

    /**
     * Link up with every Zeta device that is online on this Wayship account,
     * so opening the app on a second device connects without any clicks.
     * Only the device with the smaller peer id sends the offer. That matches
     * the tie-breaker in peers.handleWayshipSignal, so two apps opening at the
     * same time never send competing offers. Runs on every announce (~28s),
     * which also retries links that timed out or dropped.
     */
    private autoConnect(session: WayshipSession) {
        if (session.controller.signal.aborted) return;
        for (const peer of this.onlinePeers) {
            if (this.peerId >= peer.peer_id) continue;
            if (peers.links.some((link) => link.wayshipPeerId === peer.peer_id)) continue;
            this.log('auto-connect', { local: this.peerId, remote: peer.peer_id });
            void this.connectPeer(peer.peer_id, 'remote').catch((error) => {
                this.log('auto-connect failed', { remote: peer.peer_id, error: String(error) });
            });
        }
    }

    private async poll(session: WayshipSession) {
        const out = await this.api<{ events: any[] }>(session, `/peers/poll?peer_id=${encodeURIComponent(this.peerId)}`);
        if (out.events?.length) this.log('poll events', { count: out.events.length, kinds: out.events.map((event) => event.kind === 'signal' ? event.signal_kind : event.kind) });
        for (const ev of out.events ?? []) {
            this.handlePeerEvent(session, ev);
        }
    }

    private handlePeerEvent(session: WayshipSession, ev: {
        kind: 'join' | 'heartbeat' | 'leave' | 'signal';
        from_peer: string;
        to_peer?: string | null;
        device_name?: string;
        meta?: Record<string, unknown> | null;
        signal_kind?: string;
        payload?: any;
        ts?: number;
    }) {
        if (session.controller.signal.aborted || !ev || typeof ev.from_peer !== 'string' || ev.from_peer === this.peerId) return;
        if (ev.to_peer && ev.to_peer !== this.peerId) return;

        if (ev.from_peer.startsWith(DISCORD_PEER_PREFIX)) {
            if (ev.kind === 'signal' && ev.signal_kind === 'data' && ev.to_peer === this.peerId) {
                void this.handleDiscordRequest(session, ev.from_peer, ev.payload);
            }
            return;
        }

        if (ev.kind === 'join' || ev.kind === 'heartbeat') {
            const existing = this.onlinePeers.find((p) => p.peer_id === ev.from_peer);
            if (existing) {
                if (ev.ts && ev.ts < existing.updated_at) return;
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
                // A device that just opened Zeta links up right away instead of
                // waiting up to ~28s for the next announce.
            }
            this.autoConnect(session);
            return;
        }

        if (ev.kind === 'leave') {
            this.onlinePeers = this.onlinePeers.filter((p) => p.peer_id !== ev.from_peer || !!(ev.ts && p.updated_at > ev.ts));
            // A presence lease can expire while the direct channel is healthy.
            // Let the channel's own close/failure events tear the link down.
            return;
        }

        if (ev.kind === 'signal' && ev.signal_kind) {
            if (!session.signals.accept(ev.from_peer, ev.signal_kind, ev.payload)) return;
            if (ev.signal_kind !== 'ice') this.log('signal received', { kind: ev.signal_kind, from: ev.from_peer, to: ev.to_peer });
            const peerInfo = this.onlinePeers.find((p) => p.peer_id === ev.from_peer);
            void peers.handleWayshipSignal(
                ev.from_peer,
                peerInfo?.device_name || ev.device_name || 'Wayship device',
                ev.signal_kind,
                ev.payload,
                this.iceServers,
                (toPeer, kind, payload) => this.sendSignal(toPeer, kind, payload, session),
                this.peerId,
            ).catch((error) => this.log('signal handling failed', { error: String(error) }));
        }
    }

    private async handleDiscordRequest(session: WayshipSession, fromPeer: string, payload: unknown) {
        if (!this.connected) return;
        const request = this.discordRequests.accept(fromPeer, payload);
        if (!request) return;
        const peerId = this.peerId;
        const isCurrent = () => !session.controller.signal.aborted && this.peerId === peerId && request.expiresAt > Date.now();
        const result = await runDiscordCommand(request, isCurrent).catch(() => ({
            ok: false, error: 'Zeta could not complete this request. Try again in the player.',
        }));
        if (!isCurrent()) return;
        await this.sendSignal(fromPeer, 'data', {
            protocol: DISCORD_PROTOCOL,
            requestId: request.requestId,
            ...result,
        }, session).catch(() => {});
    }

    async sendSignal(toPeer: string, kind: 'offer' | 'answer' | 'ice' | 'data', payload: unknown, session = this.session) {
        if (!session || session.controller.signal.aborted) throw new Error('Wayship is disconnected.');
        if (kind !== 'ice') this.log('signal sent', { kind, from: this.peerId, to: toPeer });
        try {
            await this.api(session, '/peers/signal', {
                method: 'POST',
                body: JSON.stringify({
                    from_peer: this.peerId,
                    to_peer: toPeer,
                    kind,
                    payload,
                }),
            });
            if (kind !== 'ice') this.log('signal accepted', { kind, to: toPeer });
        } catch (error) {
            this.log('signal failed', { kind, to: toPeer, error: String(error) });
            throw error;
        }
    }

    async connectPeer(remotePeerId: string, mode: PeerMode, includeAudio = true) {
        const session = this.session;
        if (!session || session.controller.signal.aborted) throw new Error('Wayship is disconnected.');
        this.log('connect requested', { local: this.peerId, remote: remotePeerId, mode });
        const peerInfo = this.onlinePeers.find((p) => p.peer_id === remotePeerId);
        await peers.connectWayshipPeer(
            remotePeerId,
            peerInfo?.device_name || 'Wayship device',
            mode,
            this.iceServers,
            (toPeer, kind, payload) => this.sendSignal(toPeer, kind, payload, session),
            mode === 'backup' ? includeAudio : undefined,
            this.peerId,
        );
    }

    private stopSession() {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.session?.controller.abort();
        this.session = undefined;
        const ws = this.ws;
        this.ws = null;
        try { ws?.close(); } catch { /* ignore */ }
    }

    disconnect(notifyServer = true) {
        const prevToken = this.token;
        const prevPeerId = this.peerId;
        this.stopSession();
        discordVoice.stop();
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
        for (const link of peers.links) {
            if (link.wayshipPeerId) peers.disconnect(link.id);
        }
        this.token = '';
        this.reconnecting = false;
        this.accountId = '';
        this.handle = '';
        this.displayName = '';
        this.avatarUrl = '';
        this.connId = null;
        this.onlinePeers = [];
        if (browser) localStorage.removeItem(STORAGE_KEY);
    }
}

export const wayship = new WayshipState();
