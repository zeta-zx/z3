import type { Thumbnail } from "./schema";
import { isCoverUrl } from "./covers";

export function toTitleCase(str: string): string {
    return str
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export function randomChoice<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

export type LrcWord = {
    time: number;
    text: string;
};

export type LrcLine = {
    time: number;
    text: string;
    /** Per-word timings, when the source is "enhanced" LRC (`<mm:ss.xx>word`). */
    words?: LrcWord[];
};

const stampToSeconds = (m: string, s: string, ms?: string) =>
    (+m) * 60 + (+s) + (ms ? +ms.padEnd(3, '0') / 1000 : 0);

/** Split an enhanced-LRC line body into timed words; undefined when it has none. */
function parseWords(body: string): LrcWord[] | undefined {
    const re = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g;
    const marks = [...body.matchAll(re)];
    if (!marks.length) return undefined;
    const words: LrcWord[] = [];
    marks.forEach((mark, i) => {
        const start = mark.index! + mark[0].length;
        const end = i + 1 < marks.length ? marks[i + 1].index! : body.length;
        const text = body.slice(start, end);
        if (text.trim()) words.push({ time: stampToSeconds(mark[1], mark[2], mark[3]), text });
    });
    return words.length ? words : undefined;
}

export function parseLrc(lrcText: string | null): LrcLine[] {
    if (!lrcText) return [];

    return lrcText
        .trim()
        .split('\n')
        .flatMap(line => {
            // A line may carry multiple timestamps, e.g. "[00:12.00][01:04.00]text".
            const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
            if (!stamps.length) return [];

            const body = line.replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '');
            const words = parseWords(body);
            const text = body.replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim() || '♪';
            return stamps.map(([, m, s, ms]) => ({
                time: stampToSeconds(m, s, ms),
                text,
                ...(words && stamps.length === 1 ? { words } : {}),
            }));
        })
        .sort((a, b) => a.time - b.time);
}

/** Plain lyrics as display lines (section tags like `[Chorus]` removed). */
export function plainLyricLines(raw: string | null): string[] {
    if (!raw) return [];
    return raw
        .split('\n')
        .map(l => l.replace(/^\[[^\]]*\]\s*/, '').trim())
        .filter(l => l.length > 0);
}

/** True when the text contains LRC-style `[mm:ss]` timestamps. */
export function isSyncedLyrics(text: string | null): boolean {
    return !!text && /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(text);
}

/**
 * Turn raw lyrics text into display lines for the ticker.
 *
 * - Time-synced (LRC) lyrics are parsed as-is.
 * - Plain lyrics (no timestamps) are spread evenly across `durationSec`, so the
 *   ticker still scrolls through them roughly in time with the song instead of
 *   showing nothing. lrclib and other sources only have plain lyrics for a large
 *   share of tracks, so this is the difference between "No lyrics available" and
 *   actually seeing them.
 *
 * Returns `[]` only when there is no usable text at all.
 */
export function buildLyricLines(raw: string | null, durationSec: number): LrcLine[] {
    if (!raw) return [];

    const synced = parseLrc(raw);
    if (synced.length) return synced;

    const lines = raw
        .split('\n')
        .map(l => l.replace(/^\[[^\]]*\]\s*/, '').trim())
        .filter(l => l.length > 0);
    if (!lines.length) return [];

    // Fall back to a rough ~4s/line when the real duration isn't known yet
    // (audio metadata not loaded); the ticker recomputes once it is.
    const total = durationSec && isFinite(durationSec) && durationSec > 0 ? durationSec : lines.length * 4;
    const intro = Math.min(2, total * 0.02);
    const step = (total - intro) / lines.length;
    return lines.map((text, i) => ({ time: intro + i * step, text }));
}

export function formatTime(seconds: number) {
    if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    const m = Math.floor(seconds / 60);
    if (seconds <= 60**2) return `${m}:${s}`;
    const minutes = Math.floor(m % 60).toString().padStart(2, '0');
    const h = Math.floor(m / 60);
    return h ? `${h}:${minutes}:${s}` : `${m}:${s}`;
}

export const pad = (n: number) => n.toString().padStart(2, '0');

export function formatDate(dateData: any): string {
    const date = new Date(dateData);
    const now = new Date();

    const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    if (date.toDateString() === now.toDateString()) {
        return `Today at ${timeStr}`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    
    if (date.toDateString() === yesterday.toDateString()) {
        return `Yesterday at ${timeStr}`;
    }

    const sixDaysAgo = new Date(now);
    sixDaysAgo.setDate(now.getDate() - 6);

    sixDaysAgo.setHours(0, 0, 0, 0);

    if (date > sixDaysAgo) {
        const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
        return `${weekday} at ${timeStr}`;
    }

    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const year = date.getFullYear();

    return `${day}/${month}/${year} at ${timeStr}`;
}

export function getCSSVar(variable: string): string {
    return getComputedStyle(document.documentElement)
                .getPropertyValue(variable)
                .trim();
}

export enum Font {
    Lato = "Lato",
    Lora = "Lora",
    Montserrat = "Montserrat",
    NotoSans = "Noto Sans",
    OpenSans = "Open Sans",
    Oswald = "Oswald",
    PlayfairDisplay = "Playfair Display",
    Poppins = "Poppins",
    PTSans = "PT Sans",
    Raleway = "Raleway",
    Roboto = "Roboto",
    SourceSansPro = "Source Sans Pro"
}

export interface PlaceholderOpts {
    width?: number;
    height?: number;
    format?: string;
    backgroundColor?: string;
    textColor?: string;
    text?: string;
    font?: Font;

}

function hashString(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const placeholderCache = new Map<string, string>();

/**
 * A generated cover: a gradient seeded by the text, with its initial. Built
 * locally as an SVG data URI so it works offline (previously placehold.co).
 */
export function createPlaceholderUrl(opts: PlaceholderOpts = {}): string {
    const text = (opts.text ?? '').trim();
    const key = text;
    const cached = placeholderCache.get(key);
    if (cached) return cached;

    const h = hashString(text || 'zeta');
    const hue1 = h % 360;
    const hue2 = (hue1 + 40 + ((h >> 9) % 80)) % 360;
    const initial = text === '+' ? '+' : ([...text.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '♪').toUpperCase();
    const escaped = initial.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="hsl(${hue1} 62% 46%)"/><stop offset="1" stop-color="hsl(${hue2} 70% 22%)"/>` +
        `</linearGradient><radialGradient id="r" cx="0.25" cy="0.2" r="0.9">` +
        `<stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
        `<rect width="100" height="100" fill="url(#g)"/><rect width="100" height="100" fill="url(#r)"/>` +
        `<text x="50" y="50" dy=".35em" text-anchor="middle" font-family="Plus Jakarta Sans Variable, Inter Variable, system-ui, sans-serif" ` +
        `font-weight="700" font-size="42" fill="#fff" fill-opacity=".92">${escaped}</text></svg>`;

    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    placeholderCache.set(key, url);
    return url;
}

/** "1 hr 12 min" / "42 min" / "3 min 10 sec" style total duration. */
export function formatLongDuration(seconds: number): string {
    if (!isFinite(seconds) || seconds <= 0) return '0 min';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h) return `${h} hr ${m} min`;
    if (m >= 10) return `${m} min`;
    const s = Math.floor(seconds % 60);
    return m ? `${m} min ${s} sec` : `${s} sec`;
}

/**
 * A plain copy of a song without embedded cover bytes, for backend calls that
 * only need to identify it (lyrics, radio). Keeps IPC messages tiny.
 */
export function slimSong<T extends { thumbnails: Thumbnail[] }>(song: T): T {
    return {
        ...song,
        thumbnails: song.thumbnails.filter((t) => t.url).map(({ url, width, height }) => ({ url, width, height })),
    };
}

/**
 * The square region of a cover image worth looking at. Covers are cropped to
 * their centre square; YouTube's 4:3 "hqdefault" frames additionally have
 * black bars baked in above/below a 16:9 picture, which are excluded.
 */
export function coverCrop(width: number, height: number): { sx: number; sy: number; side: number } {
    let h = height;
    if (Math.abs(width / height - 4 / 3) < 0.02 && width <= 640) h = (width * 9) / 16;
    const side = Math.min(width, h);
    return { sx: (width - side) / 2, sy: (height - side) / 2, side };
}

/**
 * Identity for "the same song" across different uploads/ids:
 * "title|first artist", ignoring "(feat. …)", "[Remastered]" and the like.
 */
export function songKey(t: { title: string; artists: { name: string }[] }): string {
    const title = t.title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/\s+/g, " ").trim();
    return `${title}|${(t.artists[0]?.name ?? "").toLowerCase().trim()}`;
}

export function artistNames(song: { artists: { name: string }[] } | null | undefined): string {
    return song?.artists.map((a) => a.name).filter(Boolean).join(', ') || 'Unknown artist';
}

export function shuffle<T>(arr: T[]): T[] {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

export function toTitleCaseFromSnake(str: string): string {
    return str
        .split("_")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
    let timer: ReturnType<typeof setTimeout>;

    return function (...args: Parameters<T>) {
        clearTimeout(timer);

        timer = setTimeout(() => {
            fn(...args);
        }, delay);
    };
}

export function updateThumbnailUrl(url?: string): string {
    // e.g. https://yt3.googleusercontent.com/DoelpD8M14QV2ffMecjMcGQyJO9xjb-j0clL6Rfz7QQMF4JrqLf6nFzx3i7Y1J-EWjZEnYdjzZABMWEo=w120-h120-l90-rj
    if (!url) return '';
    if (url.includes('yt3.googleusercontent.com')) return url.replace('w120', 'w512').replace('h120', 'h512'); // hacky!
    else if (url.includes('c.saavncdn.com')) return url.replace('50x50', '500x500');
    else return url;
}

// Cache object URLs so repeated reactive reads of the same thumbnail don't
// leak a fresh blob URL every render.
const objectUrlCache = new WeakMap<object, string>();

function dataThumbnailUrl(data: Uint8Array, mimetype: string): string {
    const cached = objectUrlCache.get(data);
    if (cached) return cached;
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mimetype }));
    objectUrlCache.set(data, url);
    return url;
}

export function getThumbnailUrl(thumbnails?: Thumbnail[], fallbackTitle: string = "N/A") {
    // The embedded cover (served on demand) works offline: prefer it.
    const local = thumbnails?.find((t) => isCoverUrl(t.url));
    if (local?.url) return local.url;
    const sorted = (thumbnails || []).toSorted((a, b) => (a.height ?? 0) - (b.height ?? 0));
    // Then embedded bytes (search results played from tags), then remote URLs.
    const withData = sorted.findLast((t) => t.data?.length);
    if (withData?.data) return dataThumbnailUrl(withData.data, withData.mimetype || 'image/jpeg');
    const thumbnail = sorted.findLast((t) => t.url);
    if (thumbnail?.url) return updateThumbnailUrl(thumbnail.url);
    return createPlaceholderUrl({
        height: 64,
        text: fallbackTitle,
    });
}