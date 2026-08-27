import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSingleByteRange } from '../audioRange.service'

describe('audio byte range parsing', () => {
    it('解析浏览器请求的闭区间 Range', () => {
        assert.deepEqual(parseSingleByteRange('bytes=10-19', 100), { start: 10, end: 19 })
    })

    it('解析从指定位置到文件末尾的 Range', () => {
        assert.deepEqual(parseSingleByteRange('bytes=90-', 100), { start: 90, end: 99 })
    })

    it('拒绝越界或多段 Range', () => {
        assert.equal(parseSingleByteRange('bytes=100-120', 100), null)
        assert.equal(parseSingleByteRange('bytes=0-1,3-4', 100), null)
    })
})
