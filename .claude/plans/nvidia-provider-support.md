# Plan: 支持 NVIDIA 免费 API 作为 LLM Provider

## 背景

NVIDIA 提供 OpenAI 兼容的免费 API（`https://integrate.api.nvidia.com/v1/chat/completions`）。
GSMS 已有的 `OpenAICompatibleAdapter` 和后端 proxy 机制天然支持任何 OpenAI 兼容端点，
只需在前端供应商列表中加入 NVIDIA 并自动填充其默认配置即可。

## 修改方案

### 1. `frontend/src/lib/repos/settingsRepo.ts`

在 `PROVIDERS` 数组中加入 `'NVIDIA'`：

```ts
export const PROVIDERS = ['OpenAI', 'Anthropic', 'DeepSeek', 'Qwen', 'NVIDIA', 'Local', 'Custom']
```

新增 NVIDIA 默认配置映射：

```ts
export const PROVIDER_DEFAULTS: Record<string, { url: string; id: string } | undefined> = {
  OpenAI: { url: 'https://api.openai.com/v1', id: 'gpt-4o' },
  NVIDIA: { url: 'https://integrate.api.nvidia.com/v1', id: 'moonshotai/kimi-k2.6' },
}
```

### 2. `frontend/pages/settings.tsx`

当用户切换供应商时，自动填充该供应商的默认 URL 和模型 ID：

```ts
<Select
  value={form.provider}
  options={PROVIDERS.map(p => ({ value: p, label: p }))}
  onChange={provider => {
    const defaults = PROVIDER_DEFAULTS[provider]
    setForm({
      ...form,
      provider,
      url: defaults?.url ?? form.url,
      id: defaults?.id ?? form.id,
    })
  }}
/>
```

### 不改的部分

| 组件 | 原因 |
|------|------|
| 后端 `settings.py` | provider 字段是自由文本，无硬编码 |
| 后端 `llm_proxy.py` | URL 归一化已兼容 NVIDIA 路径 |
| Worker / CLI | `OpenAICompatibleAdapter` 是通用的 |
| 数据库 | `LlmProvider.provider` 是 `String(50)`，无枚举约束 |

## 验证

1. 前端设置页 → 添加模型 → 供应商选 "NVIDIA" → URL 和模型 ID 自动填充
2. 填入 NVIDIA API Key → 测试连接 → 通过
3. 设为默认 → 工作台 Agent 发消息 → 正常回复
