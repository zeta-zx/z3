/**
 * Real-time audio analysis for visuals.
 *
 * The <audio> element is routed through Web Audio:
 *
 *     element ─► source ─┬─► analyser            (full-level signal for visuals)
 *                        └─► gain ─► destination (volume is applied here)
 *
 * Volume lives on the gain node (the element itself stays at 1.0) so the
 * visuals react to the music, not to the volume slider.
 *
 * Feature extraction is a port of musicsync's: a Shadertoy-style 512×2 audio
 * texture (row 0 = smoothed FFT, row 1 = waveform) plus smoothed loudness, a
 * bass-onset "beat" detector and two integrated motion phases.
 */

export interface AudioFeatures {
    /** 512 bytes: smoothed spectrum (0–255), Shadertoy row 0. */
    spectrum: Uint8Array;
    /** 512 bytes: waveform centred on 128, Shadertoy row 1. */
    waveform: Uint8Array;
    /**
     * 512 bytes: the spectrum with each band's long-term average evened out.
     * Bass naturally carries far more energy than treble, so on the raw
     * spectrum the low bands always stand taller; here every band gets a gain
     * that brings its average in line with the overall average. Peaks and
     * quiet moments are kept as they are, just at an even baseline.
     */
    equalized: Uint8Array;
    /** 0..1 smoothed loudness. */
    level: number;
    /** 0..1 bass band energy. */
    bass: number;
    /** 0..1 kick/onset punch (instant attack, fast decay). */
    beat: number;
    /** Accumulated audio-driven forward distance. */
    travel: number;
    /** Accumulated audio-driven rotation phase. */
    rot: number;
    /** False when no audio graph is available (visuals should idle). */
    live: boolean;
}

const BINS = 512;

class Analyser {
    private ctx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private gain: GainNode | null = null;
    private filters: BiquadFilterNode[] = [];
    private compressor: DynamicsCompressorNode | null = null;
    private output: AudioNode | null = null;
    private levels = [0, 0, 0, 0, 0];
    private leveling = false;
    private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
    private current: HTMLMediaElement | null = null;

    private freq = new Uint8Array(1024);
    private time = new Float32Array(2048);
    private volume = 1;

    readonly features: AudioFeatures = {
        spectrum: new Uint8Array(BINS),
        waveform: new Uint8Array(BINS).fill(128),
        equalized: new Uint8Array(BINS),
        level: 0,
        bass: 0,
        beat: 0,
        travel: 0,
        rot: 0,
        live: false,
    };

    private bassFast = 0;
    private bassSlow = 0;
    // Per-band running average (0..1), for evening out the spectrum.
    private bandMean = new Float32Array(BINS).fill(0.3);
    private lastUpdate = 0;
    private subscribers = new Set<(f: AudioFeatures, dt: number) => void>();
    private raf = 0;

    /** Route the audible player through the graph (idempotent per element). */
    attach(element: HTMLMediaElement) {
        this.attachElement(element, false);
    }

    /**
     * Route a muted/hidden element only into the analyser. Android's Media3
     * player is native and therefore cannot feed Web Audio; this path lets a
     * remote device decode the same song silently for FFT-driven visuals.
     */
    attachSilent(element: HTMLMediaElement) {
        this.attachElement(element, true);
    }

    detach(element: HTMLMediaElement) {
        if (this.current !== element) return;
        try { this.sources.get(element)?.disconnect(); } catch { /* already disconnected */ }
        this.current = null;
        this.features.live = false;
    }

    private attachElement(element: HTMLMediaElement, silent: boolean) {
        if (this.current === element) return;
        try {
            this.ctx ??= new AudioContext({ latencyHint: "playback" });
            if (!this.analyser) {
                this.analyser = this.ctx.createAnalyser();
                this.analyser.fftSize = 2048;
                this.analyser.smoothingTimeConstant = 0.55;
                this.analyser.minDecibels = -100;
                this.analyser.maxDecibels = -30;
                this.gain = this.ctx.createGain();
                this.gain.connect(this.ctx.destination);
                this.compressor = this.ctx.createDynamicsCompressor();
                this.compressor.threshold.value = -20;
                this.compressor.ratio.value = 4;
                this.compressor.release.value = 0.7;
                this.compressor.connect(this.gain);
                this.filters = [60, 230, 910, 3600, 14000].map((frequency, index) => {
                    const filter = this.ctx!.createBiquadFilter();
                    filter.type = index === 0 ? 'lowshelf' : index === 4 ? 'highshelf' : 'peaking';
                    filter.frequency.value = frequency;
                    filter.Q.value = 0.9;
                    return filter;
                });
                this.filters.slice(0, -1).forEach((filter, index) => filter.connect(this.filters[index + 1]));
                this.setEffects(this.levels, this.leveling);
            }
            let source = this.sources.get(element);
            if (!source) {
                source = this.ctx.createMediaElementSource(element);
                this.sources.set(element, source);
            }
            source.connect(this.analyser);
            if (!silent) source.connect(this.filters[0] ?? this.gain!);
            element.volume = 1;
            this.current = element;
            this.applyVolume();
        } catch (err) {
            // No Web Audio: fall back to plain element volume, no visuals.
            console.warn("[analyser] Web Audio unavailable:", err);
            this.current = element;
            this.ctx = null;
            this.applyVolume();
        }
    }

    setEffects(levels: number[], leveling: boolean) {
        this.levels = levels;
        this.leveling = leveling;
        if (!this.ctx || !this.gain) return;
        this.filters.forEach((filter, index) => filter.gain.setTargetAtTime(levels[index] ?? 0, this.ctx!.currentTime, 0.02));
        const last = this.filters.at(-1);
        const output = leveling ? this.compressor : this.gain;
        if (last && output && output !== this.output) {
            last.disconnect();
            last.connect(output);
            this.output = output;
        }
    }

    /** Browsers start contexts suspended until playback; call on play. */
    resume() {
        if (this.ctx?.state === "suspended") this.ctx.resume().catch(() => {});
    }

    /** 0..1 linear slider value; mapped to a perceptual gain curve. */
    setVolume(volume: number) {
        this.volume = Math.min(1, Math.max(0, volume));
        this.applyVolume();
    }

    private applyVolume() {
        const gain = this.volume * this.volume;
        if (this.gain && this.ctx) {
            this.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.015);
        } else if (this.current) {
            this.current.volume = gain;
        }
    }

    /** Register a per-frame consumer; the analysis loop runs while any exist. */
    subscribe(fn: (f: AudioFeatures, dt: number) => void): () => void {
        this.subscribers.add(fn);
        if (!this.raf) {
            this.lastUpdate = performance.now();
            this.raf = requestAnimationFrame(this.loop);
        }
        return () => {
            this.subscribers.delete(fn);
            if (!this.subscribers.size && this.raf) {
                cancelAnimationFrame(this.raf);
                this.raf = 0;
            }
        };
    }

    private loop = (now: number) => {
        const dt = Math.min(0.1, Math.max(1e-4, (now - this.lastUpdate) / 1000));
        this.lastUpdate = now;
        this.update(dt);
        for (const fn of this.subscribers) fn(this.features, dt);
        this.raf = this.subscribers.size ? requestAnimationFrame(this.loop) : 0;
    };

    private update(dt: number) {
        const f = this.features;
        const analyser = this.analyser;
        const playing = !!this.current && !this.current.paused && !!analyser;

        let level = 0;
        let bass = 0;

        if (playing && analyser) {
            analyser.getByteFrequencyData(this.freq);
            analyser.getFloatTimeDomainData(this.time);

            // Row 0: first 512 bins (≈0–12 kHz), fast attack / slow release.
            for (let i = 0; i < BINS; i++) {
                f.spectrum[i] = Math.max(this.freq[i], f.spectrum[i] * 0.82);
            }

            // Equalized: give each band a gain that brings its ~8s average to the
            // overall average. Gains are capped, so a band that's basically
            // silent in this song stays low instead of being boosted into noise.
            const meanRate = Math.min(1, dt / 8);
            let overall = 0;
            for (let i = 0; i < BINS; i++) {
                this.bandMean[i] += (f.spectrum[i] / 255 - this.bandMean[i]) * meanRate;
                overall += this.bandMean[i];
            }
            overall /= BINS;
            for (let i = 0; i < BINS; i++) {
                const gain = Math.min(2.2, Math.max(0.55, overall / Math.max(0.02, this.bandMean[i])));
                f.equalized[i] = Math.min(255, Math.round(f.spectrum[i] * gain));
            }
            // Row 1: most recent 512 samples of the waveform.
            const offset = this.time.length - BINS;
            let sumSq = 0;
            for (let i = 0; i < BINS; i++) {
                const v = this.time[offset + i];
                sumSq += v * v;
                f.waveform[i] = Math.max(0, Math.min(255, Math.round((0.5 + 0.6 * v) * 255)));
            }

            // Bass band (30–150 Hz) energy from the dB-scaled bins.
            const hzPerBin = (this.ctx?.sampleRate ?? 48000) / analyser.fftSize;
            const lo = Math.max(1, Math.floor(30 / hzPerBin));
            const hi = Math.max(lo + 1, Math.ceil(150 / hzPerBin));
            let bassSum = 0;
            for (let i = lo; i < hi; i++) bassSum += (this.freq[i] / 255) ** 2;
            bass = Math.sqrt(bassSum / (hi - lo));

            const rms = Math.sqrt(sumSq / BINS + 1e-12);
            level = Math.tanh(rms * 2.4);
            f.live = true;
        } else {
            // Idle: let everything settle smoothly instead of freezing.
            for (let i = 0; i < BINS; i++) {
                f.spectrum[i] = Math.floor(f.spectrum[i] * 0.9);
                f.equalized[i] = Math.floor(f.equalized[i] * 0.9);
                f.waveform[i] = Math.round(128 + (f.waveform[i] - 128) * 0.85);
            }
            f.live = false;
        }

        f.level += (level - f.level) * Math.min(1, dt * 8);
        f.bass = bass;

        // Fast/slow bass envelopes → volume-independent onset (kick) detection.
        this.bassFast += (bass - this.bassFast) * Math.min(1, dt * 45);
        this.bassSlow += (bass - this.bassSlow) * Math.min(1, dt * 4);
        const onset = (this.bassFast - this.bassSlow) / (this.bassSlow + 0.02);
        const beatRaw = Math.min(1, Math.max(0, (onset - 0.18) * 0.8));
        f.beat = Math.max(f.beat * Math.exp(-dt * 9), beatRaw);

        // Integrated motion: base rates keep things alive, audio speeds them up.
        f.rot += dt * (0.25 + 1.4 * f.level);
        f.travel += dt * (6 * f.level + 2.5 * f.beat);
    }
}

export const analyser = new Analyser();
