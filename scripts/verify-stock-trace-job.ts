import pool from '../src/core/db';
import { StockTraceJobService } from '../src/modules/stock-trace/StockTraceJobService';

const eventId = process.argv[2];

if (!eventId) {
    throw new Error('Usage: node --import tsx scripts/verify-stock-trace-job.ts <event_id>');
}

async function run(): Promise<void> {
    await StockTraceJobService.ensureSchema();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const jobId = await StockTraceJobService.enqueue(client, { eventId, triggerRevision: 1 });
        await client.query('COMMIT');
        const publishOutcome = await StockTraceJobService.publishPending();
        console.log(JSON.stringify({ eventId, jobId, publishOutcome }));
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

void run().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
