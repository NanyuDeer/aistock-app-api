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
})
