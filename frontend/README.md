# Frontend

Next.js desktop Workbench frontend.

## Run

```powershell
cd frontend
npm install
$env:NEXT_PUBLIC_API_URL = "http://127.0.0.1:8000"
npm run dev -- --port 3000
```

Open:

```text
http://localhost:3000/workbench
```

## Verify

```powershell
npx tsc --noEmit
```

`npm run build` and `next dev` may hang on Windows due to Next.js cache/worker behavior. If that happens:

```powershell
npm run clean
npx tsc --noEmit
```

Then stop stale node/npm/next processes before starting a new dev server.

## Scope

The UI targets desktop and laptop workbench use. It does not need phone layout support.
