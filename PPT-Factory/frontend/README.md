# PPT Factory Frontend

This is the Next.js frontend for the PPT Factory workflow.

## Storage Model

The public app uses a local-first storage model:

- Users choose a writable project save folder before generation starts.
- Projects, pipeline history, and generated file metadata are stored under `<your-project-folder>/.local-store/`.

## Environment Variables

Copy `frontend/.env.local.example` to `frontend/.env.local` if you want to add optional configuration.

Optional variables:

- `ANTHROPIC_API_KEY`

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production Validation

```bash
npx next build --webpack
```

Webpack build is currently the most reliable validation path in this repo.
