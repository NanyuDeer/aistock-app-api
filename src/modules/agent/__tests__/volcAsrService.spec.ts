import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { VolcAsrService, type VolcAsrServiceOptions, type VolcAsrWsLike } from '../VolcAsrService'

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

/**
 * 解析火山 V3 客户端发送帧：[header 4B][size 4B][payload]。
 * 注意：仅发送方向（full request / audio）是此布局；服务端响应帧才是
 * [header 4B][sequence 4B][size 4B][payload]，由 VolcAsrService.onmessage 解析，
 * 测试侧无需解析。audio 包的 sequence 位于 payload 前 4 字节。
 */
function parseFrame(buf: Buffer) {
  assert.ok(buf.length >= 8, 'V3 发送帧至少 8 字节')
  const header = buf.subarray(0, 4)
  const size = buf.readUInt32BE(4)
  const payload = buf.subarray(8, 8 + size)
  return { header, size, payload }
}

describe('VolcAsrService (V3 豆包流式语音识别大模型)', () => {
  const baseOptions: VolcAsrServiceOptions = {
    appid: '5551085502',
    token: 'test-token',
    resourceId: 'volc.seedasr.sauc.duration',
    connectUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
    wsFactory: () => (createWsMock().ws as unknown as VolcAsrWsLike),
    timeoutMs: 10000,
  }

  it('构造 full client request 帧（header 0x11 0x10 0x10 0x00 + JSON payload 含 model_name/audio 配置）', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      wsFactory: () => (mock.ws as unknown as VolcAsrWsLike),
    })

    const p = service.recognize(Buffer.from('fake-pcm'))
    mock.emitOpen()
    // 补发空 server response，让 recognize 正常结算（本用例只验证请求帧构造）
    mock.emitMessage(buildServerResponse(''))
    await p
    assert.ok(mock.sent.length >= 2, '至少发送 full request + audio')
    const first = parseFrame(mock.sent[0].data)
    assert.deepEqual([...first.header], [0x11, 0x10, 0x10, 0x00])
    const config = JSON.parse(first.payload.toString('utf8'))
    assert.equal(config.user.uid, 'aistock-app')
    // V3 关键字段
    assert.equal(config.request.model_name, 'bigmodel')
    assert.equal(config.audio.format, 'pcm')
    assert.equal(config.audio.codec, 'raw')
    assert.equal(config.audio.rate, 16000)
    assert.equal(config.audio.bits, 16)
    assert.equal(config.audio.channel, 1)
    assert.equal(config.audio.language, 'zh-CN')
  })

  it('音频分块发送且最后一包 sequence 取反', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      chunkBytes: 4,
      wsFactory: () => (mock.ws as unknown as VolcAsrWsLike),
    })

    const p = service.recognize(Buffer.from('0123456789')) // 10 字节 → 3 块 (4+4+2)
    mock.emitOpen()
    // 补发空 server response，让 recognize 正常结算（本用例只验证音频分块）
    mock.emitMessage(buildServerResponse(''))
    await p

    // 第 1 帧是 full request，后 3 帧是 audio
    const audioFrames = mock.sent.slice(1).map(f => parseFrame(f.data))
    assert.equal(audioFrames.length, 3)
    // audio 帧 header byte1: 0x20 普通包 / 0x22 末包
    assert.equal(audioFrames[0].header[1], 0x20)
    assert.equal(audioFrames[1].header[1], 0x20)
    assert.equal(audioFrames[2].header[1], 0x22)
    // 末包 sequence 取负（-4：full request seq=1 + 3 个 audio 包，末包 seq=4 → -4）。
    // audio 包 sequence 在 payload 前 4 字节（发送帧无独立 sequence 字段）
    assert.equal(audioFrames[2].payload.readInt32BE(0), -4)
    // 末包 payload 末尾为剩余音频 2 字节（'89' → [0x38, 0x39]；payload 前 4 字节为 sequence）
    const lastPayload = audioFrames[2].payload
    assert.ok(lastPayload.length >= 6, '末包 payload 至少含 4 字节 sequence + 2 字节音频')
    assert.deepEqual([...lastPayload.subarray(lastPayload.length - 2)], [0x38, 0x39])
  })

  it('聚合 full server response 的识别文本并返回（V3 result 对象结构）', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      wsFactory: () => (mock.ws as unknown as VolcAsrWsLike),
    })

    const p = service.recognize(Buffer.from('fake-pcm'))
    mock.emitOpen()
    mock.emitMessage(buildServerResponse('贵州茅台'))
    const result = await p

    assert.deepEqual(result, { text: '贵州茅台' })
  })

  it('火山返回错误码（type 0x9 但 code != 1000）→ 抛错透出 message', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      wsFactory: () => (mock.ws as unknown as VolcAsrWsLike),
    })

    const p = service.recognize(Buffer.from('fake-pcm'))
    mock.emitOpen()
    mock.emitMessage(buildServerError('internal error', 4701))
    await assert.rejects(p, /internal error/)
  })

  it('服务端错误响应帧（type=0xF SERVER_ERROR_RESPONSE）→ 抛错透出 message（不得静默丢弃等超时）', async () => {
    // 2026-08-19 线上诊断：未开通资源时火山返回 type=15 错误帧；曾只认 0x9 导致丢弃 → 10s 超时。
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      wsFactory: () => (mock.ws as unknown as VolcAsrWsLike),
    })

    const p = service.recognize(Buffer.from('fake-pcm'))
    mock.emitOpen()
    mock.emitMessage(buildErrorResponse('requested resource not granted', 403))
    await assert.rejects(p, /requested resource not granted/)
  })

  it('建连失败 → 抛错', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      wsFactory: () => (mock.ws as unknown as VolcAsrWsLike),
    })

    const p = service.recognize(Buffer.from('fake-pcm'))
    mock.emitError(new Error('ECONNREFUSED'))
    await assert.rejects(p, /ECONNREFUSED/)
  })

  it('超时 → 抛错', async () => {
    const mock = createWsMock()
    const service = new VolcAsrService({
      ...baseOptions,
      timeoutMs: 50,
      wsFactory: () => (mock.ws as unknown as VolcAsrWsLike),
    })

    const p = service.recognize(Buffer.from('fake-pcm'))
    mock.emitOpen()
    await assert.rejects(p, /超时/)
  })
})

/** 构造火山 V3 full server response 成功帧：[header 0x91][seq=1][size][payload{audio_info,result:{text}}] */
function buildServerResponse(text: string): Buffer {
  const payload = Buffer.from(JSON.stringify({
    audio_info: { duration: 1000 },
    result: { additions: {}, text },
  }), 'utf8')
  const header = Buffer.from([0x11, 0x91, 0x10, 0x00])
  const seq = Buffer.alloc(4)
  seq.writeInt32BE(1, 0)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, seq, size, payload])
}

/** 构造火山 V3 full server response 错误帧（type 0x9 但 code != 1000） */
function buildServerError(message: string, code = 4701): Buffer {
  const payload = Buffer.from(JSON.stringify({ code, message }), 'utf8')
  const header = Buffer.from([0x11, 0x91, 0x10, 0x00])
  const seq = Buffer.alloc(4)
  seq.writeInt32BE(1, 0)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, seq, size, payload])
}

/** 构造火山 V3 SERVER_ERROR_RESPONSE 帧（type=0xF，header byte1 高 4 位 0xF） */
function buildErrorResponse(message: string, code = 403): Buffer {
  const payload = Buffer.from(JSON.stringify({ code, message }), 'utf8')
  const header = Buffer.from([0x11, 0xf1, 0x10, 0x00])
  const seq = Buffer.alloc(4)
  seq.writeInt32BE(1, 0)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, seq, size, payload])
}
