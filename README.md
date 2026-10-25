# 小小闫桌宠（xiaoxiaoyan-desktop-pet）

一只会记住你、和你慢慢变熟的 Electron AI 桌面宠物。

不只是桌面挂件：她有**三轴好感度关系系统**、**带时效衰减的长期记忆**、**严格的上下文预算**，并且支持接入本机 DSH 桥接，用 **Trae 积分实现零成本对话**。

![Windows](https://img.shields.io/badge/platform-Windows-blue) ![Electron](https://img.shields.io/badge/Electron- TypeScript-informational) ![License](https://img.shields.io/badge/license-MIT-green)

---

## 功能总览

### AI 陪伴（本项目的主战场）

| 能力 | 说明 |
|---|---|
| **三轴好感度** | 亲密度 / 活力 / 信任 三轴数值真实驱动行为：亲密度不够不主动搭话、活力耗尽会沉默、信任足够才给建议 |
| **六级关系阶梯** | 初识 → 熟悉 → 亲近 → 依赖 → 默契 → 挚友（0/15/30/50/70/90），每一级解锁**不同的行为**（不只是换语气词）——关系阶段会注入系统提示词，模型知道「现在能做什么、还没到那一步的是什么」 |
| **涨落规则** | 说话 +1、交互 +2、心跳被回应 +1、**被无视 -1**；每日涨幅上限 20 防刷 |
| **三层记忆 + 潮汐机制** | 核心档案（常驻注入）/ 近期对话（滚动窗口）/ 归档（关键词命中才翻出）；事实 30 天没被提起自动下架，重新提起自动复活续期 |
| **归档检索** | 聊到很久以前的话题时，自动从归档原文里翻出相关片段（此前归档层只写不读，是死数据） |
| **每日摘要** | 每天把前一天的闲聊压缩成一句话存进记忆，原文被挤掉后至少留一句能翻回来的梗概 |
| **上下文预算硬上限** | 总输入 16000 字符 / 单条输入 4000 / 历史 4000 / 记忆 1200 / 归档摘录 1000；闲聊与正事分档（闲聊 1800 字 + 320 token + 不带思考强度），彻底杜绝「上下文无限膨胀」 |
| **凭据脱敏** | 写入记忆前、注入模型前双向拦截常见密钥格式，聊天里贴了 key 也不会被存下来回传 |
| **人设文档热重载** | `persona.md` 六段式角色文档放在用户数据目录，改完保存下一次对话即生效，优先级高于 JSON 性格标签 |
| **说话样例** | 人设不靠形容词，靠「用户说 X → 她回 Y」的真实样例（模型学得像） |
| **心跳主动搭话** | 每天 7 个时段 + 30 分钟空闲触发；持久化去重，跨重启不重复 |
| **静默退避** | 亲密度不足或活力耗尽时不主动说话——被忽略的桌宠会安静下来，而不是硬凑热闹 |
| **唤醒补报** | 电脑从睡眠唤醒时主动打个招呼（每天最多一次），睡眠漏掉的心跳有交代 |
| **本地兜底** | 没配 API Key 也不哑：基于关键词的本地模板回复，照样能说话能记事 |

### 桌面玩具

- 呼吸 / 挤压回弹动画、眨眼、边缘吸附、拖动
- 点击音效（Web Audio 现场合成，零素材依赖）
- 摸摸头 / 比心 / 打招呼 / 递花花四种交互（各有动画与台词）
- 小屋 Dashboard：聊天、亲密度进度条、长期记忆管理、提醒
- 待办提醒、文件口袋、系统托盘、鼠标穿透
- 隐藏时自动停帧省电；置顶看门狗每 30 秒自检
- 无白框描边气泡：长句自动换行，话说得全

### 零成本模型接入（DSH 桥接）

桌宠启动时自动发现本机的 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）桥接端点（`~/.dsh/openai-bridge.json` + 端口探测），发现即接管 baseUrl / apiKey / model，**什么都不用填**。配合 `dsh-connect-trae` 插件可用 Trae 积分对话；模型列表里有多个通道时自动优先 Trae（积分计费）。

也支持直接配置任何 OpenAI 兼容接口（DeepSeek 官方、自建网关等），SSE 流式响应已适配。

## 安装

到 [Releases](../../releases) 页面下载：

- **小小闫桌宠-Setup.exe** —— 安装版，双击安装（免管理员）
- **小小闫桌宠-portable.zip** —— 便携版，解压即用

## 开发

```bash
npm install
npm run check     # 类型检查 + 契约校验 + QA
npm test          # 127 个单元/集成测试（node:test）
npm run dev       # 本地运行
npm run make:win  # 打安装包
npm run portable:win  # 打便携 zip
```

### 目录结构

```
src/
  main.ts               # Electron 主进程：窗口/托盘/IPC/看门狗/电源
  shared/contracts.ts   # 主/渲染进程共享类型与校验
  main/companion/       # AI 陪伴核心
    engine.ts           # 对话编排：人格→召回→模型→状态→记忆
    affinity.ts         # 三轴好感度 + 六级阶梯
    memory.ts           # 三层记忆 + TTL + 归档检索
    budget.ts           # 上下文预算 + 凭据脱敏
    persona.ts          # 人格编译（含 persona.md 渲染）
    api.ts / sse.ts     # OpenAI 兼容客户端 + SSE 解析
    bridge.ts           # DSH 桥接自动发现
  renderer/             # pet（本体）/ dashboard（小屋）/ reminder（提醒）
pet-spec.json           # 角色与行为的声明式规格
tests/                  # unit + integration（127 个）
```

### 配置

- `pet-spec.json`：角色、动画、交互、companion 默认参数
- 用户数据目录 `persona.md`：六段式人设文档（热重载）
- 小屋界面可改模型 / baseUrl / Key（Key 永不回传渲染层）
- 环境变量 `DEEPSEEK_API_KEY` 优先于落盘配置（零落盘方案）

## 致谢

- 好感度与记忆分层思路受社区「大肥鱼」系列项目与「潮汐记忆」启发
- [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop) 的桌面玩具功能设计（点击音效、省电、置顶看门狗）值得学习

## License

MIT
