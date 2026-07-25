import devtoolsJson from 'vite-plugin-devtools-json';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple'
import { notBundle } from 'vite-plugin-electron/plugin';

export default defineConfig({
    plugins: [
        sveltekit(),
        devtoolsJson(),
        electron({
            main: {
                entry: 'electron/main.ts',
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