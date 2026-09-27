<script lang="ts">
    import { ui } from "$lib/state/ui.svelte";
    import { fade, scale } from "svelte/transition";

    let value = $state("");
    let input = $state<HTMLInputElement>();

    $effect(() => {
        const d = ui.dialog;
        if (!d) return;
        value = d.value ?? "";
        queueMicrotask(() => input?.select());
    });

    function close(result: string | boolean | null) {
        const d = ui.dialog;
        ui.dialog = null;
        d?.resolve(result);
    }

    function submit(e: Event) {
        e.preventDefault();
        if (ui.dialog?.kind === "prompt") {
            if (value.trim()) close(value.trim());
        } else close(true);
    }
</script>

{#if ui.dialog}
    {@const d = ui.dialog}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="backdrop" transition:fade={{ duration: 180 }} onclick={(e) => e.target === e.currentTarget && close(null)}>
        <form
            class="dialog glass"
            onsubmit={submit}
            onkeydown={(e) => e.key === "Escape" && (e.stopPropagation(), close(null))}
            transition:scale={{ start: 0.92, duration: 260, opacity: 0 }}
        >
            <h3>{d.title}</h3>
            {#if d.message}<p class="muted">{d.message}</p>{/if}
            {#if d.kind === "prompt"}
                <input class="input" bind:this={input} bind:value placeholder={d.placeholder ?? ""} spellcheck="false" />
            {/if}
            <div class="actions">
                <button type="button" class="btn btn-ghost" onclick={() => close(null)}>Cancel</button>
                <button
                    type="submit"
                    class="btn"
                    class:btn-primary={!d.danger}
                    class:danger={d.danger}
                    disabled={d.kind === "prompt" && !value.trim()}
                >
                    {d.confirmLabel ?? (d.kind === "prompt" ? "Save" : "Confirm")}
                </button>
            </div>
        </form>
    </div>
{/if}

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        z-index: 2100;
        display: grid;
        place-items: center;
        background: rgb(4 3 8 / 0.55);
        backdrop-filter: blur(6px);
    }
    .dialog {
        width: min(92vw, 420px);
        padding: 24px;
        border-radius: var(--r-xl);
        background: var(--glass-strong);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    h3 {
        font-size: 20px;
        font-weight: 750;
    }
    .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 6px;
    }
    .danger {
        background: var(--danger);
        color: #fff;
        border-color: transparent;
    }
</style>
