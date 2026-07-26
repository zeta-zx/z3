import { routes as music } from './music';
import { routes as mpris } from './mpris';

import { Client, type SetActivity, type SetActivityResponse } from '@xhayper/discord-rpc';

const rpc = new Client({ clientId: '1499408750526595152' });

rpc.login().catch(err => console.warn("Discord RPC failed to connect (is Discord running?):", err));

export const routes = {
    async clearRPC() {
        if (!rpc.user) {
            console.warn(`[RPC] 'rpc.user' not yet initialized. Ignoring call...`);
            return;
        }
        await rpc.user.clearActivity();
    },
    async setRPC(activity: SetActivity): Promise<SetActivityResponse | null> {
        if (!rpc.user) {
            console.warn(`[RPC] 'rpc.user' not yet initialized. Ignoring call...`);
            return null;
        }
        console.log(`Setting RPC. Payload:`, activity);
        return await rpc.user.setActivity(activity);
    },
    ...music,
    ...mpris,
};