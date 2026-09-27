import type { HandleClientError } from "@sveltejs/kit";

/**
 * A route's code can fail to load for reasons that have nothing to do with the
 * app: Chromium aborts every in-flight request when the OS reports a network
 * change (ERR_NETWORK_CHANGED — common with Docker/VPN interfaces coming and
 * going), and the browser then caches that failed module for the page's
 * lifetime. The only recovery is a reload, so do it once, automatically,
 * instead of leaving the user on a "500 Internal Error" page.
 */
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
const RELOAD_KEY = "zeta:chunk-reload-at";

function recoverFromChunkError(error: unknown): boolean {
    const message = String((error as { message?: string })?.message ?? error);
    if (!CHUNK_ERROR.test(message)) return false;

    // Guard against reload loops if the failure is persistent.
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 15_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    location.reload();
    return true;
}

// Failures while booting the app happen before SvelteKit's error handling exists.
window.addEventListener("unhandledrejection", (event) => {
    if (recoverFromChunkError(event.reason)) event.preventDefault();
});

export const handleError: HandleClientError = ({ error, message }) => {
    recoverFromChunkError(error);
    return { message };
};
