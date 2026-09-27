<script lang="ts">
    let { paused = false, size = 14 }: { paused?: boolean; size?: number } = $props();
</script>

<span class="eq" class:paused style:width="{size}px" style:height="{size}px" aria-label="Now playing">
    <i></i><i></i><i></i><i></i>
</span>

<style>
    .eq {
        display: inline-flex;
        align-items: flex-end;
        justify-content: space-between;
        color: var(--accent);
    }
    i {
        width: 18%;
        height: 100%;
        border-radius: 2px;
        background: currentColor;
        transform-origin: bottom;
        animation: bounce 0.9s ease-in-out infinite alternate;
    }
    i:nth-child(1) {
        animation-duration: 0.82s;
    }
    i:nth-child(2) {
        animation-duration: 1.07s;
        animation-delay: -0.4s;
    }
    i:nth-child(3) {
        animation-duration: 0.71s;
        animation-delay: -0.2s;
    }
    i:nth-child(4) {
        animation-duration: 0.96s;
        animation-delay: -0.6s;
    }
    .paused i {
        animation-play-state: paused;
    }
    @keyframes bounce {
        0% {
            transform: scaleY(0.2);
        }
        50% {
            transform: scaleY(0.85);
        }
        100% {
            transform: scaleY(0.45);
        }
    }
</style>
