import { shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';

const WAYSHIP_WEB_URL = process.env.WAYSHIP_WEB_URL || 'https://wayship.link';
const TIMEOUT_MS = 180_000;

export interface WayshipConnectResult {
    token: string;
    accountId: string;
    handle: string;
    connId: number | null;
    deviceName: string;
}

let activeAbort: (() => void) | null = null;

export const wayshipRoutes = {
    async wayshipConnect(deviceName?: string): Promise<WayshipConnectResult> {
        activeAbort?.();
        const label = (deviceName?.trim() || hostname() || 'Desktop').slice(0, 60);
        const state = randomBytes(16).toString('hex');

        return new Promise<WayshipConnectResult>((resolve, reject) => {
            const server = createServer((req, res) => {
                try {
                    const url = new URL(req.url || '/', 'http://127.0.0.1');
                    if (url.pathname !== '/cb') {
                        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end('Not found');
                        return;
                    }
                    const returnedState = url.searchParams.get('state');
                    const token = url.searchParams.get('token')?.trim() || '';
                    const accountId = url.searchParams.get('account_id')?.trim() || '';
                    const handle = url.searchParams.get('handle')?.trim() || '';
                    const connIdRaw = url.searchParams.get('conn_id');
                    const connId = connIdRaw && /^\d+$/.test(connIdRaw) ? Number(connIdRaw) : null;

                    if (returnedState !== state || !token.startsWith('wsa_')) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(
                            '<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#110e18;color:#f5f2fa;display:grid;place-content:center;height:100vh;margin:0;text-align:center"><div><h2>Could not verify Wayship connection</h2><p>Please return to Zeta and try again.</p></div></body></html>',
                        );
                        finish(new Error('Invalid Wayship callback parameters.'));
                        return;
                    }

                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Connection': 'close',
                    });
                    res.end(
                        '<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#110e18;color:#f5f2fa;display:grid;place-content:center;height:100vh;margin:0;text-align:center"><div><h2>Connected to Zeta</h2><p>Wayship P2P sync is active. You can close this tab and return to Zeta.</p></div></body></html>',
                    );
                    finish(undefined, { token, accountId, handle, connId, deviceName: label });
                } catch (err) {
                    finish(err instanceof Error ? err : new Error(String(err)));
                }
            });

            const timer = setTimeout(() => {
                finish(new Error('Wayship sign-in timed out.'));
            }, TIMEOUT_MS);

            const finish = (err?: Error, result?: WayshipConnectResult) => {
                clearTimeout(timer);
                if (activeAbort === abort) activeAbort = null;
                try { server.close(); } catch { /* ignore */ }
                if (err) reject(err);
                else if (result) resolve(result);
            };

            const abort = () => finish(new Error('Wayship sign-in was cancelled.'));
            activeAbort = abort;

            server.once('error', (err) => finish(err));
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                if (!addr || typeof addr === 'string') {
                    finish(new Error('Could not start local callback server.'));
                    return;
                }
                const redirect = `http://127.0.0.1:${addr.port}/cb`;
                const connectUrl = new URL('/connect', WAYSHIP_WEB_URL);
                connectUrl.searchParams.set('app', 'zeta');
                connectUrl.searchParams.set('name', 'Zeta');
                connectUrl.searchParams.set('device_name', label);
                connectUrl.searchParams.set('redirect', redirect);
                connectUrl.searchParams.set('state', state);
                void shell.openExternal(connectUrl.toString()).catch((err) => finish(err));
            });
        });
    },
};
