import { browser } from "$app/environment";
import { client } from "$lib/ephaptic";
import type { Song } from "$lib/schema";
import { coverCrop, updateThumbnailUrl } from "$lib/utils";
import { isCoverUrl } from "$lib/covers";

export type RGB = [number, number, number];

export interface Palette {
    /** Dominant colours, most prominent first — used for gradients/backgrounds. */
    colors: [RGB, RGB, RGB];
    /** A vibrant colour lifted to read well on a dark background. */
    accent: RGB;
}

export const DEFAULT_PALETTE: Palette = {
    colors: [
        [124, 77, 255],
        [236, 72, 153],
        [34, 26, 72],
    ],
    accent: [180, 155, 255],
};

/* ------------------------------ colour maths ------------------------------ */

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): RGB {
    if (s === 0) return [l * 255, l * 255, l * 255].map(Math.round) as RGB;
    const hue = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((v) => Math.round(v * 255)) as RGB;
}

const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Bucket the pixels of a small image and pick distinct, prominent colours. */
export function extractPalette(pixels: Uint8ClampedArray): Palette {
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 128) continue;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        bucket.n++; bucket.r += r; bucket.g += g; bucket.b += b;
        buckets.set(key, bucket);
    }

    const swatches = [...buckets.values()].map((b) => {
        const rgb: RGB = [b.r / b.n, b.g / b.n, b.b / b.n].map(Math.round) as RGB;
        const [, s, l] = rgbToHsl(rgb);
        // Favour colourful, mid-lightness swatches over greys and near-black/white.
        const score = b.n * (0.35 + s) * (1 - Math.abs(l - 0.5) * 1.1);
        return { rgb, n: b.n, s, l, score };
    });
    if (!swatches.length) return DEFAULT_PALETTE;

    swatches.sort((a, b) => b.score - a.score);
    const picked: RGB[] = [];
    for (const sw of swatches) {
        if (picked.every((p) => dist(p, sw.rgb) > 56)) picked.push(sw.rgb);
        if (picked.length === 3) break;
    }
    while (picked.length < 3) {
        const [h, s, l] = rgbToHsl(picked[0] ?? DEFAULT_PALETTE.colors[0]);
        picked.push(hslToRgb((h + 0.08 * picked.length) % 1, s, Math.max(0.12, l * 0.6)));
    }

    // Accent: the most vibrant swatch, pushed to a readable lightness.
    const vibrant = [...swatches].sort((a, b) => b.s * Math.sqrt(b.n) - a.s * Math.sqrt(a.n))[0];
    const [h, s] = rgbToHsl(vibrant.rgb);
    const accent = s < 0.12 ? hslToRgb(0.72, 0.15, 0.82) : hslToRgb(h, Math.min(0.95, Math.max(0.55, s)), 0.72);

    return { colors: picked as [RGB, RGB, RGB], accent };
}

const css = (c: RGB) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

/* ---------------------------------- store --------------------------------- */

function bestSource(track: Song): { data?: Uint8Array; mimetype?: string; url?: string } | null {
    const local = track.thumbnails?.find((t) => isCoverUrl(t.url));
    if (local?.url) return { url: local.url };
    const thumbs = [...(track.thumbnails || [])].sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    const withData = thumbs.findLast((t) => t.data?.length);
    if (withData?.data) return { data: withData.data, mimetype: withData.mimetype || "image/jpeg" };
    const withUrl = thumbs.findLast((t) => t.url);
    if (withUrl?.url) return { url: updateThumbnailUrl(withUrl.url) };
    return null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

/**
 * A heavily blurred, saturated copy of the cover as a tiny image. Blurred once
 * here; stretched full-screen it reads as a huge soft blur at no ongoing cost.
 */
function blurredCover(img: HTMLImageElement): string {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const { sx, sy, side } = coverCrop(img.naturalWidth, img.naturalHeight);
    ctx.filter = "blur(7px) saturate(1.7)";
    // Overdraw past the edges so the blur doesn't pull in transparent borders.
    ctx.drawImage(img, sx, sy, side, side, -12, -12, size + 24, size + 24);
    return canvas.toDataURL("image/png");
}

interface Artwork {
    url: string;
    blurred: string;
    palette: Palette;
    brightness: number;
}

/** Average perceived brightness (0..1) of RGBA pixels. */
function averageLuminance(pixels: Uint8ClampedArray): number {
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    return sum / (pixels.length / 4) / 255;
}

class ArtworkStore {
    /** Same-origin blob URL of the current cover (safe for canvas / WebGL). */
    url = $state<string | null>(null);
    /** Tiny pre-blurred cover (data URL) for full-screen backgrounds. */
    blurred = $state<string | null>(null);
    /** Average brightness of the cover, 0..1 (backgrounds darken bright art). */
    brightness = $state(0.3);
    palette = $state<Palette>(DEFAULT_PALETTE);
    /** Bumped whenever the artwork changes (for texture re-uploads). */
    version = $state(0);

    private key: string | null = null;
    private blobs = new Map<string, Artwork>();

    async update(track: Song | null) {
        const key = track?.id ?? null;
        if (key === this.key) return;
        this.key = key;

        if (!track) {
            this.apply(null);
            return;
        }

        const cached = this.blobs.get(track.id);
        if (cached) {
            this.apply(cached);
            return;
        }

        try {
            const source = bestSource(track);
            if (!source) throw new Error("no artwork");

            let bytes = source.data;
            let mimetype = source.mimetype;
            if (!bytes && isCoverUrl(source.url)) {
                // Our own cover protocol is CORS-enabled: fetch it directly.
                const res = await fetch(source.url!);
                if (!res.ok) throw new Error("cover fetch failed");
                bytes = new Uint8Array(await res.arrayBuffer());
                mimetype = res.headers.get("Content-Type") ?? "image/jpeg";
            } else if (!bytes && source.url) {
                const fetched = await client.fetchImage(source.url);
                if (!fetched) throw new Error("artwork fetch failed");
                bytes = fetched.data;
                mimetype = fetched.mimetype;
            }

            const url = URL.createObjectURL(new Blob([new Uint8Array(bytes!)], { type: mimetype }));
            const img = await loadImage(url);

            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 40;
            const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
            // Sample the centre square, minus any baked-in letterbox bars.
            const { sx, sy, side } = coverCrop(img.naturalWidth, img.naturalHeight);
            ctx.drawImage(img, sx, sy, side, side, 0, 0, 40, 40);
            const pixels = ctx.getImageData(0, 0, 40, 40).data;
            const art: Artwork = { url, blurred: blurredCover(img), palette: extractPalette(pixels), brightness: averageLuminance(pixels) };

            this.blobs.set(track.id, art);
            if (this.blobs.size > 24) {
                const [oldKey, old] = this.blobs.entries().next().value!;
                if (old.url !== this.url) URL.revokeObjectURL(old.url);
                this.blobs.delete(oldKey);
            }

            if (this.key === track.id) this.apply(art);
        } catch {
            if (this.key === track.id) this.apply(null);
        }
    }

    /** Re-read a track's artwork (e.g. after its cover was repaired). */
    refresh(track: Song) {
        this.blobs.delete(track.id);
        if (this.key === track.id) this.key = null;
        return this.update(track);
    }

    private apply(art: Artwork | null) {
        const palette = art?.palette ?? DEFAULT_PALETTE;
        this.url = art?.url ?? null;
        this.blurred = art?.blurred ?? null;
        this.brightness = art?.brightness ?? 0.3;
        this.palette = palette;
        this.version++;
        if (!browser) return;
        const root = document.documentElement.style;
        root.setProperty("--art-1", css(palette.colors[0]));
        root.setProperty("--art-2", css(palette.colors[1]));
        root.setProperty("--art-3", css(palette.colors[2]));
        root.setProperty("--accent", css(palette.accent));
    }
}

export const artworkState = new ArtworkStore();
