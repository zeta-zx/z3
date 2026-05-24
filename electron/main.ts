import { app, BrowserWindow, protocol, net } from 'electron';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import updater from 'electron-updater';
const { autoUpdater } = updater;

import { exposeIPC } from '@ephaptic/server/electron';

import { routes } from './routes';

const __dirname = dirname(fileURLToPath(import.meta.url));

protocol.registerSchemesAsPrivileged([
	{ scheme: 'zeta-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

app.whenReady().then(() => {
	const dev = process.env.VITE_DEV_SERVER_URL;

	protocol.handle('zeta-app', (request) => {
        const url = new URL(request.url);

		let filePath = join(__dirname, '../build', url.pathname);
        
        if (url.pathname === '/' || !existsSync(filePath)) {
            filePath = join(__dirname, '../build/index.html');
        }
        
        return net.fetch(pathToFileURL(filePath).toString());
    });

	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		webPreferences: {
			preload: join(__dirname, '../dist-electron/preload.mjs'),
		},
		icon: dev ? join(__dirname, '../static/zeta.png') : join(__dirname, '../build/zeta.png'),
	});

	win.removeMenu();

	autoUpdater.on('error', console.error);
	autoUpdater.checkForUpdatesAndNotify().catch(console.error);

	if (dev) {
		win.loadURL(dev);
	} else {
		// win.loadFile(join(__dirname, '../build/index.html'));
		win.loadURL('zeta-app://app/');
	}

	win.webContents.on('before-input-event', (event, input) => {
		if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
			win.webContents.toggleDevTools();
			event.preventDefault();
		}
		if (input.control && input.key.toLowerCase() === 'r') {
			win.webContents.reload();
			event.preventDefault();
		}
	});

	exposeIPC(routes);
});

export type Routes = typeof routes;