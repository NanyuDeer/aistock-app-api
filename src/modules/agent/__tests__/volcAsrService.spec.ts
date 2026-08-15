import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { VolcAsrService, type VolcAsrServiceOptions } from '../VolcAsrService'

/** 可编程 WS 客户端 mock（对齐 tts.service.spec.ts 的 fetchImpl 注入风格） */
function createWsMock() {
  const sent: Array<{ data: Buffer; binary: boolean }> = []
  const handlers: Record<string, ((...args: any[]) => void) | null> = {}
  let openHandler: (() => void) | null = null
  return {
    sent,
    handlers,
    /** 模拟服务端响应 full server response */
    emitOpen() { openHandler?.() },
    emitMessage(payload: Buffer) { handlers.message?.({ data: payload }) },
    emitClose() { handlers.close?.() },
    emitError(err: Error) { handlers.error?.(err) },
    ws: {
      binaryType: 'arraybuffer',
      send(data: Buffer, binary = true) { sent.push({ data: Buffer.from(data), binary }) },
      close() { handlers.close?.() },
      set onopen(fn: (() => void) | null) { openHandler = fn },
      get onopen() { return openHandler },
      set onmessage(fn: ((ev: { data: unknown }) => void) | null) { handlers.message = fn },
      get onmessage() { return handlers.message },
      set onclose(fn: (() => void) | null) { handlers.close = fn },
      get onclose() { return handlers.close },
      set onerror(fn: ((ev: { error?: unknown }) => void) | null) { handlers.error = fn },
      get onerror() { return handlers.error },
    },
  }
}

/** 解析火山帧：返回 { header: Buffer, size: number, payload: Buffer } */
function parseFrame(buf: Buffer) {
  assert.ok(buf.length >= 8, '帧至少 8 字节')
  const header = buf.subarray(0, 4)
  const size = buf.readUInt32BE(4)
  const payload = buf.subarray(8, 8 + size)
  return { header, size, payload }
}

describe('VolcAsrService', () => {
  const baseOptions: VolcAsrServiceOptions = {
    appid: '5551085502',
    token: 'test-token',
    cluster: 'volcengine_streaming_common',
    connectUrl: 'wss://openspeech.bytedance.com/api/v2/asr',
    wsFactory: () => (createWsMock().ws as unknown as WebSocket),
    timeoutMs: 10000,
  }

  it('构造 full client request 帧（header 0x11 0x10 0x10 0x00 + JSON payload）', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      wsFactory: () => (mock.ws as unknown as WebSocket),
    })

    const p = service.recognize(Buffer.from('fake-mp3'))
    mock.emitOpen()
    // 补发空 server response，让 recognize 正常结算（本用例只验证请求帧构造）
    mock.emitMessage(buildServerResponse([]))
    await p
    assert.ok(mock.sent.length >= 2, '至少发送 full request + audio')
    const first = parseFrame(mock.sent[0].data)
    assert.deepEqual([...first.header], [0x11, 0x10, 0x10, 0x00])
    const config = JSON.parse(first.payload.toString('utf8'))
    assert.equal(config.app.appid, '5551085502')
    assert.equal(config.app.token, 'test-token')
    assert.equal(config.app.cluster, 'volcengine_streaming_common')
    assert.equal(config.audio.format, 'wav')
    assert.equal(config.audio.rate, 16000)
    assert.equal(config.audio.bits, 16)
    assert.equal(config.audio.channel, 1)
    assert.equal(config.audio.language, 'zh-CN')
    assert.equal(typeof config.request.reqid, 'string')
    assert.ok(config.request.reqid.length > 0, 'reqid 非空')
    assert.equal(config.request.sequence, 1)
  })

  it('音频分块发送且最后一包 sequence 取反', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      chunkBytes: 4,
      wsFactory: () => (mock.ws as unknown as WebSocket),
    })

    const p = service.recognize(Buffer.from('0123456789')) // 10 字节 → 3 块 (4+4+2)
    mock.emitOpen()
    // 补发空 server response，让 recognize 正常结算（本用例只验证音频分块）
    mock.emitMessage(buildServerResponse([]))
    await p

    // 第 1 帧是 full request，后 3 帧是 audio
    const audioFrames = mock.sent.slice(1).map(f => parseFrame(f.data))
    assert.equal(audioFrames.length, 3)
    // full request sequence=1
    const firstConfig = JSON.parse(parseFrame(mock.sent[0].data).payload.toString('utf8'))
    assert.equal(firstConfig.request.sequence, 1)
    // audio 帧 header byte1: 0x20 普通包 / 0x22 末包
    assert.equal(audioFrames[0].header[1], 0x20)
    assert.equal(audioFrames[1].header[1], 0x20)
    assert.equal(audioFrames[2].header[1], 0x22)
    // 末包 payload 末尾为剩余音频 2 字节（'89' → [0x38, 0x39]；payload 前 4 字节为 sequence，字节序见实现说明）
    const lastPayload = audioFrames[2].payload
    assert.ok(lastPayload.length >= 2, '末包 payload 至少含 2 字节音频')
    assert.deepEqual([...lastPayload.subarray(lastPayload.length - 2)], [0x38, 0x39])
  })

  it('聚合 full server response 的识别文本并返回', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      wsFactory: () => (mock.ws as unknown as WebSocket),
    })

    const p = service.recognize(Buffer.from('fake-mp3'))
    mock.emitOpen()
    mock.emitMessage(buildServerResponse([
      { text: '贵州茅台' },
    ]))
    const result = await p

    assert.deepEqual(result, { text: '贵州茅台' })
  })

  it('火山返回错误码 → 抛错透出 message', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      wsFactory: () => (mock.ws as unknown as WebSocket),
    })

    const p = service.recognize(Buffer.from('fake-mp3'))
    mock.emitOpen()
    mock.emitMessage(buildServerResponse([], 4701, 'auth failed'))
    await assert.rejects(p, /auth failed/)
  })

  it('建连失败 → 抛错', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      wsFactory: () => (mock.ws as unknown as WebSocket),
    })

    const p = service.recognize(Buffer.from('fake-mp3'))
    mock.emitError(new Error('ECONNREFUSED'))
    await assert.rejects(p, /ECONNREFUSED/)
  })

  it('超时 → 抛错', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      timeoutMs: 50,
      wsFactory: () => (mock.ws as unknown as WebSocket),
    })

    const p = service.recognize(Buffer.from('fake-mp3'))
    mock.emitOpen()
    await assert.rejects(p, /超时/)
  })
})

/** 构造火山 full server response 二进制帧 */
function buildServerResponse(results: Array<{ text: string }>, code = 1000, message = 'Success'): Buffer {
  const payload = Buffer.from(JSON.stringify({
    reqid: 'test-reqid',
    code,
    message,
    sequence: -1,
    result: results,
  }), 'utf8')
  const header = Buffer.from([0x11, 0x90, 0x10, 0x00])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, size, payload])
}
