import { updateMpris, type MprisSnapshot } from '../lib/mpris';

export const routes = {
    /**
     * Publish the renderer's current playback state to MPRIS.
     * A no-op on platforms where the MPRIS bridge isn't running (Windows and
     * macOS keep using Chromium's native SMTC / Now Playing integration).
     */
    async mprisUpdate(snapshot: MprisSnapshot): Promise<void> {
        updateMpris(snapshot);
    },
};
