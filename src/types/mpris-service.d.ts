/**
 * Minimal ambient types for `mpris-service`, which ships none and has no
 * `@types` package. Only the surface Zeta actually uses is described here
 * (see electron/lib/mpris.ts).
 */
declare module "mpris-service" {
    interface MprisPlayerOptions {
        /** Bus name suffix: org.mpris.MediaPlayer2.<name> */
        name: string;
        identity?: string;
        supportedInterfaces?: Array<"player" | "trackList" | "playlists">;
        desktopEntry?: string;
        supportedUriSchemes?: string[];
        supportedMimeTypes?: string[];
    }

    interface MprisPlayer {
        metadata: Record<string, unknown>;
        playbackStatus: "Playing" | "Paused" | "Stopped";
        loopStatus: "None" | "Track" | "Playlist";
        shuffle: boolean;
        volume: number;
        rate: number;
        minimumRate: number;
        maximumRate: number;
        canControl: boolean;
        canPlay: boolean;
        canPause: boolean;
        canSeek: boolean;
        canGoNext: boolean;
        canGoPrevious: boolean;

        /** Called by clients reading the Position property; return microseconds. */
        getPosition: () => number;
        /** Raise the MPRIS `Seeked` signal (microseconds). */
        seeked(positionUs: number): void;
        /** Build a valid D-Bus object path under this player. */
        objectPath(subpath?: string): string;

        on(event: string, listener: (...args: any[]) => void): MprisPlayer;

        /** Underlying dbus-next bus; private but needed to disconnect cleanly. */
        _bus?: { disconnect?: () => void };
    }

    function Player(options: MprisPlayerOptions): MprisPlayer;

    export = Player;
}
