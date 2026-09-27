import { playerState } from "$lib/state/player.svelte";
import { isSyncedLyrics, parseLrc, plainLyricLines, type LrcLine, type LrcWord } from "$lib/utils";

/** A gap this long between lines gets an "instrumental" indicator. */
const INTERLUDE_MIN = 5.5;

export interface DisplayLine extends LrcLine {
    /** When this line ends (next line's start, or the song's end). */
    end: number;
    /** An instrumental break rather than a sung line. */
    interlude?: boolean;
    /** Word timings were estimated (no word-level data in the source). */
    estimated?: boolean;
}

/**
 * Word timings for a line that only has a start time: spread the line's
 * duration across its words in proportion to their length. Singers usually
 * finish a line a little before the next begins, so the sweep uses ~90% of it.
 */
function estimateWords(text: string, start: number, end: number): LrcWord[] {
    const tokens = text.match(/\S+\s*/g) ?? [text];
    const span = Math.max(0.4, (end - start) * 0.9);
    const weights = tokens.map((t) => t.trim().length + 1.5);
    const total = weights.reduce((a, b) => a + b, 0);
    let at = start;
    return tokens.map((token, i) => {
        const word = { time: at, text: token };
        at += (weights[i] / total) * span;
        return word;
    });
}

class LyricsStore {
    /** Raw lyrics for the current track: its own synced lyrics win, else whatever was fetched. */
    raw = $derived.by(() => {
        const embedded = playerState.currentTrack?.lyrics ?? null;
        if (isSyncedLyrics(embedded)) return embedded;
        return playerState.lyrics ?? embedded;
    });

    synced = $derived(isSyncedLyrics(this.raw));

    /** Timed lines with interludes inserted (synced lyrics only). */
    lines = $derived.by<DisplayLine[]>(() => {
        if (!this.synced) return [];
        const parsed = parseLrc(this.raw).filter((l) => l.text !== "♪" || l.words);
        const duration = playerState.duration || playerState.currentTrack?.duration || 0;
        const out: DisplayLine[] = [];

        // Intro before the first line.
        if (parsed.length && parsed[0].time > INTERLUDE_MIN) {
            out.push({ time: 0, end: parsed[0].time, text: "", interlude: true });
        }
        parsed.forEach((line, i) => {
            const next = parsed[i + 1]?.time ?? Math.max(duration, line.time + 4);
            // A sung line rarely lasts more than ~7s; the rest of a long gap is instrumental.
            const lineEnd = next - line.time > INTERLUDE_MIN + 2 ? line.time + Math.min(7, (next - line.time) * 0.5) : next;
            // Real word timings when the source has them; otherwise estimate.
            const words = line.words ?? estimateWords(line.text, line.time, lineEnd);
            out.push({ ...line, words, estimated: !line.words, end: lineEnd });
            if (lineEnd < next && next - lineEnd >= INTERLUDE_MIN - 1 && parsed[i + 1]) {
                out.push({ time: lineEnd, end: next, text: "", interlude: true });
            }
        });
        return out;
    });

    /** Plain (untimed) lyric lines, shown statically. */
    plain = $derived(this.synced ? [] : plainLyricLines(this.raw));

    /** Index of the line being sung right now (-1 before the first line). */
    active = $derived.by(() => {
        const t = playerState.currentTime + 0.12; // tiny lead so highlights land on the beat
        const lines = this.lines;
        let lo = 0, hi = lines.length - 1, found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lines[mid].time <= t) {
                found = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        return found;
    });

    has = $derived(this.lines.length > 0 || this.plain.length > 0);
}

export const lyricsState = new LyricsStore();
