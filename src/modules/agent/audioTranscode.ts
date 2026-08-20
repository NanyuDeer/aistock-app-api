/**
 * 音频转码（2026-08-19 修复「未识别到语音」）
 *
 * 根因：App 端 HTML5+ 录音在 Android 只原生支持 amr/aac/3gp（官方文档），
 * `format:'pcm'` 产出的是「假 .pcm 实为 AMR-WB」（线上魔数取证 `#!AMR-WB`）。
 * V3 豆包流式 ASR 只支持 pcm/opus/mp3（官方文档 6561/1354871），收到 amr 数据
 * 按 pcm 解析为空文本 → App 提示「未识别到语音」。
 * 方案：App 端改回 HTML5+ 原生 amr（两端稳定），后端用 ffmpeg-static 转成 V3
 * 要求的 PCM 16kHz/16bit/单声道后再送识别。
 */
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'child_process'

/** 判断是否 AMR 文件头（#!AMR，含 AMR-NB 窄带 / AMR-WB 宽带，见线上取证） */
export function isAmr(buffer: Buffer): boolean {
  return buffer.length >= 6 && buffer.subarray(0, 5).toString('ascii') === '#!AMR'
}

/**
 * 任意音频 → PCM s16le 16kHz 单声道（V3 ASR 输入格式）。
 * 输入经 stdin 管道喂给 ffmpeg，输出 s16le 流从 stdout 收集。
 * 失败抛错（错误信息透出给前端）；amr 8k 短语音转码为毫秒级，可忽略延迟。
 */
export function transcodeToPcm16k(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpegBin = ffmpegPath
    if (!ffmpegBin) {
      reject(new Error('音频转码组件未安装（ffmpeg-static）'))
      return
    }
    const proc = spawn(
      ffmpegBin,
      // -f s16le 输出裸 PCM；-ar 16000 采样率对齐 V3；-ac 1 单声道
      ['-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString()
    })
    proc.on('error', (err) => reject(err))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks))
      } else {
        reject(new Error(`音频转码失败（ffmpeg exit ${code}）：${stderr.trim().slice(-200)}`))
      }
    })
    // 输入流提前关闭（EPIPE）可忽略：由 close 判定成败
    proc.stdin.on('error', () => { /* ignore */ })
    proc.stdin.end(input)
  })
}
