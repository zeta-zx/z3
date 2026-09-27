import { crossfade } from "svelte/transition";
import { cubicOut } from "svelte/easing";

/**
 * The player capsule's artwork and the full-screen player's artwork are the
 * same "object": sending/receiving with a shared key makes it fly and grow
 * between the two instead of cutting.
 */
export const [sendArt, receiveArt] = crossfade({
    duration: 560,
    easing: cubicOut,
    fallback: (node) => ({
        duration: 300,
        css: (t) => `opacity: ${t}; transform: scale(${0.9 + 0.1 * t})`,
    }),
});
