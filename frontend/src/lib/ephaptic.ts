import { browser, dev } from "$app/environment";
import { connect } from "@ephaptic/client";
import type { EphapticService } from "./schema";

let clientInstance: EphapticService | null = null;

if (browser) {
    clientInstance = connect({ url: '/_ws' });

    if (dev) (window as any).client = clientInstance;
    // for in-browser debugging
}

export const client = clientInstance;