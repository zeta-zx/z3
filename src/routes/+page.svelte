<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";

    const options = [
        { name: "Music", href: "/music", icon: "audio-lines", enabled: true, hue: 262 },
        { name: "Movies", icon: "clapperboard", hue: 12 },
        { name: "Anime", icon: "sparkles", hue: 320 },
        { name: "Manga", icon: "book-open", hue: 190 },
    ];
</script>

<div class="launch">
    <div class="glow"></div>
    <header>
        <span class="mark"><Icon name="audio-lines" /></span>
        <h1>Welcome to <span>Zeta</span></h1>
        <p>Media for all. What do you want to check out?</p>
    </header>

    <div class="tiles">
        {#each options as o, i}
            {#if o.enabled}
                <a class="tile" href={o.href} style:--h={o.hue} style:animation-delay="{i * 70}ms">
                    <Icon name={o.icon} />
                    <span>{o.name}</span>
                </a>
            {:else}
                <div class="tile off" style:--h={o.hue} style:animation-delay="{i * 70}ms">
                    <Icon name={o.icon} />
                    <span>{o.name}</span>
                    <small>Coming soon</small>
                </div>
            {/if}
        {/each}
    </div>
</div>

<style>
    .launch {
        position: relative;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 48px;
        padding: 40px;
        overflow: hidden;
    }
    .glow {
        position: absolute;
        inset: -30%;
        background:
            radial-gradient(35% 40% at 30% 30%, rgb(124 77 255 / 0.35), transparent 70%),
            radial-gradient(35% 40% at 70% 60%, rgb(236 72 153 / 0.22), transparent 70%);
        filter: blur(40px);
        animation: drift 18s ease-in-out infinite alternate;
    }
    @keyframes drift {
        to {
            transform: translate(4%, -3%) rotate(8deg);
        }
    }
    header {
        position: relative;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 14px;
    }
    .mark {
        display: grid;
        place-items: center;
        width: 64px;
        height: 64px;
        border-radius: 20px;
        background: linear-gradient(135deg, #b49bff, #ec4899);
        color: #0b0913;
        box-shadow: 0 16px 40px -10px rgb(180 155 255 / 0.6);
    }
    .mark :global(svg) {
        width: 34px;
        height: 34px;
    }
    h1 {
        font-size: clamp(34px, 5vw, 56px);
        font-weight: 850;
        letter-spacing: -0.04em;
    }
    h1 span {
        background: linear-gradient(90deg, #b49bff, #f472b6);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
    }
    p {
        color: var(--text-2);
        font-size: 16px;
    }
    .tiles {
        position: relative;
        display: grid;
        grid-template-columns: repeat(4, 170px);
        gap: 16px;
    }
    .tile {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        gap: 4px;
        height: 170px;
        padding: 18px;
        border-radius: var(--r-xl);
        background: linear-gradient(145deg, hsl(var(--h) 70% 50% / 0.9), hsl(calc(var(--h) + 40) 70% 25% / 0.9));
        box-shadow: 0 20px 40px -20px hsl(var(--h) 70% 40%);
        font-family: var(--font-display);
        font-size: 20px;
        font-weight: 800;
        transition: transform 0.35s var(--ease-out), box-shadow 0.35s;
        animation: rise 0.6s var(--ease-out) both;
    }
    @keyframes rise {
        from {
            opacity: 0;
            transform: translateY(16px);
        }
    }
    .tile :global(svg) {
        width: 34px;
        height: 34px;
        margin-bottom: auto;
    }
    .tile:hover:not(.off) {
        transform: translateY(-4px) scale(1.02);
        box-shadow: 0 28px 50px -20px hsl(var(--h) 70% 40%);
    }
    .off {
        filter: grayscale(0.7);
        opacity: 0.45;
        cursor: not-allowed;
    }
    .off small {
        font: 600 12px var(--font);
        opacity: 0.85;
    }
    @media (max-width: 800px) {
        .tiles {
            grid-template-columns: repeat(2, 160px);
        }
    }
</style>
