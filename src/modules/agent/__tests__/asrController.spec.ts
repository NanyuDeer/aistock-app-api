import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'http'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import { signJwt } from '../../../shared/utils/jwt'
import { AsrController, type AsrControllerDeps } from '../asrController'
import redis from '../../../core/redis'

const JWT_SECRET = 'test-secret'

after(() => {
  // tokenBlacklist→CacheService 导入链在模块加载时 redis.ping() 建连，保活事件循环导致进程挂起（仓库惯例）
  redis.disconnect();
})

function buildApp(deps: AsrControllerDeps): Express {
  const app: Express = express()
  // 对齐 index.ts：ASR 用 multer 解析 multipart（field=file）
  const asrUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })
  app.post('/api/agent/asr', asrUpload.single('file'), (req: Request, res: Response, next: NextFunction) => {
    AsrController.recognize(req, res, next, deps)
  })
  return app
}

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 })
    })
  })
}

async function postAudio(
  server: Server,
  port: number,
  audio: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  // multipart 上传（对齐前端 uni.uploadFile 直传文件路径；fetch FormData 自动带 boundary）
  const form = new FormData()
  form.append('file', new Blob([audio], { type: 'audio/amr' }), 'rec.amr')
  const res = await fetch(`http://127.0.0.1:${port}/api/agent/asr`, {
    method: 'POST',
    headers: headers.Authorization ? { Authorization: headers.Authorization } : {},
    body: form,
  })
  const json = await res.json() as Record<string, unknown>
  return { status: res.status, json }
}

const okDeps: AsrControllerDeps = {
  jwtSecret: JWT_SECRET,
  getCredentials: () => ({ appid: '5551085502', token: 'test-token', resourceId: 'volc.seedasr.sauc.duration' }),
  recognizeAudio: async () => ({ text: '贵州茅台' }),
  // 默认直通（非 amr 输入不会调用）；amr 用例单独注入
  transcodeAmrToPcm: async (audio: Buffer) => audio,
}

describe('AsrController', () => {
  it('无 token → 401', async () => {
    const app = buildApp(okDeps)
    const { server, port } = await listen(app)
    try {
      const { status } = await postAudio(server, port, Buffer.from('fake'))
      assert.equal(status, 401)
    } finally { server.close() }
  })

  it('非法 token → 401', async () => {
    const app = buildApp(okDeps)
    const { server, port } = await listen(app)
    try {
      const { status } = await postAudio(server, port, Buffer.from('fake'), { Authorization: 'Bearer invalid.token.here' })
      assert.equal(status, 401)
    } finally { server.close() }
  })

  it('合法 token + mp3 → 200 { text }', async () => {
    const app = buildApp(okDeps)
    const { server, port } = await listen(app)
    const token = signJwt({ openid: 'o_test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET)
    try {
      const { status, json } = await postAudio(server, port, Buffer.from('fake-mp3'), { Authorization: `Bearer ${token}` })
      assert.equal(status, 200)
      assert.equal(json.text, '贵州茅台')
    } finally { server.close() }
  })

  it('凭证缺失 → 503', async () => {
    const app = buildApp({ ...okDeps, getCredentials: () => null })
    const { server, port } = await listen(app)
    const token = signJwt({ openid: 'o_test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET)
    try {
      const { status } = await postAudio(server, port, Buffer.from('fake-mp3'), { Authorization: `Bearer ${token}` })
      assert.equal(status, 503)
    } finally { server.close() }
  })

  it('识别服务抛错 → 502', async () => {
    const app = buildApp({ ...okDeps, recognizeAudio: async () => { throw new Error('auth failed') } })
    const { server, port } = await listen(app)
    const token = signJwt({ openid: 'o_test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET)
    try {
      const { status } = await postAudio(server, port, Buffer.from('fake-mp3'), { Authorization: `Bearer ${token}` })
      assert.equal(status, 502)
    } finally { server.close() }
  })

  it('识别成功但空文本 → 200 { text: "" }', async () => {
    const app = buildApp({ ...okDeps, recognizeAudio: async () => ({ text: '' }) })
    const { server, port } = await listen(app)
    const token = signJwt({ openid: 'o_test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET)
    try {
      const { status, json } = await postAudio(server, port, Buffer.from('fake-mp3'), { Authorization: `Bearer ${token}` })
      assert.equal(status, 200)
      assert.equal(json.text, '')
    } finally { server.close() }
  })

  it('amr 头音频（App 假 pcm 实为 AMR）→ 先转码 PCM 再识别', async () => {
    // 2026-08-19 根因用例：线上取证 App 端 format:\'pcm\' 产出 #!AMR-WB 假文件，
    // 必须转码后送 V3（V3 只支持 pcm/opus/mp3）。
    // 闭包赋值对 TS 控制流不可见（recognized 恒为 null），用容器承载
    const seen = { audio: null as Buffer | null }
    const app = buildApp({
      ...okDeps,
      transcodeAmrToPcm: async (audio: Buffer) => {
        assert.ok(audio.subarray(0, 5).toString('ascii') === '#!AMR', '输入应为 amr 数据')
        return Buffer.from('pcm-after-transcode')
      },
      recognizeAudio: async (audio: Buffer) => {
        seen.audio = audio
        return { text: '贵州茅台' }
      },
    })
    const { server, port } = await listen(app)
    const token = signJwt({ openid: 'o_test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET)
    try {
      const { status, json } = await postAudio(server, port, Buffer.from('#!AMR\n1234'), { Authorization: `Bearer ${token}` })
      assert.equal(status, 200)
      assert.equal(json.text, '贵州茅台')
      assert.equal(seen.audio?.toString(), 'pcm-after-transcode', '识别层收到转码后的 pcm')
    } finally { server.close() }
  })

  it('amr 转码失败 → 502 透出转码错误', async () => {
    const app = buildApp({
      ...okDeps,
      transcodeAmrToPcm: async () => { throw new Error('音频转码失败（ffmpeg exit 1）') },
    })
    const { server, port } = await listen(app)
    const token = signJwt({ openid: 'o_test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET)
    try {
      const { status, json } = await postAudio(server, port, Buffer.from('#!AMR\n1234'), { Authorization: `Bearer ${token}` })
      assert.equal(status, 502)
      assert.match(json.message as string, /ffmpeg exit 1/)
    } finally { server.close() }
  })
})
