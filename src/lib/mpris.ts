/**
 * Renderer side of the native MPRIS integration.
 *
 * The main process owns `org.mpris.MediaPlayer2.zeta` on Linux and forwards
 * player commands here over a preload-exposed channel. On Windows/macOS the
 * bridge simply never fires and Chromium's own SMTC / Now Playing integration
 * (driven by `navigator.mediaSession`) is used instead.
 */

export type MediaCommand =
    | { type: "play" }
    | { type: "pause" }
    | { type: "playpause" }
    | { type: "stop" }
    | { type: "next" }
    | { type: "previous" }
    | { type: "seek"; offsetSec: number }
    | { type: "setPosition"; positionSec: number }
    | { type: "setLoop"; loop: boolean }
    | { type: "setShuffle"; shuffle: boolean }
    | { type: "setVolume"; volume: number };

interface ZetaBridge {
    onMediaCommand: (callback: (command: MediaCommand) => void) => () => void;
}

function bridge(): ZetaBridge | undefined {
    return (globalThis as unknown as { __zeta?: ZetaBridge }).__zeta;
}

/**
 * Subscribe to media commands coming from MPRIS. Returns an unsubscribe
 * function; a no-op when the bridge isn't present (browser/dev, other OSes).
 */
export function onMediaCommand(callback: (command: MediaCommand) => void): () => void {
    return bridge()?.onMediaCommand(callback) ?? (() => {});
}
