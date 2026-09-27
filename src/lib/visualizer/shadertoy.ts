/**
 * Minimal WebGL2 Shadertoy runtime (mirrors musicsync's multipass pipeline).
 *
 * Each pack lists passes; a pass renders into a named buffer or the screen and
 * reads channels from: "audio" (512×2 FFT/waveform texture), "art" / "artPrev"
 * (current and previous album art, mipmapped so high LODs act as a cheap blur),
 * or any buffer name (reading its own buffer = previous frame / feedback).
 */

import type { AudioFeatures } from "$lib/audio/analyser";
import type { RGB } from "$lib/state/artwork.svelte";
import { coverCrop } from "$lib/utils";

export type ChannelSource = "audio" | "art" | "artPrev" | string;

export interface PassDef {
    source: string;
    target: string; // buffer name or "screen"
    inputs?: Partial<Record<0 | 1 | 2 | 3, ChannelSource>>;
}

export interface ShaderPack {
    id: string;
    name: string;
    passes: PassDef[];
    /** Fraction of the canvas' CSS pixels to render at (heavy shaders go lower). */
    scale: number;
    /** Cap on frames per second (backgrounds don't need 60). */
    maxFps?: number;
    /** Frame cap while no audio is playing. */
    idleFps?: number;
}

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int iFrame;
uniform vec4 iMouse;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform float iBeat;
uniform float iLevel;
uniform float iBass;
uniform float iTravel;
uniform float iRot;
uniform vec3 iColor0;
uniform vec3 iColor1;
uniform vec3 iColor2;
uniform float iArtMix;
uniform float iIntensity;
out vec4 zetaFragColor;
`;

const FOOTER = `
void main() {
  vec4 c = vec4(0.0);
  mainImage(c, gl_FragCoord.xy);
  zetaFragColor = c;
}`;

interface CompiledPass {
    def: PassDef;
    program: WebGLProgram;
    uniforms: Map<string, WebGLUniformLocation | null>;
}

interface Buffer {
    tex: [WebGLTexture, WebGLTexture];
    fbo: [WebGLFramebuffer, WebGLFramebuffer];
    idx: number;
}

export class ShaderRunner {
    readonly gl: WebGL2RenderingContext;
    private passes: CompiledPass[] = [];
    private buffers = new Map<string, Buffer>();
    private audioTex: WebGLTexture;
    private audioData = new Uint8Array(512 * 2);
    private artTex: WebGLTexture;
    private artPrevTex: WebGLTexture;
    private vao: WebGLVertexArrayObject;
    private floatBuffers: boolean;
    private width = 0;
    private height = 0;
    private frame = 0;

    constructor(private canvas: HTMLCanvasElement, pack: ShaderPack) {
        const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: "high-performance" });
        if (!gl) throw new Error("WebGL2 unavailable");
        this.gl = gl;
        this.floatBuffers = !!gl.getExtension("EXT_color_buffer_float");

        const vbo = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        this.vao = gl.createVertexArray()!;
        gl.bindVertexArray(this.vao);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        this.audioTex = this.makeTexture(512, 2, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
        this.artTex = this.makeSolidTexture([30, 20, 60]);
        this.artPrevTex = this.makeSolidTexture([30, 20, 60]);

        for (const def of pack.passes) {
            const program = this.compile(def.source);
            this.passes.push({ def, program, uniforms: new Map() });
        }
    }

    private compile(source: string): WebGLProgram {
        const gl = this.gl;
        const make = (type: number, src: string) => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, src);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(shader);
                gl.deleteShader(shader);
                throw new Error(`Shader compile failed: ${log}`);
            }
            return shader;
        };
        const program = gl.createProgram()!;
        gl.attachShader(program, make(gl.VERTEX_SHADER, VERTEX));
        gl.attachShader(program, make(gl.FRAGMENT_SHADER, HEADER + "#line 1\n" + source + FOOTER));
        gl.bindAttribLocation(program, 0, "aPos");
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`Shader link failed: ${gl.getProgramInfoLog(program)}`);
        }
        return program;
    }

    private makeTexture(w: number, h: number, internal: number, format: number, type: number): WebGLTexture {
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    private makeSolidTexture(rgb: RGB): WebGLTexture {
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...rgb, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return tex;
    }

    /** Upload new album art (a square canvas/image). The old art becomes "artPrev". */
    setArt(image: TexImageSource | null, fallback: RGB) {
        const gl = this.gl;
        [this.artTex, this.artPrevTex] = [this.artPrevTex, this.artTex];
        gl.bindTexture(gl.TEXTURE_2D, this.artTex);
        if (image) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...fallback, 255]));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    }

    private ensureTargets(w: number, h: number) {
        if (w === this.width && h === this.height) return;
        const gl = this.gl;
        this.width = w;
        this.height = h;
        for (const b of this.buffers.values()) {
            b.tex.forEach((t) => gl.deleteTexture(t));
            b.fbo.forEach((f) => gl.deleteFramebuffer(f));
        }
        this.buffers.clear();
        const names = new Set(this.passes.map((p) => p.def.target).filter((t) => t !== "screen"));
        for (const name of names) {
            const mk = () =>
                this.floatBuffers
                    ? this.makeTexture(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)
                    : this.makeTexture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
            const tex: [WebGLTexture, WebGLTexture] = [mk(), mk()];
            const fbo = tex.map((t) => {
                const f = gl.createFramebuffer()!;
                gl.bindFramebuffer(gl.FRAMEBUFFER, f);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
                gl.clearColor(0, 0, 0, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
                return f;
            }) as [WebGLFramebuffer, WebGLFramebuffer];
            this.buffers.set(name, { tex, fbo, idx: 0 });
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    private uniform(pass: CompiledPass, name: string) {
        if (!pass.uniforms.has(name)) pass.uniforms.set(name, this.gl.getUniformLocation(pass.program, name));
        return pass.uniforms.get(name)!;
    }

    render(opts: {
        time: number;
        dt: number;
        audio: AudioFeatures;
        colors: [RGB, RGB, RGB];
        artMix: number;
        intensity: number;
    }) {
        const gl = this.gl;
        const w = this.canvas.width;
        const h = this.canvas.height;
        if (!w || !h) return;
        this.ensureTargets(w, h);

        const a = opts.audio;
        this.audioData.set(a.spectrum, 0);
        this.audioData.set(a.waveform, 512);
        gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.RED, gl.UNSIGNED_BYTE, this.audioData);

        gl.bindVertexArray(this.vao);
        const rendered = new Set<string>();
        const c = opts.colors.map((rgb) => rgb.map((v) => v / 255)) as number[][];

        for (const pass of this.passes) {
            gl.useProgram(pass.program);
            const u = (n: string) => this.uniform(pass, n);
            gl.uniform3f(u("iResolution"), w, h, 1);
            gl.uniform1f(u("iTime"), opts.time);
            gl.uniform1f(u("iTimeDelta"), opts.dt);
            gl.uniform1i(u("iFrame"), this.frame);
            gl.uniform4f(u("iMouse"), 0, 0, 0, 0);
            gl.uniform1f(u("iBeat"), a.beat);
            gl.uniform1f(u("iLevel"), a.level);
            gl.uniform1f(u("iBass"), a.bass);
            gl.uniform1f(u("iTravel"), a.travel);
            gl.uniform1f(u("iRot"), a.rot);
            gl.uniform3fv(u("iColor0"), c[0]);
            gl.uniform3fv(u("iColor1"), c[1]);
            gl.uniform3fv(u("iColor2"), c[2]);
            gl.uniform1f(u("iArtMix"), opts.artMix);
            gl.uniform1f(u("iIntensity"), opts.intensity);

            for (const [chStr, key] of Object.entries(pass.def.inputs ?? {})) {
                const ch = Number(chStr);
                gl.activeTexture(gl.TEXTURE0 + ch);
                if (key === "audio") gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
                else if (key === "art") gl.bindTexture(gl.TEXTURE_2D, this.artTex);
                else if (key === "artPrev") gl.bindTexture(gl.TEXTURE_2D, this.artPrevTex);
                else {
                    const b = this.buffers.get(key!)!;
                    // Already drawn this frame → fresh output; else previous frame.
                    gl.bindTexture(gl.TEXTURE_2D, rendered.has(key!) ? b.tex[1 - b.idx] : b.tex[b.idx]);
                }
                gl.uniform1i(u(`iChannel${ch}`), ch);
            }

            if (pass.def.target === "screen") {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            } else {
                const b = this.buffers.get(pass.def.target)!;
                gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo[1 - b.idx]);
                rendered.add(pass.def.target);
            }
            gl.viewport(0, 0, w, h);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        for (const name of rendered) this.buffers.get(name)!.idx ^= 1;
        this.frame++;
    }

    dispose() {
        this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
}

/** Crop an image to a centred square canvas, without any letterbox bars. */
export async function squareArt(url: string, size = 256): Promise<HTMLCanvasElement> {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const { sx, sy, side } = coverCrop(img.naturalWidth, img.naturalHeight);
    canvas.getContext("2d")!.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return canvas;
}
