<script lang="ts">
    /**
     * The app's own title bar. The OS title bar is hidden (electron/main.ts);
     * this strip is the window's drag handle, with the native window buttons
     * (traffic lights / minimise-maximise-close) drawn over it by the system.
     * See `--wc-left` / `--wc-right` in styles.css for the space they take.
     */
    import { client } from "$lib/ephaptic";
    import Icon from "$lib/components/Icon.svelte";
    import { wayship } from "$lib/state/wayship.svelte";
    import { peers } from "$lib/state/peers.svelte";
    import { onMount } from "svelte";

    let { hidden = false }: { hidden?: boolean } = $props();

    // Only Linux draws its own window buttons; macOS and Windows use the native ones.
    const linux = typeof document !== "undefined" && document.documentElement.dataset.os === "linux";
    let maximized = $state(false);
    const wayshipLink = $derived(peers.links.find((link) => !!link.wayshipPeerId));
    const wayshipStatus = $derived(wayshipLink?.connected ? 'Synced' : wayshipLink ? 'Connecting…' : wayship.connected ? 'Online' : 'Offline');

    $effect(() => {
        if (typeof document === "undefined") return;
        document.documentElement.dataset.maximized = maximized ? "true" : "false";
    });

    onMount(() => {
        if (!linux) return;
        let warned = false;
        const sync = () =>
            client
                .windowIsMaximized()
                .then((m) => (maximized = m))
                .catch(() => {
                    if (warned) return;
                    warned = true;
                    // The renderer hot-reloaded but the main process didn't:
                    // these routes only exist after a full restart.
                    console.warn("[zeta] Window controls unavailable — restart the app so the main process reloads.");
                });
        sync();
        window.addEventListener("resize", sync);
        return () => window.removeEventListener("resize", sync);
    });

    async function toggleMaximize() {
        maximized = await client.windowMaximizeToggle().catch(() => maximized);
    }

    async function startResize(edge: string, e: PointerEvent) {
        const grip = e.currentTarget as HTMLElement;
        // Captured so moves (and the release) still arrive once the cursor
        // leaves the window.
        grip.setPointerCapture(e.pointerId);
        await client.windowResizeStart(edge).catch(() => {});
        const move = (ev: PointerEvent) => void client.windowResizeMove(ev.screenX, ev.screenY).catch(() => {});
        const stop = () => {
            void client.windowResizeEnd().catch(() => {});
            grip.removeEventListener("pointermove", move);
            grip.removeEventListener("pointerup", stop);
            grip.removeEventListener("pointercancel", stop);
            grip.removeEventListener("lostpointercapture", stop);
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", stop);
        grip.addEventListener("pointercancel", stop);
        grip.addEventListener("lostpointercapture", stop);
    }
</script>

<header class="titlebar" class:hidden>
    <div class="brand">
        <span class="mark">ζ</span>
        <span class="name">Zeta</span>
    </div>
    <a class="wayship-indicator {wayshipStatus.toLowerCase().replace('…', '')}" href="/music/settings" title={`Wayship: ${wayshipStatus}`} aria-label={`Wayship: ${wayshipStatus}`}>
        <Icon name="smartphone" />
        <span class="wayship-label">{wayshipStatus}</span>
    </a>
</header>

{#if linux}
    <div class="wc">
        <button class="wc-btn" title="Minimise" aria-label="Minimise" onclick={() => void client.windowMinimize().catch(() => {})}>
            <Icon name="minus" />
        </button>
        <button class="wc-btn" title={maximized ? "Restore" : "Maximise"} aria-label={maximized ? "Restore" : "Maximise"} onclick={toggleMaximize}>
            <Icon name={maximized ? "copy" : "square"} />
        </button>
        <button class="wc-btn close" title="Close" aria-label="Close" onclick={() => void client.windowClose().catch(() => {})}>
            <Icon name="x" />
        </button>
    </div>
    <!-- A transparent frameless window has no native resize border. -->
    {#each ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as edge}
        <div
            class="grip {edge}"
            role="presentation"
            onpointerdown={(e) => {
                e.preventDefault();
                startResize(edge, e);
            }}
        ></div>
    {/each}
{/if}

<!-- A hairline frame around the window, so it reads as a rounded card rather
     than a raw viewport edge. -->
<div class="window-edge" aria-hidden="true"></div>

<style>
    .titlebar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 1200;
        display: flex;
        align-items: center;
        height: var(--titlebar-h);
        padding: 0 calc(16px + var(--wc-right)) 0 calc(16px + var(--wc-left));
        background: linear-gradient(180deg, rgb(255 255 255 / 0.035), transparent);
        -webkit-app-region: drag;
        transition: opacity 0.35s var(--ease-out), translate 0.35s var(--ease-out);
    }
    .titlebar.hidden {
        opacity: 0;
        translate: 0 -100%;
        pointer-events: none;
        -webkit-app-region: no-drag;
    }
    .brand {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }
    .mark {
        display: grid;
        place-items: center;
        width: 19px;
        height: 19px;
        border-radius: 50%;
        background: conic-gradient(from 200deg, var(--accent), var(--art-2), var(--accent));
        color: #0b0913;
        font-family: "Times New Roman", Georgia, serif;
        font-style: italic;
        font-size: 13px;
        font-weight: 700;
        line-height: 1;
        padding-bottom: 2px;
        box-shadow: 0 0 14px -4px var(--accent-glow);
    }
    .name {
        font-family: var(--font-display);
        font-size: 12px;
        font-weight: 750;
        letter-spacing: 0.02em;
        color: var(--text-2);
    }
    .wayship-indicator {
        margin-left: auto;
        position: relative;
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        color: var(--text-2);
        -webkit-app-region: no-drag;
    }
    .wayship-indicator:hover { color: var(--text); }
    .wayship-indicator :global(svg) { width: 15px; height: 15px; }
    .wayship-indicator.synced { color: #34d399; }
    .wayship-indicator.connecting { color: #fbbf24; }
    .wayship-indicator.offline { color: var(--text-3); }
    .wayship-label {
        font-size: 10px;
        font-weight: 650;
        margin-left: 5px;
    }
    .wayship-indicator.synced::after,
    .wayship-indicator.connecting::after {
        position: absolute;
        right: 2px;
        top: 3px;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
        box-shadow: 0 0 7px currentColor;
    }

    .window-edge {
        position: fixed;
        inset: 0;
        z-index: 2000;
        border-radius: var(--window-radius);
        box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.075);
        pointer-events: none;
    }

    /* Linux window buttons, drawn into the same strip. */
    .wc {
        position: fixed;
        top: 0;
        right: 0;
        z-index: 1300;
        display: flex;
        height: var(--titlebar-h);
        -webkit-app-region: no-drag;
    }
    .wc-btn {
        display: grid;
        place-items: center;
        width: 36px;
        height: 100%;
        color: rgb(245 243 251 / 0.7);
        transition: background 0.15s, color 0.15s;
    }
    .wc-btn:hover {
        background: rgb(255 255 255 / 0.09);
        color: #fff;
    }
    .wc-btn.close:hover {
        background: #e81123;
        color: #fff;
    }
    .wc-btn :global(svg) {
        width: 12px;
        height: 12px;
        stroke-width: 1.8;
    }
    .wc-btn.close :global(svg) {
        width: 14px;
        height: 14px;
    }

    .grip {
        position: fixed;
        z-index: 1900;
        -webkit-app-region: no-drag;
    }
    .grip.n,
    .grip.s {
        left: 8px;
        right: 8px;
        height: 5px;
        cursor: ns-resize;
    }
    .grip.n {
        top: 0;
    }
    .grip.s {
        bottom: 0;
    }
    .grip.e,
    .grip.w {
        top: 8px;
        bottom: 8px;
        width: 5px;
        cursor: ew-resize;
    }
    .grip.e {
        right: 0;
    }
    .grip.w {
        left: 0;
    }
    .grip.ne,
    .grip.nw,
    .grip.se,
    .grip.sw {
        width: 10px;
        height: 10px;
    }
    .grip.ne {
        top: 0;
        right: 0;
        cursor: nesw-resize;
    }
    .grip.nw {
        top: 0;
        left: 0;
        cursor: nwse-resize;
    }
    .grip.se {
        bottom: 0;
        right: 0;
        cursor: nwse-resize;
    }
    .grip.sw {
        bottom: 0;
        left: 0;
        cursor: nesw-resize;
    }
    @media (max-width: 640px) {
        .name {
            display: none;
        }
    }
</style>
