export type ToastKind = "info" | "success" | "error";

export interface Toast {
    id: number;
    message: string;
    kind: ToastKind;
}

class ToastStore {
    toasts = $state<Toast[]>([]);
    private nextId = 0;

    push(message: string, kind: ToastKind = "info", timeout = 4000) {
        const id = this.nextId++;
        this.toasts.push({ id, message, kind });
        if (timeout > 0) setTimeout(() => this.dismiss(id), timeout);
        return id;
    }

    info(message: string, timeout?: number) {
        return this.push(message, "info", timeout);
    }

    success(message: string, timeout?: number) {
        return this.push(message, "success", timeout);
    }

    error(message: unknown, timeout?: number) {
        const text = message instanceof Error ? message.message : String(message);
        return this.push(text, "error", timeout ?? 6000);
    }

    dismiss(id: number) {
        this.toasts = this.toasts.filter((t) => t.id !== id);
    }
}

export const toasts = new ToastStore();
