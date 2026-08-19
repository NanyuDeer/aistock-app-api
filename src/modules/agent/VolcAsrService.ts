/**
 * 火山引擎流式语音识别 V2 客户端（批次 3a，2026-08-14）
 *
 * 协议：WebSocket 二进制协议，帧 = 4 字节 header + 4 字节 payload size（uint32 大端）+ payload。
 * header[0]: 高 4 位 protocol version=0001，低 4 位 header size=0001（×4 = 4 字节）
 * header[1]: 高 4 位 message type（0x1 full request / 0x2 audio），低 4 位 specific flags（末包=0010）
 * header[2]: 高 4 位 serialization（0x1 JSON），低 4 位 compression（0x0 none）
 * header[3]: reserved = 0
 *
 * 流程：full client request（seq=1）→ audio only ×N（中间 seq 递增，末包 seq 取反）→ full server response（code=1000 成功）
 *
 * 依赖注入：wsFactory 供单测替换（对齐 tts.service.ts 的 fetchImpl 注入风格）；默认用 npm `ws` 包客户端。
 */
import { randomUUID } from 'crypto'
// 用 npm `ws` 包而非 Node 内置全局 WebSocket：内置 WebSocket 需 Node 22+，
// 而服务器 aistock-app-api 由 pm2 跑在 Node v20.20.2（全局 WebSocket=undefined），
// 曾导致真机语音识别报 502「语音识别服务异常」（VolcAsrService 内部 ReferenceError）。
// 与 volcenginePodcast.service.ts（TTS）保持同一连接库，规避 Node 版本依赖。
import WebSocket from 'ws'

/** VolcAsrService 所需的最小 WS 客户端接口（生产由 npm `ws` 包实现；单测注入手工 mock，
 * 避免与 @types/ws 全量类型强绑定）。与 Node 内置 WebSocket（Node 22+）同形，可互替。 */
export interface VolcAsrWsLike {
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: ((ev: { error?: unknown }) => void) | null
  send(data: Buffer): void
  close(): void
}

export interface VolcAsrServiceOptions {
  appid: string
  token: string
  cluster: string
  /** 建连地址（默认 wss://openspeech.bytedance.com/api/v2/asr；可注入便于测试） */
  connectUrl?: string
  /** WS 客户端工厂（默认用 npm `ws` 包 new WebSocket(url)；单测注入 mock） */
  wsFactory?: () => VolcAsrWsLike
  /** 音频分块字节数（默认 8192） */
  chunkBytes?: number
  /** 整体识别超时 ms（默认 10000） */
  timeoutMs?: number
}

export interface AsrRecognizeResult {
  text: string
}

const DEFAULT_CONNECT_URL = 'wss://openspeech.bytedance.com/api/v2/asr'
const HEADER_SIZE = 4

/** 火山 V2 消息类型 */
const MSG_FULL_CLIENT_REQUEST = 0x1
const MSG_AUDIO_ONLY = 0x2
const FLAG_LAST_PACKET = 0x2

function buildFrame(messageType: number, flags: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE)
  // protocol version=1, header size=1
  header[0] = (0b0001 << 4) | 0b0001
  // message type（高 4 位）+ flags（低 4 位）
  header[1] = ((messageType & 0b1111) << 4) | (flags & 0b1111)
  // serialization=JSON(1), compression=none(0)
  header[2] = (0b0001 << 4) | 0b0000
  header[3] = 0x00

  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, size, payload])
}

export class VolcAsrService {
  private readonly appid: string
  private readonly token: string
  private readonly cluster: string
  private readonly connectUrl: string
  private readonly wsFactory: () => VolcAsrWsLike
  private readonly chunkBytes: number
  private readonly timeoutMs: number

  constructor(options: VolcAsrServiceOptions) {
    this.appid = options.appid
    this.token = options.token
    this.cluster = options.cluster
    this.connectUrl = options.connectUrl ?? DEFAULT_CONNECT_URL
    // 断言理由：ws 包 WebSocket 回调签名带事件参数（onopen(event: Event) 等），
    // 与最小接口的无参回调在 strictFunctionTypes 下不协变；运行时方法集完全满足
    // VolcAsrWsLike（onopen/onmessage/onclose/onerror/send/close），见构造器上方接口注释。
    // V2 Token 鉴权：Authorization: Bearer; {token}（分号分隔，官方文档 6561/107789）。
    // 2026-08-19 线上诊断：不加 header → 401 missing Authorization；Bearer 空格 → invalid auth token；
    // 只有 Bearer; 分号格式才通过鉴权层。
    this.wsFactory = options.wsFactory ?? (() => new WebSocket(this.connectUrl, {
      headers: { Authorization: `Bearer; ${this.token}` },
    }) as unknown as VolcAsrWsLike)
    this.chunkBytes = options.chunkBytes ?? 8192
    this.timeoutMs = options.timeoutMs ?? 10000
  }

  /**
   * 识别一段音频（amr/mp3/wav 均可，V2 协议 audio.format 直传免转码）。
   * 返回聚合后的识别文本；失败抛错（错误信息可直接透出给前端）。
   */
  recognize(audio: Buffer): Promise<AsrRecognizeResult> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          cleanup()
          reject(new Error('语音识别超时，请重试'))
        }
      }, this.timeoutMs)

      const ws = this.wsFactory()
      const reqid = randomUUID()
      let sequence = 1

      const cleanup = () => {
        clearTimeout(timeout)
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        try { ws.close() } catch { /* 已关闭 */ }
      }

      const fail = (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }

      const sendFullRequest = () => {
        const config = {
          app: { appid: this.appid, token: this.token, cluster: this.cluster },
          user: { uid: 'aistock-app' },
          audio: { format: 'amr', rate: 8000, bits: 16, channel: 1, language: 'zh-CN' },
          request: {
            reqid,
            sequence,
            show_utterances: false,
            nbest: 1,
          },
        }
        ws.send(buildFrame(MSG_FULL_CLIENT_REQUEST, 0, Buffer.from(JSON.stringify(config), 'utf8')))
      }

      const sendAudio = () => {
        const total = audio.length
        let offset = 0
        let seq = sequence // 当前 sequence 从 full request 之后递增
        while (offset < total) {
          seq += 1
          const end = Math.min(offset + this.chunkBytes, total)
          const isLast = end >= total
          const flags = isLast ? FLAG_LAST_PACKET : 0
          // 最后一包 sequence 取反（V2 协议硬性要求）
          const wireSeq = isLast ? -seq : seq
          const payload = Buffer.alloc(4)
          payload.writeInt32BE(wireSeq, 0)
          // 注意：V2 audio 包 payload 前 4 字节为 sequence，其后为音频数据
          const audioChunk = audio.subarray(offset, end)
          ws.send(buildFrame(MSG_AUDIO_ONLY, flags, Buffer.concat([payload, audioChunk])))
          offset = end
        }
      }

      ws.onopen = () => {
        sendFullRequest()
        sendAudio()
      }

      ws.onmessage = (ev) => {
        const raw = ev.data
        let buf: Buffer
        if (raw instanceof ArrayBuffer) {
          buf = Buffer.from(raw)
        } else if (ArrayBuffer.isView(raw)) {
          buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
        } else if (typeof raw === 'string') {
          buf = Buffer.from(raw, 'utf8')
        } else {
          fail(new Error('语音识别服务返回异常数据'))
          return
        }
        if (buf.length < 8) return // 忽略无效短帧
        const msgType = buf[1] >> 4
        // 只处理 FULL_SERVER_RESPONSE(0x9) 与 SERVER_ERROR_RESPONSE(0xF)，其余（如 SERVER_ACK 0xB）忽略。
        // 2026-08-19：曾只认 0x9，把 0xF 错误帧当垃圾丢弃 → 火山 403「requested resource not granted」
        // 被静默吞掉、识别一直等到超时（App 显示"语音识别超时"）。错误帧必须透出 message。
        if (msgType !== 0x9 && msgType !== 0xf) return
        // 帧布局（2026-08-19 线上探测确认）：
        // - FULL_SERVER_RESPONSE(0x9)：[header 4B][size 4B][payload] → size 在 offset 4
        // - SERVER_ERROR_RESPONSE(0xF)：[header 4B][backend_code 4B][size 4B][payload] → size 在 offset 8
        // 曾统一用 offset 4 读错误帧 size → 读到 backend_code 45000030，判定"粘包不完整"跳过 → 等超时。
        const sizeOffset = msgType === 0xf ? 8 : 4
        const size = buf.readUInt32BE(sizeOffset)
        if (buf.length < sizeOffset + 4 + size) return // 粘包不完整，忽略（单结果场景足够）
        const payload = buf.subarray(sizeOffset + 4, sizeOffset + 4 + size)

        let parsed: { code: number; message: string; result?: Array<{ text: string }> }
        try {
          parsed = JSON.parse(payload.toString('utf8'))
        } catch {
          fail(new Error('语音识别结果解析失败'))
          return
        }

        if (msgType === 0xf || parsed.code !== 1000) {
          fail(new Error(parsed.message || `语音识别失败（${parsed.code}）`))
          return
        }

        const text = (parsed.result ?? []).map(r => r.text ?? '').join('').trim()
        if (settled) return
        settled = true
        cleanup()
        resolve({ text })
      }

      ws.onerror = (ev) => {
        // 兼容两种事件形态：标准 Event（无 error 字段）与直接抛出的 Error 对象（单测 mock 形态）
        const detail = (ev as { error?: unknown }).error ?? ev
        const msg = detail instanceof Error ? detail.message : '语音识别服务连接失败'
        fail(new Error(msg))
      }

      ws.onclose = () => {
        if (!settled) fail(new Error('语音识别服务连接中断'))
      }
    })
  }
}
