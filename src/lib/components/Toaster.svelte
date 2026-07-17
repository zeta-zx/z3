<script lang="ts">
    import { toasts } from "$lib/state/toast.svelte";
    import Icon from "$lib/components/Icon.svelte";
    import { fly } from "svelte/transition";

    const iconFor = (kind: string) =>
        kind === "error" ? "circle-alert" : kind === "success" ? "circle-check" : "info";
</script>

<div class="toaster">
    {#each toasts.toasts as toast (toast.id)}
        <div class="toast {toast.kind}" transition:fly={{ x: 40, duration: 250 }}>
            <Icon name={iconFor(toast.kind)} />
            <span>{toast.message}</span>
            <button class="toast-close" aria-label="Dismiss" onclick={() => toasts.dismiss(toast.id)}>
                <Icon name="x" />
            </button>
        </div>
    {/each}
</div>

<style>
    .toaster {
        position: fixed;
        bottom: 1rem;
        right: 1rem;
        z-index: 1000;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        max-width: min(90vw, 360px);
    }
    .toast {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.7rem 0.9rem;
        border-radius: var(--pico-border-radius, 0.5rem);
        background: var(--pico-card-background-color, #1c1c1e);
        border: 1px solid var(--pico-muted-border-color, #333);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
        color: var(--pico-color, #eee);
        font-size: 0.9rem;
    }
    .toast.error {
        border-color: var(--pico-del-color, #d33);
    }
    .toast.success {
        border-color: var(--pico-ins-color, #2a2);
    }
    .toast span {
        flex: 1;
        word-break: break-word;
    }
    .toast-close {
        all: unset;
        cursor: pointer;
        display: inline-flex;
        opacity: 0.6;
    }
    .toast-close:hover {
        opacity: 1;
    }
</style>
