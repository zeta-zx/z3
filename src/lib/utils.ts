import type { Thumbnail } from "./schema";

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

export type LrcLine = {
    time: number;
    text: string;
};

export function parseLrc(lrcText: string | null): LrcLine[] {
    if (!lrcText) return [];

    return lrcText
        .trim()
        .split('\n')
        .map(line => {
            const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
            if (!match) return null;

            const [, m, s, ms, text] = match;

            return {
                time: (+m) * 60 + (+s) + (+ms.padEnd(3, '0')) / 1000,
                text: text.trim() || '♪'
            };
        })
        .filter((line): line is { time: number; text: string } => line !== null)
        .sort((a, b) => a.time - b.time);
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

export function createPlaceholderUrl(opts: PlaceholderOpts = {}): string {
    const {
        width = 64,
        height = 64,
        format = 'svg',
        backgroundColor = null,
        textColor = null,
        text = null,
        font = Font.Lato,
    } = opts;

    let url = 'https://placehold.co';

    url += `/${width.toString()}x${height.toString()}`;

    if (backgroundColor && textColor) { // if only one specified, ignore
        url += `/${backgroundColor}/${textColor}`;
    }

    url += `.${format}`;

    const urlObj = new URL(url);

    if (text) urlObj.searchParams.append('text', text);
    if (font) urlObj.searchParams.append('font', font);

    return urlObj.toString();
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

export function getThumbnailUrl(thumbnails?: Thumbnail[], fallbackTitle: string = "N/A") {
    let thumbnail = (thumbnails || []).toSorted((a, b) => (a.height ?? 0) - (b.height ?? 0)).at(-1);
    if (thumbnail?.url) return updateThumbnailUrl(thumbnail.url);
    if (thumbnail?.data && thumbnail?.mimetype) return URL.createObjectURL(new Blob([new Uint8Array(thumbnail.data)], { type: thumbnail.mimetype }));
    return createPlaceholderUrl({
        height: 64,
        text: fallbackTitle,
    });
}