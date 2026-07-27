import assert from 'node:assert';
import { describe, test } from 'node:test';

import { isQaMode, shouldRunBackgroundJobs } from '../qa_mode';

describe('QA runtime mode', () => {
    test('only exact QA_MODE=true enables QA isolation', () => {
        assert.strictEqual(isQaMode({ QA_MODE: 'true' }), true);
        assert.strictEqual(isQaMode({ QA_MODE: 'TRUE' }), false);
        assert.strictEqual(isQaMode({ QA_MODE: '1' }), false);
        assert.strictEqual(isQaMode({}), false);
    });

    test('QA isolation disables background jobs while production defaults remain enabled', () => {
        assert.strictEqual(shouldRunBackgroundJobs({ QA_MODE: 'true' }), false);
        assert.strictEqual(shouldRunBackgroundJobs({ QA_MODE: 'false' }), true);
        assert.strictEqual(shouldRunBackgroundJobs({}), true);
    });
});
