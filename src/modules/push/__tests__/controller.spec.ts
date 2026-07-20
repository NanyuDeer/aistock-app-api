import assert from 'node:assert/strict';
import test from 'node:test';
import { withReturn } from '../controller';

// 回归测试：PostgreSQL NUMERIC 列经 pg 驱动默认返回字符串。
// withReturn 必须把数值字段从字符串归一化为 number，
// 否则前端 .toFixed() 会抛 TypeError，导致 App 端历史推送页渲染崩溃（一闪而过空白）。
test('withReturn converts string numeric fields from the database to real numbers', () => {
    const record = {
        push_id: 'windleader_20260717_test',
        stock_code: '600519',
        stock_name: '贵州茅台',
        // pg 驱动对 NUMERIC(12,4) 列返回字符串
        push_price: '10.5000' as unknown as number,
        latest_price: '11.2000' as unknown as number,
        latest_change_pct: '6.6667' as unknown as number,
        realtime_return_pct: '7.1111' as unknown as number,
        score: '85.5000' as unknown as number,
    };

    const result = withReturn(record);

    assert.equal(typeof result.push_price, 'number', 'push_price must be a number');
    assert.equal(result.push_price, 10.5);
    assert.equal(typeof result.latest_price, 'number', 'latest_price must be a number');
    assert.equal(result.latest_price, 11.2);
    assert.equal(typeof result.latest_change_pct, 'number');
    assert.equal(typeof result.realtime_return_pct, 'number');
    assert.equal(typeof result.score, 'number');
    assert.equal(result.score, 85.5);
});

test('withReturn computes return_pct and keeps numbers finite', () => {
    const result = withReturn({
        push_price: '10.0000' as unknown as number,
        latest_price: '12.5000' as unknown as number,
    });

    assert.equal(result.return_pct, 25);
    assert.equal(typeof result.return_pct, 'number');
});

test('withReturn tolerates null numeric fields without throwing', () => {
    const result = withReturn({
        push_price: null,
        latest_price: null,
    });

    assert.equal(result.push_price, null);
    assert.equal(result.latest_price, null);
    assert.equal(result.return_pct, null);
});
