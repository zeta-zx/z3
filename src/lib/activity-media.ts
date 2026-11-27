import { coverCrop } from '$lib/utils';
import { DISCORD_ACTIVITY_COVER_LIMIT } from '$lib/wayship-discord';

// Wayship's data signal holds lyrics and artwork together within 64 KiB.
const LYRICS_BUDGET = 24_000;
const encoder = new TextEncoder();

export function boundedActivityLyrics(lyrics: string | null) {
    if (!lyrics) return null;
    let text = lyrics.slice(0, LYRICS_BUDGET);
    while (encoder.encode(JSON.stringify(text)).length > LYRICS_BUDGET) {
        text = text.slice(0, Math.floor(text.length * 0.8));
    }
    if (text.length === lyrics.length) return text;
    const newline = text.lastIndexOf('\n');
    return newline >= 0 ? text.slice(0, newline) : text;
}

let cachedCover: { url: string; image: Promise<string | null> } | undefined;

export function activityCover(url: string | undefined) {
    if (!url) return Promise.resolve(null);
    if (cachedCover?.url !== url) {
        cachedCover = { url, image: resizeArtwork(url).catch(() => null) };
    }
    return cachedCover.image;
}

async function resizeArtwork(url: string) {
    // ArtworkStore has already loaded the track cover into a safe blob URL.
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const image = await createImageBitmap(await response.blob());
    try {
        const canvas = document.createElement('canvas');
        const crop = coverCrop(image.width, image.height);
        for (const [size, quality] of [[256, 0.82], [200, 0.68], [144, 0.58]]) {
            canvas.width = canvas.height = size;
            const context = canvas.getContext('2d');
            if (!context) return null;
            context.fillStyle = '#1f1b2b';
            context.fillRect(0, 0, size, size);
            context.drawImage(image, crop.sx, crop.sy, crop.side, crop.side, 0, 0, size, size);
            const data = canvas.toDataURL('image/jpeg', quality);
            if (data.startsWith('data:image/jpeg;base64,') && data.length <= DISCORD_ACTIVITY_COVER_LIMIT) return data;
        }
        return null;
    } finally {
        image.close();
    }
}
