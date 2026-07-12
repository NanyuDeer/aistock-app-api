import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { AzureMultiVoiceTtsProvider, parseBroadcastDialogue } from '../tts.service'

describe('AzureMultiVoiceTtsProvider', () => {
    it('将双人对话作为单个多音色 SSML 请求发送', async () => {
        let requestUrl = ''
        let requestInit: RequestInit | undefined
        const provider = new AzureMultiVoiceTtsProvider({
            region: 'eastasia',
            subscriptionKey: 'test-key',
            fetchImpl: async (input, init) => {
                requestUrl = String(input)
                requestInit = init
                return new Response(Buffer.from('complete-mp3'), { status: 200 })
            },
        })

        const audio = await provider.synthesize([
            { role: 'host', content: '早上好，今天市场有什么值得关注？' },
            { role: 'analyst', content: '重点关注成交量和半导体板块。' },
        ])

        assert.equal(requestUrl, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1')
        assert.equal(requestInit?.method, 'POST')
        const headers = requestInit?.headers as Record<string, string>
        assert.equal(headers['Ocp-Apim-Subscription-Key'], 'test-key')
        assert.equal(headers['X-Microsoft-OutputFormat'], 'audio-24khz-48kbitrate-mono-mp3')
        assert.equal(headers['Content-Type'], 'application/ssml+xml')
        assert.equal(String(requestInit?.body), `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="zh-CN-XiaoxiaoNeural"><mstts:express-as style="newscast"><prosody rate="0%">早上好，今天市场有什么值得关注？</prosody></mstts:express-as></voice><voice name="zh-CN-YunyangNeural"><mstts:express-as style="narration-professional"><prosody rate="0%">重点关注成交量和半导体板块。</prosody></mstts:express-as></voice></speak>`)
        assert.deepEqual(audio, Buffer.from('complete-mp3'))
    })
})

describe('parseBroadcastDialogue', () => {
    it('只提取 host 和 analyst 的有效台词', () => {
        const lines = parseBroadcastDialogue(JSON.stringify([
            { role: 'host', content: '主持人开场。', tone: 'neutral' },
            { role: 'analyst', content: '分析师解读。', tone: 'positive' },
        ]))

        assert.deepEqual(lines, [
            { role: 'host', content: '主持人开场。' },
            { role: 'analyst', content: '分析师解读。' },
        ])
    })
})
