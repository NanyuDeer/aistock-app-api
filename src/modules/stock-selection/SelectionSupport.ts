/** Small bounded cache; short TTL also limits staleness when an older historical batch is republished. */
export class SelectionCache<T> {
    private values = new Map<string, { until: number; value: T }>();
    constructor(private ttl = 30_000, private capacity = 100) {}
    get(key: string): T | undefined {
        const row = this.values.get(key);
        if (!row) return undefined;
        if (row.until <= Date.now()) { this.values.delete(key); return undefined; }
        return row.value;
    }
    set(key: string, value: T): T {
        this.values.delete(key);
        while (this.values.size >= this.capacity) this.values.delete(this.values.keys().next().value!);
        this.values.set(key, { until: Date.now() + this.ttl, value });
        return value;
    }
    clear() { this.values.clear(); }
}

export function selectionProgress(scope: string) {
    const started = Date.now();
    return (stage: string, completed?: number, total?: number) => {
        console.info(`[${scope}] progress`, { stage, completed, total, elapsedMs: Date.now() - started });
    };
}
