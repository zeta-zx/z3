import devtoolsJson from 'vite-plugin-devtools-json';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple'
import { notBundle } from 'vite-plugin-electron/plugin';
import type { ChildProcess } from 'node:child_process';

export default defineConfig({
    plugins: [
        sveltekit(),
        devtoolsJson(),
        electron({
            main: {
                // main.ts runs in Electron's main process; backend.ts is the
                // utility process that does all the heavy lifting.
                entry: ['electron/main.ts', 'electron/backend.ts'],
                // Restart Electron ourselves after a main-process rebuild. The
                // plugin's own restart tree-kills on Linux via `ps --ppid <dev
                // server pid>`, which kills *every* child of the dev server,
                // including Vite's esbuild service — after which every page
                // fails to transform ("The service is no longer running") and
                // the app shows 500 errors until `npm run dev` is restarted.
                async onstart({ startup }) {
                    const running = (process as { electronApp?: ChildProcess }).electronApp;
                    if (running && running.exitCode === null && running.signalCode === null) {
                        running.removeAllListeners();
                        // Killing just Electron's main process takes its renderer,
                        // GPU and backend processes down with it.
                        await new Promise<void>((resolve) => {
                            running.once('exit', () => resolve());
                            running.kill();
                        });
                    }
                    (process as { electronApp?: ChildProcess }).electronApp = undefined;
                    await startup();
                },
                vite: {
                    plugins: [
                        notBundle(),
                    ],
                    build: {
                        rollupOptions: {
                            // node:sqlite isn't in the bundler's builtin list yet;
                            // keep it external so it resolves at runtime instead of
                            // being stubbed as a browser-external module.
                            external: ['node:sqlite'],
                        },
                    },
                },
            },
            preload: {
                input: 'electron/preload.ts',
            },
        }),
    ],
});