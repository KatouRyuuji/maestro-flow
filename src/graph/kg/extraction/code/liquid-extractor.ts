// src/graph/kg/extraction/code/liquid-extractor.ts
// Shopify/Jekyll Liquid 模板提取器:
// render/include/section 标签 → import edge
// schema/assign 块 → variable node
// 参考: codegraph/src/extraction/liquid-extractor.ts

import type { LanguageExtractionResult, ExtractedSymbol, ExtractedReference } from './tree-sitter-types.js';
import type { Language } from '../../db/types.js';
import { makeFileNodeId } from './tree-sitter-types.js';

const LIQUID_KEYWORDS = new Set(['if','unless','for','case','when','else','elsif','end','new','return','and','or','not','in','contains','true','false','nil','blank','empty','assign','render','include','section','echo','cycle']);
export function extractLiquid(
  source: string,
  filePath: string,
): LanguageExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  const references: ExtractedReference[] = [];
  const edges: Array<{ source: string; target: string; kind: string }> = [];

  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // render/include → import edge
    const renderMatch = line.match(/\{%[-\s]*render\s+"([^"]+)"/);
    if (renderMatch) {
      references.push({
        fromSymbolName: '<module>',
        fromSymbolId: `${filePath}:<module>`,
        referenceName: renderMatch[1],
        referenceKind: 'imports',
        line: lineNum,
        col: (renderMatch.index ?? 0) + 1,
        filePath,
        language: 'liquid' as Language,
      });
    }

    const includeMatch = line.match(/\{%[-\s]*include\s+"([^"]+)"/);
    if (includeMatch) {
      references.push({
        fromSymbolName: '<module>',
        fromSymbolId: `${filePath}:<module>`,
        referenceName: includeMatch[1],
        referenceKind: 'imports',
        line: lineNum,
        col: (includeMatch.index ?? 0) + 1,
        filePath,
        language: 'liquid' as Language,
      });
    }

    // section → import edge
    const sectionMatch = line.match(/\{%[-\s]*section\s+"([^"]+)"/);
    if (sectionMatch) {
      references.push({
        fromSymbolName: '<module>',
        fromSymbolId: `${filePath}:<module>`,
        referenceName: sectionMatch[1],
        referenceKind: 'imports',
        line: lineNum,
        col: (sectionMatch.index ?? 0) + 1,
        filePath,
        language: 'liquid' as Language,
      });
    }

    // assign → variable node
    const assignMatch = line.match(/\{%[-\s]*assign\s+(\w+)\s*=/);
    if (assignMatch) {
      symbols.push({
        kind: 'variable',
        name: assignMatch[1],
        qualifiedName: assignMatch[1],
        filePath,
        language: 'liquid' as Language,
        startLine: lineNum,
        endLine: lineNum,
        startColumn: (assignMatch.index ?? 0) + 1,
        endColumn: line.length + 1,
        docstring: '',
        signature: `assign ${assignMatch[1]}`,
        visibility: '',
        isExported: false,
        isAsync: false,
        isStatic: false,
        isAbstract: false,
        decorators: [],
        typeParameters: [],
      });
    }

    // 输出表达式/过滤器 → calls: {{ fn(...) }} / {{ x | upcase }} / {{ x | default: 5 }}
    const outMatch = line.match(/\{\{(.*?)\}\}/);
    if (outMatch) {
      const expr = outMatch[1];
      const emitCall = (name: string): void => {
        if (LIQUID_KEYWORDS.has(name)) return;
        references.push({
          fromSymbolName: '<file>',
          fromSymbolId: makeFileNodeId(filePath),
          referenceName: name,
          referenceKind: 'calls',
          line: lineNum,
          col: (outMatch.index ?? 0) + 1,
          filePath,
          language: 'liquid' as Language,
        });
      };
      const fnRe = /([A-Za-z_]\w*)\s*\(/g;
      let fm: RegExpExecArray | null;
      while ((fm = fnRe.exec(expr)) !== null) emitCall(fm[1]);
      const filterRe = /\|\s*([A-Za-z_]\w*)/g;
      while ((fm = filterRe.exec(expr)) !== null) emitCall(fm[1]);
    }

    // schema 块 → JSON schema 定义
    if (line.includes('{% schema %}')) {
      const schemaStart = i;
      let schemaEnd = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].includes('{% endschema %}')) {
          schemaEnd = j;
          break;
        }
      }
      const schemaContent = lines.slice(schemaStart + 1, schemaEnd).join('\n');
      const nameMatch = schemaContent.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch) {
        symbols.push({
          kind: 'variable',
          name: nameMatch[1],
          qualifiedName: `schema:${nameMatch[1]}`,
          filePath,
          language: 'liquid' as Language,
          startLine: schemaStart + 1,
          endLine: schemaEnd + 1,
          startColumn: 1,
          endColumn: 1,
          docstring: schemaContent.substring(0, 200),
          signature: `schema "${nameMatch[1]}"`,
          visibility: '',
          isExported: false,
          isAsync: false,
          isStatic: false,
          isAbstract: false,
          decorators: [],
          typeParameters: [],
        });
      }
    }

    // {% ... %} 标签体内的函数调用: {% assign y = fn() %} / {% if fn() %}
    const tagBodyMatch = line.match(/\{%[-]?\s*\w+\b([\s\S]*?)%\}/);
    if (tagBodyMatch && tagBodyMatch[1]) {
      const fnRe = /([A-Za-z_]\w*)\s*\(/g;
      let fm: RegExpExecArray | null;
      while ((fm = fnRe.exec(tagBodyMatch[1])) !== null) {
        if (LIQUID_KEYWORDS.has(fm[1])) continue;
        references.push({
          fromSymbolName: '<file>',
          fromSymbolId: makeFileNodeId(filePath),
          referenceName: fm[1],
          referenceKind: 'calls',
          line: lineNum,
          col: (tagBodyMatch.index ?? 0) + 1,
          filePath,
          language: 'liquid' as Language,
        });
      }
    }
  }

  return { symbols, references, edges };
}