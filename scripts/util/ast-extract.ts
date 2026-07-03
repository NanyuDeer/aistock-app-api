/**
 * AST 提取工具：从 TypeScript 源文件中静态提取对象字面量的属性值
 * 使用 TypeScript Compiler API（built-in，无额外依赖）
 */
import ts from 'typescript'
import * as fs from 'node:fs'

export interface ExtractedObject {
  name: string        // export const 的变量名
  properties: Record<string, string | number | boolean | string[]>
}

/**
 * 从 .ts 源文件中提取所有 export const <name>: <typeName> = { ... } 对象字面量
 * @param filePath .ts 文件路径
 * @param typeName 类型名称（如 'Skill'、'Agent'）
 * @returns 匹配的导出对象列表
 */
export function extractExportObjects(
  filePath: string,
  typeName: string
): ExtractedObject[] {
  const sourceText = fs.readFileSync(filePath, 'utf-8')
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)

  const results: ExtractedObject[] = []

  for (const statement of sourceFile.statements) {
    // 只处理 VariableStatement
    if (!ts.isVariableStatement(statement)) continue

    // 检查是否有 export 修饰符
    const isExport = statement.modifiers?.some(
      m => m.kind === ts.SyntaxKind.ExportKeyword
    )
    if (!isExport) continue

    // 处理每个变量声明
    for (const declaration of statement.declarationList.declarations) {
      // 只处理 const
      if (!declaration.initializer) continue

      // 检查类型注解是否为 typeName
      const typeAnnotation = declaration.type
      if (!typeAnnotation) continue

      // 提取类型名称（处理 "Skill"、"Agent" 等）
      const typeNameNode = typeAnnotation.kind === ts.SyntaxKind.TypeReference
        ? (typeAnnotation as ts.TypeReferenceNode).typeName
        : null
      if (!typeNameNode || typeNameNode.getText(sourceFile) !== typeName) continue

      // 确认变量名
      const varName = declaration.name.getText(sourceFile)

      // 处理对象字面量
      const initializer = declaration.initializer
      if (!ts.isObjectLiteralExpression(initializer)) continue

      // 提取属性
      const properties: Record<string, any> = {}
      for (const prop of initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const propName = prop.name.getText(sourceFile)
        properties[propName] = extractPropertyValue(prop.initializer, sourceFile)
      }

      results.push({ name: varName, properties })
    }
  }

  return results
}

function extractPropertyValue(
  node: ts.Expression,
  sourceFile: ts.SourceFile
): any {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text)
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(e => extractPropertyValue(e, sourceFile))
  }

  // 对于非字面量（如 zod 对象、变量引用、函数调用等），返回占位标记
  return '__NON_LITERAL__'
}
