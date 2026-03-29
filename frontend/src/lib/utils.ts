import type { AudioStream } from "$lib/schema";

export function toTitleCase(str: string): string {
    return str
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export type LrcLine = {
    time: number;
    text: string;
};

export function parseLrc(lrcText: string): LrcLine[] {
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
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

export function getMimeType(stream: AudioStream): string {
    if (stream.ext === "m4a") return "audio/mp4";
    if (stream.ext === "webm") return "audio/webm";
    if (stream.ext === "mp3") return "audio/mpeg";
    if (stream.ext === "opus") return "audio/ogg; codecs=opus";

    return "";
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