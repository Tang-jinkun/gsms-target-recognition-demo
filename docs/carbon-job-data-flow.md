# Carbon 作业完整数据流

本文档深入拆解 GSMS 中一次完整 InVEST Carbon 作业的端到端数据流，
从用户发出自然语言请求到最终报告生成，覆盖每一层的代码逻辑。

## 阶段 0：会话生命周期（Worker 轮询机制）

在数据流开始之前，先理解 Agent 是怎么被"唤醒"的。

```
前端 POST /sessions/{id}/messages  →  session 状态变为 queued
                                          ↓
Worker 每 1.5s 轮询 GET /sessions?status=queued
                                          ↓
Worker POST /checkpoint {action:'start'} →  session 状态变为 running
                                          ↓
Worker 从 DB 加载 domain_state + artifacts →  重建内存状态
                                          ↓
创建 AgentRuntime + 注入 Tools + 加载 Skills →  开始 Agent 循环
```

### 关键设计：Worker 是无状态的

Worker 每次运行都从后端 DB 完全重建 `ArtifactStore` 和 `DomainStateStore`。
运行结束后再通过 checkpoint 把所有状态持久化回去。这意味着 Worker 崩溃后
可以从断点恢复。

### Agent 循环（AgentRuntime.run）

`packages/agent-core/src/agent/AgentRuntime.ts` 实现了核心循环：

```
初始化 GoalState { status: 'active', turnCount: 0, maxTurns: 20 }
构建消息数组：system prompt + 用户目标

while (goal.status === 'active' && turnCount < maxTurns):
    response = model.complete(messages, tools)

    if response 无 tool_calls:
        注入隐藏消息 "Continue acting toward the objective."
        continue

    检测重复工具调用循环（同一序列重复 4 次 → 中止）

    for each tool_call in response:
        解析工具 → 检查可见性 → 检查权限 → 执行
        处理结果：artifacts / statePatch / goalUpdate / diagnostics / activateSkill

    检测连续失败（同一工具连续 3 次无进展 → 中止）
```

- LLM 调用通过后端代理（`POST /chat/completions`），Worker 永远不接触原始
  API Key
- 权限可以导致工具执行被延迟（`goal.status = 'blocked'`），暂停运行
- 事件通过 `eventSink` 发送到后端用于可观测性

### 相关源码

| 文件 | 职责 |
|------|------|
| `agent/src/worker.ts` | 后台 Worker 入口，轮询 + 领取 + 恢复 + 运行 + 持久化 |
| `agent/src/cli.ts` | 交互式 CLI，直接在进程内运行 AgentRuntime |
| `packages/agent-core/src/agent/AgentRuntime.ts` | 模型无关的 Agent 循环 |
| `packages/agent-core/src/artifacts/ArtifactStore.ts` | 内存工件存储（Map + 深克隆） |
| `packages/agent-core/src/state/DomainStateStore.ts` | 域状态存储（JSON Merge Patch） |
| `backend/app/routers/agent.py` | 会话 CRUD、消息、事件、确认、checkpoint、LLM 代理 |

### 会话状态机

```
idle → queued（用户发消息）→ running（Worker 领取）
  → idle（完成）| failed（失败）
  → awaiting_confirmation（请求确认）→ queued（批准）| idle（拒绝）
```

确认状态机：`pending → approved / rejected → consumed`

---

## 阶段 1：Matching（数据匹配）

### 1.1 加载模型和数据

Agent 首先加载两个基础信息：

**加载模型 Schema：**

```
get_invest_model_schema("carbon")
  → 后端 GET /models/carbon/schema
  → 返回 Carbon 模型的输入槽定义（哪些输入是必须的、类型、约束）
  → 生成 model-input-schema 工件
  → domain_state.phase 重置为 "conversation-ready"
```

**加载场景数据卡：**

```
list_scene_data_cards(sceneId)
  → 后端 GET /scenes/{id}/data-cards
  → 对每个 DataFile 调用 build_data_card()，提取 CRS、bounds、字段、波段等元数据
  → 计算 matchingContextId = SHA-24(sceneId + modelId + 排序后的资产指纹)
  → 每个文件生成一个 data-card 工件
```

`matchingContextId` 是确定性的——相同的场景 + 模型 + 数据永远产生相同的 ID，
用于后续所有工件的命名空间隔离。

### 1.2 逐槽检索候选

Carbon 模型有多个输入槽（如 `lulc_cur`、`lulc_fut`、`carbon_pools` 等）。
对每个必须的槽：

```
retrieve_input_candidates({ slot: "lulc_cur" })
  → 从 data-card 工件中检索匹配的候选
  → retrieveCandidates(inputSlot, dataCards) 进行类型/空间匹配
  → 生成 candidate-set:{matchingContextId}:lulc_cur 工件
  → domain_state.slots["lulc_cur"] = { candidates: [...], status: "candidates-found" }
```

**边界强制**：`workflowBoundary.ts` 中的 `phaseAllows()` 检查——如果某个必须槽
还没有 candidate-set 工件，Agent 只能调用 `retrieve_input_candidates`，不能跳到
下一步。

### 1.3 关系检查

如果槽声明了 `relationConstraints`（如土地利用栅格和查找表之间的编码一致性）：

```
check_data_relation({
  kind: "code-coverage",
  left_asset_id, right_asset_id,
  field: "lucode"
})
  → 后端 POST /matching/check-relation
  → check_code_coverage(left_file, right_file, field) 做确定性检查
  → 生成 relation-check:{left}:{right}:{field} 工件
```

### 1.4 完成匹配

```
finalize_data_matching({
  modelId: "carbon",
  decisions: [
    { slot: "lulc_cur", selectedAssetId: "abc123",
      status: "matched", confidence: 0.95, reasoning: "..." },
    { slot: "carbon_pools", selectedAssetId: "def456",
      status: "matched", confidence: 0.8, reasoning: "..." },
    ...
  ],
  unresolvedQuestions: []
})
```

这一步是关键设计：**Agent 只传决策，不构建 Binding Report**。工具内部：

1. 验证所有必须槽都有 candidate-set 工件（否则抛 `MATCHING_EVIDENCE_INCOMPLETE`）
2. 验证 `selectedAssetId` 确实在候选集中（否则抛 `SELECTED_ASSET_NOT_CANDIDATE`）
3. 检查所有有约束的槽对都有 relation-check 工件（否则抛
   `MATCHING_RELATION_CHECK_MISSING`）
4. **确定性地**构建 Binding Report，计算冲突和 `recommendedNextAction`
5. 持久化 `binding-report:{matchingContextId}:{hash}` 工件
6. `domain_state.phase = 'ready-for-validation'`

### 相关源码

| 文件 | 职责 |
|------|------|
| `agent/skills/data-matching/SKILL.md` | 数据匹配 Skill 定义（策略层） |
| `agent/src/tools/matchingTools.ts` | Agent 侧工具实现（`retrieve_input_candidates`、`finalize_data_matching`） |
| `backend/app/routers/matching.py` | 后端端点（data-cards、check-relation、validate-bindings、confirm、jobs） |
| `agent/src/workflowBoundary.ts` | 工作流边界强制（状态机 + 工具过滤） |

---

## 阶段 2：Validation（验证）

```
validate_binding_report()
  → 后端 POST /models/{model_id}/validate-bindings
  → build_model_inputs_from_bindings() 将绑定翻译为文件路径
  → check_model_inputs() 调用 InVEST 自带的输入验证
  → 计算 asset_fingerprints（所有输入文件的 SHA-256）
  → validation_snapshot_id() = SHA-256(模型ID + 场景ID + 输入路径 + 资产指纹)
  → 创建 ValidationSnapshot 数据库行
```

快照 ID 是**不可变的**——相同的输入组合永远产生相同的 ID。如果用户改了任何一
个输入文件，资产指纹会变，旧快照自动失效。

---

## 阶段 3：Confirmation（确认）

```
confirm_validation_snapshot({ confirmed: true })
  → 后端 POST /validation-snapshots/{id}/confirm
  → with_for_update() 行级锁防止并发
  → _invalidate_if_assets_changed() 再次检查资产是否变更（HTTP 409 如果变了）
  → next_snapshot_status(snapshot, "confirm") → 状态变为 confirmed
  → domain_state.phase = 'confirmed-for-execution'
```

这里实现了 **human-in-the-loop**：高风险操作（执行 InVEST）需要用户明确确认。
Agent 通过 `PermissionManager` 发起确认请求，会话进入 `awaiting_confirmation`
状态，前端弹出确认对话框。

---

## 阶段 4：Execution（执行）

```
execute_validated_snapshot({ runMode: "real" })
  → 后端 POST /validation-snapshots/{id}/jobs
  → 再次检查资产失效 + 检查是否已有作业（一个快照只能创建一个作业）
  → create_scene_job_record():
      1. 生成 job_id (UUID)
      2. 创建 job 目录
      3. freeze_snapshot_inputs() — 复制/符号链接输入资产到 job_dir/inputs/
         生成 input-manifest.json
      4. 写入 job.json + input-manifest.json + run.log
      5. 创建 Job 数据库记录 (status: running)
      6. subprocess.Popen(run_job.py) — 启动子进程
  → domain_state.phase = 'job-running'
```

### run_job.py 子进程

```
1. 加载 job.json 获取输入和模型 ID
2. 验证 input-manifest.json 确保输入完整性
3. 调用 run_model_job() — 这是真正执行 InVEST 的地方
   （调用 natcap.invest Python API）
4. 输出写入 job_dir/outputs/
5. 写入 run.log 记录成功/失败
```

**资产冻结**：`freeze_snapshot_inputs` 把输入文件复制或符号链接到作业目录的
`inputs/` 子目录，加上 `input-manifest.json` 记录每个文件的 SHA-256。这保证
即使原始文件被修改，作业的输入是不可变的。

### 相关源码

| 文件 | 职责 |
|------|------|
| `agent/src/tools/gsmsTools.ts` | `execute_validated_snapshot` 工具实现 |
| `backend/app/routers/jobs.py` | 作业 CRUD、输出管理、结果分析端点 |
| `backend/app/routers/matching.py` | 快照确认 → 作业创建端点 |
| `backend/run_job.py` | InVEST 子进程执行器 |
| `backend/invest_models/registry.py` | 模型注册表，`run_model_job()` 实际调用 |

---

## 阶段 5：Interpretation（解读）

这是 `feat/deterministic-result-analysis` 分支的核心贡献。

### 5.1 轮询作业状态

```
get_invest_job_status()
  → 后端 GET /scenes/{id}/jobs/{job_id}
  → _sync_job_from_disk():
      读取 run.log 判断状态
      扫描 outputs/ 目录
      如有新输出文件：读取元数据（bounds, CRS），创建 JobOutput 记录
      _register_outputs_to_data_hub(): 自动注册到 Data Hub
  → status: succeeded → domain_state.phase = 'job-succeeded'
```

### 5.2 清点输出

```
inspect_invest_job_outputs()
  → 后端 GET /scenes/{id}/jobs/{job_id}/outputs
  → 返回所有输出文件列表（名称、类型、大小、下载/预览 URL）
  → 发布 job-output-inventory.json 到 Data Hub
  → 生成 job-output-inventory 工件
  → domain_state.phase = 'outputs-inspected'
```

### 5.3 确定性栅格分析（核心）

```
analyze_invest_results()
  → 后端 POST /scenes/{id}/jobs/{job_id}/analyze-results
```

后端执行 `analyze_job_outputs()`（`result_analysis.py`）：

```
1. 指纹收集
   遍历所有 .tif/.tiff 文件，计算 SHA-256

2. 缓存检查
   如果已有分析结果且指纹未变，直接返回缓存

3. 逐文件分析
   · 用 rasterio 打开 GeoTIFF，读取为 float64
   · 构建有效性掩码：排除 nodata（np.isclose）、NaN、Inf
   · 计算统计量：
     validPixels, nodataPixels, min, max, mean,
     total（求和）, p05（第5百分位）, median, p95（第95百分位）
   · 空间元数据：CRS, bounds, width, height, nodata 值
   · 对 carbon-change 角色的栅格，额外计算：
     positivePixels, negativePixels, zeroPixels,
     positiveTotal, negativeTotal

4. 角色解析
   resolve_output_role(filename, model_schema)
   用 fnmatch 匹配文件名到模型 schema 中的输出模式
   返回 { role, quantity, unit, aggregation }

5. 跨栅格一致性检查
   · check_baseline_alternate_delta_consistency(
       baseline_total, alternate_total, delta_total)
     验证 alternate - baseline ≈ delta
     浮点容差：magnitude * 1e-6 + 1e-3
   · check_delta_internal_consistency(
       positive_total, negative_total, delta_total)
     验证 positive + negative ≈ delta

6. 持久化到 analysis/result-analysis.json
```

返回结构：

```json
{
  "sceneId": "...",
  "jobId": "...",
  "modelId": "carbon",
  "outputFingerprints": {
    "c_storage_cur.tif": "abc123...",
    "c_storage_fut.tif": "def456..."
  },
  "rasters": [
    {
      "filename": "c_storage_cur.tif",
      "role": "carbon-storage",
      "quantity": "carbon",
      "unit": "Mg C",
      "statistics": {
        "validPixels": 12345,
        "total": 98765.4,
        "mean": 0.8,
        "median": 0.6,
        "minimum": 0.0,
        "maximum": 15.2,
        "p05": 0.1,
        "p95": 3.5
      },
      "spatial": {
        "crs": "EPSG:32610",
        "bounds": [500000, 4500000, 600000, 4600000],
        "width": 1000,
        "height": 1000,
        "nodata": -9999
      }
    }
  ],
  "comparisons": [
    {
      "kind": "baseline-alternate-delta",
      "status": "passed",
      "baseline_total": 98765.4,
      "alternate_total": 95000.1,
      "delta_total": -3765.3,
      "computed_delta": -3765.3,
      "abs_difference": 0.0
    }
  ],
  "warnings": [],
  "generatedAt": "2025-06-08T12:00:00Z"
}
```

**关键**：这些数字是从真实 GeoTIFF 像素中用 `rasterio` + `numpy` 确定性计算的，
不经过 LLM。

### 5.4 构建解读上下文

```
interpret_invest_results()
  → 收集三个数据源：
    1. result-analysis 工件（确定性统计）
    2. job-output-inventory 工件（输出文件清单）
    3. 执行日志（client.getSceneJobLogs()，截断到最近 20,000 字符）
  → 组装 interpretation 对象，包含 guidance 规则：
    - "All numerical values must come from the result-analysis artifact"
    - "Do not infer ecological causality"
    - "Do not claim to have analyzed individual carbon pools"
  → 发布 result-interpretation-context.json 到 Data Hub
  → domain_state.phase = 'results-ready-for-interpretation'
```

### 5.5 生成报告（数字净化机制）

```
write_invest_report({
  highlightMetricIds: ["carbon-storage.total", ...],
  contextualExplanation: "该区域碳储量总计约为 98,765 Mg C...",
  limitations: ["模型未考虑土壤碳的季节变化", ...]
})
```

**数字净化流程**（`reportTools.ts`，这是防幻觉的核心）：

```
步骤 1：收集允许的数字
  collectAllowedNumbers(result-analysis.json)
  → 递归遍历整个 JSON 结构
  → 收集每个有限数值的两种形式：
    · String(value) 形式："98765.4"
    · toLocaleString('en-US', {maximumFractionDigits: 20}) 形式："98,765.4"
  → 存入 Set<string>

步骤 2：净化 contextualExplanation
  findUnsupportedNumbers(text, allowed)
  → 正则提取所有数字模式：/-?\d[\d,]*(?:\.\d+)?/g
  → 每个数字规范化：Number("98,765.4") → String → "98765.4"
  → 检查是否在 allowed 集合中
  → 如果发现任何不在集合中的数字 → 整段替换为：
    "The deterministic result-analysis tables above provide the
     authoritative numerical findings..."

步骤 3：逐条净化 limitations
  对每个 limitation 单独检查
  → 包含不支持数字的 limitation → 替换为通用省略通知

步骤 4：输出诊断警告
  列出被省略的不支持数字
```

### 报告章节结构

`buildInvestReport()` 组装最终 Markdown，包含 10 个章节：

| # | 章节 | 数据来源 |
|---|------|----------|
| 1 | Header | 固定文本 |
| 2 | Assessment | domain_state（模型、场景、快照、作业 ID） |
| 3 | Input Bindings | binding-report 工件 |
| 4 | Validation & Confirmation | validation-report + confirmation-record 工件 |
| 5 | Execution | model-job + job-status 工件 |
| 6 | Outputs | job-output-inventory 工件 |
| 7 | **Result Analysis** | **result-analysis 工件**（统计表、变化分布、一致性检查、空间元数据、指纹） |
| 8 | Result Interpretation | 净化后的 contextualExplanation |
| 9 | Limitations | 净化后的 limitations + 三条强制免责声明 |
| 10 | Audit Evidence | 工件清单 + 生成时间戳 |

### 相关源码

| 文件 | 职责 |
|------|------|
| `agent/skills/interpret-invest-results/SKILL.md` | 结果解读 Skill 定义 |
| `agent/src/tools/gsmsTools.ts` | 11 个 GSMS 工具（状态轮询、输出清点、分析、解读） |
| `agent/src/tools/reportTools.ts` | `write_invest_report` 工具（数字净化 + 路径安全） |
| `agent/src/report/buildInvestReport.ts` | 纯 Markdown 报告构建器（10 个章节） |
| `backend/app/routers/jobs.py` | 作业 API（状态同步、输出列表、分析端点） |
| `backend/app/result_analysis.py` | 确定性栅格统计引擎（rasterio + numpy） |

---

## 全景图：职责分工

```
┌─────────────────────────────────────────────────────────────────────┐
│  LLM Agent 做的事（软性推理）                                         │
│  · 理解用户自然语言意图                                               │
│  · 选择合适的 InVEST 模型                                             │
│  · 为每个输入槽选择候选数据（基于 Data Card 元数据）                     │
│  · 对不确定的匹配给出置信度和推理                                       │
│  · 撰写解读散文（但数字会被净化）                                       │
│  · 总结局限性和假设                                                   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  后端做的事（确定性执行）—— LLM 不参与                                  │
│  · 构建 Binding Report（从 Agent 的决策确定性地构建）                   │
│  · 验证输入（调用 InVEST 的 check_model_inputs）                       │
│  · 计算快照 ID（SHA-256 哈希）                                         │
│  · 冻结输入资产（复制 + 清单）                                          │
│  · 执行 InVEST 子进程                                                 │
│  · 读取 GeoTIFF 像素、计算统计量（rasterio + numpy）                    │
│  · 跨栅格一致性检查                                                    │
│  · 数字净化（不支持的数字从报告中移除）                                   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  workflowBoundary.ts 做的事（状态机强制）                               │
│  · 从用户请求推断工作流阶段                                             │
│  · 根据当前 domain_state.phase 限制可用工具                             │
│  · 防止跳步、重复、或越权调用                                           │
└─────────────────────────────────────────────────────────────────────┘
```

## 工作流阶段与可用工具映射

`workflowBoundary.ts` 实现了五阶段边界，每个阶段有严格的工具白名单：

| 阶段 | 允许的工具 | 触发条件 |
|------|-----------|----------|
| matching | list_invest_models, get_invest_model_schema, list_scene_data_cards, retrieve_input_candidates, check_data_relation, finalize_data_matching | 用户请求涉及数据匹配 |
| validation | validate_binding_report | phase = ready-for-validation |
| confirmation | confirm_validation_snapshot | phase = awaiting-user-confirmation |
| execution | execute_validated_snapshot, get_invest_job_status | phase = confirmed-for-execution |
| interpretation | get_invest_job_status, inspect_invest_job_outputs, analyze_invest_results, interpret_invest_results, write_invest_report | 用户请求涉及解读/报告 |

阶段内的细粒度控制（`phaseAllows`）：

| domain_state.phase | 唯一允许的工具 |
|--------------------|---------------|
| job-running | get_invest_job_status |
| job-succeeded | inspect_invest_job_outputs |
| outputs-inspected | analyze_invest_results |
| results-analyzed | interpret_invest_results |
| results-ready-for-interpretation | write_invest_report |
| report-written | get_invest_job_status（仅 interpretation 边界） |

---

## 产出工件清单

一次完整运行产出以下工件（按时间顺序）：

| # | 工件类型 | ID 模式 | 产出者 |
|---|---------|---------|--------|
| 1 | model-input-schema | model-input-schema:{modelId} | get_invest_model_schema |
| 2 | data-card | data-card:{matchingContextId}:{assetId} | list_scene_data_cards |
| 3 | candidate-set | candidate-set:{matchingContextId}:{slot} | retrieve_input_candidates |
| 4 | relation-check | relation-check:{left}:{right}:{field} | check_data_relation |
| 5 | binding-report | binding-report:{matchingContextId}:{hash} | finalize_data_matching |
| 6 | validation-report | (内联于 domain_state) | validate_binding_report |
| 7 | confirmation-record | (内联于 domain_state) | confirm_validation_snapshot |
| 8 | model-job | (内联于 domain_state) | execute_validated_snapshot |
| 9 | job-status | (轮询更新) | get_invest_job_status |
| 10 | job-output-inventory | job-output-inventory:{jobId} | inspect_invest_job_outputs |
| 11 | result-analysis | result-analysis:{jobId} | analyze_invest_results |
| 12 | result-interpretation-context | (发布到 Data Hub) | interpret_invest_results |
| 13 | invest-report | invest-report:{jobId} | write_invest_report |

所有工件都会通过 checkpoint 持久化到后端 DB，并在 Data Hub 中对用户可见。

---

## 防幻觉机制总结

GSMS 通过多层机制确保 LLM 不会捏造科学数据：

| 层 | 机制 | 作用 |
|----|------|------|
| 架构 | 后端是科学计算的权威 | LLM 不直接运行 InVEST 或读取 GeoTIFF |
| 工具 | 确定性分析（result_analysis.py） | 统计量从真实像素计算，不经过 LLM |
| 报告 | 数字净化（reportTools.ts） | 散文中不被 result-analysis 支持的数字被移除 |
| 工作流 | 阶段边界（workflowBoundary.ts） | 防止 Agent 跳过分析步骤直接写报告 |
| Skill | 指导规则（SKILL.md） | 明确告知 LLM "所有数字必须来自 result-analysis" |
| 审计 | 全链路工件 | 每一步产出可审计的中间文件 |
