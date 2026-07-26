import { exposeEphaptic } from '@ephaptic/server/electron/preload';
import { contextBridge, ipcRenderer } from 'electron';

exposeEphaptic();

// Ephaptic is renderer -> main only. MPRIS commands (play/pause/next/seek…)
// originate in the main process, so expose a minimal listener for them.
contextBridge.exposeInMainWorld('__zeta', {
	onMediaCommand: (callback: (command: unknown) => void) => {
		const listener = (_event: unknown, command: unknown) => callback(command);
		ipcRenderer.on('zeta:media-command', listener);
		return () => ipcRenderer.removeListener('zeta:media-command', listener);
	},
});
