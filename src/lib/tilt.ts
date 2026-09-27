import type { Action } from "svelte/action";

/**
 * Lean an element toward the cursor in 3D, with a moving specular highlight
 * (exposed as --mx/--my in %). Settles back smoothly on leave.
 */
export const tilt: Action<HTMLElement, { max?: number } | undefined> = (node, opts) => {
    let max = opts?.max ?? 8;
    let frame = 0;

    function move(e: PointerEvent) {
        const r = node.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            node.style.setProperty("--rx", `${(0.5 - y) * max}deg`);
            node.style.setProperty("--ry", `${(x - 0.5) * max}deg`);
            node.style.setProperty("--mx", `${x * 100}%`);
            node.style.setProperty("--my", `${y * 100}%`);
        });
    }

    function leave() {
        cancelAnimationFrame(frame);
        node.style.setProperty("--rx", "0deg");
        node.style.setProperty("--ry", "0deg");
    }

    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        node.addEventListener("pointermove", move);
        node.addEventListener("pointerleave", leave);
    }

    return {
        update(next) {
            max = next?.max ?? 8;
        },
        destroy() {
            cancelAnimationFrame(frame);
            node.removeEventListener("pointermove", move);
            node.removeEventListener("pointerleave", leave);
        },
    };
};
