# dsh-personal-memory：跨会话全局个人记忆

**为 DeepSeek Harness（DSH）维护一份全局个人记忆：换项目不丢、可视化可管理、记忆可个性化设置。**

## 它是什么

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的跨会话个人记忆插件。以“个人”为中心，随着你聊天的深入，逐步了解你的工作、生活，在全局记住你的画像，并可以持续进化，自我整理。

防止了每开一个新工作区，AI 就把你忘光。与你相关的偏好、工作、教训、生活琐事、个人计划、家庭情况等，永远开箱就在。

## 主要特性

本插件参考 [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) 的记忆存储和检索，主要改造：

1. 记忆全局化：原插件按照项目工作区隔离记忆，现改为以用户为中心的全局记忆；
2. 记忆可视化：原插件没有记忆对用户不可见，这次新增侧边栏【个人记忆库】全屏面板，包含总览、时间线、记忆管理、关系知识图谱、设置 5 个标签页，可视化管理和设置记忆；
3. 记忆检索优化：原插件没有向量检索，只有关键词检索，导致模糊需求检索无内容召回，本次新增向量语义检索，采用关键词 + 语义 RRF 混合召回，召回效果更好，设置里可以配置参数，修改后即时生效。

目前具备以下能力：

- **全局共享记忆库**：七层记忆库统一存于 `memory.db`，支持3种主目录配置、热切换；启动时只读合并各工作区旧记忆，幂等写入、不删原有数据。
- **记忆管理面板**：侧边栏「个人记忆库」入口，含5个标签页：
  - 总览：用户/AI画像、记忆分布、关键词云、TOP命中、记忆体检（过期记忆一键归档）
  - 时间线：按日期分组的记忆流水
  - 记忆管理：七层卡片筛选、全库防抖搜索、多维度排序分页，支持增删改记忆
  - 关系网：以「我」为中心的知识图谱。默认「实体」视图——从记忆的 keywords + 正文派生人物/健康/地点/机构/物品/事件（零 LLM、不建表、永远与记忆同步）；支持个人/项目范围切换、Top N 展开、人卡/主题下钻；保留跳数、图例开关、节点/边抽屉、拖拽缩放。可一键切回「关键词」视图。
  - 设置：内嵌喵记忆全部配置项
- **关键词 + 向量语义双重检索**：配置OpenAI兼容Embedding端点（支持本地离线网关）；向量检索默认关闭，开启后关键词无命中时向量兜底召回，检索使用关键词+语义RRF混合排序；向量数据本地存储，换模型自动重嵌入，配置保存即时生效。
- **七层记忆结构**：分为`soul(AI自身)`/`user(用户信息偏好)`/`project(项目，含多子分类)`/`fact(原子事实)`/`lesson(经验教训)`/`topic(讨论话题)`/`rules(设计准则)`，每层独立SQLite表。
- **记忆注入机制**
  1. 首轮：用户第一条消息前注入长期记忆快照（AI画像、用户信息、核心准则、项目列表），首轮不做关键词命中
  2. 后续轮次：每条消息检索匹配fact/lesson/rules/topic，top2相关记忆前置注入；支持项目锚定，未锚定时仅检索全局记忆
- **会话压缩容错**：会话压缩后，下一轮自动重加载长期记忆、项目全景、本次会话新增记忆，避免压缩失忆；会话内记录已注入记忆，防止重复推送。
- **Dream记忆整理**
  - 自动触发：窗口空闲≥3h，避开业务高峰时段；支持单会话手动`/dream`命令触发，不受峰时限制（可自行设置）
  - 整理逻辑：分三轮梳理本窗口记忆，旧条目自动归档；支持会话单独设置「跳过自动dream」
  - 状态标识：会话列表用月牙图标区分【待整理/整理中/已整理/跳过自动整理】
  - 防重复机制：原子节流、幂等抢占、中断自愈，避免重复整理
- **反思提醒**：单次连续≥7步工具调用后，自动询问是否留存新记忆；记忆相关工具调用后跳过反思

## 安装

前提：已安装 DSH Web 版并配置好可用模型。Node.js 需要 ≥ 22.13。

从 [Releases](https://github.com/friendllcc/dsh-personal-memory/releases) 下载最新版 tgz（已预编译，无需本地构建），执行：

```sh
dsh plugin --profile web add "/path/to/dsh-personal-memory-0.4.2.tgz"
```

也可以直接给插件安装命令一个 Release 下载地址：

```sh
dsh plugin --profile web add "https://github.com/friendllcc/dsh-personal-memory/releases/download/v0.4.2/dsh-personal-memory-0.4.2.tgz"
```

装完重启 `dsh web`。升级 = 下载新版 tgz 重复上述命令后重启，原有记忆数据保留。

## 怎么使用

1. 安装重启后正常聊天即可——AI 自动在合适的时机记忆与检索，无需手动操作。
2. 想看 AI 记住了什么：左侧边栏打开**「个人记忆库」**面板。
3. 所有配置在面板的**「设置」**标签页里图形化修改，热字段保存即生效。

## 数据与隐私

- 全部记忆与运行数据默认保存在 `~/.dsh-personal-memory/`。备份 / 换机器 = 拷走这个目录；卸载插件不会删除数据。
- 向量语义检索**默认关闭**。开启后记忆内容会发往你配置的 embedding 端点，请确认端点可信（可指向本地网关完全离线）。

## 开发

Release 的 tgz 已预编译，安装不需要运行下面的命令。从源码开发：

```sh
npm install
npm run build
npm test
```

开发依赖的 `@deepseek-ai/*` 包来自 DSH 宿主源码仓（deepseek-harness monorepo），需先在本机准备好该仓库；`schemastery` 已锁定 3.18.1，请勿升级（配置解析行为有差异，`tests/config-volatile.mjs` 会把关）。

## 关联插件
依赖本项目个人的长期记忆，可实现两个个性化的功能插件：
- [dsh-goals](https://github.com/dawn0713/dsh-goals)：个人目标管理，支持跨会话目标规划、步骤管理、每周回顾和条件追踪
- [dsh-goals](https://github.com/dawn0713/dsh-ideas)：个性化工具，聊过的想法、已经制定的计划和真正开始执行之间，往往还差一个具体动作。你可能知道自己想改善什么，却不确定现在最值得做哪一步，也不想每次都重新交代背景。它把个人记忆、Goals 中的未完成步骤和近期对话整理成下一步建议卡片；你选中一张卡片后，可以在聊天里继续推进你的计划，并查看实际进度、交付产物和后续跟进。

## 致谢

本项目基于上游 [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) 改造，感谢上游及每一位贡献者：

- **[daveycodez](https://github.com/daveycodez)** — 英文语言包与英文分词（[PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6)）
- **[chenmzh](https://github.com/chenmzh)** — 记忆注入改为独立 plugin snapshot 消息（[PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10)）
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — 双版本 Session events 兼容（[PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11)）
- **[coutogilson](https://github.com/coutogilson)** — 巴西葡语语言包与界面文案层

## License

MIT —— 见 [LICENSE](LICENSE)。
