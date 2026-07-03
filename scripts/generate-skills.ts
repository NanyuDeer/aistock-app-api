/**
 * Skills 构建时代码生成脚本
 * 扫描 src/modules/agent/skills/*.skill.ts → 生成 src/modules/agent/skills/skills.generated.ts
 *
 * 用法: tsx scripts/generate-skills.ts [--watch]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { extractExportObjects } from './util/ast-extract'

const SKILLS_DIR = path.resolve(__dirname, '../src/modules/agent/skills')
const OUTPUT_FILE = path.join(SKILLS_DIR, 'skills.generated.ts')
const WATCH_FLAG = process.argv.includes('--watch')

/** 找到所有 .skill.ts 文件（排除 .generated.ts） */
function findSkillFiles(): string[] {
  const files = fs.readdirSync(SKILLS_DIR)
  return files
    .filter(f => f.endsWith('.skill.ts') && !f.endsWith('.generated.ts'))
    .sort()
}

/** 生成 import 语句 */
function generateImports(files: string[]): string {
  return files
    .map(f => {
      const varName = path.basename(f, '.skill.ts').replace(/[.-]/g, '_')
      const importPath = `./${f.replace(/\.ts$/, '')}`
      return `import { ${varName} } from '${importPath}'`
    })
    .join('\n')
}

/** 从文件路径提取变量名 */
function varNameFromFile(file: string): string {
  return path.basename(file, '.skill.ts').replace(/[.-]/g, '_')
}

/** 生成 SKILL_LOADERS 映射 */
function generateLoaders(files: string[]): string {
  const entries = files.map(f => {
    const name = path.basename(f, '.skill.ts')
    const modPath = `./${f.replace(/\.ts$/, '')}`
    return `  '${name}': () => import('${modPath}'),`
  })
  return entries.join('\n')
}

/** 生成完整的文件内容 */
function generateContent(files: string[]): string {
  const timestamp = new Date().toISOString()

  const registryEntries = files.map(f => {
    const varName = varNameFromFile(f)
    return `  {
    name: ${varName}.name,
    description: ${varName}.description,
    tags: ${varName}.tags ?? [],
    priority: ${varName}.priority ?? 99,
  }`
  })

  return `// ===== 自动生成，请勿手动修改 =====
// 生成命令：npm run generate:skills
// 生成时间：${timestamp}

${generateImports(files)}
import type { Skill } from './types'

// Skill 元数据注册表（不含执行逻辑，用于 LLM 发现）
export const SKILLS_REGISTRY = [
${registryEntries.join(',\n')},
]

// 懒加载映射（运行时按需加载 execute）
export const SKILL_LOADERS: Record<string, () => Promise<{ default: Skill }>> = {
${generateLoaders(files)}
}

export const REGISTERED_SKILL_COUNT = ${files.length}
`
}

/** 校验文件合法性 */
function validateFiles(files: string[]): boolean {
  let valid = true

  // 1. 检查 name 唯一性
  const names = new Set<string>()
  for (const f of files) {
    const filePath = path.join(SKILLS_DIR, f)
    const objects = extractExportObjects(filePath, 'Skill')
    for (const obj of objects) {
      const skillName = obj.properties.name as string
      if (skillName) {
        if (names.has(skillName)) {
          console.error(`[generate-skills] ERROR: Skill name "${skillName}" 重复 (来自 ${f})`)
          valid = false
        }
        names.add(skillName)
      }
    }
  }

  // 2. 检查每个文件是否至少导出一个 Skill
  for (const f of files) {
    const filePath = path.join(SKILLS_DIR, f)
    const objects = extractExportObjects(filePath, 'Skill')
    if (objects.length === 0) {
      console.warn(`[generate-skills] WARN: ${f} 没有导出 Skill 接口对象`)
    }
  }

  return valid
}

/** 主逻辑 */
function run() {
  console.log('[generate-skills] 扫描 Skills 目录:', SKILLS_DIR)

  const files = findSkillFiles()
  if (files.length === 0) {
    console.warn('[generate-skills] WARN: 未找到 .skill.ts 文件，生成空注册表')
  } else {
    console.log(`[generate-skills] 找到 ${files.length} 个 Skill 文件:`, files)
  }

  if (!validateFiles(files)) {
    console.error('[generate-skills] 校验失败，退出')
    process.exit(1)
  }

  const content = generateContent(files)
  fs.writeFileSync(OUTPUT_FILE, content, 'utf-8')
  console.log(`[generate-skills] 生成完成: ${OUTPUT_FILE} (${content.split('\n').length} 行)`)

  return files
}

// 首次运行
let currentFiles = run()

// Watch 模式（仅开发环境）
if (WATCH_FLAG) {
  console.log('[generate-skills] Watch 模式启动，监听文件变化...')
  fs.watch(SKILLS_DIR, (eventType, filename) => {
    if (!filename || filename.endsWith('.generated.ts')) return
    if (filename.endsWith('.skill.ts')) {
      console.log(`[generate-skills] 文件变化: ${filename} (${eventType})`)
      currentFiles = run()
    }
  })

  // 保持进程存活（concurrently 管理）
  setInterval(() => {}, 60000)
}
