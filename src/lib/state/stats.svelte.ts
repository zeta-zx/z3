import { client } from "$lib/ephaptic";
import { toasts } from "$lib/state/toast.svelte";

type Summary = Awaited<ReturnType<typeof client.statsSummary>>;

class StatsStore {
    summary = $state<Summary | null>(null);
    loading = $state<boolean>(true);

    async load() {
        this.loading = true;
        try {
            this.summary = await client.statsSummary(30);
        } catch (err) {
            toasts.error(err);
        } finally {
            this.loading = false;
        }
    }
}

export const statsState = new StatsStore();
