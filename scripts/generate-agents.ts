/**
 * Agents 构建时代码生成脚本
 * 扫描 src/modules/agent/agents/*.agent.ts → 生成 src/modules/agent/agents/agents.generated.ts
 *
 * 用法: tsx scripts/generate-agents.ts [--watch]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { extractExportObjects } from './util/ast-extract'

const AGENTS_DIR = path.resolve(__dirname, '../src/modules/agent/agents')
const OUTPUT_FILE = path.join(AGENTS_DIR, 'agents.generated.ts')
const WATCH_FLAG = process.argv.includes('--watch')

/** 当前阶段扫描 *.agent.ts，同时向后兼容 *.ts（排除已生成的） */
function findAgentFiles(): string[] {
  const files = fs.readdirSync(AGENTS_DIR)

  // 优先使用 .agent.ts 命名约定
  const namedFiles = files.filter(f => f.endsWith('.agent.ts'))
  if (namedFiles.length > 0) return namedFiles.sort()

  // 降级：扫所有 .ts（排除 generated.ts 和 types.ts 等非 Agent 文件）
  return files.filter(f =>
    f.endsWith('.ts') &&
    !f.endsWith('.generated.ts') &&
    f !== 'types.ts'
  ).sort()
}

/** 从文件读取实际导出的 Agent 变量名 */
function collectExportNames(files: string[]): Record<string, string> {
  const exportMap: Record<string, string> = {}
  for (const f of files) {
    const filePath = path.join(AGENTS_DIR, f)
    const objects = extractExportObjects(filePath, 'Agent')
    if (objects.length > 0) {
      exportMap[f] = objects[0].name
    } else {
      // 降级：从文件名推导
      exportMap[f] = path.basename(f, '.ts').replace(/[.-]/g, '_')
    }
  }
  return exportMap
}

function generateImports(files: string[], exportMap: Record<string, string>): string {
  return files
    .map(f => {
      const varName = exportMap[f]
      const importPath = `./${f.replace(/\.ts$/, '')}`
      return `import { ${varName} } from '${importPath}'`
    })
    .join('\n')
}

function generateContent(files: string[], exportMap: Record<string, string>): string {
  const timestamp = new Date().toISOString()

  const listEntries = files.map(f => {
    const varName = exportMap[f]
    return `  ${varName}`
  })

  return `// ===== 自动生成，请勿手动修改 =====
// 生成命令：npm run generate:agents
// 生成时间：${timestamp}

${generateImports(files, exportMap)}

// Agent 列表（所有已注册的 Agent 实例）
export const AGENT_LIST = [
${listEntries.join(',\n')},
]

export const REGISTERED_AGENT_COUNT = ${files.length}
`
}

function validateFiles(files: string[]): boolean {
  let valid = true
  const ids = new Set<string>()

  for (const f of files) {
    const filePath = path.join(AGENTS_DIR, f)
    const objects = extractExportObjects(filePath, 'Agent')
    for (const obj of objects) {
      const agentId = obj.properties.id as string
      if (agentId) {
        if (ids.has(agentId)) {
          console.error(`[generate-agents] ERROR: Agent id "${agentId}" 重复 (来自 ${f})`)
          valid = false
        }
        ids.add(agentId)
      }

      // 检查必填字段
      if (!obj.properties.routingPrompt || obj.properties.routingPrompt === '__NON_LITERAL__') {
        console.error(`[generate-agents] ERROR: Agent "${agentId || varNameFromFile(f)}" 缺少 routingPrompt`)
        valid = false
      }
      if (!obj.properties.category) {
        console.warn(`[generate-agents] WARN: Agent "${agentId || varNameFromFile(f)}" 未设置 category`)
      }
    }
  }

  return valid
}

function varNameFromFile(file: string): string {
  return path.basename(file, '.ts').replace(/[.-]/g, '_')
}

function run() {
  console.log('[generate-agents] 扫描 Agents 目录:', AGENTS_DIR)

  const files = findAgentFiles()
  if (files.length === 0) {
    console.warn('[generate-agents] WARN: 未找到 Agent 文件，生成空列表')
  } else {
    console.log(`[generate-agents] 找到 ${files.length} 个 Agent 文件:`, files)
  }

  if (!validateFiles(files)) {
    console.error('[generate-agents] 校验失败，退出')
    process.exit(1)
  }

  const exportMap = collectExportNames(files)
  console.log('[generate-agents] 导出名映射:', exportMap)

  const content = generateContent(files, exportMap)
  fs.writeFileSync(OUTPUT_FILE, content, 'utf-8')
  console.log(`[generate-agents] 生成完成: ${OUTPUT_FILE} (${content.split('\n').length} 行)`)

  return files
}

let currentFiles = run()

if (WATCH_FLAG) {
  console.log('[generate-agents] Watch 模式启动，监听文件变化...')
  fs.watch(AGENTS_DIR, (eventType, filename) => {
    if (!filename || filename.endsWith('.generated.ts')) return
    if (filename.endsWith('.agent.ts') || filename.endsWith('.ts')) {
      console.log(`[generate-agents] 文件变化: ${filename} (${eventType})`)
      currentFiles = run()
    }
  })

  setInterval(() => {}, 60000)
}
