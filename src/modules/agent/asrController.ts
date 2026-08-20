/**
 * 语音识别（ASR）接口（批次 3a，2026-08-14）
 *
 * POST /api/agent/asr
 *  - 鉴权：JWT（Bearer/Cookie，复用 extractTokenFromRequest + isTokenRevoked，对齐 profileController.requireAuth）
 *  - body：multipart/form-data 文件字段 `file`（multer 内存存储；前端 uni.uploadFile 直传录音
 *    amr + 8kHz 文件路径——2026-08-19 由 express.raw(audio/amr 二进制) 改为 multipart，
 *    对齐 App 端绕开 readFile 引擎缺陷的直传方案）
 *  - 返回：200 { text }（空文本表示静音，前端复用"未识别到语音"）
 *
 * 错误矩阵：401 无/非法 token；400 请求体超限（raw limit 前置）；503 火山凭证缺失；
 *          502 识别服务异常/超时；504 由服务内超时映射为 502（见 VolcAsrService，前端提示"识别超时"）。
 */
import { Request, Response, NextFunction } from 'express'
import { verifyJwt } from '../../shared/utils/jwt'
import { extractTokenFromRequest, isTokenRevoked, REVOKED_MESSAGE } from '../../shared/utils/tokenBlacklist'
import { VolcAsrService } from './VolcAsrService'
import { isAmr, transcodeToPcm16k } from './audioTranscode'

export interface AsrCredentials {
  appid: string
  token: string
  /** 资源 ID（V3 大模型，豆包流式语音识别 2.0 小时版 = volc.seedasr.sauc.duration） */
  resourceId: string
}

export interface AsrControllerDeps {
  /** JWT 验签密钥 */
  jwtSecret: string
  /** 获取火山凭证；缺失返回 null（503） */
  getCredentials: () => AsrCredentials | null
  /** 识别音频（生产注入 VolcAsrService.recognize；测试 mock） */
  recognizeAudio: (audio: Buffer) => Promise<{ text: string }>
  /**
   * amr → PCM 16kHz 转码（生产用 ffmpeg-static；测试 mock）。
   * 2026-08-19：App 端 HTML5+ Android 录音 format:'pcm' 产出假 pcm（实为 AMR-WB，
   * 线上魔数取证），而 V3 只支持 pcm/opus/mp3 → 必须先转码再识别。
   */
  transcodeAmrToPcm: (audio: Buffer) => Promise<Buffer>
}

/** 生产依赖工厂：从 env 读取火山凭证 */
export function createDefaultAsrDeps(): AsrControllerDeps {
  return {
    jwtSecret: process.env.JWT_SECRET || '',
    getCredentials: () => {
      const appid = process.env.VOLC_ASR_APPID
      const token = process.env.VOLC_ASR_TOKEN
      const resourceId = process.env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration'
      if (!appid || !token) return null
      return { appid, token, resourceId }
    },
    recognizeAudio: async (audio: Buffer) => {
      const appid = process.env.VOLC_ASR_APPID!
      const token = process.env.VOLC_ASR_TOKEN!
      const resourceId = process.env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration'
      const service = new VolcAsrService({ appid, token, resourceId })
      return service.recognize(audio)
    },
    transcodeAmrToPcm: (audio: Buffer) => transcodeToPcm16k(audio),
  }
}

export class AsrController {
  static async recognize(
    req: Request,
    res: Response,
    _next: NextFunction,
    deps: AsrControllerDeps = createDefaultAsrDeps(),
  ): Promise<void> {
    // 1. 鉴权（fail closed，对齐 profileController.requireAuth：extract → verify → revoked）
    const token = extractTokenFromRequest(req)
    if (!token) {
      res.status(401).json({ code: 401, message: '未登录' })
      return
    }
    const payload = verifyJwt(token, deps.jwtSecret)
    if (!payload) {
      res.status(401).json({ code: 401, message: '登录已过期' })
      return
    }
    if (await isTokenRevoked(payload.jti)) {
      res.status(401).json({ code: 401, message: REVOKED_MESSAGE })
      return
    }

    // 2. 请求体校验（multipart 文件由 multer 解析为 req.file；非文件 → 400）
    const audio = (req as Request & { file?: Express.Multer.File }).file?.buffer
    if (!audio || audio.length === 0) {
      res.status(400).json({ code: 400, message: '音频数据无效' })
      return
    }
    // 诊断日志（2026-08-19 排查「未识别到语音」）：记录上传音频大小与文件头魔数，
    // 确认 App 端 format:'pcm' 在 HTML5+ Android 上实际产出格式（amr 头 #!AMR=23 21 41 4d 52 0a、
    // aac 帧同步 FFFx、真 pcm 无魔数）——验证完根因后按需移除。
    const fileMeta = (req as Request & { file?: Express.Multer.File }).file
    console.log(
      `[asr] upload audio: size=${audio.length} magic=${audio.subarray(0, 8).toString('hex')}` +
        ` name=${fileMeta?.originalname ?? '?'} type=${fileMeta?.mimetype ?? '?'}`,
    )

    // 3. 凭证检查
    const credentials = deps.getCredentials()
    if (!credentials) {
      res.status(503).json({ code: 503, message: '语音识别暂不可用' })
      return
    }

    // 4. 音频转码（2026-08-19「未识别到语音」根因修复）：App 端 HTML5+ 录音
    //    format:'pcm' 实际产出 AMR-WB（假 pcm，线上魔数取证 #!AMR-WB），V3 只支持
    //    pcm/opus/mp3 → 先转成 PCM 16kHz 再识别；非 amr（如测试/纯 pcm）直传。
    let pcm = audio
    if (isAmr(audio)) {
      try {
        pcm = await deps.transcodeAmrToPcm(audio)
        console.log(`[asr] amr→pcm transcode: ${audio.length}B -> ${pcm.length}B`)
      } catch (err) {
        const reason = err instanceof Error ? err.message : '音频转码失败'
        res.status(502).json({ code: 502, message: reason })
        return
      }
    }

    // 5. 识别
    try {
      const result = await deps.recognizeAudio(pcm)
      res.status(200).json({ code: 200, message: 'success', text: result.text })
    } catch (err) {
      const message = err instanceof Error ? err.message : '语音识别服务异常'
      // 超时消息保持 502 语义（前端对 502 显示"语音识别服务异常"）
      res.status(502).json({ code: 502, message })
    }
  }
}
