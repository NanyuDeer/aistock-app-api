import { Request } from 'express';

const TRUTHY_QUERY_VALUES = new Set(['1', 'true', 'yes', 'y', 'on']);

export function getBooleanQueryParam(req: Request, keys: string[]): boolean {
    for (const key of keys) {
        const raw = req.query[key];
        if (raw === undefined || raw === null) continue;
        const value = typeof raw === 'string' ? raw : String(raw);
        return TRUTHY_QUERY_VALUES.has(value.trim().toLowerCase());
    }
    return false;
}
