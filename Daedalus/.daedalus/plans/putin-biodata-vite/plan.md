# Putin Biodata Vite Project

## Goal
Build a single-page static website displaying Vladimir Putin's basic biographical data (name, title, birth date, photo, two-paragraph career summary) using Vite + React + TypeScript. Content in Indonesian, professional presentation, responsive design.

## Scope / Non-goals
- In scope: Single-page biodata with photo, static content, responsive layout, Vite build
- Non-goals: Multi-page site, interactive features, CMS, multiple languages, deep political analysis

## Decisions
- Biodata scope → Dasar (name, title, birth date, photo, 1-2 paragraph career summary)
- Data source → Static content in React component (assumed)
- Photo source → Wikimedia Commons openly-licensed image, downloaded into project (assumed)
- Language → Indonesian (assumed)
- Styling → Basic CSS modules, clean professional card layout (assumed)

## Steps
1. Create `jojo/` directory and run Vite generator (files: `jojo/package.json`, `jojo/vite.config.ts`, `jojo/index.html`, `jojo/src/main.tsx`, `jojo/src/App.tsx`, `jojo/src/App.css`)
2. Install dependencies in `jojo/` (command: `npm install`)
3. Search and download Putin photo from Wikimedia Commons (file: `jojo/public/putin.jpg`)
4. Write biodata content into `jojo/src/App.tsx` — replace default component with Putin data display (file: `jojo/src/App.tsx`)
5. Style the biodata card in `jojo/src/App.css` — centered card, responsive, professional (file: `jojo/src/App.css`)
6. Verify build succeeds (command: `npm run build` in `jojo/`)

## Acceptance criteria
- `jojo/dist/` exists and contains built static site
- Opening `jojo/dist/index.html` shows Putin's name, title, birth date, photo, and two-paragraph career summary
- Layout is responsive (card centers on desktop, adapts to mobile)
- `npm run build` exits with code 0, no TypeScript or build errors
