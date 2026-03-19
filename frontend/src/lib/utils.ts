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