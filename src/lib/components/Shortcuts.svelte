<script lang="ts">
    import { ui } from "$lib/state/ui.svelte";
    import { fade, scale } from "svelte/transition";

    const SHORTCUTS: [string[], string][] = [
        [["Space"], "Play / pause"],
        [["Shift", "→"], "Next track"],
        [["Shift", "←"], "Previous track"],
        [["→"], "Forward 5 seconds"],
        [["←"], "Back 5 seconds"],
        [["↑", "↓"], "Volume"],
        [["M"], "Mute"],
        [["S"], "Shuffle"],
        [["R"], "Repeat (off → all → one)"],
        [["Q"], "Queue"],
        [["Y"], "Lyrics panel"],
        [["F"], "Full-screen player"],
        [["V"], "Visualizer"],
        [["Ctrl", "K"], "Search"],
        [["?"], "This list"],
    ];
</script>

{#if ui.shortcutsOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="backdrop" transition:fade={{ duration: 160 }} onclick={() => (ui.shortcutsOpen = false)}>
        <div class="sheet glass" transition:scale={{ start: 0.94, duration: 240 }}>
            <h3>Keyboard shortcuts</h3>
            <div class="list">
                {#each SHORTCUTS as [keys, label]}
                    <div class="item">
                        <span>{label}</span>
                        <span class="keys">{#each keys as k}<kbd>{k}</kbd>{/each}</span>
                    </div>
                {/each}
            </div>
        </div>
    </div>
{/if}

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        z-index: 2100;
        display: grid;
        place-items: center;
        background: rgb(4 3 8 / 0.5);
        backdrop-filter: blur(6px);
    }
    .sheet {
        width: min(92vw, 560px);
        padding: 24px;
        border-radius: var(--r-xl);
        background: var(--glass-strong);
        box-shadow: var(--shadow-lg);
    }
    h3 {
        font-size: 20px;
        margin-bottom: 16px;
    }
    .list {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px 24px;
    }
    .item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 7px 0;
        border-bottom: 1px solid var(--border);
        font-size: 13px;
        color: var(--text-2);
    }
    .keys {
        display: flex;
        gap: 4px;
    }
    kbd {
        min-width: 24px;
        height: 24px;
        padding: 0 7px;
        display: inline-grid;
        place-items: center;
        border-radius: var(--r-xs);
        background: var(--surface-3);
        border: 1px solid var(--border-strong);
        border-bottom-width: 2px;
        font: 600 11.5px var(--font);
        color: var(--text);
    }
</style>
