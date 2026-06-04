# Agent 开发准则：InVEST WebGIS Workbench

## 1. 文档目的

本文档用于约束后续参与本项目开发的 agent 或开发者，确保前端、后端、WebGIS 和 InVEST 模型接入工作沿着同一套工程标准推进。

本项目不是普通表单系统，而是一个轻量级 WebGIS 分析工作台。任何开发任务都应服务于以下主线：

```text
管理地理数据资产
-> 在地图中查看输入与输出
-> 在右侧面板绑定 InVEST 模型参数
-> 后端真实执行模型
-> 日志与输出回流到 workbench
```

## 2. 总体开发原则

### 2.1 优先保持 MVP 闭环

开发时优先保证最小可用链路稳定：

```text
Upload / Sample data
-> Asset metadata
-> Add to map
-> Run Carbon
-> Poll logs
-> Show outputs
-> Add output to map / Download output
```

任何新功能如果会破坏这条链路，应先修复链路，再继续扩展。

### 2.2 小步提交，避免大范围重写

- 优先做局部增量修改。
- 不做无关重构。
- 不随意替换技术栈。
- 不为了视觉效果牺牲模型运行、数据资产和地图交互的清晰性。

### 2.3 数据流必须清晰

前端和后端都要区分以下对象：

- `FileAsset`：文件资产，来自上传、样例数据或模型输出。
- `MapLayer`：地图图层，是资产在地图上的一次展示配置。
- `ModelJob`：模型运行任务。
- `JobOutput`：任务输出文件。

不要把文件、图层、任务输出混成同一个对象。

## 3. 前端开发准则

### 3.1 页面定位

前端主页面必须保持三栏 workbench 形态：

```text
Left Panel: Files / Layers
Center: Map Canvas
Right Panel: Model / Job / Logs / Outputs
```

不应把页面改成营销页、普通 dashboard 或单列表管理页。

### 3.2 UI 风格

- 采用 shadcn 风格：克制、清晰、工具型、信息密度适中。
- 优先使用已有 `Button`、`Input` 等本地 UI 组件。
- 扩展组件时保持同一套 Tailwind 风格。
- 图标优先使用 `lucide-react`。
- 工具按钮必须有明确的 `aria-label`。
- 长文件名、长 job id、长日志行不能撑破布局。
- 不使用大面积装饰性渐变、营销式 hero、过度卡片化布局。

### 3.3 地图交互

MapLibre 是地图核心，开发时注意：

- 地图容器必须有稳定高度，避免 canvas 退化为默认 300px。
- 添加图层必须由 store 驱动，不能在组件中散落临时状态。
- 图层 ID 必须稳定且唯一，尤其是 job output 图层需要包含 `job_id`。
- 删除图层时必须同步清理 MapLibre layer 和 source。
- GeoJSON 图层至少支持：
  - 显示 / 隐藏。
  - opacity。
  - zoom to layer。
  - 点击查看属性。
- Raster 图层后续必须走后端 tile / preview endpoint，不允许前端直接读取大 GeoTIFF 整文件。

### 3.4 状态管理

当前前端 store 位于：

```text
frontend/src/stores/useStores.tsx
```

开发准则：

- 资产、图层、任务、输出等跨组件状态放入 store。
- 组件内部只保留局部 UI 状态，例如 tab、展开项、表单输入。
- 不在多个组件中重复发起同一类 API 请求。
- API 返回值必须经过 normalize，再进入 UI 状态。

### 3.5 API 调用

- 默认 API 地址使用 `NEXT_PUBLIC_API_URL`，缺省为 `http://localhost:8000`。
- 请求失败时必须给用户可见反馈。
- 不要让页面因为后端不可用而空白崩溃。
- 对轮询类请求要有清理逻辑，组件卸载后不得继续更新状态。

### 3.6 响应式要求

本项目当前不适配手机端。Workbench 是桌面 GIS 分析工作台，优先保证桌面和笔记本视口下的三栏效率，不为手机窄屏重排牺牲地图、文件列表和模型日志的密度。

必须至少考虑：

- Desktop：1440x900。
- Laptop：1366x768。

验收时重点检查：

- 三栏在桌面不互相挤压。
- 地图、日志、文件列表都有可用高度。
- 文本不重叠、不溢出、不遮挡按钮。
- 低于 1200px 宽度的窄屏可给出横向滚动或最小宽度约束，不要求手机布局。

## 4. 后端开发准则

### 4.1 后端定位

后端是模型运行和地理数据处理层，不只是文件上传服务。

职责包括：

- 资产保存。
- metadata 识别。
- GeoJSON / raster preview 服务。
- job 创建与状态管理。
- InVEST 模型执行。
- 日志读取。
- 输出扫描、注册与下载。

### 4.2 API 设计原则

API 应围绕资源对象设计：

```text
/api/assets
/api/layers
/api/models
/api/jobs
/api/tiles
```

当前重点接口：

```text
GET  /api/assets
POST /api/assets/upload
GET  /api/assets/{asset_id}/metadata
GET  /api/assets/{asset_id}/geojson
GET  /api/models
GET  /api/models/{model_id}/schema
POST /api/jobs
GET  /api/jobs/{job_id}
GET  /api/jobs/{job_id}/logs
GET  /api/jobs/{job_id}/outputs
GET  /api/jobs/{job_id}/outputs/{filename}/download
GET  /api/jobs/{job_id}/outputs/{filename}/geojson
```

新增接口时要符合以下要求：

- 返回 JSON 字段名保持 snake_case。
- 前端可在 store 中 normalize 为 camelCase。
- 错误使用明确 HTTP status 和 `detail`。
- 文件路径不得直接信任用户输入，必须用 `Path(...).name` 或等价方式限制路径穿越。

### 4.3 文件系统规则

默认数据根目录：

```text
backend/data/projects/default/
```

建议结构：

```text
assets/
jobs/{job_id}/
  job.json
  run.log
  outputs/
  outputs_index.json
```

开发注意事项：

- `backend/data/` 是本地运行数据，不应提交到 Git。
- job 输出必须按 job 分目录保存。
- 上传重名文件不得直接覆盖，应生成唯一文件名。
- 下载接口只能访问 job 输出目录内的文件。

### 4.4 Metadata 识别

资产 metadata 是 WebGIS 的基础能力。后端应尽量提供：

GeoTIFF：

- `crs`
- `bounds`
- `width`
- `height`
- `band_count`
- `nodata`
- `dtypes`

GeoJSON：

- `feature_count`
- `bounds`
- `crs`

CSV：

- `columns`
- `row_count`
- `sample_rows`

metadata 读取失败时，不应导致资产完全不可见，应返回可展示的基础信息和 `metadata_error`。

### 4.5 Job Runner

InVEST 模型不应直接阻塞 FastAPI 请求线程。

推荐流程：

```text
POST /api/jobs
-> 创建 job 目录
-> 写入 job.json
-> 写入 run.log 初始内容
-> 启动独立 runner 进程
-> 前端轮询 job status/logs
-> runner 写输出
-> 后端扫描 outputs
```

注意事项：

- `job.json` 必须是合法 JSON，不要写 Python `str(dict)`。
- runner 需要记录输入参数和执行阶段。
- runner 失败时必须写入包含 `ERROR` 的日志，便于 status 推断。
- 后续真实 InVEST 接入时，应捕获 stdout/stderr 或 Python logging 输出。

### 4.6 InVEST 接入

真实 Carbon 模型接入时，后端需要将 asset id 转换为真实文件路径：

```python
args = {
    "workspace_dir": workspace_dir,
    "lulc_bas_path": lulc_bas_path,
    "carbon_pools_path": carbon_pools_path,
    "calc_sequestration": calc_sequestration,
    "results_suffix": results_suffix,
    "n_workers": -1,
}
```

开发注意事项：

- 运行前必须校验输入文件存在。
- 必须校验输入类型与模型 schema 匹配。
- Carbon pools CSV 应检查必要列。
- `workspace_dir` 必须是 job 独立目录。
- 不要把 InVEST 输出写到上传资产目录。
- 模型执行失败必须保留 workspace 和日志，方便排查。

### 4.7 Conda / InVEST 运行环境

本项目真实运行 InVEST Carbon 时，应使用项目专用 conda 环境：

```powershell
conda activate gsms-invest
```

当前已验证环境位置：

```text
E:\Anaconda_envs\envs\gsms-invest
```

已验证核心包版本：

```text
natcap.invest 3.19.0
rasterio 1.4.3
fastapi 0.136.3
```

Carbon Python 入口已验证可用：

```text
natcap.invest.carbon.execute
natcap.invest.carbon.carbon.execute
```

启动后端时必须使用该环境，而不是系统 Python 或 base 环境：

```powershell
conda activate gsms-invest
cd E:\Github\GSMS\backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

注意事项：

- `natcap.invest 3.19.0` 通过 conda-forge 安装；不要优先用 pip 在 Windows 上手工拼 GDAL/rasterio 依赖。
- 创建环境时使用 `python=3.10` 更稳；本机验证过 `python=3.11 + fastapi==0.99.0 + natcap.invest=3.19.0` 会出现依赖冲突。
- 不要锁定 `fastapi==0.99.0` 给真实 InVEST 环境使用；该版本依赖 Pydantic v1，而 `natcap.invest 3.19.0` 的依赖链需要 Pydantic v2 相关包。当前验证可用的是 `fastapi 0.136.3`。
- 使用 `conda run -n gsms-invest ...` 时，不要并发启动多个 `conda run` 命令；Windows 下可能争用 `__conda_tmp_*.txt` 临时激活文件。验证脚本优先使用环境内 `python.exe` 绝对路径，或先 `conda activate gsms-invest` 再运行命令。
- 如果直接调用 `E:\Anaconda_envs\envs\gsms-invest\python.exe` 出现 GDAL/PROJ 环境变量告警，优先改用 `conda activate gsms-invest` 后启动服务，确保 GDAL 环境变量由 conda 正确注入。
- `backend/requirements.txt` 当前不应被视为真实 InVEST conda 环境的完整锁文件；真实模型运行以 conda 环境为准。

真实 Carbon 验证要求：

```text
POST /api/jobs with run_mode=real
-> run.log contains "running natcap.invest.carbon.execute"
-> run.log contains "InVEST Carbon execution completed"
-> outputs include real Carbon rasters such as c_storage_bas_*.tif
-> output preview endpoint returns 200 image/png
```

已在本机用 Willamette sample data 验证真实运行成功，生成过以下输出：

```text
c_above_bas_conda_real.tif
c_below_bas_conda_real.tif
c_dead_bas_conda_real.tif
c_soil_bas_conda_real.tif
c_storage_bas_conda_real.tif
```

## 5. WebGIS 特殊注意事项

### 5.1 Raster 不等于普通图片

GeoTIFF 通常不能直接交给浏览器显示。应遵循：

```text
GeoTIFF
-> 后端读取 metadata
-> 后端生成 tile / preview
-> 前端 MapLibre 加 raster source
```

禁止在前端直接 `fetch` 大 GeoTIFF 并尝试解析。

### 5.2 坐标系与 bounds

- 地图显示默认以 EPSG:4326 / Web Mercator 兼容为目标。
- 后端 metadata 返回的 bounds 必须明确含义。
- 如果数据 CRS 不是 EPSG:4326，后续应在后端转换 bounds 后再给前端使用。
- `zoom to layer` 依赖 bounds，bounds 不可信时应禁用按钮或给出提示。

### 5.3 Shapefile

- Shapefile 必须要求 zip 上传。
- 后端应检查 zip 中是否包含 `.shp`、`.shx`、`.dbf`、`.prj`。
- 第一阶段可提示“metadata extraction not enabled”，但不能假装已经完整支持。

### 5.4 输出回流

模型输出是 workbench 的核心，不是普通下载附件。

job 成功后应执行：

```text
scan workspace
-> identify outputs
-> register output metadata
-> expose download URL
-> expose map preview URL when possible
-> update right Outputs
-> optionally add primary output to map
```

## 6. 文档与编码规范

- 新文档统一放在 `docs/`。
- Markdown 文件使用 UTF-8。
- 标题清晰，避免只写临时笔记。
- 若 PowerShell 控制台显示中文乱码，优先确认文件实际编码，不要随意改成非 UTF-8。
- README 和阶段计划应与实际功能同步，避免文档承诺超过系统能力。

### 6.1 Windows PowerShell 中文读取规则

本项目源码和文档使用 UTF-8。当前 Windows 本地环境已确认：

```text
PowerShell: 5.1
Active code page: 936
Console InputEncoding: gb2312
Console OutputEncoding: utf-8
```

在该环境下，`Get-Content`、`Select-String` 等命令如果不显式指定编码，可能把 UTF-8 文件按系统 ANSI/GBK 解读，导致终端输出出现 `鏁版嵁`、`宸ヤ綔鍙` 这类 mojibake。此时通常不是文件损坏，而是读取方式错误。

读取含中文文件时必须使用以下方式之一：

```powershell
Get-Content -Encoding UTF8 -Path docs/agent-development-guidelines.md
Get-Content -Encoding UTF8 -LiteralPath 'frontend/pages/workbench/[sceneId].tsx'
[System.IO.File]::ReadAllText((Resolve-Path -LiteralPath 'frontend/pages/workbench/[sceneId].tsx'), [System.Text.Encoding]::UTF8)
```

注意事项：

- `frontend/pages/workbench/[sceneId].tsx` 这类路径必须用 `-LiteralPath`，否则方括号会被 PowerShell 当作通配符。
- 不要从乱码终端输出中复制中文片段再写回源码；这会把显示层 mojibake 变成真实文件内容。
- 如果需要判断文件是否真的损坏，先用 UTF-8 显式读取并检查是否包含正常中文，而不是依赖默认 `Get-Content` 输出。

## 7. 验证准则

### 7.1 后端验证

至少运行：

```powershell
cd backend
python -m py_compile app\main.py run_job.py invest_models\carbon.py
```

关键接口验证：

```text
GET /health
GET /api/assets
GET /api/models/carbon/schema
POST /api/jobs
GET /api/jobs/{job_id}/logs
GET /api/jobs/{job_id}/outputs
```

### 7.2 前端验证

至少运行：

```powershell
cd frontend
npx tsc --noEmit
npm run build
```

#### Next.js on Windows 构建 / dev server 卡住处理

本项目多次遇到 Next.js 在 Windows 上卡在 `Creating an optimized production build ...`、`next-router-worker` 或启动后端口无响应的情况。根据当前追溯，`.next` 缓存和 `.next/trace` 锁文件是高频诱因，但不是唯一原因；即使执行过清理，Next 13.5.6 在 Windows 上仍可能停在 worker 启动阶段。

处理顺序必须固定：

1. 先确认并停止已有 Next / npm / node 进程，尤其是占用 `3000-3010` 端口的进程。
2. 再运行：

```powershell
cd frontend
npm run clean
```

该脚本会清理：

```text
.next/
.next-build/
node_modules/.cache/
.turbo/
```

3. 清理后再运行：

```powershell
npx tsc --noEmit
npm run dev -- --port <free-port>
```

4. 如果 `npm run build` 或 `next dev` 仍长时间无输出，不要让构建进程留在后台；应停止相关进程，记录为 Windows Next dev/build hang，并用 `npx tsc --noEmit`、后端 API smoke test、浏览器可访问性检查作为本轮替代验证。

注意事项：

- 不要随意重新引入 `distDir: ".next-build"` 或在 `next.config.js` 中关闭 webpack cache。历史提交 `8755a37` 曾尝试用该方式稳定 Windows 构建，后续提交 `82d90ba` 已将其移除，因为它本身也可能引入 dev hang。
- `.next/`、`.next-build/`、`node_modules/.cache/` 和 `.turbo/` 永远不应提交到 Git。
- 如果 `.next/trace` 被锁，必须先杀掉持有该目录的 Next 进程，再清理缓存；不要直接反复启动新的 dev server。

### 7.3 浏览器验证

涉及 UI 或地图时，不能只依赖 build。必须验证至少一条用户路径：

```text
打开 /workbench
-> 点击 Sample data
-> 地图出现图层
-> 点击 Run Carbon
-> 等待 job succeeded
-> Outputs 出现 carbon_preview.geojson
-> Add output to map
-> 地图图层数量增加
```

检查内容：

- 页面不是空白。
- 没有 Next.js error overlay。
- console 无应用级 error。
- 地图 canvas 可见。
- 按钮点击后 UI 状态真实变化。

## 8. Git 与提交规范

- 提交前检查 `git status -sb`。
- 不提交：
  - `backend/data/`
  - `node_modules/`
  - `.next/`
  - `__pycache__/`
  - 日志文件。
- 不回滚不是自己造成的改动。
- 工作区混杂时，只暂存本任务相关文件。
- commit message 使用简短英文动词短语，例如：
  - `Add job output indexing`
  - `Implement raster metadata endpoint`
  - `Improve workbench layer controls`

## 9. 本项目当前特殊限制

截至当前 MVP：

- Carbon runner 已具备真实 `natcap.invest` 调用路径；使用 `gsms-invest` 环境启动后端并设置 `run_mode=real` 时，已可真实运行 Carbon。默认 `auto` 模式仍允许在缺少 InVEST 的环境中回退到显式 development stub。
- Raster 图层仍以占位预览为主，真实 GeoTIFF tile 服务尚未完成。
- SQLite 尚未接入，metadata 主要来自文件扫描。
- 用户系统、权限系统、多项目管理不在当前阶段范围。
- Agent/skills 智能辅助暂不接入，后续应建立在稳定 workbench 操作能力之上。

后续 agent 不应误把这些限制描述为已完成能力。

## 10. 下一步推荐任务

后续 agent 若继续开发，建议优先顺序如下：

1. 完成真实 GeoTIFF metadata 读取和 raster preview endpoint。
2. 建立 job output index，支持刷新后恢复输出列表。
3. 接入真实 InVEST Carbon。
4. 将 Carbon raster 输出通过 tile endpoint 加入地图。
5. 引入 SQLite 持久化 assets/jobs/outputs。
6. 增加 Carbon 输入检查与模型 schema 驱动表单。

任何阶段完成后，都应更新对应开发计划或阶段总结文档。
