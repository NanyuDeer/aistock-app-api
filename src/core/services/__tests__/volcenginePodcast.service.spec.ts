import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
    buildPodcastPayload,
    buildPodcastRequestHeaders,
    buildFinishConnectionFrame,
    buildStartSessionFrame,
    formatPodcastEventDiagnostic,
    parsePodcastResponseFrame,
    readVolcenginePodcastOptions,
    VolcenginePodcastProvider,
} from '../volcenginePodcast.service'

function buildResponseFrame(event: number, payload: Buffer, sessionId = 'abc', messageType = 0x94): Buffer {
    const session = Buffer.from(sessionId)
    const frame = Buffer.alloc(4 + 4 + 4 + session.length + 4 + payload.length)
    frame.set([0x11, messageType, messageType === 0xb4 ? 0x00 : 0x10, 0x00], 0)
    frame.writeUInt32BE(event, 4)
    frame.writeUInt32BE(session.length, 8)
    session.copy(frame, 12)
    frame.writeUInt32BE(payload.length, 12 + session.length)
    payload.copy(frame, 16 + session.length)
    return frame
}

describe('Volcengine podcast protocol', () => {
    it('将现有双人台词转换为 action=3 请求', () => {
        assert.deepEqual(buildPodcastPayload('session-1', [
            { role: 'host', content: '主持人开场。' },
            { role: 'analyst', content: '分析师解读。' },
        ]), {
            input_id: 'session-1',
            action: 3,
            use_head_music: false,
            audio_config: { format: 'mp3', sample_rate: 24000, speech_rate: 0 },
            nlp_texts: [
                { speaker: 'zh_female_mizaitongxue_v2_saturn_bigtts', text: '主持人开场。' },
                { speaker: 'zh_male_dayixiansheng_v2_saturn_bigtts', text: '分析师解读。' },
            ],
        })
    })

    it('构造播客鉴权请求头', () => {
        assert.deepEqual(buildPodcastRequestHeaders({
            appId: 'app-id',
            accessToken: 'access-token',
            resourceId: 'volc.service_type.10050',
            appKey: 'aGjiRDfUWi',
        }, 'request-id'), {
            'X-Api-App-Id': 'app-id',
            'X-Api-Access-Key': 'access-token',
            'X-Api-Resource-Id': 'volc.service_type.10050',
            'X-Api-App-Key': 'aGjiRDfUWi',
            'X-Api-Request-Id': 'request-id',
        })
    })

    it('从环境变量读取播客配置并使用协议固定值', () => {
        assert.deepEqual(readVolcenginePodcastOptions({
            VOLCENGINE_PODCAST_APP_ID: 'app-id',
            VOLCENGINE_PODCAST_ACCESS_TOKEN: 'access-token',
        }), {
            appId: 'app-id',
            accessToken: 'access-token',
            resourceId: 'volc.service_type.10050',
            appKey: 'aGjiRDfUWi',
        })
    })

    it('按 WebSocket V3 协议构造 StartSession 二进制帧', () => {
        const frame = buildStartSessionFrame('abc', { action: 3 })

        assert.deepEqual([...frame.subarray(0, 12)], [0x11, 0x14, 0x10, 0x00, 0, 0, 0, 100, 0, 0, 0, 3])
        assert.equal(frame.subarray(12, 15).toString(), 'abc')
        assert.equal(frame.readUInt32BE(15), Buffer.byteLength('{"action":3}'))
        assert.equal(frame.subarray(19).toString(), '{"action":3}')
    })

    it('解析 PodcastRoundResponse 音频帧', () => {
        const sessionId = Buffer.from('abc')
        const audio = Buffer.from([0xff, 0xf3, 0x64, 0xc4])
        const frame = Buffer.alloc(4 + 4 + 4 + sessionId.length + 4 + audio.length)
        frame.set([0x11, 0xb4, 0x00, 0x00], 0)
        frame.writeUInt32BE(361, 4)
        frame.writeUInt32BE(sessionId.length, 8)
        sessionId.copy(frame, 12)
        frame.writeUInt32BE(audio.length, 15)
        audio.copy(frame, 19)

        assert.deepEqual(parsePodcastResponseFrame(frame), {
            type: 'event',
            event: 361,
            sessionId: 'abc',
            payload: audio,
        })
    })

    it('输出不含台词和凭证的事件诊断', () => {
        assert.equal(
            formatPodcastEventDiagnostic({ type: 'event', event: 361, sessionId: 'secret-session', payload: Buffer.alloc(128) }),
            '[VolcenginePodcast] event=361 bytes=128',
        )
    })

    it('构造 FinishConnection 二进制帧', () => {
        const frame = buildFinishConnectionFrame()

        assert.deepEqual([...frame.subarray(0, 8)], [0x11, 0x14, 0x10, 0x00, 0, 0, 0, 2])
        assert.equal(frame.readUInt32BE(8), 2)
        assert.equal(frame.subarray(12).toString(), '{}')
    })

    it('收集音频事件并在会话完成后关闭连接', async () => {
        const sentEvents: number[] = []
        class FakeSocket extends EventEmitter {
            send(data: Buffer): void {
                const event = data.readUInt32BE(4)
                sentEvents.push(event)
                if (event === 100) {
                    queueMicrotask(() => {
                        this.emit('message', buildResponseFrame(361, Buffer.from('mp3-data'), 'abc', 0xb4))
                        this.emit('message', buildResponseFrame(362, Buffer.from('{"audio_duration":1}')))
                    })
                } else if (event === 2) {
                    queueMicrotask(() => this.emit('message', buildResponseFrame(52, Buffer.from('{"status_code":20000000}'))))
                }
            }

            close(): void {
                this.emit('close')
            }
        }

        const socket = new FakeSocket()
        const provider = new VolcenginePodcastProvider({
            appId: 'app-id',
            accessToken: 'access-token',
            resourceId: 'volc.service_type.10050',
            appKey: 'aGjiRDfUWi',
            timeoutMs: 20,
            webSocketFactory: () => {
                queueMicrotask(() => socket.emit('open'))
                return socket
            },
        })

        const audio = await provider.synthesize([{ role: 'host', content: '开场。' }])

        assert.deepEqual(audio, Buffer.from('mp3-data'))
        assert.deepEqual(sentEvents, [100, 2])
    })
})
