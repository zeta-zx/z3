import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import updater from 'electron-updater';
const { autoUpdater } = updater;

import { exposeIPC } from '@ephaptic/server/electron';

import { routes } from './routes';

const __dirname = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(() => {
	const dev = process.env.VITE_DEV_SERVER_URL;

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
		win.loadFile(join(__dirname, '../build/index.html'));
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