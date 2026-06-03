# GSMS 各页面前端设计要求（对接后端导向）

> 用途：原型视觉稿由其他工具产出。本文档**不规定视觉细节**，而是固定两件事，保证任何原型最终都能接上后端：
> 1. **保留既有设计规范**（视觉/交互约定，见 §1）。
> 2. 从"前端必须能对接后端"的角度，逐页给出**数据契约、API 端点、状态流、组件↔数据绑定、加载/空/错误态**。
>
> 端点标注：`【现有】` = `backend/app/main.py` 已实现，可直接调用；`【新增】` = 后端需新建，本文给出建议契约。
> 命名约定：后端 `snake_case`，前端 `camelCase`，经 `apiClient`/normalizer 转换（沿用 `stores/useStores.tsx` 现有 `normalizeAsset` 等模式）。

---

## 1. 通用设计规范（所有页面强制遵守）

### 1.1 视觉与交互规范（保留原 `frontend-design.md` §10）

以下为**绑定规范**，原型与实现都不得偏离：

- **色彩**：slate=主 UI 色；white=面板背景；teal/emerald=地图与成功；amber=运行中/警告；red=失败/错误；sky=提示。不用大面积渐变/装饰背景/营销视觉。
- **间距与圆角**：面板 `p-3`/`p-4`；卡片 `rounded-md`；细边框 `border-slate-200`；阴影只用于地图浮层/小卡片。**禁止卡片套卡片**（区块用分隔线，不用嵌套边框盒）。
- **字体层级**：`Inter` 字族；区块/页面标题 `text-sm font-semibold`；分组标签 `text-[11px] font-semibold uppercase tracking-wide text-slate-500`；辅助/元数据 `text-xs`~`text-[11px]`；工作台内不用 hero 大字。
- **图标**：仅用 `lucide-react`，不手写 SVG；纯图标按钮必须有 `aria-label`/`title`。
- **列表项次级操作 hover 显形**：`opacity-0 group-hover:opacity-100 focus-within:opacity-100`（沿用本轮去堆砌实现）。
- **复用基础组件**：`ui/Button`（variant: default/secondary/ghost/outline/destructive；size: sm/md/icon）、`ui/Input`、`ui/SegmentedTabs`、`lib/format.formatBytes`。
- **桌面端约束**：最小宽度三栏可用（≥1180px），窄屏横向滚动，不做移动端重排。

### 1.2 前后端对接通用约定

- **API base URL**：`process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'`；生产为相对路径，经 Next.js rewrite 转发（沿用现状）。**建议（Phase 0）**统一收敛到 `lib/apiClient`，禁止组件内散落 `fetch` + 写死 base URL。
- **大小写归一**：所有后端响应经 normalizer 转 camelCase；`*_url` 字段统一补全为绝对/相对可用地址（沿用 `normalizeOutput`）。
- **鉴权**：用户系统已纳入设计（见 §6），`apiClient` 预留 `Authorization` 头注入点；当前单用户可先空实现。
- **每个数据区域必须实现四态**：`loading` / `ready` / `empty` / `error`，错误提示就近展示、不弹全局 alert（沿用 `frontend-design.md` §13）。
- **长任务实时性**：InVEST 任务沿用**轮询** `GET /api/jobs/{id}` + `/logs`（现状 1s）；Agent 流式输出用 **SSE**（见 §3.4）。后续可统一升级 WebSocket。
- **错误响应约定（建议）**：`{ "error": { "code": string, "message": string, "details"?: object } }`，HTTP 状态码语义化（404/400/409/422/500）。

### 1.3 全局共享数据实体

| 实体 | 状态 | 说明 |
|---|---|---|
| `Asset` / `AssetMetadata` | 现有 | 见 `stores/useStores.tsx`，复用 |
| `Layer` | 现有（前端态） | 地图图层，客户端派生 |
| `Job` / `JobOutput` | 现有 | 复用 |
| `Model`(InVEST) / `ModelInputSpec` | 现有 | 复用 schema |
| `Scene` | **新增** | 工作台外层场景；工作台内数据按 `sceneId` 隔离 |
| `Project` / `Folder` | **新增** | 数据管理与持久化（SQLite）依赖 |
| `LlmProvider` | **新增** | 设置页配置，工作台模型选择器读取 |
| `User` | **新增** | 设置页用户信息 |
| `Skill` / `SkillFileNode` | **新增** | Skills 页 |
| `ChatSession` / `ChatMessage` / `Attachment` | **新增** | 工作台 Agent（5a 纯聊天） |

---

## 2. 公共框架：顶部导航 + AppShell

**前端要求**
- `AppShell` = TopNav（GSMS / 工作台 / 数据管理 / Skills / 设置 / 用户入口）+ 当前路由 body。选中态由当前路由决定。
- 路由：`/workbench`、`/data`、`/skills`、`/settings`；`StoresProvider`/全局 store 提升到 `_app.tsx`（跨页共享当前项目、已配置模型、运行中任务）。

**对接后端**
- TopNav 用户入口：`GET /api/user`【新增】返回当前用户名/头像占位。
- 全局"当前项目"上下文：`GET /api/projects`【新增】+ 选中项目 id 写入全局 store（数据管理、工作台资源都按 project 维度取数）。
- 健康检查/连接态：`GET /health`【现有】用于全局"后端在线/离线"指示，避免冷启动多发 500。

---

## 3. 工作台模块（两层：场景列表 → 场景工作台）

工作台改为两层（与 Skills 的"列表→详情"一致）：
- 第一层 **场景列表页** `/workbench`：管理场景基本信息。
- 第二层 **场景工作台页** `/workbench/{sceneId}`：在具体场景内做 Agent 对话、地图、InVEST 运行。

### 3.0 场景层 `/workbench`（列表）

- **数据**：`Scene { id, name, description, studyArea, note, updatedAt }`。
- **端点【新增】**：
  - `GET /api/scenes`（可带 `?q=` 搜索，仅名/描述）— 场景列表。
  - `POST /api/scenes` — 新建：`{ name, description, studyArea, note }`。
  - `GET /api/scenes/{id}` — 场景基本信息（含面包屑标题）。
  - `PUT /api/scenes/{id}` — 编辑基本信息（仅四字段，不动场景内数据/日志/结果）。
  - `DELETE /api/scenes/{id}` — 删除（前端二次确认；是否连带删输出文件留作后端策略）。
- **要求**：列表条目显示 名称/一句话描述/研究区名称/更新时间 + 进入/编辑/删除；空/错误态。列表页**不**取地图、日志、运行状态。

### 3.0.1 场景作用域（关键约定）

进入 `/workbench/{sceneId}` 后，**工作台内所有数据按 `sceneId` 隔离**，场景间互不串：
- 资产/文件、Job、Chat 会话、图层、输出都归属某个 `sceneId`。
- 现有 `GET /api/assets`、`/api/jobs`、`/api/chat/*` 等需补 `sceneId` 维度（查询参数或 `/api/scenes/{id}/...` 子路径，二选一，后端统一）。
- **前端已实现的透传约定（前端先行，后端按此实现隔离即可生效）**：scene-scoped 的**读**接口用查询参数 `?scene_id=<id>`（`GET /api/assets`、资产 `preview.png` / `geojson`）；**写**接口（`POST /api/jobs`、`check-inputs`）在 body 里带 `scene_id` 字段。模型 registry 与按 job_id 的状态/日志为全局，不带 scene_id。当前后端忽略该参数 → 前向兼容、暂为 no-op。
- 面包屑 `工作台 / {场景名}` 取自 `GET /api/scenes/{id}`。

> 下文 §3.1–§3.6 均发生在**某个场景上下文内**（请求需携带当前 `sceneId`）。

### 3.1 左栏·图层 Tab
- **数据**：`Layer[]`（客户端态，来自"添加到地图"的资产/输出）。复用现有 `useLayersStore`。
- **操作→后端**：raster 取 `GET /api/assets/{assetId}/preview.png`【现有】或输出 `GET /api/jobs/{jobId}/outputs/{filename}/preview.png`【现有】；vector 取 `.../geojson`【现有】。显隐/透明度/排序/缩放为纯前端态。
- **要求**：支持显隐、透明度、**图层顺序调整**（新设计 §7，现实现未做，需补 reorder）、zoom to layer。

### 3.2 左栏·文件 Tab（数据管理轻量入口）
- **数据**：当前项目文件列表（精简：名/类型/大小）。
- **端点**：`GET /api/assets`【现有】先复用；持久化落地后切到按项目/目录维度的 `GET /api/files?projectId=&folderId=`【新增】（见 §4）。
- **要求**：不做完整元数据，仅"作为当前任务输入参考/加入地图/作为附件"。点击文件可"加入 Agent 附件"（§3.4）。

### 3.3 左栏·InVEST Tab + 手动运行弹窗
- **模型列表**：`GET /api/models`【现有】→ 渲染可手动调用的模型条目（Carbon/Habitat/Water Yield/SDR/NDR）。
- **手动运行**：点击模型 → 打开 `ModelConfigModal`（复用现 `right/RunTab` + `ModelForm` + `types`）：
  - 取 schema：`GET /api/models/{modelId}/schema`【现有】。
  - 资产下拉来自当前项目资产（按 `asset_type` 过滤）。
  - 运行前检查：`POST /api/models/{modelId}/check-inputs`【现有】。
  - 提交：`POST /api/jobs`（body 传 asset id、参数、`run_mode`）【现有】。
- **要求**：弹窗承载，不常驻；运行后关闭弹窗、右栏出状态+日志。

### 3.4 中央·Agent 视图（Phase 5a：纯聊天，**不接 InVEST 编排**）

> 当前阶段只做"能对话的前端壳"：消息流 + 输入卡片 + 附件 + 对话模型选择器。**不做** tool-use、不自动选模型/跑模型、不出确认卡片（那是 5b）。

- **会话数据**：`ChatSession { id, title, createdAt }`，`ChatMessage { id, role:'user'|'assistant', content, attachments?, createdAt }`。
- **端点【新增】**：
  - `GET /api/chat/sessions` / `POST /api/chat/sessions` — 列出/新建会话。
  - `GET /api/chat/sessions/{id}/messages` — 历史消息（纵向滚动、保持最新可见）。
  - `POST /api/chat/sessions/{id}/messages` — 发送：`{ content, providerId, attachmentIds[] }`；**响应以 SSE 流式返回** assistant 增量 token。
  - 该端点**仅代理到所选 LLM 供应商**（5a 不挂 InVEST 工具）；服务端用设置页凭据发起调用。
- **对话模型选择器**：读取 `GET /api/llm-providers`【新增，见 §6】（masked，不含明文 Key）；默认选中 `isDefault` 的 provider；**无已配置模型时**，禁用发送并提示"请先到设置页配置模型"。
- **附件**：来源=本地上传或当前项目文件。
  - 本地：`POST /api/chat/attachments`【新增】(multipart) → 返回 `attachmentId`。
  - 项目文件：直接引用 `assetId` 作为附件。
  - 附件标签展示在输入卡片内、文本区上方，可移除；不作为历史消息内容渲染。
- **状态**：发送中（流式追加、禁用重复发送）、流错误（就近提示、可重试）、空会话态。

### 3.5 中央·Map 视图 / Split 视图
- **Map**：复用 `MapCanvas`（MapLibre、图层增删、要素属性、坐标/缩放）。图层来自 §3.1。
- **Split**：Agent + Map 同屏；模型结果回流后，Agent 文字解释与地图结果并置。**视图切换为纯前端态**，无新增端点。

### 3.6 右栏·任务状态 + 日志（轻量）
- **数据**：当前/最近 InVEST 任务。复用 `right/ResultsTab` 演化。
- **端点【现有】**：`GET /api/jobs/{id}`（状态）、`/logs`（文本日志）、`/outputs`（输出）。轮询同现状。
- **状态机**：必须支持后端完整态 `pending / validating / running / succeeded / failed`（现前端类型只有 4 态，需补 `pending/validating`，否则中间态徽章无样式——见可行性评估与架构批判）。
- **要求**：只回答"当前是否有任务在跑"+日志；不做进度条/资源/多阶段步骤。成功后输出自动尝试回流地图（沿用 `c_storage_bas_*` 主栅格识别）。

---

## 4. 数据管理 `/data`

布局：左（目录树）｜中（文件列表）｜右（文件详情/元数据）。关系：目录→文件→元数据。

### 4.1 数据与端点

| 区域 | 数据 | 端点 |
|---|---|---|
| 目录树 | `Folder` 树（id/name/path/children） | `GET /api/projects`【新增】、`GET /api/projects/{id}/folders`【新增】 |
| 文件列表 | `FileItem { id, name, type, size }` | `GET /api/files?projectId=&folderId=`【新增】（type∈ 栅格/矢量/表格/文本/文件夹/其他）|
| 文件详情 | `FileMetadata`（含空间元数据） | `GET /api/assets/{assetId}/metadata`【现有，复用】 |
| 顶部操作 | 上传/新建文件夹/导入/搜索 | `POST /api/files/upload?folderId=`【新增，可由现 upload 扩展】、`POST /api/folders`【新增】、`POST /api/files/import`【新增】、`GET /api/files/search?q=`【新增】 |

### 4.2 类型（前端）
```ts
type Folder = { id: string; name: string; path: string; children?: Folder[] }
type FileItem = { id: string; name: string; type: 'raster'|'vector'|'table'|'text'|'folder'|'other'; size?: number }
type FileMetadata = AssetMetadata // 复用现有：format/crs/bounds/width/height/bands/columns/rows/features...
```

### 4.3 状态与要求
- 三栏级联：选目录→刷新文件列表→选文件→刷新详情。
- 四态齐全；空目录、无选中文件的空态。
- **边界**：不做地图/内容预览/属性表/分析（那些在工作台）。详情只读。
- **后端前置**：依赖 SQLite + project/folder 模型（已决策）。落地前可用现有扁平 `GET /api/assets` 退化为"单目录"展示。

---

## 5. Skills 管理 `/skills`

两层：列表页 → 详情页（面包屑 + 文件树 + 文件详情）。

### 5.1 数据与端点

| 区域 | 数据 | 端点【全部新增】 |
|---|---|---|
| Skills 列表 | `Skill { id, name, description, updatedAt }` | `GET /api/skills`、`GET /api/skills/search?q=`（仅名/描述）、`POST /api/skills/import` |
| 文件树 | `SkillFileNode { name, path, type:'file'|'dir', children? }` | `GET /api/skills/{id}/tree` |
| 文件详情 | `{ name, path, size, mime, updatedAt, content? }` | `GET /api/skills/{id}/file?path=`（返回内容 + mime；二进制不返回 content） |

### 5.2 内容渲染规则（由后端 `mime`/`type` 驱动）
- Markdown → Markdown 渲染（需引入 `react-markdown` 等）。
- 代码（py/js/…）→ 只读代码块（可选高亮）。
- JSON/TXT → 只读文本。
- 二进制/不可预览 → 仅展示基本信息 + "该文件暂不支持内容预览"。

### 5.3 状态与要求
- **默认选中规则**：进入详情默认 `SKILL.md` → 退化 `README.md` → 都无则右侧空态"请选择一个文件查看详情"。
- 面包屑 `Skills / {name}`，可点首段返回列表。
- **后端安全**：`path` 参数必须限制在该 skill 根目录内（防路径穿越）。
- **边界**：只读浏览，不测试/不装依赖/不编辑。

---

## 6. 设置 `/settings`

布局：左（设置菜单：用户信息 / 模型配置，默认选中"模型配置"）｜右（设置内容）。

### 6.1 用户信息
- **数据**：`User { id, username, email, organization, researchField }`。
- **端点【新增】**：`GET /api/user`、`PUT /api/user`。
- 保存后轻量提示"设置已保存"/失败提示。

### 6.2 模型配置（本页重点，工作台依赖）
- **数据**：`LlmProvider { id, name, provider, baseUrl, modelId, isDefault, status:'connected'|'failed'|'untested', apiKeyMasked }`。
  供应商枚举：`OpenAI | Anthropic | DeepSeek | Qwen | Local | Custom`（目标全量）。
- **端点【新增】**：
  - `GET /api/llm-providers` — 列表，**绝不返回明文 Key**，只返回 `apiKeyMasked`（如 `****abcd`）。
  - `POST /api/llm-providers` / `PUT /api/llm-providers/{id}` — 新建/编辑，`apiKey` **只写不读**（未填则保留原值）。
  - `DELETE /api/llm-providers/{id}`。
  - `POST /api/llm-providers/{id}/test` — 服务端发起最小探测，返回 `{ status, message }`。
  - `POST /api/llm-providers/{id}/default` — 设默认。
- **表单字段**：名称 / 供应商 / API Key（password，遮罩）/ Base URL / 模型 ID / 是否默认。
- **状态**：列表项显示连接状态徽章（emerald/red/slate）；测试连接返回"连接成功"或"连接失败，请检查 API Key、Base URL 或模型 ID"。

### 6.3 安全要求（硬约束）
- API Key：**服务端存储 + 静态加密**；**不回传明文、不进日志、不进前端 bundle**；前端只见 `apiKeyMasked`。
- 测试连接一律由服务端发起，前端不直连第三方。
- 工作台 Agent 模型选择器读取 §6.2 的 `GET /api/llm-providers`（masked）；无默认模型则提示去设置页配置。

---

## 7. 新增后端契约汇总（交付后端团队的核心清单）

> `【现有】` 直接用；下表只列**需要后端新建/改造**的端点。请求/响应字段以建议为准，落地时细化。

| 端点 | 方法 | 页面 | 关键请求 | 关键响应 |
|---|---|---|---|---|
| `/api/scenes` | GET/POST | 工作台(场景列表) | `?q=` / `{name,description,studyArea,note}` | `Scene[]` / `Scene` |
| `/api/scenes/{id}` | GET/PUT/DELETE | 工作台 | 四字段(PUT) | `Scene` |
| （工作台内数据按 `sceneId` 隔离） | — | 工作台 | assets/jobs/chat 补 `sceneId` 维度 | — |
| `/api/user` | GET/PUT | 设置/导航 | user 字段 | `User` |
| `/api/projects` | GET | 数据/导航 | — | `Project[]` |
| `/api/projects/{id}/folders` | GET | 数据 | — | `Folder` 树 |
| `/api/files` | GET | 数据/工作台 | `projectId,folderId` | `FileItem[]` |
| `/api/files/upload` | POST | 数据 | multipart, `folderId` | 创建结果 |
| `/api/folders` | POST | 数据 | `parentId,name` | `Folder` |
| `/api/files/import` | POST | 数据 | 来源描述 | 导入结果 |
| `/api/files/search` | GET | 数据 | `q` | `FileItem[]` |
| `/api/skills` | GET | Skills | — | `Skill[]` |
| `/api/skills/import` | POST | Skills | 目录/压缩包 | `Skill` |
| `/api/skills/{id}/tree` | GET | Skills | — | `SkillFileNode` |
| `/api/skills/{id}/file` | GET | Skills | `path` | 内容+mime（二进制无 content）|
| `/api/llm-providers` | GET/POST | 设置/工作台 | provider 字段（Key 只写）| 列表（masked）|
| `/api/llm-providers/{id}` | PUT/DELETE | 设置 | — | — |
| `/api/llm-providers/{id}/test` | POST | 设置 | — | `{status,message}` |
| `/api/llm-providers/{id}/default` | POST | 设置 | — | — |
| `/api/chat/sessions` | GET/POST | 工作台 | — | `ChatSession[]`/`ChatSession` |
| `/api/chat/sessions/{id}/messages` | GET | 工作台 | — | `ChatMessage[]` |
| `/api/chat/sessions/{id}/messages` | POST | 工作台 | `content,providerId,attachmentIds` | **SSE** 流式 |
| `/api/chat/attachments` | POST | 工作台 | multipart | `attachmentId` |

**复用（无需改）**：`/api/models`、`/api/models/{id}/schema`、`/api/models/{id}/check-inputs`、`/api/assets`、`/api/assets/{id}/metadata`、`/api/assets/{id}/geojson`、`/api/assets/{id}/preview.png`、`/api/assets/upload(-many)`、`/api/jobs`(POST/GET)、`/api/jobs/{id}`、`/logs`、`/outputs`、`/outputs/{file}/download|geojson|preview.png`、`/health`。

---

## 8. 前端状态与数据流约定

- **按域拆 store**（Phase 0 使能改造）：`appStore`(当前项目/用户/连接态)、`assetsStore`、`layersStore`、`jobsStore`、`chatStore`、`providersStore`、`skillsStore`、`dataHubStore`。避免单一 God-Context 每秒全树重渲染（见架构批判）。
- **统一 `lib/apiClient`**：集中 base URL、鉴权头、snake↔camel 归一、错误归类、SSE 封装。组件内禁止裸 `fetch`。
- **刷新策略**：列表类用"动作后 refetch"；任务/聊天用流式/轮询增量；图层/视图为本地态。
- **四态组件约定**：每个数据区域统一 `loading/ready/empty/error` 渲染分支，错误就近、不阻塞其他面板。

---

*依据：四份 GSMS 页面设计 + 可行性评估（已决策版）+ 现仓库 `backend/app/main.py` 实际端点 + `frontend/src` 现有组件与约定。本文聚焦对接后端的契约层，视觉原型由其他工具产出，但须遵守 §1 设计规范。*
