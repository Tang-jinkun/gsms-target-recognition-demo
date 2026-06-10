# Evidence Ledger 设计文档

## 问题

当前 `ArtifactStore` 存在三个违反 append-only 审计原则的问题：

1. **`delete()` 允许删除历史产物** — executor 的 auto-persist 逻辑（`StreamingToolExecutor.ts:328-329`）会先 `delete` 再 `create`，覆盖历史记录
2. **无 scope 隔离** — 所有 turn、所有 skill 的产物混在一个 flat list 里，`list()` 返回全量历史
3. **无 supersedes 关系** — 同名/同类型产物被覆盖时，旧版本直接消失，无法追溯「被什么替代了」

## 设计目标

- **Append-only**: 产物永远不被物理删除，只能被标记 `superseded`
- **Scope-aware**: 产物自动归属到 `(turn, skillScope)` 组合，读取默认只返回当前 scope
- **审计可追溯**: 每个产物记录 `scopeKey`、`supersedes`（被替代的旧产物 ID）、`createdAt`
- **最小侵入**: 不改变 `ToolResult.artifacts` 的写入方式，scope 由 runtime 自动注入

## 类型变更

### `Artifact<T>` (types.ts)

```typescript
export interface Artifact<T = unknown> {
  id: string
  type: string
  version?: number
  createdAt?: string
  createdBy: ArtifactCreator
  data: T
  metadata?: Record<string, unknown>

  // ── Evidence Ledger fields ──
  /** Scope key in the form "turn:N" or "turn:N:skill:name". */
  scopeKey?: string
  /** ID of the artifact this one supersedes (for version chains). */
  supersedes?: string
  /** Set to true when a newer artifact supersedes this one. */
  superseded?: boolean
}
```

### `ArtifactRepository` (types.ts)

```typescript
export interface ArtifactRepository {
  create<T>(input: ArtifactInput<T>): Artifact<T>
  createMany(inputs: readonly ArtifactInput[]): Artifact[]
  get<T = unknown>(id: string): Artifact<T> | undefined

  /**
   * List artifacts.  Without scopeKey, returns all (for audit).
   * With scopeKey, returns only artifacts whose scopeKey matches.
   * superseded artifacts are excluded unless includeSuperseded is true.
   */
  list(type?: string, options?: { scopeKey?: string; includeSuperseded?: boolean }): Artifact[]

  /** @deprecated Use scope-aware supersession. Kept for backward compat. */
  delete(id: string): boolean
}
```

### `ArtifactInput<T>` (types.ts)

```typescript
export interface ArtifactInput<T = unknown> {
  id?: string
  type: string
  version?: number
  createdAt?: string
  createdBy: ArtifactCreator
  data: T
  metadata?: Record<string, unknown>
  scopeKey?: string       // optional; runtime auto-injects if absent
  supersedes?: string     // optional; ID of artifact being replaced
}
```

## 实现变更

### `ArtifactStore` (artifacts/ArtifactStore.ts)

#### `create` / `createMany` — 注入 scope，处理 supersedes

```
createMany(inputs):
  for each input:
    1. scopeKey = input.scopeKey ?? this.currentScopeKey  (由 runtime 注入)
    2. 如果 input.supersedes 存在:
       - 查找旧产物，标记 old.superseded = true
       - 新产物.supersedes = old.id
    3. 如果没有 supersedes，但存在同 scopeKey + 同 type 的产物:
       - 自动建立 supersedes 关系（最新的那个被标记 superseded）
    4. 创建新产物，scopeKey 写入
```

#### `list` — scope 过滤

```
list(type?, options?):
  遍历所有产物:
    - 如果 options.scopeKey 存在，只返回 scopeKey 匹配的
    - 如果 options.includeSuperseded !== true，排除 superseded === true 的
    - 如果 type 存在，过滤 type
```

#### `delete` — 标记废弃

```
delete(id):
  - 不物理删除
  - 标记 artifact.superseded = true
  - 返回 true（保持接口兼容）
  - console.warn 一次："ArtifactStore.delete() is deprecated, use scope-aware supersession"
```

### `AgentRuntime` (agent/AgentRuntime.ts)

#### 注入 scopeKey

在每轮循环开始时，设置 `artifactStore.currentScopeKey`:

```
const scopeKey = goal.skillScope
  ? `turn:${goal.turnCount}:skill:${goal.skillScope.name}`
  : `turn:${goal.turnCount}`
artifacts.currentScopeKey = scopeKey
```

#### finish tool 的 evidence gate

当前 `finishTool` 检查 `context.artifacts.list()` 来判断是否有 domain 产物。改为只检查**当前 scope** 的产物：

```
const scopeKey = context.goal.skillScope
  ? `turn:${context.goal.turnCount}:skill:${context.goal.skillScope.name}`
  : `turn:${context.goal.turnCount}`
const scopeArtifacts = context.artifacts.list(undefined, { scopeKey })
```

### `StreamingToolExecutor` (agent/StreamingToolExecutor.ts)

#### auto-persist 不再 delete

当前逻辑（line 328-329）:
```typescript
if (this.context.artifacts.list().some(a => a.id === artifactId)) {
  this.context.artifacts.delete(artifactId)
}
```

改为用 supersedes:
```typescript
const existing = this.context.artifacts.list().find(a => a.id === artifactId)
const persisted = this.context.artifacts.create({
  id: artifactId,
  type: 'tool-result',
  createdBy: 'tool' as const,
  scopeKey: this.scopeKey,  // 由 runtime 注入到 executor
  supersedes: existing?.id,
  data: { ... },
})
```

## 迁移策略

1. **Phase 1**: 加 `scopeKey`、`supersedes`、`superseded` 字段到 `Artifact` 接口（可选字段，不破坏现有代码）
2. **Phase 2**: `ArtifactStore.createMany` 自动注入 `scopeKey`，处理 `supersedes` 关系
3. **Phase 3**: `list()` 支持 scope 过滤，`delete()` 标记为 deprecated
4. **Phase 4**: executor auto-persist 改用 supersedes
5. **Phase 5**: finish tool evidence gate 改为 scope-aware

每个 phase 独立可测，不破坏已有测试。

## 测试计划

1. **基础 supersedes**: 创建产物 A，创建 B supersedes A → A 标记 superseded，B.supersedes = A.id
2. **list 过滤**: `list()` 排除 superseded；`list(undefined, { includeSuperseded: true })` 包含全部
3. **scope 隔离**: turn 1 创建产物，turn 2 创建产物 → `list(undefined, { scopeKey: 'turn:2' })` 只返回 turn 2 的
4. **delete 兼容**: `delete(id)` 标记 superseded 而非物理删除
5. **auto-persist supersedes**: 大结果 auto-persist 不删除旧版本，而是标记 superseded
6. **evidence gate scope**: finish tool 只看当前 scope 的产物

## 不在范围内

- 跨 run 的持久化（当前 ArtifactStore 是内存态，run 结束即销毁）
- 产物的物理存储（GeoTIFF 等大文件由后端管理，不经过 ArtifactStore）
- 产物的序列化/反序列化（未来可加 SQLite 持久化层）
