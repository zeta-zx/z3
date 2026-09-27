import { browser } from "$app/environment";

export type NowPlayingMode = "lyrics" | "visualizer";
export type SidePanel = "queue" | "lyrics" | null;

const PREFS_KEY = "zeta:ui-prefs";

interface UiPrefs {
    ambient: boolean;
    visualizerPack: string;
    sidePanel: SidePanel;
    sidebarCollapsed: boolean;
}

function loadPrefs(): Partial<UiPrefs> {
    if (!browser) return {};
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    } catch {
        return {};
    }
}

export interface MenuItem {
    label?: string;
    icon?: string;
    action?: () => unknown;
    danger?: boolean;
    disabled?: boolean;
    checked?: boolean;
    submenu?: MenuItem[];
    /** Renders a divider instead of an item. */
    separator?: boolean;
}

interface DialogRequest {
    kind: "prompt" | "confirm";
    title: string;
    message?: string;
    value?: string;
    placeholder?: string;
    confirmLabel?: string;
    danger?: boolean;
    resolve: (value: string | boolean | null) => void;
}

class UiStore {
    private prefs = loadPrefs();

    nowPlayingOpen = $state(false);
    nowPlayingMode = $state<NowPlayingMode>("lyrics");
    sidePanel = $state<SidePanel>(this.prefs.sidePanel ?? null);
    sidebarCollapsed = $state(!!this.prefs.sidebarCollapsed);
    ambient = $state(this.prefs.ambient !== false);
    visualizerPack = $state(this.prefs.visualizerPack ?? "halo");
    shortcutsOpen = $state(false);

    /** Epoch ms at which playback pauses, or "track" to stop after the current song. */
    sleepAt = $state<number | "track" | null>(null);

    menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
    dialog = $state<DialogRequest | null>(null);

    save() {
        if (!browser) return;
        const prefs: UiPrefs = {
            ambient: this.ambient,
            visualizerPack: this.visualizerPack,
            sidePanel: this.sidePanel,
            sidebarCollapsed: this.sidebarCollapsed,
        };
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    }

    openNowPlaying(mode?: NowPlayingMode) {
        if (mode) this.nowPlayingMode = mode;
        this.nowPlayingOpen = true;
    }

    toggleSidePanel(panel: Exclude<SidePanel, null>) {
        this.sidePanel = this.sidePanel === panel ? null : panel;
        this.save();
    }

    openMenu(event: MouseEvent | { clientX: number; clientY: number }, items: MenuItem[]) {
        if ("preventDefault" in event) {
            event.preventDefault();
            event.stopPropagation();
        }
        this.menu = { x: event.clientX, y: event.clientY, items };
    }

    /** Open a menu anchored under a button. */
    openMenuAt(element: Element, items: MenuItem[]) {
        const rect = element.getBoundingClientRect();
        this.menu = { x: rect.left, y: rect.bottom + 6, items };
    }

    closeMenu() {
        this.menu = null;
    }

    prompt(title: string, opts: { value?: string; placeholder?: string; confirmLabel?: string; message?: string } = {}) {
        return new Promise<string | null>((resolve) => {
            this.dialog = { kind: "prompt", title, ...opts, resolve: (v) => resolve(typeof v === "string" ? v : null) };
        });
    }

    confirm(title: string, opts: { message?: string; confirmLabel?: string; danger?: boolean } = {}) {
        return new Promise<boolean>((resolve) => {
            this.dialog = { kind: "confirm", title, ...opts, resolve: (v) => resolve(v === true) };
        });
    }
}

export const ui = new UiStore();
