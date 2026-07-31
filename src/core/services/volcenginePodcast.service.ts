import { randomUUID } from 'crypto'
import WebSocket from 'ws'

import type { DialogueLine } from './tts.service'

const PODCAST_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sami/podcasttts'
const START_SESSION_EVENT = 100
const SESSION_FINISHED_EVENT = 152
const USAGE_RESPONSE_EVENT = 154
const PODCAST_AUDIO_EVENT = 361
const PODCAST_ROUND_END_EVENT = 362
const FINISH_CONNECTION_EVENT = 2
const CONNECTION_FINISHED_EVENT = 52

const PODCAST_SPEAKERS = {
    host: 'zh_female_mizaitongxue_v2_saturn_bigtts',
    analyst: 'zh_male_dayixiansheng_v2_saturn_bigtts',
} as const

interface VolcenginePodcastCredentials {
    appId: string
    accessToken: string
    resourceId: string
    appKey: string
}

interface PodcastSocket {
    on(event: 'open', listener: () => void): this
    on(event: 'message', listener: (data: unknown) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'close', listener: () => void): this
    send(data: Buffer): void
    close(): void
}

interface VolcenginePodcastProviderOptions extends VolcenginePodcastCredentials {
    endpoint?: string
    timeoutMs?: number
    webSocketFactory?: (endpoint: string, headers: Record<string, string>) => PodcastSocket
}

export function readVolcenginePodcastOptions(env: Record<string, string | undefined>): VolcenginePodcastCredentials {
    const appId = env.VOLCENGINE_PODCAST_APP_ID
    const accessToken = env.VOLCENGINE_PODCAST_ACCESS_TOKEN
    if (!appId || !accessToken) {
        throw new Error('缺少 VOLCENGINE_PODCAST_APP_ID 或 VOLCENGINE_PODCAST_ACCESS_TOKEN')
    }
    return {
        appId,
        accessToken,
        resourceId: env.VOLCENGINE_PODCAST_RESOURCE_ID || 'volc.service_type.10050',
        appKey: env.VOLCENGINE_PODCAST_APP_KEY || 'aGjiRDfUWi',
    }
}

/** 单个火山引擎账号（用户提供的 App ID + Access Token + Secret Key） */
interface VolcenginePodcastAccount {
    appId: string
    accessToken: string
    appKey?: string
}

/** 从环境变量读取多账号列表，支持 JSON 数组和单账号回退 */
export function readVolcenginePodcastAccounts(env: Record<string, string | undefined>): VolcenginePodcastAccount[] {
    const accountsJson = env.VOLC_PODCAST_ACCOUNTS
    if (accountsJson) {
        try {
            const parsed: unknown = JSON.parse(accountsJson)
            if (Array.isArray(parsed) && parsed.length > 0) {
                const accounts = parsed
                    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
                    .map((item) => ({
                        appId: String(item.appId ?? item.app_id ?? ''),
                        accessToken: String(item.accessToken ?? item.access_token ?? ''),
                        appKey: item.appKey ? String(item.appKey) : (item.secret_key ? String(item.secret_key) : undefined),
                    }))
                    .filter((a) => a.appId && a.accessToken)
                if (accounts.length > 0) return accounts
            }
            console.warn('[VolcenginePodcast] VOLC_PODCAST_ACCOUNTS 解析为空，回退到单账号')
        } catch {
            console.warn('[VolcenginePodcast] VOLC_PODCAST_ACCOUNTS JSON 解析失败，回退到单账号')
        }
    }

    const single = readVolcenginePodcastOptions(env)
    return [{ appId: single.appId, accessToken: single.accessToken, appKey: single.appKey }]
}

export interface PodcastResponseEvent {
    type: 'event'
    event: number
    sessionId: string
    payload: Buffer
}

export interface PodcastErrorResponse {
    type: 'error'
    code: number
    message: string
}

export function buildPodcastPayload(sessionId: string, lines: DialogueLine[]) {
    return {
        input_id: sessionId,
        action: 3,
        use_head_music: false,
        audio_config: { format: 'mp3', sample_rate: 24000, speech_rate: 0 },
        nlp_texts: lines.map((line) => ({
            speaker: PODCAST_SPEAKERS[line.role],
            text: line.content,
        })),
    }
}

export function buildPodcastRequestHeaders(
    credentials: VolcenginePodcastCredentials,
    requestId: string,
): Record<string, string> {
    return {
        'X-Api-App-Id': credentials.appId,
        'X-Api-Access-Key': credentials.accessToken,
        'X-Api-Resource-Id': credentials.resourceId,
        'X-Api-App-Key': credentials.appKey,
        'X-Api-Request-Id': requestId,
    }
}

function buildEventFrame(event: number, payload: Buffer, sessionId?: string): Buffer {
    const session = sessionId ? Buffer.from(sessionId) : null
    const size = 4 + 4 + (session ? 4 + session.length : 0) + 4 + payload.length
    const frame = Buffer.alloc(size)
    frame.set([0x11, 0x14, 0x10, 0x00], 0)
    frame.writeUInt32BE(event, 4)

    let offset = 8
    if (session) {
        frame.writeUInt32BE(session.length, offset)
        offset += 4
        session.copy(frame, offset)
        offset += session.length
    }
    frame.writeUInt32BE(payload.length, offset)
    payload.copy(frame, offset + 4)
    return frame
}

export function buildStartSessionFrame(sessionId: string, payload: unknown): Buffer {
    return buildEventFrame(START_SESSION_EVENT, Buffer.from(JSON.stringify(payload)), sessionId)
}

export function buildFinishConnectionFrame(): Buffer {
    return buildEventFrame(FINISH_CONNECTION_EVENT, Buffer.from('{}'))
}

export function parsePodcastResponseFrame(frame: Buffer): PodcastResponseEvent | PodcastErrorResponse {
    const messageType = frame[1] >> 4
    if (messageType === 0x0f) {
        const code = frame.readUInt32BE(4)
        const messageLength = frame.readUInt32BE(8)
        return { type: 'error', code, message: frame.subarray(12, 12 + messageLength).toString() }
    }

    const event = frame.readUInt32BE(4)
    const sessionLength = frame.readUInt32BE(8)
    const sessionStart = 12
    const payloadLengthOffset = sessionStart + sessionLength
    const payloadLength = frame.readUInt32BE(payloadLengthOffset)
    const payloadStart = payloadLengthOffset + 4
    return {
        type: 'event',
        event,
        sessionId: frame.subarray(sessionStart, payloadLengthOffset).toString(),
        payload: frame.subarray(payloadStart, payloadStart + payloadLength),
    }
}

export function formatPodcastEventDiagnostic(response: PodcastResponseEvent): string {
    return `[VolcenginePodcast] event=${response.event} bytes=${response.payload.length}`
}

function toBuffer(data: unknown): Buffer {
    if (Buffer.isBuffer(data)) return data
    if (Array.isArray(data)) return Buffer.concat(data)
    return Buffer.from(data as ArrayBuffer)
}

export class VolcenginePodcastProvider {
    private readonly options: VolcenginePodcastProviderOptions

    constructor(options: VolcenginePodcastProviderOptions) {
        this.options = options
    }

    async synthesize(lines: DialogueLine[]): Promise<Buffer> {
        if (lines.length === 0) throw new Error('播报内容不能为空')

        const sessionId = randomUUID()
        const requestId = randomUUID()
        const headers = buildPodcastRequestHeaders(this.options, requestId)
        const createSocket = this.options.webSocketFactory
            ?? ((endpoint: string, socketHeaders: Record<string, string>) => new WebSocket(endpoint, { headers: socketHeaders }))

        return new Promise<Buffer>((resolve, reject) => {
            const socket = createSocket(this.options.endpoint ?? PODCAST_ENDPOINT, headers)
            const audioChunks: Buffer[] = []
            let completed = false
            let lastEvent: number | undefined
            let finishedRounds = 0
            let finishRequested = false
            const timer = setTimeout(() => {
                socket.close()
                reject(new Error('火山播客生成超时'))
            }, this.options.timeoutMs ?? 10 * 60 * 1000)

            const fail = (error: Error) => {
                if (completed) return
                completed = true
                clearTimeout(timer)
                socket.close()
                reject(error)
            }

            const requestFinish = () => {
                if (finishRequested) return
                finishRequested = true
                socket.send(buildFinishConnectionFrame())
            }

            socket.on('open', () => {
                socket.send(buildStartSessionFrame(sessionId, buildPodcastPayload(sessionId, lines)))
            })

            socket.on('message', (data) => {
                const response = parsePodcastResponseFrame(toBuffer(data))
                if (response.type === 'error') {
                    fail(new Error(`火山播客请求失败: ${response.code} ${response.message}`))
                    return
                }

                if (response.event !== lastEvent) {
                    console.info(formatPodcastEventDiagnostic(response))
                    lastEvent = response.event
                }

                if (response.event === PODCAST_AUDIO_EVENT) {
                    audioChunks.push(response.payload)
                } else if (response.event === PODCAST_ROUND_END_EVENT) {
                    finishedRounds += 1
                    if (finishedRounds === lines.length) requestFinish()
                } else if (response.event === USAGE_RESPONSE_EVENT) {
                    console.info(`[VolcenginePodcast] usage=${response.payload.toString()}`)
                } else if (response.event === SESSION_FINISHED_EVENT) {
                    requestFinish()
                } else if (response.event === CONNECTION_FINISHED_EVENT) {
                    if (audioChunks.length === 0) {
                        fail(new Error('火山播客未返回音频数据'))
                        return
                    }
                    completed = true
                    clearTimeout(timer)
                    socket.close()
                    resolve(Buffer.concat(audioChunks))
                }
            })

            socket.on('error', fail)
            socket.on('close', () => {
                if (!completed) fail(new Error('火山播客连接提前关闭'))
            })
        })
    }
}

/** 多账号轮换池：round-robin 选择账号，失败自动切换下一个 */
export class VolcenginePodcastPool {
    private readonly accounts: VolcenginePodcastAccount[]
    private readonly options: Pick<VolcenginePodcastProviderOptions, 'endpoint' | 'timeoutMs' | 'webSocketFactory'>
    private nextIndex = 0

    constructor(
        accounts: VolcenginePodcastAccount[],
        options?: Pick<VolcenginePodcastProviderOptions, 'endpoint' | 'timeoutMs' | 'webSocketFactory'>,
    ) {
        if (accounts.length === 0) throw new Error('火山播客账号池不能为空')
        this.accounts = accounts
        this.options = options ?? {}
    }

    async synthesize(lines: DialogueLine[]): Promise<Buffer> {
        const maxAttempts = this.accounts.length
        let lastError: Error | null = null

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const account = this.accounts[this.nextIndex % this.accounts.length]
            this.nextIndex++

            const credentials: VolcenginePodcastCredentials = {
                appId: account.appId,
                accessToken: account.accessToken,
                resourceId: 'volc.service_type.10050',
                appKey: account.appKey || 'aGjiRDfUWi',
            }

            try {
                const provider = new VolcenginePodcastProvider({ ...credentials, ...this.options })
                const result = await provider.synthesize(lines)
                console.info(`[VolcenginePodcastPool] 账号 ${account.appId} 合成成功 (attempt ${attempt + 1}/${maxAttempts})`)
                return result
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err))
                console.warn(`[VolcenginePodcastPool] 账号 ${account.appId} 失败 (attempt ${attempt + 1}/${maxAttempts}): ${lastError.message}`)
            }
        }

        throw lastError ?? new Error('所有火山播客账号均失败')
    }
}
