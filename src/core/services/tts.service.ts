export type DialogueRole = 'host' | 'analyst'

export interface DialogueLine {
    role: DialogueRole
    content: string
}

export function parseBroadcastDialogue(text: unknown): DialogueLine[] {
    if (typeof text !== 'string') {
        throw new Error('播报文本格式无效')
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new Error('播报文本不是有效 JSON')
    }

    if (!Array.isArray(parsed)) {
        throw new Error('播报文本必须是对话数组')
    }

    const lines = parsed.flatMap((item): DialogueLine[] => {
        if (!item || typeof item !== 'object') return []
        const { role, content } = item as Record<string, unknown>
        if ((role !== 'host' && role !== 'analyst') || typeof content !== 'string' || !content.trim()) return []
        return [{ role, content: content.trim() }]
    })

    if (lines.length === 0) {
        throw new Error('播报文本没有有效台词')
    }

    return lines
}

interface AzureMultiVoiceTtsProviderOptions {
    region: string
    subscriptionKey: string
    fetchImpl?: typeof fetch
}

const VOICES: Record<DialogueRole, { name: string; style: string }> = {
    host: { name: 'zh-CN-XiaoxiaoNeural', style: 'newscast' },
    analyst: { name: 'zh-CN-YunyangNeural', style: 'narration-professional' },
}

function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}

export class AzureMultiVoiceTtsProvider {
    private readonly endpoint: string
    private readonly subscriptionKey: string
    private readonly fetchImpl: typeof fetch

    constructor(options: AzureMultiVoiceTtsProviderOptions) {
        this.endpoint = `https://${options.region}.tts.speech.microsoft.com/cognitiveservices/v1`
        this.subscriptionKey = options.subscriptionKey
        this.fetchImpl = options.fetchImpl ?? fetch
    }

    async synthesize(lines: DialogueLine[]): Promise<Buffer> {
        if (lines.length === 0) {
            throw new Error('播报内容不能为空')
        }

        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="zh-CN">${lines.map((line) => {
            const voice = VOICES[line.role]
            return `<voice name="${voice.name}"><mstts:express-as style="${voice.style}"><prosody rate="0%">${escapeXml(line.content)}</prosody></mstts:express-as></voice>`
        }).join('')}</speak>`

        const response = await this.fetchImpl(this.endpoint, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': this.subscriptionKey,
                'Content-Type': 'application/ssml+xml',
                'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
            },
            body: ssml,
        })

        if (!response.ok) {
            throw new Error(`Azure TTS 请求失败: ${response.status}`)
        }

        return Buffer.from(await response.arrayBuffer())
    }
}
