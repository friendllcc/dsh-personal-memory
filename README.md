# dsh-personal-memory 🐱📝

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的跨会话个人记忆插件。

> 本仓库参考了：[meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) 的记忆存储与部分检索方式，在其基础上做三处改造——
> ① **记忆全局化**：七层记忆库从 per-workspace 迁到用户全局目录（默认
> `~/.dsh-personal-memory/.dsh-personal-memory/memory.db`，`homeDir` 三预设可配），换项目空间
> 记忆不丢，各工作区旧库启动时只读合并（幂等，绝不删除旧目录）；
> ② **个人记忆库面板**：dsh 侧边栏新增「个人记忆库」入口，全屏面板五个标签——
> **总览**（画像文档 + 七层分布 + 关键词云 + 最常命中/最近新增榜单 + 记忆体检，默认首页）、
> **时间线**（按创建日分组：AI 一天天记住了什么）、
> **记忆管理**（分门别类的画像与记忆卡片，可新增/编辑/删除，全库搜索 + 状态过滤 + 排序）、
> **关系网**（以「我」为中心的多跳知识图谱：分类着色 + 跳数控制 + 双击重聚焦 +
> 图例分类开关 + 缩放/平移/拖拽，节点与边都可点、划出关联记忆抽屉）、
> **设置**（原宿主设置窗口的「个人记忆」分区内嵌于此）。底层记忆引擎逻辑不变；
> ③ **向量语义检索**：`memory_search` 增加上游没有的语义向量检索（关键词×语义
> RRF 混合排序 + 关键词无命中时的向量召回兜底），记忆召回率进一步提高。设置页
> 「向量语义检索」分区可实时开关、改模型/条数/相似度及格线，**保存后下一轮对话
> 即生效，无需重启宿主**。

**核心理念**：全局维护一份结构化记忆数据库（`~/.dsh-personal-memory/.dsh-personal-memory/memory.db`，基于 `node:sqlite`）。
静态记忆手册（数据总览 + 工具用法 + 写作准则）以固定 section 的形式放在 **system prompt** 里——
文本恒定，因此不会破坏 LLM provider 的 KV/上下文缓存。动态内容（soul/user 全量、设计原则、
记忆导引）作为**第一条用户消息的前缀**注入，且首轮只注入长期记忆、不做关键词命中；
从第二轮起每条用户消息做关键词命中（top-2）。模型按需用 `memory_search` /
`memory_project` 深入检索。每个窗口由自己的主 agent 在空闲时（"dream"）整理记忆
（本窗口建立 + 提取过的记忆），以窗口最后一次对话时间戳冻结其知识。

## ✨ 功能特性

- **记忆全局化（fork）**：七层记忆库住用户全局目录（默认 `~/.dsh-personal-memory/.dsh-personal-memory/memory.db`，`homeDir` 三预设（默认用户主目录 / dsh storages / 插件根）可配 + 保存后热切换），跨工作区共享同一份个人记忆；启动时把各工作区旧库**只读**合并进来（`INSERT OR IGNORE` 幂等，绝不删除旧目录）。
- **记忆库展示面板（fork，可管理）**：dsh 前端侧边栏「个人记忆库」入口 → 全屏面板五个标签页：
  **总览**（默认首页：soul/user 画像文档、七层分布条、高频关键词云、最常命中 TOP5 与
  最近新增榜单、**记忆体检**（已过时/久未命中清单，一键归档），所有元素点击即跳转管理页对应过滤）、
  **时间线**（按创建日分组的记忆流水，点卡定位管理页）、**记忆管理**（七层记忆卡片分门别类，
  层级 chips / 项目 / 状态（活跃/已过时/已归档）/ 关键词过滤 + **服务端全库搜索**
  （防抖 300ms 调 `/api/search`，不再只过滤已载入）+ 排序（最近更新/最重要/最常命中）+ 分页，
  支持界面直接**新增 / 编辑 / 删除**——经 host 写路由
  `POST|PATCH|DELETE /dsh-personal-memory/api/memory` 落库）、**关系网**（以「我」为中心的
  多跳知识图谱：节点按语义分类着色——人物·画像/项目/事物/经验·原则/AI 自身，
  **人名形状识别**（常见姓氏形/复姓/姓氏+称谓，姓氏表剔除与高频词碰撞的姓——「周末/程序/黄河」不误判），
  「我」只直连项目与画像锚点，其余经共现/归属间接到达；**用户自报姓名自动折叠进「我」**
  （中英双语别名识别，本名不再以独立节点出现）；工具条可切 1 跳/2 跳/全部；
  滚轮缩放、背景平移、节点拖拽、双击节点重聚焦、图例点击开关分类；
  悬停聚焦邻居降噪；**节点与边都可点击**——节点抽屉列关联记忆，边抽屉显示
  「关系详情」（两端、关系类型、支撑这条边的全部记忆），tooltip 带命中数/最近更新/边权重）、
  **设置**（原宿主设置窗口「个人记忆」分区的完整内容内嵌于此，`settings.section`
  注册已移除）。手动点标签始终回到该标签的默认完整视图（各标签过滤状态互不泄漏）。
  读数据来自 host 只读 API（`/dsh-personal-memory/api/stats|memories|search`）。
- **向量语义检索（可选，默认关，fork）**：设置页「向量语义检索」分区配置 OpenAI 兼容
  embedding 端点（可指向本地网关完全离线，apiKey 留空不带鉴权头）——开启后
  ① 每条消息关键词无命中时按向量相似度**召回兜底**注入；② `memory_search` 走
  关键词×语义 **RRF 混合排序**。向量落本地 `memory_embeddings` 表（内容指纹校验
  新鲜度，换模型自动重嵌），后台索引器小步补缺 + 熔断 fail-soft，主流程永远先
  走纯关键词。**设置保存即热生效（无需重启）：语义七字段（开关/召回兜底/端点/
  key/模型/条数/阈值）全部为活配置——保存后下一轮对话即生效，刚开启保存时索引器
  立刻回填存量记忆；改端点自动复位熔断器（新端点不背旧端点的连败）。隐私提示：
  开启即记忆内容发往所配端点，请确认端点可信。**
- **七层记忆**（`soul` = AI 自身 / `user` = 用户基本信息与偏好 / `project` = 项目信息，
  含 `subcategory`（overview/structure/decisions/quotes/ops/todo）/ `fact` = 原子事实 /
  `lesson` = 教训与纠正 / `topic` = 进行中的讨论话题，带目标句 / `rules` = 设计原则与行为准则）。
  每层一张 SQLite 表，UUID 带时间前缀，id 顺序即创建顺序。
- **首轮注入（长期记忆块）**：第一条用户消息前注入固定格式
  `===== 长期记忆 =====` → `【关于你】`（soul 全量）→ `【关于user】`（user 全量）→
  `【设计原则】`（全局 rules 且 importance≥2，少而精的命令式准则）→ `【记忆导引】`
  （用法说明 + 「用户的所有 project」动态列表，供 `memory_project` 选用）。
  记忆作为独立 plugin snapshot 消息放在真实 user 消息之前，不改写用户 prompt。
  **首轮不跑关键词命中**（命中从第二轮起）。即使首条用户消息与插件通知消息同批到达
  （如 approval policy 变更通知），快照仍会紧贴插入到真实用户消息之前、命中绝不提前。
- **每消息关键词命中**：从第二条用户消息起，每条真实用户消息都检索
  fact/lesson/rules/topic（范围 = 全局 + 当前 project 锚定），top-2 命中以
  「可能相关的记忆，仅供参考：」前缀注入。命中基于**条目关键词**（LLM 提取或自动
  bigram）而非全文——全文匹配噪音大。打分 = 交集分 × idf × 覆盖率 × 艾宾浩斯衰减
  （按记忆时间戳）× importance 权重 × title 加成。
- **当前 project 锚定**：`memory_remember/search/update/project` 带 project 参数即锚定
  该会话的当前项目；未锚定时命中只搜全局（用户闲聊不误伤）。
- **缓存友好设计**：静态 `dsh-personal-memory:guide` section（order 130，紧随各 `tool:*` 说明之后）
  在 system prompt 中注册一次——文本恒定，KV 缓存友好。已见记忆（`injected` + `searched`）
  按会话记录（全局目录下的 `sessions/<id>.json`）：注入绝不重复；`memory_search` 前 5 条按相关度
  无脑取（不排除已见/本 session 建立的记忆），其余从排名后续绕开已见补齐；收到会话压缩
  信号（`compaction/*`）时释放已见记录，允许压缩后被再次命中提取。
- **压缩后重注入**：会话被压缩（手动 `/compact` 或 token 压力自动触发）后，下一个用户
  消息轮自动重新注入长期记忆快照 + 本会话此前用 `memory_project` 查阅过的项目全景 +
  本会话自己写入/更新过的记忆原文（均按最新数据重新整理）——压缩甩掉的"记性"一个回合
  就补回来，AI 不会因为压缩突然失忆。
- **工具集**：`memory_remember`（写入，必填 content/project/keywords/importance 且缺失报错引导重填，
  自动去重合并，返回读回确认：关键词/项目归属）/
  `memory_search`（BM25 × 近期权重 ×（开启时）语义 RRF 混合，支持 level/project/status/days 过滤，默认 top10 = 前 5 条
  最相关不排除已见 + 后 5 条绕开已见补齐，按记忆时间戳排序；返回检索元数据视图：
  归属 + 完整 id + 相对时间 + 关键词列表，不含原文）/
  `memory_project`（项目全景注入段落：**project 参数必填**——你要看哪个项目的信息？按子标签分组、未过时条目全给、每条带完整 id 与
  最后更新时间戳、todo 输出「已完成：」最近 5 条 +「To do list：」，末尾附记忆库与
  会话历史定位说明）/
  `memory_find_similar`（查重与冲突检测）/ `memory_read` / `memory_update`（含 status
  active/archived/stale、importance、goal、keywords 手动修正）/ `memory_dream`（手动触发；
  用户也可以直接在输入框敲 `/dream` 命令）。
- **记忆时间戳**（`updated_at` = 最后更新时间）：dream 封存或 `memory_update` 刷新时更新。
  展示的时间戳一律是 `updated_at`；search（工作视图）带相对时间戳，命中注入/memory_project
  （原文视图）带相对 + 绝对时间戳（如「2026-08-15 10:58 [2 天前]」）。
- **project 归属**：全局适用的信息 project 填 `"全局"`（与留空=未标记区分）；同时适用于
  多个项目时用英文逗号分隔（如 `"dsh, femo"`）——检索/命中按"包含当前项目名 或 全局"判定。
- **按窗口 dream**：窗口空闲 ≥ `idleMinutes`（默认 **180 分钟 = 3 小时**）即进入允许
  触发状态（替代原夜间窗口），每个最后发言晚于上次 dream 的窗口由自己的主 agent
  整理——分轮处理（第 1 轮原子记忆 project/fact/lesson/rules/soul/user，第 2 轮 topic
  记忆，第 3 轮项目总结——本窗口涉及具体项目时追加：调 memory_project 复查并精简成
  新的项目长期记忆，被取代的旧条目归档），project 小标题分段，每条记忆附关键词行
  （AI 核查/重写关键词用），范围=本窗口
  建立 + 提取过（注入/检索/查阅 memory_read）的记忆，使用其完整会话上下文；
  长期稳定的 rules 不反复重审（`dream.rulesReviewDays` 默认 2 天内有更新才进清单，
  防"没话找话"式更新）。**峰时抑制**（按 `timeZone` 计算，默认
  北京时间）：`suppressWindows`（默认 09:00–12:00、14:00–18:00，API 峰谷电价峰时）
  及各自开始前 `suppressLeadMinutes`（默认 15）分钟内不触发，峰时结束后下一个检查
  周期自动触发；进行中的 dream 不打断。无 live agent 且超过 24h 的旧窗口、以及已归档
  的会话，均不处理。
- **`/dream` 命令**：不想等空闲触发？在输入框敲 `/dream` 立即手动唤起本窗口的记忆整理
  （与 `memory_dream` 工具同语义，不受峰时抑制）。dsh 命令平面执行、不发给模型，输入 `/`
  的补全菜单里直接可见；已有整理在进行中会明确提示，不会重复启动。
- **跳过梦境整理（client 端）**：某个窗口的记忆不想被自动整理？左侧边栏该会话行的「…」
  菜单里点一下**「跳过梦境整理记忆」**即可，再点**「取消跳过梦境整理记忆」**恢复。被跳过
  的窗口不再被空闲定时器自动 dream（`/dream` 与 `memory_dream` 手动触发不受影响），
  会话列表里显示**静音灰「月牙+斜杠」**图标、一眼可辨。跳过状态持久保存、重启不丢；
  双实例共享同一记忆库，状态天然一致。
- **反思**：单次任务内连续 ≥7 个工具 step 后，插件询问模型自上次整理以来是否有值得记忆的内容。
  最后工具是 `memory_*` 视为已主动记忆、不重复反思；被取消的轮次绝不触发。
- **注入折叠 UI（client 端）**：首轮长期记忆 / 每消息关键词命中的注入文本在前端
  折叠成「▸ 已注入记忆（长期记忆/关键词命中）」横条（与用户气泡同宽），点开可查看
  注入全文；用户 prompt 以气泡形式直接显示，消息流干净不被注入刷屏。纯文本消息才折叠
  （带附件的保持原样）。
- **反思轮折叠 UI（client 端）**：记忆反思/dream 轮的 prompt 与后续 think/tool call/汇报
  折叠成一条横条（默认折叠，显示「新增记忆 N 条」/「记忆梦境任务」），点击向下展开成
  卡片查看完整记录——卡片内 Think / tool call / 上下文注入均可点开查看细节。
- **会话列表 dream 图标（client 端）**：左侧会话列表中，"dream 整理过记忆且之后无新对话
  新信息"的会话行显示**淡黄色小月牙 🌙**；dream 轮进行中显示**白→金呼吸灯月牙**（与 dsh
  状态点并存、月牙居左，不与正常工作混淆）；被**跳过梦境整理**的会话显示**静音灰「月牙+斜杠」**
  （取消跳过自动回落；优先级：呼吸灯 > 跳过 > 月牙）；有新活动即移除。图标放进 dsh 会话行的
  状态槽位、状态点左侧——只追加/只移除自有节点，不改写 React 拥有的子节点（整槽替换会令
  React 虚拟 DOM 失同步，commit 抛 removeChild NotFoundError 把侧边栏整树卸载）。
  数据走全页共享的 60s 轮询 diff（v0.23.0 连接池修复，替代原 SSE 长连接）：
  `/dsh-personal-memory/dreamed-sessions` 与 `/dsh-personal-memory/skip-dreams` 各一次 GET，事件语义不变——
  dream 开始推 `state:'dreaming'`、完成推 `state:'dreamed'`、有新活动推 `state:'active'`、
  跳过翻转推 `state:'skip'/'unskip'`；client 挂载时全量对账一次。
  行定位零 dsh 改动：读 React 18 fiber（`__reactFiber$` 内部属性）拿会话行渲染 key =
  session id，不依赖标题匹配。
- **dream 防重复**：check 门（DB 原子 60s 检查节流）+ start 幂等抢占（`dream_pending`）+
  中断自愈（未收尾的 dream 自动补收尾）+ 孤儿收尾（跨实例/热重载后 turn 结束也能收尾）；
  插件注入轮的事件不刷新窗口活跃度——已 dream 的窗口不会反复被 dream。
- **零运行时依赖**：`node:sqlite`（Node ≥22.13 默认可用；22.5–22.12 需 `--experimental-sqlite`）+ 自包含 esbuild 产物（`lib/index.js`）。
  无原生模块。

## 📦 安装与卸载

### 方式〇：GitHub Releases 发布包（普通用户推荐）

从 [Releases](https://github.com/friendllcc/dsh-personal-memory/releases) 下载最新版
`dsh-personal-memory-<版本>.tgz`（预构建，`lib/` 已编译，无需本地构建），执行：

```sh
dsh plugin --profile web add /path/to/dsh-personal-memory-0.4.2.tgz
```

装完重启 `dsh web` 即可。每个版本一个 tgz，升级 = 下载新版 tgz 重复上述命令后重启宿主。

### 方式一 / 二：从源码安装（开发者）

从本地目录或本仓库 clone 安装（改代码即插即用）。两种方式任选其一。

### 方式一：profile 依赖声明（推荐，可随源码更新）

1. 编辑 profile 的 `~/.dsh/profiles/web/package.json`，`dependencies` 加一行 link 依赖：
   ```json
   "dsh-personal-memory": "link:D:/移动研究院/PA-dev/dsh-personal-memory"
   ```
   （路径换成你机器上的仓库位置。）
2. 同文件 `dsh.profile.bundles` 数组追加 `"dsh-personal-memory"`：
   ```json
   "dsh": { "profile": { "bundles": [ "...", "dsh-personal-memory" ] } }
   ```
3. 在 profile 目录执行包管理器安装（创建 node_modules 链接）：
   ```sh
   cd ~/.dsh/profiles/web && pnpm install   # 或 npm install
   ```
   装完后**改源码 → `npm run build` → 重启 `dsh web` 即生效**，无需重装（link 指向源码目录）。
4. 重启 `dsh web`，新会话自动加载插件。

### 方式二：手动软链（不跑包管理器）

1. 把本包软链到 profile 的 `node_modules`：
   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/dsh-personal-memory ~/.dsh/profiles/web/node_modules/dsh-personal-memory
   ```
   （Windows：`New-Item -ItemType Junction -Path ... -Target ...` —— NTFS junction，无需管理员权限。）
2. 方式一的第 2 步（`dsh.profile.bundles` 加 `dsh-personal-memory`）。
3. 重启 `dsh web`。

> ⚠️ **首次安装前先 `npm run build`**：仓库带 `prepare` 脚本，包管理器安装会自动编译；手动软链方式没有这步，需自跑一次（产物 `lib/index.js`，自包含）。开发依赖的 `@deepseek-ai/*` 包不在本包 `node_modules` 里，构建前先执行 `npm run link-workspace`（Windows junction；macOS/Linux 用 `ln -s`，布局一致）。

### 卸载

1. `~/.dsh/profiles/web/package.json`：从 `dsh.profile.bundles` 删除 `"dsh-personal-memory"`（插件停止加载）；方式一安装的再把 `dependencies` 里的 link 行一并删除。
2. 清掉 node_modules 链接：`pnpm remove dsh-personal-memory`（方式一）或直接删除 junction/软链目录（方式二）。
3. 重启 `dsh web`。
4. **（可选，不可逆）清理数据**：插件的全部记忆与运行数据在 `~/.dsh-personal-memory/`（默认 homeDir 布局）。确认不再需要这份个人记忆后再整个删除该目录；想换机器/备份，拷走这个目录即完成迁移（`homeDir` 改成别的预设时同理，旧目录保留不删）。

## 🔌 兼容性

插件不写死宿主版本号，运行时探测宿主能力，新旧 dsh 走各自正确分支。已在两代设置链路上实测：**0.1.7**（`configForms.get` 共享表单腿——面板「设置」标签页走此路，含 0.1.7 宿主「写后不重载 entry」盲区的兼容补丁）与 **0.1.6**（`settingsScope.bind` 腿，原生 installSection/onChange 全链）。更早宿主自动降级（设置走 patch 层，面板仍可用）。

升级 dsh 不需要改本插件，也不需要改任何配置。

## ⚙️ 配置

所有字段均可选（profile patch 或 `cordis.patch.yml`）。**也可以不手编文件**：v0.3.0 起设置图形界面内嵌在侧边栏「个人记忆库」面板的**「设置」标签页**里（原宿主设置窗口的「个人记忆」标签页已移除），下面这些项全部图形化可改、字段级保存、可单项恢复默认（恢复默认 = 回到插件出厂默认，不受 patch 基线影响）。**热字段（命中/反思/梦境/停用名单/语义检索全项）保存即生效，下一轮对话可用；注册期字段（enabled/projectDir/homeDir 结构）需热重载/重启插件。**

```yaml
- id: dsh-personal-memory
  name: 'dsh-personal-memory'
  config:
    enabled: true               # 总开关
    homeDir: ''                 # 全局目录（默认 '~'=用户主目录下 ~/.dsh-personal-memory；'dsh-storage'=宿主 storages；'plugin-root'=插件根；或绝对路径）
    projectDir: '.dsh-personal-memory' # 记忆目录名（全局目录内的子目录）
    promptLang: 'zh'            # ⚠️ 首次使用建议显式配置（见下方说明）
    hitTopK: 2                  # 每条用户消息关键词命中的条目数上限（fact/lesson/rules/topic）
    reflect: true               # 连续 ≥reflectTurns 轮工具调用后自动反思
    reflectTurns: 7             # 触发反思所需的连续工具轮数
    disabledWorkspaces: []      # 工作区停用名单（路径归一精确匹配）
    dream:
      enabled: true
      idleMinutes: 180          # 窗口空闲 ≥180 分钟（3 小时）允许 dream
      suppressWindows:          # 峰时抑制时段（按下方 timeZone 计算，"HH:MM" 起止）
        - start: '09:00'        #   API 峰谷电价峰时
          end: '12:00'
        - start: '14:00'
          end: '18:00'
      suppressLeadMinutes: 15   # 每个峰时开始前 15 分钟也不触发
      checkMinutes: 15
      timeZone: 'Asia/Shanghai' # 用户机器时钟为美区时间；抑制时段必须
                                 # 按此固定时区计算
      rulesReviewDays: 2        # updated_at 距今超该天数的稳定准则不进 dream 第 1 轮
                                 # 清单（防反复整理不变化的条目）；0 = 不过滤
    delegate:
      model: ''                 # 整理任务换模型（可选）：填写后反思轮与梦境轮自动换用
                                 # 该模型执行，轮次结束自动换回主模型；'provider/model'
                                 # 指定 provider+model，'model' 只换模型（provider 继承
                                 # 主会话）；留空 = 全程主模型
    semantic:                   # 向量语义检索（v0.4.0+，默认关；保存即热生效）
      enabled: false            #   总开关——开启即记忆内容发往所配端点，注意隐私
      recall: true              #   关键词无命中时的语义召回兜底（enabled 前提下）
      baseUrl: 'https://api.openai.com/v1' # OpenAI 兼容端点根（可指向本地网关离线用）
      apiKey: ''                #   留空 = 不带鉴权头（本地网关）
      model: 'text-embedding-3-small'
      topK: 5                   #   语义侧条数上限（1–20）
      minScore: 0.25            #   cosine 相似度及格线（0–1，低于视为无关）
```

### 整理任务换模型（可选）

反思轮和 dream 各组始终在主窗口执行（steer）——prompt、模型回应、工具调用落在主会话 log（折叠 UI 负责视觉收纳）。独立 fork 子代理执行方式已于 v0.24 移除，不再提供"独立执行"开关。

如果想让记忆整理换个（更便宜的）模型跑：配置 `delegate.model` 后，反思/梦境轮发起的每个 LLM 请求会经 dsh 的 `agent/request` waterfall 自动覆盖 provider/model，轮次结束自动换回主模型——正常对话、工具轮完全不受影响。实现是无状态的：按"当前 turn 是否携带反思/梦境指令标记"逐请求判定，用户中止、崩溃、热重载都不会留下"卡在换模型"的脏状态。

### promptLang：prompt 与检索语言（重要）

`promptLang` 决定两件事：①注入/反思/dream 文案的语言；②工具描述的语言。它同时影响模型写记忆条目用的语言——关键词按条目语言提取，**以你说话的语言为准**。

**因此首次使用时请显式配置它**：`promptLang: 'zh'`（默认）、`'en'`（内置英文语言包。配置值就是子目录名，**逐字匹配**：填一个 `src/prompts/` 里不存在的名字（例如 `pt`）不会报错，而是静默落回中文包。

检索侧说明：BM25 分词自 v0.20.0 起语言无关（类别路由），条目与查询语言不一致不再"杀检索"；`en` 模式额外启用英语归一化（停用词过滤 + Porter 词干还原），屈折变化不影响命中（`tokenizers` 能命中存为 `tokenizer` 的条目）。

## 🧠 工作原理

```
第一条用户消息（首轮）         第二条起的每条消息                空闲≥3h 且非峰时
┌────────────────────┐        ┌────────────────────┐        ┌──────────────────────┐
│ ===== 长期记忆 ===== │        │ 可能相关的记忆，仅供  │        │ 按窗口 dream：        │
│ 【关于你】(soul)     │        │ 参考：keywords 命中   │        │ 三轮（含项目总结）      │
│ 【关于user】         │        │ top-2（全局+当前     │  +语义  │ 七层+提取过的，       │
│ 【设计原则】(rules)   │        │ project 锚定；关键词  │ 召回   │ updated_at 以 T 封存  │
│ 【记忆导引】          │        │ 无命中且语义开启时    │ 兜底   │                      │
└────────────────────┘        │ 向量相似度召回兜底）  │        └──────────────────────┘
                               └────────────────────┘
独立 plugin snapshot          已见 id 按会话记录
消息在真实 user prompt         (sessions/<id>.json)
之前；首轮只注入，             压缩信号 → 释放已见
不做命中
```

## 🙏 致谢

本项目借站在上游 [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) 的肩膀上，感谢上游及每一位贡献者：
- **[daveycodez](https://github.com/daveycodez)** — 英文语言包与英文分词（[PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6)，v0.22.0 发布）
- **[chenmzh](https://github.com/chenmzh)** — 记忆注入改为独立 plugin snapshot 消息，根治会话标题污染（[PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10)）
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — dsh 0.1.2-alpha.4 双版本 Session events 兼容（[PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11)）
- **[coutogilson](https://github.com/coutogilson)** — 巴西葡语 prompt 语言包（`src/prompts/pt-br/`）与跟随 DSH 语言设置的界面文案层

## 📄 License

MIT —— 见 [LICENSE](LICENSE)。
