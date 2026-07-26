/**
 * Native MPRIS integration (Linux only).
 *
 * Rather than relying on Chromium's built-in MediaSession → MPRIS bridge, Zeta
 * owns `org.mpris.MediaPlayer2.zeta` itself from the main process. That bridge
 * gives us no control over the metadata it publishes — most importantly it
 * can't expose a usable `mpris:artUrl`, and its position/seek reporting is
 * approximate. Owning the service directly lets us publish:
 *
 *   - `mpris:artUrl`   the real remote cover URL (KDE/GNOME fetch these fine —
 *                      it's what Spotify does), or a file:// URL for artwork we
 *                      only have as embedded bytes
 *   - `xesam:url`      a real link back to the track
 *   - accurate Position/Seek, and a correct PlaybackStatus
 *
 * Chromium's own registration is suppressed in main.ts (Linux only) so the
 * desktop doesn't show two players. Windows and macOS are untouched and keep
 * using Chromium's native SMTC / Now Playing integration.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface MprisTrackInfo {
    /** Zeta canonical id (yt:… / js:… / local:…). */
    id: string;
    title: string;
    artists: string[];
    album?: string | null;
    durationSec: number;
    /** Remote cover URL — published verbatim as mpris:artUrl. */
    artUrl?: string;
    /** Embedded cover bytes, used when there's no remote URL. */
    artData?: Uint8Array;
    artMimetype?: string;
    /** Published as xesam:url. */
    url?: string;
}

export interface MprisSnapshot {
    track: MprisTrackInfo | null;
    paused: boolean;
    positionSec: number;
    canNext: boolean;
    canPrevious: boolean;
    loop: boolean;
    shuffle: boolean;
    volume: number;
    /** Set when the position jumped, so we raise the MPRIS `Seeked` signal. */
    seeked?: boolean;
}

export type MprisCommand =
    | { type: 'play' }
    | { type: 'pause' }
    | { type: 'playpause' }
    | { type: 'stop' }
    | { type: 'next' }
    | { type: 'previous' }
    | { type: 'seek'; offsetSec: number }
    | { type: 'setPosition'; positionSec: number }
    | { type: 'setLoop'; loop: boolean }
    | { type: 'setShuffle'; shuffle: boolean }
    | { type: 'setVolume'; volume: number };

export interface MprisHandlers {
    onCommand: (command: MprisCommand) => void;
    onRaise: () => void;
    onQuit: () => void;
}

let player: any = null;

/* ------------------------------ position state ---------------------------- */
// MPRIS clients poll `Position` at their own cadence, so we interpolate between
// the position updates the renderer pushes instead of reporting a stale value.
let positionSec = 0;
let positionAt = Date.now();
let playing = false;
let durationSec = 0;

function livePositionSec(): number {
    let pos = positionSec;
    if (playing) pos += (Date.now() - positionAt) / 1000;
    if (durationSec > 0) pos = Math.min(pos, durationSec);
    return Math.max(0, pos);
}

// int64 ('x') values must be whole numbers: dbus-next converts via toString(),
// which throws on a fractional value.
const toMicros = (seconds: number): number => Math.max(0, Math.round(seconds * 1e6));

/* -------------------------------- artwork --------------------------------- */

const ART_DIR = join(tmpdir(), 'zeta-mpris-art');

// Resolved art URL per track, so the renderer only has to send embedded cover
// bytes once per track instead of on every position sync.
const artUrlCache = new Map<string, string>();
const ART_CACHE_LIMIT = 100;

function rememberArt(trackId: string, url: string): void {
    artUrlCache.set(trackId, url);
    if (artUrlCache.size > ART_CACHE_LIMIT) {
        artUrlCache.delete(artUrlCache.keys().next().value as string);
    }
}

/** Persist embedded cover bytes to a temp file so MPRIS can reference them. */
function artFileUrl(data: Uint8Array, mimetype?: string): string | undefined {
    try {
        const hash = createHash('sha1').update(Buffer.from(data)).digest('hex').slice(0, 16);
        const ext = mimetype?.includes('png') ? 'png' : mimetype?.includes('webp') ? 'webp' : 'jpg';
        const file = join(ART_DIR, `${hash}.${ext}`);
        if (!existsSync(file)) {
            mkdirSync(ART_DIR, { recursive: true });
            writeFileSync(file, Buffer.from(data));
        }
        return `file://${file}`;
    } catch (err) {
        console.warn('[mpris] Could not cache embedded artwork:', err);
        return undefined;
    }
}

/** D-Bus object paths only allow [A-Za-z0-9_] between slashes. */
function trackObjectPath(id: string): string {
    const safe = id.replace(/[^A-Za-z0-9_]/g, '_') || 'unknown';
    return player.objectPath(`track/${safe}`);
}

/* --------------------------------- bridge --------------------------------- */

/**
 * Claim the MPRIS bus name and start publishing state. Resolves to false (and
 * stays inert) on non-Linux platforms or when no session bus is reachable.
 */
export async function initMpris(handlers: MprisHandlers): Promise<boolean> {
    if (process.platform !== 'linux' || player) return false;

    try {
        const mod: any = await import('mpris-service');
        const Player = mod.default ?? mod;

        player = Player({
            name: 'zeta', // -> org.mpris.MediaPlayer2.zeta
            identity: 'Zeta',
            supportedInterfaces: ['player'],
            desktopEntry: 'zeta',
        });

        player.canControl = true;
        player.canPlay = true;
        player.canPause = true;
        player.canSeek = true;
        player.canGoNext = false;
        player.canGoPrevious = false;
        player.playbackStatus = 'Stopped';
        player.rate = 1;
        player.minimumRate = 1;
        player.maximumRate = 1;

        // Clients read Position off this getter, so interpolate on demand.
        player.getPosition = () => toMicros(livePositionSec());

        const cmd = handlers.onCommand;
        player.on('play', () => cmd({ type: 'play' }));
        player.on('pause', () => cmd({ type: 'pause' }));
        player.on('playpause', () => cmd({ type: 'playpause' }));
        player.on('stop', () => cmd({ type: 'stop' }));
        player.on('next', () => cmd({ type: 'next' }));
        player.on('previous', () => cmd({ type: 'previous' }));

        // 'x' params arrive as BigInt/JSBI from dbus-next.
        player.on('seek', (offset: any) => cmd({ type: 'seek', offsetSec: Number(offset) / 1e6 }));
        player.on('position', (ev: any) => cmd({ type: 'setPosition', positionSec: Number(ev?.position ?? 0) / 1e6 }));

        player.on('volume', (volume: any) => {
            const v = Math.min(1, Math.max(0, Number(volume)));
            player.volume = v;
            cmd({ type: 'setVolume', volume: v });
        });
        player.on('loopStatus', (status: string) => {
            player.loopStatus = status;
            cmd({ type: 'setLoop', loop: status !== 'None' });
        });
        player.on('shuffle', (enabled: any) => {
            player.shuffle = !!enabled;
            cmd({ type: 'setShuffle', shuffle: !!enabled });
        });

        player.on('raise', () => handlers.onRaise());
        player.on('quit', () => handlers.onQuit());
        player.on('error', (err: any) => console.warn('[mpris] bus error:', err?.message ?? err));

        console.log('[mpris] Serving org.mpris.MediaPlayer2.zeta');
        return true;
    } catch (err) {
        // No session bus (headless, container, …) — degrade silently.
        console.warn('[mpris] Not available, continuing without it:', (err as Error)?.message ?? err);
        player = null;
        return false;
    }
}

/** Push the current player state onto the bus. */
export function updateMpris(snapshot: MprisSnapshot): void {
    if (!player) return;

    try {
        const { track } = snapshot;

        durationSec = track?.durationSec ?? 0;

        // Detect a discontinuity so we can raise `Seeked` even if the caller
        // didn't flag one (e.g. an MPRIS client called SetPosition).
        const drift = Math.abs(snapshot.positionSec - livePositionSec());
        const jumped = snapshot.seeked || drift > 2;

        positionSec = snapshot.positionSec;
        positionAt = Date.now();
        playing = !!track && !snapshot.paused;

        if (track) {
            const artUrl =
                track.artUrl ||
                (track.artData?.length ? artFileUrl(track.artData, track.artMimetype) : undefined) ||
                artUrlCache.get(track.id);
            if (artUrl) rememberArt(track.id, artUrl);

            const metadata: Record<string, unknown> = {
                'mpris:trackid': trackObjectPath(track.id),
                'mpris:length': toMicros(track.durationSec),
                'xesam:title': track.title || 'Unknown',
                'xesam:artist': track.artists.length ? track.artists : ['Unknown Artist'],
            };
            if (track.album) metadata['xesam:album'] = track.album;
            if (artUrl) metadata['mpris:artUrl'] = artUrl;
            if (track.url) metadata['xesam:url'] = track.url;

            player.metadata = metadata;
            player.playbackStatus = snapshot.paused ? 'Paused' : 'Playing';
        } else {
            player.metadata = {};
            player.playbackStatus = 'Stopped';
        }

        player.canGoNext = snapshot.canNext;
        player.canGoPrevious = snapshot.canPrevious;
        player.loopStatus = snapshot.loop ? 'Playlist' : 'None';
        player.shuffle = snapshot.shuffle;
        if (typeof snapshot.volume === 'number') player.volume = snapshot.volume;

        if (jumped && track) player.seeked(toMicros(snapshot.positionSec));
    } catch (err) {
        console.warn('[mpris] Failed to publish state:', (err as Error)?.message ?? err);
    }
}

export function shutdownMpris(): void {
    if (!player) return;

    try {
        // Let clients (scrobblers, panels) see playback stop before we vanish.
        player.playbackStatus = 'Stopped';
    } catch {
        /* best effort */
    }

    // Deliberately NOT disconnecting the bus here.
    //
    // dbus-next's incoming-message handler replies to messages from inside its
    // own catch block (lib/bus.js): if the socket has been torn down, that
    // reply throws "Cannot send message, stream is closed" *from within the
    // catch*, so it escapes as an uncaught exception and Electron shows a
    // crash dialog. Any MPRIS client polling us during shutdown (playerctld,
    // mpris-scrobbler, a desktop panel...) reliably triggers it.
    //
    // The bus name is released automatically when the process exits and the
    // socket closes, so an explicit disconnect buys us nothing.
    player = null;
}
