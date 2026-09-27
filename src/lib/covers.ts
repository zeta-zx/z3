/**
 * Embedded cover art is served on demand through a custom protocol instead of
 * being shipped inside every song object. Songs carry a `zeta-cover://` URL;
 * Electron's main process answers it with the bytes from the backend. This
 * keeps the library payload tiny and lets Chromium load/decode/cache only the
 * covers that are actually on screen.
 */

export const COVER_SCHEME = "zeta-cover:";

export function coverUrl(songId: string): string {
    return `zeta-cover://cover/${encodeURIComponent(songId)}`;
}

export function isCoverUrl(url: string | undefined | null): boolean {
    return !!url && url.startsWith(COVER_SCHEME);
}

export function coverIdFromUrl(url: string): string {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}
