/**
 * 行业名归一与同族展开单测（自选股相关事件卡片）。
 *
 * 契约：resolveIndustryAliases 把行业名归一到申万一级后反查同族全部细分行业名；
 * 精确/去罗马后缀/旧名归一均需命中；未知名与空串降级不报错。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIndustryAliases, stripRomanSuffix } from '../industryAlias';

describe('resolveIndustryAliases（行业名 → 同族行业名集合）', () => {
    it('精确命中的申万一级行业名 → 展开同族全部细分行业', () => {
        const aliases = resolveIndustryAliases('电力设备');
        assert.ok(aliases.includes('电力设备'));
        assert.ok(aliases.includes('电池'));
        assert.ok(aliases.includes('光伏设备'));
        // 不跨一级：不含农林牧渔
        assert.ok(!aliases.includes('农林牧渔'));
    });

    it('Tushare 旧名「电气设备」→ 归一到「电力设备」后展开（含电池/光伏设备）', () => {
        const aliases = resolveIndustryAliases('电气设备');
        assert.ok(aliases.includes('电池'));
        assert.ok(aliases.includes('光伏设备'));
    });

    it('去「Ⅲ/Ⅱ/Ⅰ」后缀（保险Ⅲ → 保险，展开到证券）', () => {
        assert.equal(stripRomanSuffix('保险Ⅲ'), '保险');
        assert.equal(stripRomanSuffix('半导体材料Ⅱ'), '半导体材料');
        const aliases = resolveIndustryAliases('保险Ⅲ');
        assert.ok(aliases.includes('保险'));
        assert.ok(aliases.includes('证券'));
    });

    it('银行 → 仅自身（同族只有银行）', () => {
        assert.deepEqual(resolveIndustryAliases('银行'), ['银行']);
    });

    it('未知行业名 → 降级返回去后缀后的自身；空输入 → []', () => {
        assert.deepEqual(resolveIndustryAliases('某不存在的行业'), ['某不存在的行业']);
        assert.deepEqual(resolveIndustryAliases(''), []);
    });
});
