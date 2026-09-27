import { updateMpris, type MprisSnapshot } from '../lib/mpris';
import { callBackend } from '../lib/backend';
import { coverIdFromUrl, isCoverUrl } from '../../src/lib/covers';

// Tracks whose zeta-cover art has already been handed to MPRIS (it caches the
// resulting file URL per track, so the bytes are only needed once).
const coverSent = new Set<string>();

export const routes = {
    /**
     * Publish the renderer's current playback state to MPRIS.
     * A no-op on platforms where the MPRIS bridge isn't running (Windows and
     * macOS keep using Chromium's native SMTC / Now Playing integration).
     */
    async mprisUpdate(snapshot: MprisSnapshot): Promise<void> {
        const track = snapshot.track;
        // Desktop MPRIS clients can't load our custom scheme: resolve the cover
        // to bytes, which the MPRIS bridge writes to a temp file.
        if (track && isCoverUrl(track.artUrl)) {
            const url = track.artUrl!;
            track.artUrl = undefined;
            if (!coverSent.has(track.id)) {
                const cover = await callBackend<{ data: Uint8Array; mimetype: string } | null>('musicCover', [
                    coverIdFromUrl(url),
                ]).catch(() => null);
                if (cover) {
                    track.artData = cover.data;
                    track.artMimetype = cover.mimetype;
                    coverSent.add(track.id);
                }
            }
        }
        updateMpris(snapshot);
    },
};
