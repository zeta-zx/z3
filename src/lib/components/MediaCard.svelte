<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import Cover from "$lib/components/Cover.svelte";
    import EqBars from "$lib/components/EqBars.svelte";
    import type { Thumbnail } from "$lib/schema";
    import type { Snippet } from "svelte";
    import { tilt } from "$lib/tilt";

    interface Props {
        title: string;
        subtitle?: string;
        src?: string | null;
        thumbnails?: Thumbnail[];
        onclick?: () => void;
        onplay?: () => void;
        oncontextmenu?: (e: MouseEvent) => void;
        playing?: boolean;
        paused?: boolean;
        index?: number;
        art?: Snippet;
        round?: boolean;
    }

    let { title, subtitle = "", src, thumbnails, onclick, onplay, oncontextmenu, playing = false, paused = true, index = 0, art, round = false }: Props = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
    class="media-card"
    class:playing
    class:round
    role="button"
    tabindex="0"
    onclick={onclick}
    onkeydown={(e) => e.key === "Enter" && onclick?.()}
    {oncontextmenu}
    style:animation-delay="{Math.min(index, 16) * 45}ms"
>
    <div class="face" use:tilt={{ max: 10 }}>
        <div class="art">
            {#if art}
                {@render art()}
            {:else}
                <Cover {src} {thumbnails} {title} size="100%" radius="0" />
            {/if}
        </div>
        <div class="shine"></div>
        {#if !round}
            <div class="label">
                <span class="title ellipsis" {title}>{title}</span>
                {#if subtitle}<span class="subtitle ellipsis">{subtitle}</span>{/if}
            </div>
        {/if}
        {#if onplay}
            <button
                class="orb"
                aria-label={playing && !paused ? "Pause" : "Play"}
                onclick={(e) => {
                    e.stopPropagation();
                    onplay?.();
                }}
            >
                <Icon name={playing && !paused ? "pause" : "play"} />
            </button>
        {/if}
        {#if playing && !paused}<span class="eq-badge"><EqBars size={12} /></span>{/if}
    </div>
    {#if round}
        <div class="round-label">
            <span class="title ellipsis" {title}>{title}</span>
            {#if subtitle}<span class="subtitle ellipsis">{subtitle}</span>{/if}
        </div>
    {/if}
</div>

<style>
    .media-card {
        --rx: 0deg;
        --ry: 0deg;
        --mx: 50%;
        --my: 0%;
        perspective: 800px;
        cursor: pointer;
        min-width: 0;
        outline-offset: 4px;
        border-radius: 26px;
        animation: card-in 0.6s var(--ease-out) both;
    }
    @keyframes card-in {
        from {
            opacity: 0;
            transform: translateY(16px) scale(0.96);
        }
    }
    .face {
        position: relative;
        aspect-ratio: 1;
        border-radius: 26px;
        overflow: hidden;
        transform: rotateX(var(--rx)) rotateY(var(--ry));
        transform-style: preserve-3d;
        box-shadow: 0 18px 40px -20px rgb(0 0 0 / 0.85), 0 0 0 1px rgb(255 255 255 / 0.07);
        transition: transform 0.5s var(--ease-out), box-shadow 0.4s, translate 0.4s var(--ease-out);
    }
    .round .face {
        border-radius: 50%;
    }
    .media-card:hover .face {
        translate: 0 -4px;
        box-shadow: 0 28px 50px -22px rgb(0 0 0 / 0.95), 0 0 0 1px rgb(255 255 255 / 0.12);
        transition: transform 0.12s linear, box-shadow 0.4s, translate 0.4s var(--ease-out);
    }
    .playing .face {
        box-shadow: 0 18px 40px -20px rgb(0 0 0 / 0.85), 0 0 0 2px var(--accent), 0 0 30px -6px var(--accent-glow);
    }
    .art {
        position: absolute;
        inset: 0;
    }
    .art :global(.cover) {
        transition: transform 0.7s var(--ease-out);
    }
    .media-card:hover .art :global(.cover) {
        transform: scale(1.06);
    }
    .shine {
        position: absolute;
        inset: 0;
        background: radial-gradient(60% 60% at var(--mx) var(--my), rgb(255 255 255 / 0.22), transparent 70%);
        opacity: 0;
        transition: opacity 0.3s;
        pointer-events: none;
        mix-blend-mode: overlay;
    }
    .media-card:hover .shine {
        opacity: 1;
    }
    .label {
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: 8px;
        display: flex;
        flex-direction: column;
        padding: 9px 12px 10px;
        border-radius: 18px;
        /* Tinted rather than backdrop-blurred: a shelf can hold dozens of these. */
        background: rgb(12 10 18 / 0.74);
        border: 1px solid rgb(255 255 255 / 0.08);
        transition: padding-right 0.35s var(--ease-out);
    }
    .media-card:hover .label {
        padding-right: 58px;
    }
    .title {
        font-weight: 700;
        font-size: 14px;
        line-height: 1.3;
    }
    .playing .title {
        color: color-mix(in srgb, var(--accent) 70%, white);
    }
    .subtitle {
        font-size: 12.5px;
        color: rgb(255 255 255 / 0.68);
    }
    .orb {
        position: absolute;
        right: 14px;
        bottom: 16px;
        display: grid;
        place-items: center;
        width: 42px;
        height: 42px;
        border-radius: 50%;
        background: var(--text);
        color: #0b0913;
        box-shadow: 0 8px 20px -6px rgb(0 0 0 / 0.6);
        opacity: 0;
        transform: scale(0.6) rotate(-45deg);
        transition: opacity 0.25s, transform 0.4s var(--ease-spring);
    }
    .round .orb {
        right: 50%;
        bottom: 50%;
        translate: 50% 50%;
        width: 54px;
        height: 54px;
    }
    .orb :global(svg) {
        width: 18px;
        height: 18px;
        fill: currentColor;
    }
    .media-card:hover .orb,
    .media-card:focus-visible .orb,
    .playing .orb {
        opacity: 1;
        transform: none;
    }
    .orb:hover {
        background: #fff;
        transform: scale(1.08) !important;
    }
    .eq-badge {
        position: absolute;
        left: 12px;
        top: 12px;
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: rgb(0 0 0 / 0.65);
    }
    .round .eq-badge {
        left: 50%;
        top: 14px;
        translate: -50% 0;
    }
    .round-label {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        margin-top: 12px;
        min-width: 0;
    }
    .round-label .title,
    .round-label .subtitle {
        max-width: 100%;
    }
</style>
