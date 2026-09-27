<script lang="ts">
    import Icon from "$lib/components/Icon.svelte";
    import { ui, type MenuItem } from "$lib/state/ui.svelte";
    import { tick } from "svelte";
    import { scale } from "svelte/transition";

    let menuEl = $state<HTMLDivElement>();
    let pos = $state({ x: 0, y: 0 });
    let sub = $state<{ index: number; x: number; y: number; flip: boolean } | null>(null);
    let subEl = $state<HTMLDivElement>();

    // Keep the menu inside the window.
    $effect(() => {
        const menu = ui.menu;
        if (!menu) return;
        sub = null;
        pos = { x: menu.x, y: menu.y };
        tick().then(() => {
            if (!menuEl) return;
            const r = menuEl.getBoundingClientRect();
            pos = {
                x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
                y: menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y,
            };
        });
    });

    function run(item: MenuItem) {
        if (item.disabled || item.submenu) return;
        ui.closeMenu();
        item.action?.();
    }

    function openSub(index: number, e: MouseEvent) {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const flip = r.right + 230 > window.innerWidth;
        sub = { index, x: flip ? r.left - 4 : r.right + 4, y: r.top - 5, flip };
        tick().then(() => {
            if (!subEl || !sub) return;
            const sr = subEl.getBoundingClientRect();
            if (sr.bottom > window.innerHeight - 8) sub = { ...sub, y: Math.max(8, window.innerHeight - 8 - sr.height) };
        });
    }

    function onWindowKey(e: KeyboardEvent) {
        if (ui.menu && e.key === "Escape") {
            e.stopPropagation();
            ui.closeMenu();
        }
    }
</script>

<svelte:window onkeydowncapture={onWindowKey} onblur={() => ui.closeMenu()} onresize={() => ui.closeMenu()} />

{#snippet items(list: MenuItem[], nested: boolean)}
    {#each list as item, i}
        {#if item.separator}
            <div class="sep"></div>
        {:else}
            <button
                class="item"
                class:danger={item.danger}
                class:open={!nested && sub?.index === i}
                disabled={item.disabled}
                onclick={() => run(item)}
                onmouseenter={(e) => {
                    if (!nested) {
                        if (item.submenu) openSub(i, e);
                        else sub = null;
                    }
                }}
            >
                <span class="icon">
                    {#if item.checked}
                        <Icon name="check" />
                    {:else if item.icon}
                        <Icon name={item.icon} />
                    {/if}
                </span>
                <span class="label ellipsis">{item.label}</span>
                {#if item.submenu}<span class="chev"><Icon name="chevron-right" /></span>{/if}
            </button>
        {/if}
    {/each}
{/snippet}

{#if ui.menu}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="catcher" onclick={() => ui.closeMenu()} oncontextmenu={(e) => { e.preventDefault(); ui.closeMenu(); }}></div>
    <div
        class="menu glass"
        bind:this={menuEl}
        style:left="{pos.x}px"
        style:top="{pos.y}px"
        role="menu"
        transition:scale={{ start: 0.94, duration: 140, opacity: 0 }}
    >
        {@render items(ui.menu.items, false)}
    </div>
    {#if sub && ui.menu.items[sub.index]?.submenu}
        <div
            class="menu glass sub"
            bind:this={subEl}
            style:left="{sub.x}px"
            style:top="{sub.y}px"
            style:transform={sub.flip ? "translateX(-100%)" : undefined}
            role="menu"
        >
            {@render items(ui.menu.items[sub.index].submenu!, true)}
        </div>
    {/if}
{/if}

<style>
    .catcher {
        position: fixed;
        inset: 0;
        z-index: 2000;
    }
    .menu {
        position: fixed;
        z-index: 2001;
        min-width: 216px;
        max-width: 300px;
        max-height: min(70vh, 520px);
        overflow-y: auto;
        padding: 5px;
        border-radius: var(--r-md);
        background: var(--glass-strong);
        box-shadow: var(--shadow-lg);
        transform-origin: top left;
    }
    .item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        height: 34px;
        padding: 0 10px 0 8px;
        border-radius: var(--r-xs);
        text-align: left;
        font-size: 13px;
        font-weight: 500;
        color: var(--text);
    }
    .item:hover:not(:disabled),
    .item.open {
        background: var(--surface-3);
    }
    .item.danger {
        color: var(--danger);
    }
    .icon,
    .chev {
        display: grid;
        place-items: center;
        width: 18px;
        color: var(--text-2);
        flex-shrink: 0;
    }
    .danger .icon {
        color: inherit;
    }
    .icon :global(svg),
    .chev :global(svg) {
        width: 16px;
        height: 16px;
    }
    .label {
        flex: 1;
    }
    .sep {
        height: 1px;
        margin: 4px 6px;
        background: var(--border);
    }
</style>
