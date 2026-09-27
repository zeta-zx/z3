<script lang="ts">
    import { toasts } from "$lib/state/toast.svelte";
    import Icon from "$lib/components/Icon.svelte";
    import { fly } from "svelte/transition";
    import { flip } from "svelte/animate";

    const iconFor = (kind: string) => (kind === "error" ? "circle-alert" : kind === "success" ? "circle-check" : "info");
</script>

<div class="toaster" aria-live="polite">
    {#each toasts.toasts as toast (toast.id)}
        <div class="toast {toast.kind}" animate:flip={{ duration: 260 }} in:fly={{ y: 24, duration: 380 }} out:fly={{ x: 60, duration: 260 }}>
            <span class="ic"><Icon name={iconFor(toast.kind)} /></span>
            <span class="msg">{toast.message}</span>
            <button class="close" aria-label="Dismiss" onclick={() => toasts.dismiss(toast.id)}>
                <Icon name="x" />
            </button>
        </div>
    {/each}
</div>

<style>
    .toaster {
        position: fixed;
        left: 50%;
        bottom: calc(var(--bar-h) + 16px);
        translate: -50% 0;
        z-index: 1500;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        width: min(92vw, 440px);
        pointer-events: none;
    }
    .toast {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: 100%;
        padding: 10px 10px 10px 14px;
        border-radius: var(--r-full);
        background: rgb(20 18 28 / 0.88);
        backdrop-filter: blur(20px) saturate(1.4);
        border: 1px solid var(--border-strong);
        box-shadow: var(--shadow-lg);
        font-size: 13.5px;
        font-weight: 550;
    }
    .ic {
        display: grid;
        color: var(--accent);
        flex-shrink: 0;
    }
    .ic :global(svg) {
        width: 18px;
        height: 18px;
    }
    .error .ic {
        color: var(--danger);
    }
    .success .ic {
        color: var(--success);
    }
    .error {
        border-radius: var(--r-lg);
    }
    .msg {
        flex: 1;
        word-break: break-word;
    }
    .close {
        display: grid;
        place-items: center;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        color: var(--text-3);
        flex-shrink: 0;
    }
    .close:hover {
        color: var(--text);
        background: var(--surface-3);
    }
    .close :global(svg) {
        width: 15px;
        height: 15px;
    }
</style>
