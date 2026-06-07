# InVEST Agent CLI

The CLI connects the provider-neutral Agent runtime to a real GSMS backend,
GSMS scenes, built-in Skills, and an OpenAI-compatible model endpoint.

## Configure The Model

Configure the model ID and Base URL on the GSMS Settings page and mark it as
the default provider. The CLI reads this non-secret metadata from:

```text
GET /api/settings/llm-providers
```

API keys are intentionally not returned by GSMS. When the default Provider has
a saved key, the CLI automatically uses the server-side GSMS model proxy:

```text
POST /api/agent/chat/completions
```

The proxy decrypts and forwards the key inside GSMS; the CLI never receives it.
The proxy is disabled unless both backend and CLI processes receive the same
independent access token:

```powershell
$env:GSMS_AGENT_PROXY_TOKEN = "choose-a-long-random-token"
```

To override the GSMS Provider, set the key in the terminal:

```powershell
$env:INVEST_AGENT_API_KEY = "your-api-key"
```

Flags and environment variables override GSMS provider metadata:

```powershell
$env:INVEST_AGENT_MODEL = "your-model-id"
$env:INVEST_AGENT_BASE_URL = "https://your-provider.example/v1"
```

For a trusted local endpoint without authentication:

```powershell
$env:INVEST_AGENT_ALLOW_NO_API_KEY = "true"
```

## Start GSMS And The Agent

Start the local GSMS backend:

```powershell
cd E:\Github\GSMS
.\scripts\start_local_gsms.ps1
```

Or start the Docker backend:

```powershell
.\scripts\start_docker_gsms.ps1
```

In another terminal, start the Agent:

```powershell
cd E:\Github\GSMS
$env:INVEST_AGENT_API_KEY = "your-api-key"
.\scripts\start_invest_agent.ps1
```

To process persisted Agent sessions created by the GSMS Web application, start
the Worker instead:

```powershell
$env:GSMS_AGENT_PROXY_TOKEN = "choose-a-long-random-token"
.\scripts\start_invest_agent_worker.ps1
```

To select a scene explicitly and approve confirmed execution/report writes:

```powershell
.\scripts\start_invest_agent.ps1 -SceneId "<scene-id>" -Yes
```

When multiple GSMS scenes exist, the CLI prompts for one. It then keeps
artifacts, domain state, and recent conversation summaries across user turns.

Useful commands:

```text
/status
/scenes
/help
/exit
```

Example conversation:

```text
you> 我想评估这个场景当前的碳储量，请选择合适模型并检查已有数据
you> 展示当前状态
you> 我确认执行这个校验通过的方案
you> 检查运行结果并生成报告
```

Reports are written under:

```text
<workspace>/runs/<job-id>/report.md
```
