# InVEST WebGIS Workbench

轻量级 WebGIS 分析工作台原型，用于管理地理数据资产、在 MapLibre 地图中查看输入/输出，并通过 FastAPI 后端运行 InVEST Carbon 模型。

当前 MVP 主线：

```text
Import sample data / Upload assets
-> Add raster/vector assets to map
-> Bind Carbon model inputs
-> Run job in auto or real mode
-> Poll logs and status
-> Show outputs
-> Add primary raster output to map
```

## Repository Layout

```text
backend/                FastAPI backend and job runner
frontend/               Next.js workbench frontend
sample_data/carbon/     Willamette Carbon sample assets
docs/                   Development plan, acceptance notes, and agent guidelines
```

## Backend Environment

真实 InVEST 运行使用 conda 环境，不使用普通 venv。

```powershell
conda env create -f backend/environment.yml
conda activate gsms-invest
```

已验证核心版本：

```text
python 3.10
natcap.invest 3.19.0
fastapi 0.136.3
rasterio 1.4.3
```

启动后端：

```powershell
conda activate gsms-invest
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

## Frontend

```powershell
cd frontend
npm install
$env:NEXT_PUBLIC_API_URL = "http://127.0.0.1:8000"
npm run dev -- --port 3000
```

Windows 上 Next.js 偶尔会卡在 build/dev worker。先停止相关 node/npm/next 进程，再清理缓存：

```powershell
cd frontend
npm run clean
npx tsc --noEmit
```

详细处理规范见 `docs/agent-development-guidelines.md`。

## Real Carbon Smoke Test

1. 启动后端。
2. 打开 `/workbench`。
3. 点击 `Import sample Carbon data`。
4. 选择 `Runner mode = Real`。
5. 点击 `Run Carbon`。

成功日志应包含：

```text
run mode: real
running natcap.invest.carbon.execute
InVEST Carbon execution completed
indexed 5 workspace output files
```

输出中应包含：

```text
c_storage_bas_*.tif
```

## Current Scope

已具备：

- 三栏桌面 Workbench。
- asset upload/list/metadata。
- raster PNG preview。
- GeoJSON layer rendering。
- Carbon `auto` / `real` runner。
- Carbon input check。
- job logs/status/outputs。
- recent job restore。
- sample Carbon auto-binding。

尚未完成：

- 真正 XYZ/COG tile 服务。
- SQLite metadata 持久化。
- Shapefile zip 完整解析。
- raster pixel query。
- 更多 InVEST 模型。
- agent/skills 辅助层。
