# Frontend Design

本文档记录 InVEST WebGIS Workbench 当前前端设计。它描述的是一个桌面端 GIS 分析工作台，而不是移动端网站或普通表单系统。

## 1. 前端目标

前端的核心目标是让用户完成一条连续的 WebGIS + InVEST 模型工作流：

```text
导入/上传空间数据
-> 在左侧管理文件和图层
-> 在中间地图查看输入/输出
-> 在右侧选择模型、绑定参数、检查输入、运行任务
-> 查看日志和输出
-> 将输出结果回流到地图
```

当前前端不是营销页，不做登录注册，不做移动端适配。第一版只服务桌面浏览器中的研究型原型演示和后续模型能力扩展。

## 2. 技术栈

当前实现：

- Next.js Pages Router
- React 18
- TypeScript
- Tailwind CSS
- MapLibre GL JS
- lucide-react icons
- 自定义 shadcn 风格基础组件：`Button`、`Input`
- React Context + hooks 作为轻量状态层

暂不引入：

- Redux
- 大型组件库
- 用户系统
- 移动端响应式布局
- 完整地图制图系统

## 3. 页面信息架构

Workbench 使用固定三栏桌面布局：

```text
┌──────────────────────────────────────────────────────────────┐
│ Top Bar                                                      │
├───────────────┬────────────────────────────┬─────────────────┤
│ Left Panel    │ Map Canvas                 │ Right Panel     │
│ Files/Layers  │ MapLibre view              │ Model/Jobs/Logs │
└───────────────┴────────────────────────────┴─────────────────┘
```

当前尺寸：

- 左栏：`320px`
- 中间地图：`minmax(460px, 1fr)`
- 右栏：`400px`
- 页面最小宽度：`1180px`
- 高度：`100vh`

设计原则：

- 不适配手机端。
- 窄屏时允许横向滚动，而不是重排为移动布局。
- GIS 工作台优先保持三栏并列，因为文件、地图、模型日志需要同时可见。

## 4. Top Bar 设计

Top Bar 用于提供全局上下文和轻量操作。

当前元素：

- 产品标识：`InVEST WebGIS Workbench`
- 项目状态：`Default project`
- 资产数量
- 图层数量
- 当前任务状态
- `Sample data` 快捷按钮
- `Settings` 占位按钮

设计意图：

- Top Bar 不承载复杂导航。
- 只展示全局状态和高频入口。
- 避免将 Workbench 做成项目管理系统。

## 5. Left Panel 设计

左侧是数据和地图图层管理区，分为两个 tab：

```text
[Files] [Layers]
```

### 5.1 Files Tab

Files Tab 展示当前可用的数据资产和任务输出。

当前分组：

- `Project inputs`
- `Selected job outputs`

`Project inputs` 包含：

- 后端资产列表
- 上传资产
- fallback 示例资产
- 文件类型标签
- 文件大小
- metadata 展开面板
- 添加到地图
- 删除资产

支持上传：

- 多文件上传
- `.tif`
- `.tiff`
- `.geojson`
- `.json`
- `.zip`
- `.csv`
- `.html`
- `.txt`

资产卡片操作：

- `Info`：加载并展示 metadata
- `Plus`：添加到地图
- `Trash`：删除资产

metadata 展示字段：

- Format
- CRS
- Bounds
- Bounds WGS84
- Raster size
- Bands
- Columns
- Rows
- Features
- Preview
- Metadata error

### 5.2 Selected Job Outputs

任务输出作为文件流的一部分出现，而不是单独隐藏在右侧。

当前支持：

- 查看当前选中 job 的输出文件
- 输出文件添加到地图
- 输出文件下载

设计意图：

- 输入和输出都属于 Workbench 数据资产。
- 模型结果必须能回到地图，而不是只停留在日志或下载链接中。

### 5.3 Layers Tab

Layers Tab 管理地图中的可视图层。

每个图层支持：

- 显示/隐藏
- zoom to layer
- remove from map
- opacity slider

当前图层类型：

- Raster preview
- GeoJSON preview

设计意图：

- 文件资产和地图图层分离。
- 一个资产可以被添加为地图图层；后续也可以支持同一资产的多种样式图层。

## 6. Map Canvas 设计

中间地图是 Workbench 的主要空间语境。

当前实现：

- MapLibre GL JS
- 离线背景色 style，不依赖外部底图服务
- NavigationControl
- ScaleControl
- 鼠标坐标显示
- zoom 显示
- 当前显示图层数量
- fit workspace
- zoom to layer
- GeoJSON 点击属性查看
- Raster preview 叠加

### 6.1 Raster 显示策略

当前 raster 使用后端生成的 preview PNG，通过 MapLibre `image` source 按 bounds 叠加：

```text
GeoTIFF asset
-> backend preview.png
-> frontend image source
-> MapLibre raster layer
```

这是 MVP 策略，不是最终 tile 服务。

优点：

- 实现简单
- 适合小数据和 demo
- 可以快速完成“输出回流地图”

限制：

- 不支持大栅格切片
- 不支持按 zoom 动态加载
- 不支持像元查询
- 不支持色带配置

下一阶段应升级为：

```text
GeoTIFF / COG
-> tile endpoint
-> MapLibre raster tile source
```

### 6.2 Vector 显示策略

当前 GeoJSON 使用 MapLibre `geojson` source：

- fill layer
- line layer
- 点击后显示属性面板
- hover 时显示 pointer

Shapefile zip 当前在前端上被归类为可地图资产，但完整解析能力依赖后端进一步实现。

### 6.3 地图叠加 UI

地图上的浮层包括：

- 左上：地图标题和活动图层数
- 右上：fit workspace 按钮
- 右侧：选中矢量要素属性卡片
- 底部：鼠标坐标、显示图层数、zoom

设计原则：

- 地图浮层保持小尺寸。
- 不使用大型卡片遮挡地图。
- 操作按钮以 icon 为主，符合 GIS 工具习惯。

## 7. Right Panel 设计

右侧是模型运行、输入检查、任务历史、输出和日志区域。

当前区块顺序：

```text
Model run
Input binding / Parameters
Job status
Recent jobs
Outputs
Logs
```

### 7.1 Model Selector

模型列表来自后端：

```http
GET /api/models
GET /api/models/{model_id}/schema
```

当前模型状态：

- Carbon：可运行
- Habitat Quality：schema/input check 阶段
- Annual Water Yield：planned
- Sediment Delivery Ratio：planned

设计原则：

- 模型参数表单由 schema 驱动。
- 前端不为每个模型硬编码完整表单。
- 前端可以对少量模型做必要交互约束，但模型主体配置应来自后端 registry。

### 7.2 Schema-driven Form

模型输入字段结构：

```ts
type ModelInputSpec = {
  id: string
  invest_arg?: string
  label: string
  help?: string
  kind?: "asset" | "boolean" | "number" | "string"
  asset_type?: AssetType
  group?: string
  required?: boolean
  required_if?: string
  allowed_if?: string
  default?: string | number | boolean
  placeholder?: string | number
  hidden?: boolean
}
```

前端根据字段类型渲染：

- asset -> asset select
- boolean -> checkbox
- number -> number input
- string -> text input

字段支持：

- 分组
- 必填
- 条件必填
- 条件显示
- 默认值
- help text

### 7.3 Asset Binding

模型输入不是上传表单，而是从左侧资产池中选择。

例如 Carbon：

```text
Baseline LULC Raster -> raster asset
Carbon Pools Table   -> table asset
Alternate LULC       -> raster asset
```

设计意图：

- 用户先管理数据资产，再把资产绑定给模型。
- 这使系统更像 WebGIS Workbench，而不是一次性模型表单。

### 7.4 Input Check

右侧提供 `Check inputs`，调用后端：

```http
POST /api/models/{model_id}/check-inputs
```

结果展示：

- Errors
- Warnings
- Info

设计原则：

- 运行前检查应成为主流程的一部分。
- 错误和警告需要比日志更早暴露。
- 后续 agent/skills 可以接管此检查结果并给出修复建议。

### 7.5 Runner Mode

当前支持：

- `auto`：可用时跑真实 InVEST，否则走开发 stub
- `real`：要求真实 `natcap.invest`

设计意图：

- demo 和开发时保持可运行。
- 真实验收时可以强制使用 InVEST 包。

### 7.6 Job Status

任务状态展示：

- idle
- running
- succeeded
- failed

状态来自轮询：

```http
GET /api/jobs/{job_id}
GET /api/jobs/{job_id}/logs
GET /api/jobs/{job_id}/outputs
```

当前轮询周期：`1000ms`

后续可升级为 WebSocket。

### 7.7 Recent Jobs

Recent jobs 用于恢复已完成或失败的任务上下文。

当前能力：

- 列出最近任务
- 点击任务加载状态、日志和输出
- 高亮当前任务

设计意图：

- 用户不应只看到当前内存任务。
- 刷新页面后仍能从后端恢复任务历史。

### 7.8 Outputs

Outputs 展示当前任务输出。

每个输出支持：

- 添加到地图
- 下载
- 显示大小和类型

成功任务会自动尝试把 primary raster 加到地图。

Carbon 当前 primary raster 优先匹配：

```text
c_storage_bas_*.tif
```

### 7.9 Logs

日志区使用固定高度 terminal 风格。

当前能力：

- 自动滚动到底部
- copy logs
- 失败时红色 terminal 样式

设计原则：

- 日志是模型运行可信度的重要来源。
- 但日志不应该取代结构化状态、输出和输入检查。

## 8. 状态管理设计

当前使用单个 `StoresProvider` 管理核心状态，并通过三个 hook 暴露：

```ts
useAssetsStore()
useLayersStore()
useJobsStore()
```

### 8.1 Assets State

管理：

- assets
- assetsStatus
- assetsError
- assetMetadata
- metadataStatus
- metadataError

动作：

- loadAssets
- uploadAsset
- uploadAssets
- loadAssetMetadata
- deleteAsset
- useSampleData

### 8.2 Layers State

管理：

- layers
- zoomRequest

动作：

- addLayer
- addOutputLayer
- updateLayer
- removeLayer
- zoomToLayer

### 8.3 Jobs State

管理：

- activeJobId
- activeJobStatus
- logs
- outputs
- jobHistory

动作：

- runModelJob
- loadJobHistory
- selectJob
- loadJobOutputs

### 8.4 当前状态管理取舍

优点：

- 少依赖
- 易读
- 适合 MVP
- 不需要 Redux/Zustand 额外配置

限制：

- `useStores.tsx` 已经较大
- 部分 API base URL 逻辑在组件内重复
- 模型表单逻辑和右侧 UI 耦合较多

后续重构方向：

- 拆出 `apiClient`
- 拆出 `modelFormStore`
- 拆出 `jobPolling` hook
- 将 schema form renderer 独立成组件目录

## 9. API 连接设计

前端 API base URL 当前规则：

```ts
process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
```

Docker 生产构建中：

```text
NEXT_PUBLIC_API_URL=""
```

因此浏览器请求使用相对路径：

```text
/api/assets
/api/models
/api/jobs
```

Next.js rewrite 将 `/api/*` 转发到后端容器：

```text
frontend /api/*
-> backend:8000/api/*
```

设计原因：

- 浏览器不直接依赖 Docker 内部服务名。
- 服务器只暴露前端 3000 端口也可以工作。
- 本地开发仍可设置 `NEXT_PUBLIC_API_URL=http://127.0.0.1:8000`。

## 10. 视觉设计规范

当前视觉方向是 shadcn 风格的轻量工具 UI。

### 10.1 色彩

主色：

- slate 作为主 UI 色
- white 作为面板背景
- teal/emerald 表示地图和成功结果
- amber 表示运行中或警告
- red 表示失败或错误
- sky 表示提示信息

原则：

- 不使用大面积渐变。
- 不使用装饰性背景。
- 不做营销页视觉。
- 保持 GIS 工具的冷静、可扫描、低干扰。

### 10.2 间距和圆角

当前风格：

- 面板 padding：`p-3` / `p-4`
- 卡片圆角：`rounded-md`
- 细边框：`border-slate-200`
- 阴影只用于小卡片和地图浮层

原则：

- 不使用大圆角卡片。
- 不做卡片套卡片的大面积堆叠。
- 工具表单和文件项保持紧凑。

### 10.3 Typography

字体：

```css
Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif
```

字号：

- 页面标题：`text-sm`
- 面板标题：`text-sm`
- 描述：`text-xs`
- metadata/log 辅助信息：`text-xs` / `text-[11px]`

原则：

- 工作台内部不使用 hero 大字。
- 信息密度优先，但避免拥挤。

### 10.4 Icon Usage

使用 `lucide-react`。

当前图标角色：

- `Map`：产品标识
- `Upload`：上传
- `RefreshCw`：刷新
- `Plus`：添加到地图
- `Trash2`：删除
- `Info`：metadata
- `Eye/EyeOff`：显示/隐藏图层
- `LocateFixed`：定位/缩放到图层
- `Play`：运行模型
- `Loader2`：运行中
- `Download`：下载
- `Clipboard`：复制日志
- `TriangleAlert`：错误/警告
- `CheckCircle2`：成功

原则：

- 工具按钮优先使用 icon。
- 不使用手写 SVG。
- 不熟悉的 icon 通过 `aria-label` 或 title 表达含义。

## 11. 组件设计

当前组件：

```text
frontend/src/components
├── Layout.tsx
├── LeftPanel.tsx
├── MapCanvas.tsx
├── RightPanel.tsx
└── ui
    ├── Button.tsx
    ├── Input.tsx
    └── index.ts
```

### 11.1 Layout

职责：

- 三栏布局
- Top Bar
- 全局状态摘要
- 组合 LeftPanel / MapCanvas / RightPanel

不应承担：

- 业务表单逻辑
- 地图渲染逻辑
- API 请求细节

### 11.2 LeftPanel

职责：

- Files / Layers tab
- 上传资产
- 刷新资产
- 展开 metadata
- 删除资产
- 资产添加到地图
- 输出文件添加到地图或下载
- 图层可见性、透明度、缩放、删除

后续拆分建议：

- `FilesTab`
- `LayersTab`
- `AssetCard`
- `OutputCard`
- `MetadataDetails`

### 11.3 MapCanvas

职责：

- MapLibre 初始化
- source/layer 生命周期
- raster preview 叠加
- GeoJSON 显示和点击属性
- 坐标/zoom/scale/fit workspace

后续拆分建议：

- `useMapLibre`
- `useLayerRenderer`
- `FeaturePropertiesPanel`
- `MapStatusBar`

### 11.4 RightPanel

职责：

- 加载模型 registry/schema
- 渲染 schema-driven form
- 输入自动绑定
- input check
- run job
- 展示 job status/history/outputs/logs

后续拆分建议：

- `ModelSelector`
- `ModelFormRenderer`
- `InputCheckPanel`
- `JobStatusPanel`
- `JobHistory`
- `OutputList`
- `LogConsole`

### 11.5 UI Components

当前基础组件：

- `Button`
- `Input`

Button variant：

- default
- secondary
- ghost
- outline
- destructive

Button size：

- sm
- md
- icon

后续可扩展：

- Select
- Tabs
- Dialog
- Tooltip
- Badge
- Slider
- Checkbox
- ScrollArea

## 12. 当前用户路径

### 12.1 上传并查看数据

```text
打开 /workbench
-> 左侧 Files
-> 上传一个或多个文件
-> 文件出现在 Project inputs
-> 点击 Info 查看 metadata
-> 点击 Plus 添加到地图
-> 在 Layers 调整显示和透明度
```

### 12.2 运行 Carbon

```text
打开 /workbench
-> 右侧选择 Carbon
-> 导入 sample data 或上传自己的 raster/csv
-> 绑定 Baseline LULC 和 Carbon Pools
-> Check inputs
-> Run Carbon
-> 查看 logs
-> 输出出现在 Outputs 和左侧 Selected job outputs
-> raster 输出自动或手动添加到地图
```

### 12.3 恢复历史任务

```text
打开 /workbench
-> 右侧 Recent jobs
-> 点击历史任务
-> 恢复状态、日志和输出
-> 将输出重新添加到地图
```

## 13. 错误和空状态设计

当前错误处理：

- assets 加载失败：显示 fallback sample rows，并在左侧展示提示
- 上传失败：左侧 amber 提示
- metadata 失败：metadata 区域展示错误
- schema 加载失败：右侧模型描述区域展示错误
- input check 失败：右侧 red/amber/emerald 状态卡
- job 创建失败：右侧 form error
- job 运行失败：job status 显示 failed，日志终端变红

当前空状态：

- 无 project inputs
- 无 selected job outputs
- 无 map layers
- 无 job history
- 无 outputs
- 无 model parameters

设计原则：

- 错误提示靠近触发区域。
- 工作台不弹全局 alert。
- 错误不阻塞其他面板继续查看。

## 14. 桌面端约束

明确不做手机端适配。

要求：

- 页面最小宽度保持三栏可用。
- 桌面浏览器优先，建议宽度 `>= 1280px`。
- 小屏幕可以横向滚动。
- 不做移动抽屉、底部导航、单栏重排。

原因：

- GIS 地图、图层、日志、参数表单需要并列协作。
- 手机端无法有效承载 InVEST 工作台操作。

## 15. 后续前端开发路线

### Phase A：稳定当前 Workbench

- 统一 API base URL 获取逻辑
- 把 RightPanel 中的 API 调用迁移到 store/apiClient
- 增加模型 registry/schema 加载状态
- 增加全局 backend connection 状态
- 避免 backend 刚启动时前端直接显示多个错误

验收标准：

- Docker 启动后 `/workbench` 无初始 API 500 噪声
- 后端未就绪时显示明确连接状态
- 刷新页面可恢复 job history

### Phase B：组件拆分

- 拆分 LeftPanel
- 拆分 RightPanel
- 抽出 schema form renderer
- 抽出 LogConsole
- 抽出 OutputList

验收标准：

- 单个组件文件不再承担多个业务区块
- schema-driven form 可以被多个模型复用
- 新增模型时不需要修改 RightPanel 主体结构

### Phase C：地图能力升级

- raster preview 升级为 tile source
- 增加图层样式面板
- 增加 raster color ramp
- 增加 raster min/max
- 增加 vector fill/stroke style
- 增加 raster/vector query

验收标准：

- 大 GeoTIFF 不通过单张 PNG 预览加载
- 用户可以调整输出 raster 色带和透明度
- 点击地图可以查询 raster 值或 vector 属性

### Phase D：模型扩展

- Habitat Quality 完成真实 runner UI
- Annual Water Yield schema UI
- SDR schema UI
- 每个模型支持 input check
- 每个模型输出能自动识别 primary map layer

验收标准：

- 模型列表中至少两个模型可完成真实或准备态运行
- schema-driven form 不需要为每个模型复制 UI
- 输出回流地图机制模型无关

### Phase E：Agent/Skills UI 预留

后续 agent 不替代 Workbench，而是作为辅助层：

```text
用户自然语言目标
-> 推荐模型
-> 检查已有资产
-> 自动绑定参数
-> 解释 input check
-> 生成运行配置
-> 用户确认后运行
```

建议 UI 位置：

- 右侧 Model run 顶部增加 assistant strip
- 或 Top Bar 下方增加 command bar

验收标准：

- agent 只辅助模型选择和参数绑定
- 用户仍能看到和修改所有显式参数
- agent 生成的操作必须可审计

## 16. 前端设计红线

以下事项当前不做：

- 手机端适配
- 登录注册
- 多租户权限
- 复杂项目管理
- 营销页
- 3D 地球
- 在线矢量编辑
- 完整制图系统
- 一次性支持所有 InVEST 模型真实运行

以下事项必须保持：

- 三栏 Workbench 形态
- 文件资产和地图图层分离
- 模型输入从资产池绑定
- 任务日志实时可见
- 模型输出回流地图
- 桌面端高信息密度
- API 错误可见且可定位

