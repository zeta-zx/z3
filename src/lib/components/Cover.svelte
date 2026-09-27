<script lang="ts">
    import type { Thumbnail } from "$lib/schema";
    import { createPlaceholderUrl, getThumbnailUrl, updateThumbnailUrl } from "$lib/utils";

    interface Props {
        thumbnails?: Thumbnail[];
        src?: string | null;
        title?: string;
        size?: number | string;
        radius?: string;
        shadow?: boolean;
        class?: string;
    }

    let { thumbnails, src, title = "", size, radius = "var(--r-sm)", shadow = false, class: className = "" }: Props = $props();

    let failed = $state(false);
    let loaded = $state(false);
    // One retry before giving up: loads can be aborted by transient network
    // changes (ERR_NETWORK_CHANGED), not just by genuinely missing images.
    let retry = $state(0);

    // updateThumbnailUrl upgrades small web thumbnails to their large variant.
    const source = $derived(src ? updateThumbnailUrl(src) : getThumbnailUrl(thumbnails, title));
    const url = $derived(failed ? createPlaceholderUrl({ text: title }) : source);

    // A new image resets the fade-in / error state.
    $effect(() => {
        void src;
        void thumbnails;
        failed = false;
        loaded = false;
        retry = 0;
    });

    // YouTube's 4:3 "hqdefault" frames have black bars baked in around a 16:9
    // picture; zoom past them so covers aren't letterboxed.
    let letterboxed = $state(false);
    function onLoad(e: Event) {
        const img = e.currentTarget as HTMLImageElement;
        letterboxed = Math.abs(img.naturalWidth / img.naturalHeight - 4 / 3) < 0.02 && img.naturalWidth <= 640;
        loaded = true;
    }

    function onError() {
        if (retry === 0 && /^https?:/.test(source)) setTimeout(() => (retry = 1), 1200);
        else failed = true;
    }

    const dim = $derived(typeof size === "number" ? `${size}px` : size);
</script>

<div
    class="cover {className}"
    class:shadow
    class:loaded
    style:width={dim}
    style:height={dim}
    style:border-radius={radius}
    style:background-image="url('{createPlaceholderUrl({ text: title })}')"
>
    <!-- Re-keying on retry recreates the <img>, which issues a fresh request. -->
    {#key `${url}#${retry}`}
        <img
            src={url}
            alt=""
            draggable="false"
            referrerpolicy="no-referrer"
            loading="lazy"
            decoding="async"
            class:letterboxed
            onload={onLoad}
            onerror={onError}
        />
    {/key}
</div>

<style>
    .cover {
        position: relative;
        flex-shrink: 0;
        overflow: hidden;
        aspect-ratio: 1;
        background-size: cover;
        background-color: var(--surface-2);
        isolation: isolate;
    }
    .cover.shadow {
        box-shadow: var(--shadow-cover);
    }
    img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        opacity: 0;
        transform: scale(1.04);
        transition: opacity 0.45s var(--ease-out), transform 0.6s var(--ease-out);
    }
    .loaded img {
        opacity: 1;
        transform: none;
    }
    /* 360px-tall frame, 270px-tall picture: zoom 360/270 to crop the bars */
    .loaded img.letterboxed {
        transform: scale(1.34);
    }
    /* subtle inner edge so light covers don't bleed into the background */
    .cover::after {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: inherit;
        box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.06);
        pointer-events: none;
    }
</style>
