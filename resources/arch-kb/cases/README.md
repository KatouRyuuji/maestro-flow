# 案例篇:把架构从答案写成推理过程

> `tutorial/` 教方法,`templates/` 给地图,`cases/` 带你把一个具体项目从 0 推到能上线、再推到能扛住真实压力。

案例篇不是「更多模板」。模板回答的是:**这类系统通常长什么样?** 案例回答的是:**在某个具体场景里,为什么架构最后被约束逼成这样?**

---

## 第一批案例

| 案例 | 对应模板 | 主要练什么 |
|---|---|---|
| [01 · StarArena:2 万座演唱会抢票系统](stararena-ticketing/README.md) | [在线票务 / 抢票](../templates/online-ticketing/README.md) · [电商平台](../templates/ecommerce-platform/README.md) · [支付系统](../templates/payment-system/README.md) | 有限库存、虚拟等候室、锁座、支付状态机、对账补偿 |
| [02 · PatchDesk:给 20 人团队用的轻量工单 SaaS](patchdesk-saas/README.md) | [标准 Web 应用](../templates/standard-web-app/README.md) · [移动 App](../templates/mobile-app/README.md) · [通知 / 推送系统](../templates/notification-system/README.md) | 模块化单体、多租户隔离、RBAC、工单时间线、Outbox、异步通知、搜索报表演进 |
| [03 · DocuMind:给 500 人公司用的企业 RAG 知识库](documind-rag/README.md) | [RAG 知识库](../templates/rag-knowledge-base/README.md) · [AI 对话产品](../templates/ai-chat-product/README.md) · [向量数据库](../templates/vector-database/README.md) | 文档入库、切块、混合检索、知识图谱 RAG、重排、引用、权限过滤、提示注入、评测回归 |
| [04 · SyncRoom:给远程团队用的实时协同工作台](syncroom-collaboration/README.md) | [实时通讯](../templates/realtime-chat/README.md) · [实时协同文档](../templates/collaborative-doc/README.md) · [通知 / 推送系统](../templates/notification-system/README.md) | 长连接、服务端序号、离线补齐、多端同步、OT / CRDT、Presence、通知降级 |
| [05 · FeedStream:社交 Feed 与视频内容分发系统](feedstream-content/README.md) | [社交信息流](../templates/social-feed/README.md) · [视频流媒体](../templates/video-streaming/README.md) · [搜索引擎](../templates/search-engine/README.md) | 推拉混合、大 V 扇出、时间线收件箱、推荐排序、搜索索引、视频转码、CDN、审核召回 |
| [06 · CodePilot:AI Agent / 编码 Agent 平台](codepilot-agent/README.md) | [AI Agent / 工作流平台](../templates/ai-agent-platform/README.md) · [OpenAI Codex](../templates/codex/README.md) · [Claude Code](../templates/claude-code/README.md) | 工具调用、权限网关、沙箱、人工审批、上下文压缩、检查点、子代理、trace、eval 门禁 |

第一批 6 个核心案例到这里收束。后续案例会按同一质量标准继续扩展到行业纵深或专项技术栈。

---

## 案例篇怎么读

读案例时不要背图,而要盯住四件事:

1. **旧架构为什么一开始是合理的?**
2. **哪个量化信号说明它不能继续用了?**
3. **新架构做了什么选择,又放弃了什么?**
4. **如果约束变了,这个答案还成立吗?**

一句话标准:

> **没有数字,不是案例;没有取舍,不是架构;没有演进,不配进案例篇。**
