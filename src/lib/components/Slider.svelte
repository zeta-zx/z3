<script lang="ts">
    /**
     * A pointer-driven range slider. While dragging it shows the pending value
     * locally and only commits on release (so seeking doesn't stutter audio).
     */
    interface Props {
        value: number;
        max: number;
        onchange: (value: number) => void;
        /** Live updates while dragging (e.g. volume). */
        live?: boolean;
        /** Formats the hover/drag tooltip; no tooltip when omitted. */
        format?: (value: number) => string;
        disabled?: boolean;
        label?: string;
        buffered?: number;
    }

    let { value, max, onchange, live = false, format, disabled = false, label = "", buffered }: Props = $props();

    let track = $state<HTMLDivElement>();
    let dragging = $state(false);
    let dragValue = $state(0);
    let hoverX = $state<number | null>(null);

    const shown = $derived(dragging ? dragValue : value);
    const pct = $derived(max > 0 ? Math.min(100, Math.max(0, (shown / max) * 100)) : 0);
    const hoverValue = $derived(hoverX === null || !track ? null : (hoverX / track.clientWidth) * max);

    function valueAt(clientX: number) {
        const rect = track!.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        return ratio * max;
    }

    function down(e: PointerEvent) {
        if (disabled || !max || e.button !== 0) return;
        track!.setPointerCapture(e.pointerId);
        dragging = true;
        dragValue = valueAt(e.clientX);
        if (live) onchange(dragValue);
    }

    function move(e: PointerEvent) {
        const rect = track!.getBoundingClientRect();
        hoverX = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
        if (!dragging) return;
        dragValue = valueAt(e.clientX);
        if (live) onchange(dragValue);
    }

    function up(e: PointerEvent) {
        if (!dragging) return;
        dragging = false;
        onchange(valueAt(e.clientX));
    }

    function key(e: KeyboardEvent) {
        if (disabled || !max) return;
        const step = max / 50;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") onchange(Math.min(max, value + step));
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") onchange(Math.max(0, value - step));
        else return;
        e.preventDefault();
        e.stopPropagation();
    }
</script>

<div
    class="slider"
    class:dragging
    class:disabled
    bind:this={track}
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={max}
    aria-valuenow={shown}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onpointerleave={() => (hoverX = null)}
    onkeydown={key}
>
    <div class="rail">
        {#if buffered !== undefined && max > 0}
            <div class="buffered" style:width="{Math.min(100, (buffered / max) * 100)}%"></div>
        {/if}
        {#if hoverX !== null && !dragging}
            <div class="hover" style:width="{hoverX}px"></div>
        {/if}
        <div class="fill" style:width="{pct}%"></div>
    </div>
    <div class="thumb" style:left="{pct}%"></div>
    {#if format && (dragging || hoverValue !== null)}
        <div class="tip" style:left={dragging ? `${pct}%` : `${hoverX}px`}>
            {format(dragging ? dragValue : hoverValue ?? 0)}
        </div>
    {/if}
</div>

<style>
    .slider {
        position: relative;
        height: 18px;
        display: flex;
        align-items: center;
        cursor: pointer;
        touch-action: none;
        flex: 1;
        min-width: 0;
    }
    .slider.disabled {
        cursor: default;
        opacity: 0.4;
    }
    .rail {
        position: relative;
        width: 100%;
        height: 4px;
        border-radius: var(--r-full);
        background: rgb(255 255 255 / 0.16);
        overflow: hidden;
        transition: height 0.18s var(--ease-out);
    }
    .slider:hover .rail,
    .slider.dragging .rail {
        height: 6px;
    }
    .fill,
    .hover,
    .buffered {
        position: absolute;
        inset: 0 auto 0 0;
        border-radius: inherit;
    }
    .buffered {
        background: rgb(255 255 255 / 0.1);
    }
    .hover {
        background: rgb(255 255 255 / 0.14);
    }
    .fill {
        background: var(--text);
        transition: background 0.2s;
    }
    .slider:hover .fill,
    .slider.dragging .fill {
        background: var(--accent);
    }
    .thumb {
        position: absolute;
        top: 50%;
        width: 13px;
        height: 13px;
        margin: -6.5px 0 0 -6.5px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 2px 8px rgb(0 0 0 / 0.45);
        transform: scale(0);
        transition: transform 0.2s var(--ease-spring);
        pointer-events: none;
    }
    .slider:hover .thumb,
    .slider.dragging .thumb,
    .slider:focus-visible .thumb {
        transform: scale(1);
    }
    .tip {
        position: absolute;
        bottom: calc(100% + 6px);
        transform: translateX(-50%);
        padding: 3px 7px;
        border-radius: var(--r-xs);
        background: rgb(10 8 16 / 0.92);
        border: 1px solid var(--border);
        font-size: 11.5px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: var(--shadow-sm);
    }
</style>
