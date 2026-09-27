import type { ShaderPack } from "./shadertoy";

import halo from "./shaders/halo.glsl?raw";
import cubes from "./shaders/cubes.glsl?raw";
import gizaA from "./shaders/neon-giza-a.glsl?raw";
import gizaB from "./shaders/neon-giza-b.glsl?raw";
import gizaImage from "./shaders/neon-giza-image.glsl?raw";

/** Full-screen visualizers (the two raymarchers are mrange's CC0 Shadertoys, via musicsync). */
export const VISUALIZER_PACKS: ShaderPack[] = [
    {
        id: "halo",
        name: "Halo",
        scale: 0.75,
        passes: [{ source: halo, target: "screen", inputs: { 0: "audio", 1: "art" } }],
    },
    {
        id: "neon-giza",
        name: "Neon Giza",
        scale: 0.5,
        passes: [
            { source: gizaA, target: "A", inputs: { 0: "audio" } },
            { source: gizaB, target: "B", inputs: { 0: "A", 1: "B" } },
            { source: gizaImage, target: "screen", inputs: { 0: "B" } },
        ],
    },
    {
        id: "cubes",
        name: "Cubes",
        scale: 0.5,
        passes: [{ source: cubes, target: "screen", inputs: { 0: "audio" } }],
    },
];
