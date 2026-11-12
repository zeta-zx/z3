import { browser } from '$app/environment';

export type WidgetTheme = 'artwork' | 'material';

const KEY = 'zeta:android-prefs';
function load(): { haptics?: boolean; keepAwake?: boolean; widgetTheme?: WidgetTheme } {
    if (!browser) return {};
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

class AndroidPreferences {
    private saved = load();
    haptics = $state(this.saved.haptics !== false);
    keepAwake = $state(this.saved.keepAwake === true);
    widgetTheme = $state<WidgetTheme>(this.saved.widgetTheme === 'material' ? 'material' : 'artwork');

    save() {
        if (browser) {
            localStorage.setItem(KEY, JSON.stringify({
                haptics: this.haptics,
                keepAwake: this.keepAwake,
                widgetTheme: this.widgetTheme,
            }));
        }
    }
}

export const androidPreferences = new AndroidPreferences();
