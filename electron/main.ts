import { app, BrowserWindow, protocol, net } from 'electron';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import updater from 'electron-updater';
const { autoUpdater } = updater;

import { exposeIPC } from '@ephaptic/server/electron';

import { routes } from './routes';
import { initMpris, shutdownMpris, type MprisCommand } from './lib/mpris';
import { callBackend, startBackend, stopBackend } from './lib/backend';
import { coverIdFromUrl } from '../src/lib/covers';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dev/testing hooks: run an isolated profile (own config + library) and expose
// the DevTools protocol for automated screenshots.
if (process.env.ZETA_USER_DATA) app.setPath('userData', process.env.ZETA_USER_DATA);
if (process.env.ZETA_REMOTE_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.ZETA_REMOTE_DEBUG_PORT);
// Extra Chromium switches, e.g. "ozone-platform=x11,use-angle=swiftshader".
for (const entry of (process.env.ZETA_CHROMIUM_SWITCHES ?? '').split(',').filter(Boolean)) {
	const [name, ...value] = entry.split('=');
	app.commandLine.appendSwitch(name.trim(), value.join('=').trim() || undefined);
}

// On Linux we publish our own org.mpris.MediaPlayer2.zeta service (see
// lib/mpris.ts), so Chromium's MediaSession -> MPRIS bridge must be suppressed
// or the desktop would list Zeta twice. Windows and macOS are left alone: they
// have no MPRIS and Chromium's bridge is what drives SMTC / Now Playing there.
if (process.platform === 'linux') {
	app.commandLine.appendSwitch('disable-features', 'MediaSessionService,HardwareMediaKeyHandling');
}

protocol.registerSchemesAsPrivileged([
	{ scheme: 'zeta-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
	// Embedded cover art, served on demand (see src/lib/covers.ts). CORS-enabled
	// so the renderer can sample covers for colours and WebGL textures.
	{ scheme: 'zeta-cover', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

function createWindow() {
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

	if (dev) {
		win.loadURL(dev);
	} else {
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

	return win;
}

app.whenReady().then(() => {
	// Spin the backend up first so it's warm by the time the UI asks for data.
	startBackend();

	protocol.handle('zeta-cover', async (request) => {
		const cover = await callBackend<{ data: Uint8Array; mimetype: string } | null>('musicCover', [
			coverIdFromUrl(request.url),
		]).catch(() => null);
		if (!cover) return new Response(null, { status: 404 });
		return new Response(new Uint8Array(cover.data), {
			headers: {
				'Content-Type': cover.mimetype,
				'Cache-Control': 'public, max-age=31536000, immutable',
				'Access-Control-Allow-Origin': '*',
			},
		});
	});

	protocol.handle('zeta-app', (request) => {
		const url = new URL(request.url);

		let filePath = join(__dirname, '../build', url.pathname);

		if (url.pathname === '/' || !existsSync(filePath)) {
			filePath = join(__dirname, '../build/index.html');
		}

		return net.fetch(pathToFileURL(filePath).toString());
	});

	const mainWindow = createWindow();

	autoUpdater.on('error', console.error);
	autoUpdater.checkForUpdatesAndNotify().catch(console.error);

	exposeIPC(routes);

	// Own the MPRIS service ourselves (Linux only; no-op elsewhere).
	initMpris({
		onCommand: (command: MprisCommand) => {
			const win = BrowserWindow.getAllWindows()[0] ?? mainWindow;
			if (!win?.isDestroyed()) win.webContents.send('zeta:media-command', command);
		},
		onRaise: () => {
			const win = BrowserWindow.getAllWindows()[0] ?? mainWindow;
			if (win?.isDestroyed()) return;
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
		},
		onQuit: () => app.quit(),
	}).catch((err) => console.warn('[mpris] init failed:', err));

	// macOS: re-create a window when the dock icon is clicked and none are open.
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

// Quit when all windows are closed, except on macOS where apps stay active.
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

// Release the MPRIS bus name cleanly so the desktop drops our entry.
app.on('before-quit', () => {
	shutdownMpris();
	stopBackend();
});

export type Routes = typeof routes;