// src/graph/kg/resolution/import-resolver.ts
// Import 路径解析 — tsconfig alias + go.mod + compile_commands + re-export 链
// 参考: codegraph/src/resolution/import-resolver.ts (986 行)
// 本文件实现核心接口和 tsconfig/go.mod 解析, 完整版从 CodeGraph 移植

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Import 映射条目
// ---------------------------------------------------------------------------

export interface ImportMapping {
  alias: string;        // "@/*" or "github.com/org/repo/pkg"
  target: string;       // "./src/*" or relative path
  source: 'tsconfig' | 'go-mod' | 'compile-commands' | 'manual';
}

export interface ResolvedImport {
  targetFilePath: string;
  targetSymbol?: string;
  confidence: number;
  strategy: string;
}

// ---------------------------------------------------------------------------
// tsconfig paths 别名解析
// ---------------------------------------------------------------------------

/**
 * 从 tsconfig.json 提取 paths 别名映射
 * 例: { "@/*": ["./src/*"] } → [{ alias: "@", target: "./src", source: "tsconfig" }]
 */
export function extractTsconfigMappings(projectRoot: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // 尝试多个 tsconfig 位置
  const tsconfigPaths = [
    join(projectRoot, 'tsconfig.json'),
    join(projectRoot, 'tsconfig.paths.json'),
    join(projectRoot, 'tsconfig.base.json'),
  ];

  for (const tsconfigPath of tsconfigPaths) {
    if (!existsSync(tsconfigPath)) continue;

    try {
      const content = readFileSync(tsconfigPath, 'utf-8');
      // 移除注释 (tsconfig 允许注释)
      const cleanContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const config = JSON.parse(cleanContent);

      const paths = config.compilerOptions?.paths;
      if (!paths) continue;

      for (const [alias, targets] of Object.entries(paths)) {
        const targetArray = Array.isArray(targets) ? targets : [targets];
        const normalizedAlias = alias.replace(/\/\*$/, '');
        const normalizedTarget = (targetArray[0] as string).replace(/\/\*$/, '');

        mappings.push({
          alias: normalizedAlias,
          target: resolve(dirname(tsconfigPath), normalizedTarget),
          source: 'tsconfig',
        });
      }
    } catch {
      // 解析失败, 跳过
    }
  }

  return mappings;
}

/**
 * 解析 tsconfig alias import
 * 例: import { X } from "@graph/kg/db" + alias @ → ./src/graph/kg/db
 */
export function resolveTsconfigAlias(
  importPath: string,
  mappings: ImportMapping[],
  fromFilePath: string,
): ResolvedImport | null {
  for (const mapping of mappings) {
    if (importPath === mapping.alias || importPath.startsWith(mapping.alias + '/')) {
      const suffix = importPath === mapping.alias ? '' : importPath.substring(mapping.alias.length + 1);
      const targetPath = suffix ? join(mapping.target, suffix) : mapping.target;

      // 尝试解析为文件
      // NodeNext: '../db/types.js' 磁盘上实为 '../db/types.ts' — 需扩展名替换
      const stripped = targetPath.replace(/\.jsx?$/i, '');
      const candidates = [
        // 已带扩展名的别名导入直接命中
        targetPath,
        stripped + '.ts',
        stripped + '.tsx',
        stripped + '.js',
        stripped + '.jsx',
        join(stripped, 'index.ts'),
        join(stripped, 'index.tsx'),
        join(stripped, 'index.js'),
        join(stripped, 'index.jsx'),
      ];

      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return {
            targetFilePath: candidate,
            confidence: 0.95,
            strategy: 'tsconfig-alias',
          };
        }
      }

      // 目录存在但文件未找到
      if (existsSync(targetPath)) {
        return {
          targetFilePath: targetPath,
          confidence: 0.7,
          strategy: 'tsconfig-alias-dir',
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Go module 路径解析
// ---------------------------------------------------------------------------

/**
 * 从 go.mod 提取模块路径
 * 例: module github.com/org/repo → { module: "github.com/org/repo", root: "." }
 */
export function extractGoModule(projectRoot: string): { module: string; root: string } | null {
  const goModPath = join(projectRoot, 'go.mod');
  if (!existsSync(goModPath)) return null;

  try {
    const content = readFileSync(goModPath, 'utf-8');
    const moduleMatch = content.match(/^module\s+(\S+)/m);
    if (moduleMatch) {
      return { module: moduleMatch[1], root: projectRoot };
    }
  } catch {
    // 解析失败
  }

  return null;
}

/**
 * 解析 Go 跨包引用
 * 例: "github.com/org/repo/pkg" → "./pkg/"
 */
export function resolveGoCrossPackageReference(
  importPath: string,
  goModule: { module: string; root: string },
): ResolvedImport | null {
  if (!importPath.startsWith(goModule.module)) return null;

  const relativePath = importPath.substring(goModule.module.length).replace(/^\//, '');
  const targetDir = join(goModule.root, relativePath);

  if (existsSync(targetDir)) {
    return {
      targetFilePath: targetDir,
      confidence: 0.9,
      strategy: 'go-module',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// compile_commands.json (C/C++ 编译数据库)
// ---------------------------------------------------------------------------

/**
 * 解析 C/C++ #include 路径
 * 例: #include "header.h" → 查找 compile_commands.json 中的 include 路径
 */
export function resolveCppIncludePath(
  includePath: string,
  projectRoot: string,
  fromFilePath: string,
): ResolvedImport | null {
  const compileCommandsPath = join(projectRoot, 'compile_commands.json');
  if (!existsSync(compileCommandsPath)) return null;

  try {
    const content = readFileSync(compileCommandsPath, 'utf-8');
    const commands = JSON.parse(content) as Array<{
      directory: string;
      file: string;
      command: string;
    }>;

    // 从命令行提取 -I include 路径
    const includeDirs = new Set<string>();
    for (const cmd of commands) {
      const matches = cmd.command.matchAll(/-I\s*(\S+)/g);
      for (const m of matches) {
        includeDirs.add(resolve(cmd.directory, m[1]));
      }
    }

    // 在 include 目录中查找文件
    const normalizedInclude = includePath.replace(/["<>]/g, '');
    const fromDir = dirname(fromFilePath);

    // 先检查同目录
    const localCandidate = join(fromDir, normalizedInclude);
    if (existsSync(localCandidate)) {
      return { targetFilePath: localCandidate, confidence: 0.95, strategy: 'cpp-local-include' };
    }

    // 再检查 -I 路径
    for (const includeDir of includeDirs) {
      const candidate = join(includeDir, normalizedInclude);
      if (existsSync(candidate)) {
        return { targetFilePath: candidate, confidence: 0.9, strategy: 'cpp-compile-commands' };
      }
    }
  } catch {
    // 解析失败
  }

  return null;
}

// ---------------------------------------------------------------------------
// Re-export 链传递解析
// ---------------------------------------------------------------------------

/**
 * 构建 re-export 映射
 * 例: a.ts: export { Foo } from './foo' → { 'a.ts::Foo' → 'foo.ts::Foo' }
 */
export interface ReExportMap {
  /** key: "sourceFile::symbolName", value: "targetFile::symbolName" */
  map: Map<string, string>;
}

export function buildReExportMap(
  exports: Array<{
    sourceFile: string;
    symbolName: string;
    fromPath: string;
  }>,
): ReExportMap {
  const reExportMap: ReExportMap = { map: new Map() };

  for (const exp of exports) {
    const key = `${exp.sourceFile}::${exp.symbolName}`;
    reExportMap.map.set(key, `${exp.fromPath}::${exp.symbolName}`);
  }

  return reExportMap;
}

/**
 * 穿透 re-export 链
 * 例: index.ts re-exports from internal/foo.ts
 *     b.ts imports from index.ts → 应解析到 internal/foo.ts
 */
export function resolveViaReExport(
  importPath: string,
  symbolName: string,
  reExportMap: ReExportMap,
  maxDepth: number = 5,
): string | null {
  let currentKey = `${importPath}::${symbolName}`;
  const visited = new Set<string>();

  for (let i = 0; i < maxDepth; i++) {
    if (visited.has(currentKey)) return null;  // 循环检测
    visited.add(currentKey);

    const next = reExportMap.map.get(currentKey);
    if (!next) return currentKey;  // 链终止

    currentKey = next;
  }

  return null;  // 超过最大深度
}

// ---------------------------------------------------------------------------
// 统一 import 解析入口
// ---------------------------------------------------------------------------

export class ImportResolver {
  private tsconfigMappings: ImportMapping[];
  private goModule: { module: string; root: string } | null;
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.tsconfigMappings = extractTsconfigMappings(projectRoot);
    this.goModule = extractGoModule(projectRoot);
  }

  /**
   * 统一解析 import 路径
   * 按优先级尝试: tsconfig alias → go module → 相对路径
   */
  resolveImport(
    importPath: string,
    fromFilePath: string,
    language: string,
  ): ResolvedImport | null {
    // 1. tsconfig alias (TypeScript/JavaScript)
    if ((language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx')
        && this.tsconfigMappings.length > 0) {
      const result = resolveTsconfigAlias(importPath, this.tsconfigMappings, fromFilePath);
      if (result) return result;
    }

    // 2. Go module
    if (language === 'go' && this.goModule) {
      const result = resolveGoCrossPackageReference(importPath, this.goModule);
      if (result) return result;
    }

    // 3. C/C++ compile_commands
    if (language === 'c' || language === 'cpp') {
      const result = resolveCppIncludePath(importPath, this.projectRoot, fromFilePath);
      if (result) return result;
    }

    // 4. 相对路径
    if (importPath.startsWith('.')) {
      const fromDir = dirname(fromFilePath);
      const targetPath = resolve(fromDir, importPath);
      // NodeNext: '../db/types.js' 磁盘上实为 '../db/types.ts' — 扩展名替换
      const stripped = targetPath.replace(/\.jsx?$/i, '');
      const candidates = [
        // 已带扩展名的导入 (NodeNext: '../db/types.js') 直接命中
        targetPath,
        stripped + '.ts', stripped + '.tsx', stripped + '.js', stripped + '.jsx',
        stripped + '.go', stripped + '.rs', stripped + '.py',
        join(stripped, 'index.ts'), join(stripped, 'index.tsx'),
        join(stripped, 'index.js'), join(stripped, 'index.jsx'),
      ];

      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return { targetFilePath: candidate, confidence: 0.95, strategy: 'relative-path' };
        }
      }
    }

    return null;
  }
}