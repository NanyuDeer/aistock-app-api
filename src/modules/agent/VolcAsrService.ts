/**
 * 火山引擎「豆包流式语音识别大模型」客户端（V3，2026-08-19 从 V2 升级）
 *
 * 背景：账号开通的是「豆包流式语音识别模型 2.0-小时版」（V3 大模型），此前误连旧版
 * `/api/v2/asr`（cluster=volcengine_streaming_common → resource=volc.streamingasr.common.cn
 * 未开通 → 403）。V3 与 V2 差异（官方文档 6561/1354869，线上实测确认）：
 *   - 接口：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream（流式输入模式）
 *   - 鉴权：X-Api-App-Key(APP ID) + X-Api-Access-Key(Access Token) + X-Api-Resource-Id
 *     （豆包流式 2.0 小时版 = volc.seedasr.sauc.duration）+ X-Api-Request-Id + X-Api-Sequence(-1)
 *   - 请求体：request 必填 model_name:'bigmodel'；audio.format 仅支持 pcm/wav/ogg/mp3
 *     （不支持 amr），rate 必须 16000，bits 16，channel 1
 *   - 帧布局：统一 [header 4B][sequence 4B][size 4B][payload]，size 在 offset 8、payload 从 offset 12
 *   - 响应：result 为对象 {text}（V2 是 result 数组）
 *
 * 协议：WebSocket 二进制帧。header[0]=0x11（version=1, header size=1）；header[1] 高 4 位消息类型
 * （0x1 full request / 0x2 audio / 0x9 full server response / 0xF server error），低 4 位 flags
 * （audio 末包=0x2）；header[2]=0x10（JSON 序列化，无压缩）。
 *
 * 流程：full client request（model_name=bigmodel）→ audio only ×N（sequence 递增，末包取负）→
 * full server response（result.text）或 server error（透出 message）。
 *
 * 依赖注入：wsFactory 供单测替换；默认用 npm `ws` 包客户端（服务器 Node 20 无内置 WebSocket，
 * 与 volcenginePodcast.service.ts TTS 同库规避 Node 版本依赖）。
 */
import { randomUUID } from 'crypto'
import WebSocket from 'ws'

/** VolcAsrService 所需的最小 WS 客户端接口（生产由 npm `ws` 包实现；单测注入手工 mock） */
export interface VolcAsrWsLike {
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: ((ev: { error?: unknown }) => void) | null
  send(data: Buffer): void
  close(): void
}

/** 音频输入配置（V3 大模型：仅 pcm/wav/ogg/mp3，rate 必须 16000） */
export interface VolcAsrAudioConfig {
  format?: 'pcm' | 'wav' | 'ogg' | 'mp3'
  /** 音频编码（pcm 用 raw；ogg 必须 opus；mp3 不生效） */
  codec?: 'raw' | 'opus'
  rate?: number
  bits?: number
  channel?: number
  language?: string
}

export interface VolcAsrServiceOptions {
  /** 旧版控制台 APP ID（X-Api-App-Key） */
  appid: string
  /** 旧版控制台 Access Token（X-Api-Access-Key） */
  token: string
  /** 资源 ID（X-Api-Resource-Id），豆包流式语音识别 2.0 小时版 = volc.seedasr.sauc.duration */
  resourceId: string
  /** 建连地址（默认 V3 流式输入模式 /api/v3/sauc/bigmodel_nostream；可注入便于测试） */
  connectUrl?: string
  /** WS 客户端工厂（默认用 npm `ws` 包 new WebSocket(url, {headers})；单测注入 mock） */
  wsFactory?: () => VolcAsrWsLike
  /** 音频分块字节数（默认 8192；单包建议 100~200ms） */
  chunkBytes?: number
  /** 整体识别超时 ms（默认 10000） */
  timeoutMs?: number
  /** 音频元数据（默认 pcm + 16000 + 16bit + 单声道 + zh-CN，与 App 端录音对齐） */
  audio?: VolcAsrAudioConfig
}

export interface AsrRecognizeResult {
  text: string
}

const DEFAULT_CONNECT_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'
const DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration' // 豆包流式语音识别模型 2.0-小时版
const HEADER_SIZE = 4

/** 火山 V3 消息类型 */
const MSG_FULL_CLIENT_REQUEST = 0x1
const MSG_AUDIO_ONLY = 0x2
const MSG_FULL_SERVER_RESPONSE = 0x9
const MSG_SERVER_ERROR_RESPONSE = 0xf
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
  private readonly resourceId: string
  private readonly connectUrl: string
  private readonly wsFactory: () => VolcAsrWsLike
  private readonly chunkBytes: number
  private readonly timeoutMs: number
  private readonly audio: Required<VolcAsrAudioConfig>

  constructor(options: VolcAsrServiceOptions) {
    this.appid = options.appid
    this.token = options.token
    this.resourceId = options.resourceId ?? DEFAULT_RESOURCE_ID
    this.connectUrl = options.connectUrl ?? DEFAULT_CONNECT_URL
    this.audio = {
      format: options.audio?.format ?? 'pcm',
      codec: options.audio?.codec ?? 'raw',
      rate: options.audio?.rate ?? 16000,
      bits: options.audio?.bits ?? 16,
      channel: options.audio?.channel ?? 1,
      language: options.audio?.language ?? 'zh-CN',
    }
    // V3 鉴权（旧版控制台，官方文档 6561/1354869）：X-Api-App-Key + X-Api-Access-Key +
    // X-Api-Resource-Id + X-Api-Request-Id + X-Api-Sequence(-1)。2026-08-19 线上实测通过。
    // 断言理由：ws 包回调签名带事件参数，与最小接口无参回调在 strictFunctionTypes 下不协变；
    // 运行时方法集完全满足 VolcAsrWsLike。
    this.wsFactory = options.wsFactory ?? (() => new WebSocket(this.connectUrl, {
      headers: {
        'X-Api-App-Key': this.appid,
        'X-Api-Access-Key': this.token,
        'X-Api-Resource-Id': this.resourceId,
        'X-Api-Request-Id': randomUUID(),
        'X-Api-Sequence': '-1',
      },
    }) as unknown as VolcAsrWsLike)
    this.chunkBytes = options.chunkBytes ?? 8192
    this.timeoutMs = options.timeoutMs ?? 10000
  }

  /**
   * 识别一段音频（V3 要求 pcm/wav/ogg/mp3；与 App 端 PCM 16kHz 录音对齐）。
   * 返回识别文本；失败抛错（错误信息可直接透出给前端）。
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
      let sequence = 1
      // V3 流式输入模式：服务端持续返回中间结果帧（text 为空、audio_info.duration 递增），
      // 最后返回带 text/utterances 的最终帧（2026-08-20 线上抓包实证：3s 语音 13 帧，
      // 前 12 帧空、第 13 帧才带文本）。必须聚合文本并等到最终帧才结算，
      // 否则取到第一个空帧 → App「未识别到语音」。
      let lastText = ''

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

      const settleWithText = (text: string) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ text: text.trim() })
      }

      const sendFullRequest = () => {
        const config = {
          user: { uid: 'aistock-app' },
          audio: {
            format: this.audio.format,
            codec: this.audio.codec,
            rate: this.audio.rate,
            bits: this.audio.bits,
            channel: this.audio.channel,
            language: this.audio.language,
          },
          request: {
            // V3 必填：大模型标识（官方文档：目前只有 bigmodel）
            model_name: 'bigmodel',
            enable_itn: true,
            enable_punc: true,
          },
        }
        ws.send(buildFrame(MSG_FULL_CLIENT_REQUEST, 0, Buffer.from(JSON.stringify(config), 'utf8')))
      }

      const sendAudio = () => {
        const total = audio.length
        let offset = 0
        let seq = sequence // full request 后 sequence 从 2 递增
        while (offset < total) {
          seq += 1
          const end = Math.min(offset + this.chunkBytes, total)
          const isLast = end >= total
          const flags = isLast ? FLAG_LAST_PACKET : 0
          // 最后一包 sequence 取反（负包，协议硬性要求）
          const wireSeq = isLast ? -seq : seq
          const payload = Buffer.alloc(4)
          payload.writeInt32BE(wireSeq, 0)
          // audio 包 payload 前 4 字节为 sequence，其后为音频数据
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
        if (buf.length < 12) return // 忽略无效短帧（V3 帧最小 12 字节）
        const msgType = buf[1] >> 4
        // 只处理 FULL_SERVER_RESPONSE(0x9) 与 SERVER_ERROR_RESPONSE(0xF)，其余（如 SERVER_ACK 0xB）忽略。
        // 错误帧必须透出 message（2026-08-19 曾丢弃错误帧导致"识别超时"症状）。
        if (msgType !== MSG_FULL_SERVER_RESPONSE && msgType !== MSG_SERVER_ERROR_RESPONSE) return
        // V3 帧布局统一：[header 4B][sequence 4B][size 4B][payload]，size 在 offset 8、payload 从 offset 12
        const size = buf.readUInt32BE(8)
        if (buf.length < 12 + size) return // 粘包不完整，忽略（单结果场景足够）
        const payload = buf.subarray(12, 12 + size)

        let parsed: { code?: number; message?: string; result?: { text?: string; utterances?: unknown[] } }
        try {
          parsed = JSON.parse(payload.toString('utf8'))
        } catch {
          fail(new Error('语音识别结果解析失败'))
          return
        }

        if (msgType === MSG_SERVER_ERROR_RESPONSE || (parsed.code !== undefined && parsed.code !== 1000)) {
          fail(new Error(parsed.message || `语音识别失败（${parsed.code ?? ''}）`))
          return
        }

        // 流式输入模式：中间结果帧（text 空、无 utterances）不结算，继续等最终帧。
        // 最终帧标记：result.utterances 存在 或 text 非空（线上实证最终帧两者皆有）。
        const text = (parsed.result?.text ?? '').trim()
        if (text) lastText = text
        const isFinal = Array.isArray(parsed.result?.utterances) || text.length > 0
        if (!isFinal) return
        settleWithText(text || lastText)
      }

      ws.onerror = (ev) => {
        // 兼容两种事件形态：标准 Event（无 error 字段）与直接抛出的 Error 对象（单测 mock 形态）
        const detail = (ev as { error?: unknown }).error ?? ev
        const msg = detail instanceof Error ? detail.message : '语音识别服务连接失败'
        fail(new Error(msg))
      }

      ws.onclose = () => {
        // 服务端可能在最终帧后关闭连接；若已有聚合文本则兜底结算，否则按连接中断处理
        if (lastText) {
          settleWithText(lastText)
          return
        }
        if (!settled) fail(new Error('语音识别服务连接中断'))
      }
    })
  }
}
