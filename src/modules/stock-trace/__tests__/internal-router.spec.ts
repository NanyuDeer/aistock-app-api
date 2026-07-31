import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { StockTraceService } from '../StockTraceService';
import stockTraceInternalRouter from '../internalRouter';

test('internal Stock Trace event route is mounted and requires the internal token', async () => {
    const originalGetInternalEvent = StockTraceService.getInternalEvent;
    const requestedEventIds: string[] = [];
    StockTraceService.getInternalEvent = async (eventId: string) => {
        requestedEventIds.push(eventId);
        return { event_id: eventId, trigger_revision: 1 };
    };

    const app = express();
    app.use(express.json());
    app.use('/internal/stock-trace', stockTraceInternalRouter);
    const server = app.listen(0, '127.0.0.1');

    try {
        await once(server, 'listening');
        const address = server.address() as AddressInfo;
        const eventId = 'mv:600519:2026-07-31:1785500000000:up';
        const url = `http://127.0.0.1:${address.port}/internal/stock-trace/events/${encodeURIComponent(eventId)}`;

        const forbidden = await fetch(url);
        assert.equal(forbidden.status, 403);
        assert.deepEqual(requestedEventIds, []);

        const internalToken = process.env.INTERNAL_API_TOKEN
            || process.env.INTERNAL_TOKEN
            || 'change-me-in-production';
        const response = await fetch(url, {
            headers: { 'X-Internal-Token': internalToken },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            code: 200,
            data: { event_id: eventId, trigger_revision: 1 },
        });
        assert.deepEqual(requestedEventIds, [eventId]);
    } finally {
        StockTraceService.getInternalEvent = originalGetInternalEvent;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});
