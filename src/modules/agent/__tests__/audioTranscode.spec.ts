import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isAmr } from '../audioTranscode'

describe('audioTranscode.isAmr', () => {
  it('AMR-NB 头（#!AMR\\n）→ true', () => {
    assert.equal(isAmr(Buffer.from('#!AMR\n00000000000000')), true)
  })

  it('AMR-WB 头（#!AMR-WB，线上取证 App 假 pcm 实际格式）→ true', () => {
    // 线上日志 magic=2321414d522d5742 = '#!AMR-WB'（App format:\'pcm\' 实为 AMR-WB）
    assert.equal(isAmr(Buffer.from('#!AMR-WB123456')), true)
  })

  it('纯 PCM（无魔数）→ false', () => {
    assert.equal(isAmr(Buffer.alloc(160)), false)
  })

  it('mp3（ID3 头）→ false', () => {
    assert.equal(isAmr(Buffer.from('ID3\x03\x00\x00\x00')), false)
  })

  it('wav（RIFF 头）→ false', () => {
    assert.equal(isAmr(Buffer.from('RIFF....WAVEfmt ')), false)
  })

  it('不足 5 字节 → false（不越界）', () => {
    assert.equal(isAmr(Buffer.from('#!AM')), false)
  })
})
