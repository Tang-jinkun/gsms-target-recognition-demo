# Frontend Polling → SSE 转换设计

> 状态：Draft
> 作者：Agent
> 日期：2026-06-10

---

## 1. 问题

前端通过 **500ms `setTimeout` 轮询** 获取 Agent 事件，每次 tick 发起 **4 个并行 HTTP 请求**：

| 请求 | 用途 |
|------|------|
| `GET /sessions/{id}` | 拉取 session 状态 |
| `GET /sessions/{id}/messages` | 拉取消息列表 |
| `GET /sessions/{id}/events?after_id=X` | 拉取新事件 |
| `GET /sessions/{id}/confirmations` | 拉取确认请求 |

**问题**：

- **延迟**：最坏 500ms 才能感知新事件，实际体感 250ms（平均）
- **浪费**：idle 状态下 1500ms 轮询，每次 4 个无变化请求
- **放大**：多标签页 × 多 session = 请求量线性放大
- **DB 压力**：每次 events 查询都走 DB，即使无新事件

## 2. 目标

- 事件到达前端延迟 < 100ms（DB 轮询 300ms + 网络）
- idle 状态零请求（SSE 连接保持，无数据时无 HTTP 往返）
- 支持断线自动重连 + 事件不丢失（`Last-Event-ID`）
- 向后兼容：SSE 失败时回退到原有轮询

## 3. 现有架构

```
┌─────────┐  POST /events   ┌──────────┐  DB write  ┌──────┐
│  Agent   │ ──────────────→ │ Backend  │ ─────────→ │ DB   │
│ Worker   │                 │ (FastAPI)│            │(PG)  │
└─────────┘                 └──────────┘            └──────┘
                                     ↑
                    GET /events?after_id=X   │ 500ms 轮询
                                     │
                              ┌──────────┐
                              │ Frontend │
                              │ (Next.js)│
                              └──────────┘
```

**事件生命周期**：

1. Agent Worker 调用 `POST /api/agent/sessions/{id}/events`，写入 DB
2. Backend 返回事件 JSON
3. 前端每 500ms 轮询 `GET /events?after_id=X`
4. 前端 `applyEventToBlocks()` 累积到 `runBlocksRef`

**关键代码**：

- 前端轮询：`frontend/pages/workbench/[sceneId].tsx:318-344`
- 事件处理：`frontend/pages/workbench/[sceneId].tsx:30-73` (`applyEventToBlocks`)
- 后端事件端点：`backend/app/routers/agent.py:270-285`
- 已有 SSE（LLM proxy）：`backend/app/routers/agent.py:488-548`

## 4. 设计：SSE 事件流

### 4.1 架构

```
┌─────────┐  POST /events   ┌──────────┐  DB write  ┌──────┐
│  Agent   │ ──────────────→ │ Backend  │ ─────────→ │ DB   │
│ Worker   │                 │ (FastAPI)│            │(PG)  │
└─────────┘                 └──────────┘            └──────┘
                                  │
                     GET /stream (SSE)  │ 实时推送
                                  │
                           ┌──────────┐
                           │ Frontend │
                           │ (Next.js)│
                           └──────────┘
```

### 4.2 Backend：新增 SSE 端点

**端点**：`GET /api/agent/sessions/{session_id}/stream`

**协议**：Server-Sent Events（`text/event-stream`）

**行为**：

1. 验证 session 存在
2. 从 `Last-Event-ID` header（或 query param `last_event_id`）获取游标
3. 进入循环：
   - 查询 DB 获取 `id > cursor` 的事件
   - 有新事件 → 逐条发送，更新 cursor
   - 无新事件 → 发送 `:heartbeat\n\n` 注释保活
   - 等待 300ms
4. 客户端断开 → 清理退出

**SSE 消息格式**：

```
id: 42
event: model.streaming
data: {"run_id":"abc","text":"分析中"}

id: 43
event: tool.started
data: {"run_id":"abc","tool":"invest_carbon","tool_call_id":"tc_1"}

:heartbeat

```

**实现**：

```python
# backend/app/routers/agent.py

@router.get("/sessions/{session_id}/stream")
async def stream_agent_events(
    session_id: str,
    request: FastApiRequest,
    last_event_id: int = Query(default=0, ge=0),
):
    """SSE endpoint: push events in real-time via DB polling."""
    from fastapi.responses import StreamingResponse

    # Resolve initial cursor: header takes precedence (EventSource auto-sends).
    cursor_header = request.headers.get("last-event-id")
    cursor = int(cursor_header) if cursor_header else last_event_id

    async def event_generator():
        import asyncio
        while True:
            if await request.is_disconnected():
                break
            # Open a short-lived DB session per poll (sync driver compatibility).
            db = next(get_db())
            try:
                session = db.get(AgentSession, session_id)
                if not session:
                    yield f"event: error\ndata: {{\"detail\":\"session not found\"}}\n\n"
                    break
                rows = (
                    db.query(AgentEvent)
                    .filter(AgentEvent.session_id == session_id, AgentEvent.id > cursor)
                    .order_by(AgentEvent.id.asc())
                    .limit(100)
                    .all()
                )
                for event in rows:
                    cursor = event.id
                    yield f"id: {event.id}\n"
                    yield f"event: {event.event_type}\n"
                    yield f"data: {json.dumps(event.data, ensure_ascii=False)}\n\n"
                if not rows:
                    yield ":heartbeat\n\n"
            finally:
                db.close()
            await asyncio.sleep(0.3)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
            "connection": "keep-alive",
        },
    )
```

### 4.3 Frontend：EventSource 替换轮询

**新增 SSE hook**：

```typescript
// frontend/src/lib/useAgentEventSource.ts

import React from 'react'
import type { AgentEvent } from './repos/agentSessionsRepo'

type UseAgentEventSourceOptions = {
  sessionId: string | null
  onEvent: (event: AgentEvent) => void
  onError?: () => void
  enabled?: boolean
}

/**
 * Connect to the SSE event stream for an agent session.
 * Falls back to null (caller should use polling) if EventSource is unsupported.
 */
export function useAgentEventSource({
  sessionId,
  onEvent,
  onError,
  enabled = true,
}: UseAgentEventSourceOptions) {
  const esRef = React.useRef<EventSource | null>(null)

  React.useEffect(() => {
    if (!sessionId || !enabled) return
    if (typeof EventSource === 'undefined') {
      onError?.()
      return
    }

    const url = `/api/agent/sessions/${encodeURIComponent(sessionId)}/stream`
    const es = new EventSource(url)
    esRef.current = es

    // Generic event handler — EventSource dispatches events by type.
    // We listen on the generic 'message' for events without a specific type,
    // and also register handlers for known event types.
    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data)
        onEvent({
          id: Number(ev.lastEventId) || 0,
          session_id: sessionId,
          type: ev.type || 'message',
          data,
        })
      } catch { /* ignore parse errors */ }
    }

    // Register for known event types + fallback message.
    const types = [
      'model.streaming', 'tool.started', 'tool.progress',
      'tool.completed', 'tool.failed', 'artifact.created',
      'diagnostic.created', 'session.status', 'confirmation.requested',
      'message.queued', 'message.persisted', 'session.created',
    ]
    for (const t of types) es.addEventListener(t, handler)
    es.onmessage = handler

    es.onerror = () => {
      // EventSource auto-reconnects. On repeated failures, call onError
      // so the caller can fall back to polling.
      onError?.()
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [sessionId, enabled])

  return esRef
}
```

**前端改造**（`[sceneId].tsx`）：

```typescript
// 替换 polling loop (lines 318-344)

const [sseFailed, setSseFailed] = React.useState(false)

// SSE event handler: apply to runBlocksRef in real-time.
const handleSseEvent = React.useCallback((ev: AgentEvent) => {
  // Apply to run blocks (same logic as current applyEventToBlocks)
  if (isStreamingEvent(ev.type)) {
    const runId = (ev.data.run_id as string) ?? 'run'
    let blocks = runBlocksRef.current.get(runId)
    if (!blocks) {
      blocks = []
      runBlocksRef.current.set(runId, blocks)
      runOrderRef.current.push(runId)
    }
    applyEventToBlocks(blocks, ev)
    // Force re-render to show streaming progress.
    setTurns(prev => [...prev]) // trigger re-render
  }
}, [])

useAgentEventSource({
  sessionId: pollSessionRef.current?.id ?? null,
  onEvent: handleSseEvent,
  onError: () => setSseFailed(true),
  enabled: !sseFailed,
})

// Lightweight fallback: poll session/messages/confirmations every 5s
// (not events — those come via SSE). Only runs if SSE is active.
React.useEffect(() => {
  if (sseFailed || !pollSessionRef.current) return
  const id = setInterval(() => {
    refreshSessionMeta(pollSessionRef.current!)
  }, 5000)
  return () => clearInterval(id)
}, [sseFailed])

// Full polling fallback: only if SSE failed.
React.useEffect(() => {
  if (!sseFailed) return
  // ... original polling logic as fallback ...
}, [sseFailed, sceneId])
```

**Session 状态更新策略**：

| 数据 | SSE 时 | Polling 时 |
|------|--------|-----------|
| Events | SSE 推送 | 500ms 轮询 |
| Session status | SSE 中 `session.status` 事件 + 5s 轮询 | 500ms 轮询 |
| Messages | Session → `idle`/`failed` 时拉取 | 500ms 轮询 |
| Confirmations | SSE 中 `confirmation.requested` 事件 + 5s 轮询 | 500ms 轮询 |

### 4.4 Session 状态变化通知

当前 SSE 只推事件，但前端还需要感知 session 状态变化（`running` → `idle`）。

**方案**：在 `_transition_session_status()` 中也写一条事件：

```python
# backend/app/agent_sessions.py 或 agent.py 中状态变更处
_add_event(db, session.id, "session.status", {
    "status": new_status,
    "previous_status": old_status,
})
```

这样前端通过 SSE 就能感知：
- `session.status` → `idle`/`failed` → 拉取最终 messages
- `confirmation.requested` → 拉取 confirmations
- `session.status` → `awaiting_confirmation` → 显示确认 UI

### 4.5 事件格式规范

**SSE 消息**：

```
id: <event.id>          ← 数字，用于 Last-Event-ID 重连
event: <event.event_type> ← 如 model.streaming, tool.started
data: <event.data JSON>  ← 单行 JSON
\n\n
```

**心跳**：

```
:heartbeat\n\n          ← 无数据时每 300ms 发送
```

**错误**：

```
event: error
data: {"detail": "..."}\n\n
```

## 5. 连接生命周期

### 5.1 连接建立

```
前端打开 workbench page
  → 初始 runRefresh：拉取 session + messages + confirmations + events（一次性）
    并把 events 折叠进 runBlocks，记录 cursor = 最后一个 event.id
  → 创建 EventSource(`/sessions/{id}/stream?last_event_id=<cursor>`)
  → SSE 从 cursor 之后恢复，初始 fetch 已折叠的事件不会重复推送（否则会重复文本）
  → 前端 applyEventToBlocks 实时更新 UI
```

> **关键**：必须先完成初始 `runRefresh`（拿到 cursor），再激活 SSE 并把
> `initialCursor` 传给 EventSource。否则 SSE 从 0 开始会重新推送已折叠的流式
> 增量，导致 think card 文本翻倍。实现上通过「priming 完成后才 `setActiveSession`」
> 保证顺序。

### 5.2 正常运行

```
Agent 执行中 → POST /events 写入 DB
  → SSE 轮询发现新事件 → 推送到前端
  → 前端 UI 实时更新（延迟 < 300ms + 网络）
```

### 5.3 断线重连

```
SSE 连接断开（网络波动、服务端重启）
  → EventSource 自动重连，发送 Last-Event-ID: <last_id>
  → 后端从 last_event_id 开始推送
  → 事件不丢失
```

### 5.4 Session 切换

```
用户切换到不同 scene/session
  → 关闭旧 EventSource
  → 重新拉取新 session 初始数据
  → 创建新 EventSource
```

### 5.5 SSE 失败回退

```
EventSource.onerror 持续触发（后端不支持 / 域名限制）
  → setSseFailed(true)
  → 启用原有 500ms 轮询
  → 完全向后兼容
```

## 6. 实现步骤

### Phase 1：Backend SSE 端点

1. 在 `backend/app/routers/agent.py` 添加 `GET /sessions/{id}/stream`
2. DB 轮询 + SSE 格式输出
3. 添加 `session.status` 事件通知（在状态变更时写入）
4. 单元测试：验证 SSE 格式、cursor 重连、心跳

### Phase 2：Frontend SSE Hook

1. 创建 `frontend/src/lib/useAgentEventSource.ts`
2. 在 `[sceneId].tsx` 中集成 SSE hook
3. 保留 polling 作为 fallback
4. 集成测试：验证事件实时到达、断线重连

### Phase 3：优化

1. 后端 DB 轮询优化：idle session 降低轮询频率（1s → 5s）
2. 前端 `setTurns` 优化：避免全量重渲染，使用 `requestAnimationFrame` 节流
3. 多标签页支持：共享 EventSource（BroadcastChannel）

## 7. 风险与权衡

| 风险 | 缓解 |
|------|------|
| DB 轮询增加 DB 负载 | 300ms 间隔 + limit 100 + idle 降频 |
| 长连接占用服务端资源 | asyncio 生成器，无阻塞；单连接 ~1KB 内存 |
| HTTP/1.1 连接数限制 | SSE 占 1 连接，比 4 请求/tick 更省 |
| EventSource 不支持自定义 header | 用 query param `last_event_id` 作为备选 |
| 同步 FastAPI + async 生成器 | 使用 `asyncio.sleep` + 短生命周期 DB session |
| 服务端重启丢失 SSE 连接 | EventSource 自动重连 + Last-Event-ID 恢复 |

## 8. 后续演进

- **Phase 2+**：如果 DB 轮询成为瓶颈，引入 Redis Pub/Sub 或 PostgreSQL LISTEN/NOTIFY
- **Phase 3+**：Agent Worker 直接写入 Redis channel，SSE 端点订阅 channel（零 DB 查询）
- **长期**：考虑 WebSocket 双向通道（确认/控制），但当前需求 SSE 足够
