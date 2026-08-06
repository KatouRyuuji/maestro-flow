// src/graph/kg/extraction/code/vue-extractor.ts
// Vue SFC 提取器: <script>/<script setup> 块委托 tree-sitter + 行号偏移校正
// 参考: codegraph/src/extraction/vue-extractor.ts

import { createRequire } from 'node:module';
import type { LanguageExtractionResult, ExtractedSymbol } from './tree-sitter-types.js';
import type { Language } from '../../db/types.js';
import { getTreeSitterEngine } from './tree-sitter.js';
import { makeFileNodeId } from './tree-sitter-types.js';

const require = createRequire(import.meta.url);

interface VueSFCBlock {
  type: 'script' | 'template' | 'style';
  content: string;
  startLine: number;  // SFC 文件中的起始行 (1-indexed)
  lang?: string;
  setup?: boolean;
}

/**
 * 解析 Vue SFC — 提取 <script>/<script setup>/<template> 块
 */
function parseVueSFC(source: string): { blocks: VueSFCBlock[]; startLine: number } {
  const blocks: VueSFCBlock[] = [];
  const lines = source.split('\n');

  // 匹配 <script>, <template>, <style> 标签
  const blockRegex = /<(script|template|style)([^>]*)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(source)) !== null) {
    const [fullMatch, type, attrs, content] = match;
    const fullMatchStart = match.index;

    // 计算起始行 (1-indexed)
    const beforeMatch = source.substring(0, fullMatchStart);
    const startLine = beforeMatch.split('\n').length;

    // 解析属性
    const langMatch = attrs.match(/lang=["'](\w+)["']/);
    const setupMatch = attrs.match(/\bsetup\b/);

    // 计算 content 的起始行 (跳过开始标签行)
    const tagEnd = source.indexOf('>', fullMatchStart);
    if (tagEnd === -1) continue;
    const contentStartLine = source.substring(0, tagEnd + 1).split('\n').length;

    blocks.push({
      type: type as VueSFCBlock['type'],
      content: content,
      startLine: contentStartLine,
      lang: langMatch?.[1],
      setup: Boolean(setupMatch),
    });
  }

  return { blocks, startLine: 1 };
}

/**
 * 提取 Vue SFC — 委托 script 块给 tree-sitter, 处理模板中的组件引用
 */
export async function extractVueSFC(
  source: string,
  filePath: string,
): Promise<LanguageExtractionResult> {
  const { blocks } = parseVueSFC(source);
  const allSymbols: ExtractedSymbol[] = [];
  const references: import('./tree-sitter-types.js').ExtractedReference[] = [];
  const edges: Array<{ source: string; target: string; kind: string }> = [];

  const engine = getTreeSitterEngine();

  for (const block of blocks) {
    if (block.type === 'script' && block.content.trim()) {
      // 确定语言 (默认 typescript for <script setup lang="ts">)
      const lang: Language = (block.lang === 'ts' || block.lang === 'typescript')
        ? 'typescript' as Language
        : 'javascript' as Language;

      // 委托 tree-sitter 解析 script 块
      if (engine.isAvailable()) {
        try {
          const tree = await engine.parse(block.content, lang);
          if (tree) {
            try {
              const { typescriptExtractor } = await import('./languages/typescript.js');
              const result = typescriptExtractor.extract(tree, block.content, filePath);

              // 行号偏移校正: script 块在 SFC 中的起始行
              for (const sym of result.symbols) {
                sym.startLine += block.startLine - 1;
                sym.endLine += block.startLine - 1;
                allSymbols.push(sym);
              }
              for (const ref of result.references) {
                ref.line += block.startLine - 1;
                references.push(ref);
              }
            } finally {
              tree.delete();
            }
          }
        } catch (err) {
          if (process.env.MAESTRO_DEBUG === '1') console.warn('[MaestroGraph] Vue script parse error:', err);
        }
      }
    } else if (block.type === 'template') {
      // 从模板中提取 PascalCase 组件引用 → import edges
      const componentRegex = /<([A-Z][a-zA-Z0-9]*)/g;
      let compMatch: RegExpExecArray | null;

      const seen = new Set<string>();
      while ((compMatch = componentRegex.exec(block.content)) !== null) {
        const componentName = compMatch[1];
        if (!seen.has(componentName)) {
          seen.add(componentName);
          references.push({
            fromSymbolName: '<file>',
            fromSymbolId: makeFileNodeId(filePath),
            referenceName: componentName,
            referenceKind: 'imports',  // 组件引用作为 import
            line: block.startLine,
            col: compMatch.index + 1,
            filePath,
            language: 'vue' as Language,
          });
        }
      }

      // 模板表达式函数调用 → calls 引用 ({{ fn() }} / @click="fn()" / v-on:click / :prop)
      const templateCallRegex = /(?:^|[\s{}=:(,>"'])([A-Za-z_$][\w$]*)\s*\(/g;
      const TEMPLATE_KEYWORDS = new Set(['if','for','while','switch','catch','function','return','new','typeof','instanceof','delete','void','in','of']);
      let tplCall: RegExpExecArray | null;
      while ((tplCall = templateCallRegex.exec(block.content)) !== null) {
        const fnName = tplCall[1];
        if (TEMPLATE_KEYWORDS.has(fnName)) continue;
        const lineInBlock = block.content.substring(0, tplCall.index).split('\n').length;
        references.push({
          fromSymbolName: '<file>',
          fromSymbolId: makeFileNodeId(filePath),
          referenceName: fnName,
          referenceKind: 'calls',
          line: block.startLine + lineInBlock - 1,
          col: tplCall.index + (tplCall[0].length - fnName.length) + 1,
          filePath,
          language: 'vue' as Language,
        });
      }
    }
  }

  return { symbols: allSymbols, references, edges };
}
