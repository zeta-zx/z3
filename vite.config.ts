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
                },
            },
            preload: {
                input: 'electron/preload.ts',
            },
        }),
    ],
});