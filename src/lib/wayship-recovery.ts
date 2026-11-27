const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export class WayshipHttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export function nextWayshipRetry(delay: number) {
    return delay ? Math.min(delay * 2, MAX_RETRY_MS) : FIRST_RETRY_MS;
}

export class WayshipSignalInbox {
    private received = new Map<string, number>();

    accept(from: string, kind: string, payload: unknown, now = Date.now()) {
        if (kind !== 'offer' && kind !== 'answer') return true;
        const sdp = (payload as { sdp?: unknown } | null)?.sdp;
        if (typeof sdp !== 'string') return false;
        for (const [key, expires] of this.received) {
            if (expires <= now) this.received.delete(key);
        }
        const key = `${from}\0${kind}\0${sdp}`;
        if (this.received.has(key)) return false;
        if (this.received.size >= 128) this.received.delete(this.received.keys().next().value!);
        this.received.set(key, now + 60_000);
        return true;
    }
}
