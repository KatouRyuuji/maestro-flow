#!/usr/bin/env node
/**
 * build-arch-kb-index.mjs
 * 
 * 预构建脚本：扫描 _analysis/awesome-architecture/（存在时）并同步可发布正文，
 * 否则从已固化的 resources/arch-kb/ 重建索引。
 * 输出: resources/arch-kb/index.json + templates/ + tutorial/ + cases/ + LICENSE
 * 
 * 运行: node scripts/build-arch-kb-index.mjs
 * 时机: 发布前执行；固化产物提交到仓库并随包发布
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const UPSTREAM_DIR = join(import.meta.dirname, '..', '_analysis', 'awesome-architecture');
const OUTPUT_DIR = join(import.meta.dirname, '..', 'resources', 'arch-kb');
const CONTENT_DIRS = ['templates', 'tutorial', 'cases'];
const SOURCE_DIR = existsSync(UPSTREAM_DIR) ? UPSTREAM_DIR : OUTPUT_DIR;

function syncBundledContent() {
  if (SOURCE_DIR === OUTPUT_DIR) return;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const name of CONTENT_DIRS) {
    const source = join(SOURCE_DIR, name);
    if (!existsSync(source)) throw new Error(`arch-kb source directory not found: ${source}`);
    const target = join(OUTPUT_DIR, name);
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
  }

  const license = join(SOURCE_DIR, 'LICENSE');
  if (!existsSync(license)) throw new Error(`arch-kb license not found: ${license}`);
  copyFileSync(license, join(OUTPUT_DIR, 'LICENSE'));
}

// ─── 模板关键词映射 (用于 match 命令的系统类型匹配) ───────────────────
const TEMPLATE_KEYWORDS = {
  'ai-agent-platform': ['agent', 'workflow', 'orchestrator', 'tool-call', 'langgraph', 'dify', 'coze', 'autogpt', '行动循环', '编排'],
  'ai-chat-product': ['chat', 'llm', '对话', 'streaming', '流式', 'claude', 'chatgpt', '上下文', 'rag'],
  'ai-gateway': ['gateway', 'proxy', '网关', 'litellm', 'one-api', 'portkey', '限流', '负载均衡', '计费'],
  'ai-native-organization': ['组织', 'organization', '团队', 'ai-native', '治理'],
  'automotive-ee': ['汽车', 'automotive', 'ecu', 'can-bus', '嵌入式', '车规'],
  'browser-extension': ['浏览器', 'extension', 'plugin', 'chrome', '注入', 'honey', 'grammarly'],
  'claude-code': ['claude-code', 'terminal', '终端', '编码agent', 'sandbox', 'mcp', '权限'],
  'cloud-storage': ['网盘', 'storage', 'dropbox', 'icloud', '同步', '分块', '去重'],
  'codex': ['codex', 'openai', 'cloud-agent', 'pr', '沙箱', '审批'],
  'collaborative-doc': ['协同', 'collaboration', 'crdt', 'ot', 'google-docs', 'figma', '实时编辑'],
  'ecommerce-platform': ['电商', 'ecommerce', '订单', '库存', '支付', '超卖', 'shopify', '淘宝'],
  'embedded-device': ['嵌入式', 'embedded', 'firmware', 'ota', 'rtos', '固件'],
  'hermes': ['hermes', 'nous', '自托管', '常驻', '记忆', 'cron'],
  'industrial-edge': ['工业', 'industrial', 'edge', 'plc', 'scada', '产线'],
  'inference-serving': ['推理', 'inference', 'vllm', 'sglang', 'triton', 'gpu', '批处理', '量化'],
  'iot-platform': ['iot', '物联网', '设备管理', 'mqtt', '传感器', '时序'],
  'mobile-app': ['移动', 'mobile', 'ios', 'android', '离线', '推送', '同步'],
  'notification-system': ['通知', 'notification', 'push', '推送', '多渠道', '限频', 'novu'],
  'online-ticketing': ['票务', '抢票', 'ticketing', '12306', '大麦', '超卖', '锁座', '等候室'],
  'openclaw': ['openclaw', '龙虾', '自托管', '聊天', 'gateway', 'harness'],
  'payment-system': ['支付', 'payment', 'stripe', '支付宝', '幂等', '对账', '复式记账'],
  'rag-knowledge-base': ['rag', '知识库', '向量', '检索', 'llamaindex', 'ragflow', 'dify', '切块', '重排'],
  'realtime-chat': ['即时通讯', 'chat', 'im', 'websocket', '长连接', 'whatsapp', 'slack', '微信'],
  'ride-hailing': ['网约车', '出行', 'uber', '滴滴', '地理', '匹配', '实时位置'],
  'robotics': ['机器人', 'robotics', 'ros', '运动控制', '感知', '规划'],
  'search-engine': ['搜索', 'search', '倒排索引', 'elasticsearch', '排序', '分片'],
  'social-feed': ['信息流', 'feed', 'twitter', 'instagram', '推拉', '关注', '推荐'],
  'standard-web-app': ['网站', 'web', 'saas', '后台', '三层', '缓存', '读写分离'],
  'system-prompt-architecture': ['系统提示词', 'prompt', 'agent-os', '分层', 'skills', '决策树'],
  'url-shortener': ['短链接', 'shortener', 'bitly', '重定向', '301', '302'],
  'vector-database': ['向量数据库', 'vector', 'milvus', 'qdrant', 'pgvector', 'ann', 'hnsw'],
  'video-streaming': ['视频', 'video', 'streaming', 'netflix', 'youtube', 'cdn', '转码', '码率'],
};

// ─── 教程章节关键词 ───────────────────────────────────────────────────
const TUTORIAL_KEYWORDS = {
  '01': ['架构思维', '为什么', '核心竞争力'],
  '02': ['思考框架', '需求', '约束', '质量属性', '取舍', '决策'],
  '03': ['架构图', 'c4', '画图', 'context', 'container'],
  '04': ['架构模式', '分层', '微服务', '事件驱动', 'cqrs', '单体', 'serverless'],
  '05': ['数据', '状态', '存储', '一致性', 'cap'],
  '06': ['质量属性', '性能', '可用性', '一致性', '成本', '权衡'],
  '07': ['从0到1', '设计系统', '八步', '实战方法论'],
  '08': ['adr', '架构决策记录', '演进', '决策'],
  '09': ['品味', '审美', '判断力'],
  '10': ['分布式', '部分失败', '共识', '时钟'],
  '11': ['一致性', 'saga', 'outbox', '幂等', '事件溯源'],
  '12': ['韧性', '熔断', '降级', '限流', 'slo', '混沌工程'],
  '13': ['规模化', '一致性哈希', '热点', '多活', '尾延迟'],
  '14': ['演进', '拆分', '绞杀者', '迁移', 'ddd', '限界上下文'],
  '15': ['组织', '康威', '团队拓扑', '平台工程'],
  '16': ['安全', '多租户', '零信任', '威胁建模', '隔离'],
  '17': ['大模型', 'llm', 'vibe-coding', '上下文工程', 'agentic'],
  '18': ['读图', '拆解', '陌生系统', '框架'],
  '19': ['设计演练', '中等复杂度', '客服'],
  '20': ['演进剧本', 'mvp', '规模化'],
  '21': ['拆分', '迁移', '绞杀者', '影子流量'],
  '22': ['ai原生', 'agent', '自主'],
  '23': ['规格', '约束', 'agents.md', '护栏', '写给ai'],
  '24': ['审查清单', 'review', 'checklist', '幂等', '超时', '熔断', '注入'],
  '25': ['评测', 'eval', 'ci', '门禁'],
  '26': ['协作决策树', 'vibe', 'spec-first'],
  '27': ['语言选型', '框架选型', '后端'],
  '28': ['数据库选型', '存储选型'],
  '29': ['缓存', '消息队列', '事件系统', '选型'],
  '30': ['api', '通信', 'grpc', 'rest', '选型'],
  '31': ['云原生', '部署', 'k8s', '选型'],
  '32': ['可观测性', '可靠性', '监控', '选型'],
  '33': ['ai基础设施', 'gpu', '选型'],
  '34': ['技术选型', '决策树'],
  '35': ['ai组织', '组织架构'],
  '36': ['超级个体', '超级团队'],
  '37': ['共享上下文'],
  '38': ['ai工作流'],
  '39': ['责任', '治理'],
  '40': ['演进路线', 'ai组织'],
};

// ─── 工具函数 ─────────────────────────────────────────────────────────

function extractTitle(content) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function extractFirstParagraph(content) {
  // 取第一个 > 引用块或第一段非标题文本
  const quoteMatch = content.match(/^>\s*\*\*(.+?)\*\*/m);
  if (quoteMatch) return quoteMatch[1].trim();
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('|') && !l.startsWith('```'));
  return lines[0]?.trim().slice(0, 200) || '';
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ─── 主逻辑 ───────────────────────────────────────────────────────────

function buildIndex() {
  const entries = [];

  // 1. Templates
  const templatesDir = join(SOURCE_DIR, 'templates');
  if (existsSync(templatesDir)) {
    for (const dir of readdirSync(templatesDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const readmePath = join(templatesDir, dir.name, 'README.md');
      if (!existsSync(readmePath)) continue;
      const content = readFileSync(readmePath, 'utf-8');
      const title = extractTitle(content);
      const summary = extractFirstParagraph(content);
      const keywords = TEMPLATE_KEYWORDS[dir.name] || [];

      entries.push({
        id: `arch-tpl-${dir.name}`,
        type: 'template',
        title,
        slug: dir.name,
        summary: summary.slice(0, 300),
        keywords,
        path: `templates/${dir.name}/README.md`,
        sections: extractSections(content),
      });
    }
  }

  // 2. Tutorials
  const tutorialDir = join(SOURCE_DIR, 'tutorial');
  if (existsSync(tutorialDir)) {
    for (const file of readdirSync(tutorialDir).filter(f => f.endsWith('.md') && f !== 'README.md').sort()) {
      const content = readFileSync(join(tutorialDir, file), 'utf-8');
      const title = extractTitle(content);
      const summary = extractFirstParagraph(content);
      const num = file.match(/^(\d+)/)?.[1] || '';
      const keywords = TUTORIAL_KEYWORDS[num] || [];

      entries.push({
        id: `arch-tut-${num || slugify(basename(file, '.md'))}`,
        type: 'tutorial',
        title,
        slug: basename(file, '.md'),
        summary: summary.slice(0, 300),
        keywords,
        path: `tutorial/${file}`,
        sections: extractSections(content),
      });
    }
  }

  // 3. Cases
  const casesDir = join(SOURCE_DIR, 'cases');
  if (existsSync(casesDir)) {
    for (const dir of readdirSync(casesDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const readmePath = join(casesDir, dir.name, 'README.md');
      if (!existsSync(readmePath)) continue;
      const content = readFileSync(readmePath, 'utf-8');
      const title = extractTitle(content);
      const summary = extractFirstParagraph(content);

      entries.push({
        id: `arch-case-${dir.name}`,
        type: 'case',
        title,
        slug: dir.name,
        summary: summary.slice(0, 300),
        keywords: [dir.name.replace(/-/g, ' '), ...extractCaseKeywords(content)],
        path: `cases/${dir.name}/README.md`,
        sections: extractSections(content),
      });
    }
  }

  return entries;
}

function extractSections(content) {
  // 提取 ## 级标题作为章节索引
  const sections = [];
  const re = /^##\s+(.+)$/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    sections.push(m[1].trim());
  }
  return sections;
}

function extractCaseKeywords(content) {
  const kw = [];
  if (content.includes('幂等')) kw.push('幂等');
  if (content.includes('Saga')) kw.push('saga');
  if (content.includes('多租户')) kw.push('多租户');
  if (content.includes('CRDT') || content.includes('OT')) kw.push('crdt', '协同');
  if (content.includes('RAG') || content.includes('检索')) kw.push('rag', '检索');
  if (content.includes('Agent')) kw.push('agent');
  if (content.includes('沙箱') || content.includes('sandbox')) kw.push('sandbox');
  if (content.includes('Feed')) kw.push('feed');
  if (content.includes('抢票') || content.includes('库存')) kw.push('抢票', '库存');
  return kw;
}

// ─── 执行 ─────────────────────────────────────────────────────────────

mkdirSync(OUTPUT_DIR, { recursive: true });
syncBundledContent();

const entries = buildIndex();
if (entries.length === 0) {
  throw new Error(`arch-kb contains no indexable entries: ${SOURCE_DIR}`);
}
for (const entry of entries) {
  const bundledPath = join(OUTPUT_DIR, entry.path);
  if (!existsSync(bundledPath)) {
    throw new Error(`arch-kb bundled source file not found: ${bundledPath}`);
  }
}

const index = {
  version: 1,
  builtAt: new Date().toISOString(),
  source: 'github.com/study8677/awesome-architecture',
  license: 'MIT',
  stats: {
    templates: entries.filter(e => e.type === 'template').length,
    tutorials: entries.filter(e => e.type === 'tutorial').length,
    cases: entries.filter(e => e.type === 'case').length,
    total: entries.length,
  },
  entries,
};

const outPath = join(OUTPUT_DIR, 'index.json');
writeFileSync(outPath, JSON.stringify(index, null, 2), 'utf-8');
console.log(`✓ arch-kb index built: ${outPath}`);
console.log(`  templates: ${index.stats.templates}, tutorials: ${index.stats.tutorials}, cases: ${index.stats.cases}`);
console.log(`  total entries: ${index.stats.total}`);
