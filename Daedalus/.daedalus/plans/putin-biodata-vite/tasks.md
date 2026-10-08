# Execution Tasks

## Setup
- [ ] **T1: Scaffold Vite project**  
  Files: `jojo/package.json`, `jojo/vite.config.ts`, `jojo/index.html`, `jojo/src/main.tsx`, `jojo/src/App.tsx`, `jojo/src/App.css`  
  Command: `npm create vite@latest jojo -- --template react-ts --no-interactive`  
  Verification: `jojo/package.json` exists, `jojo/src/App.tsx` exists  
  PRD: Infrastructure for F1, F2

- [ ] **T2: Install dependencies**  
  Files: `jojo/node_modules/`, `jojo/package-lock.json`  
  Command: `npm install` (in `jojo/`)  
  Verification: `jojo/node_modules` exists, exit code 0  
  PRD: Infrastructure for F1, F2

## Content
- [ ] **T3: Download Putin photo**  
  Files: `jojo/public/putin.jpg`  
  Action: Search Wikimedia Commons for openly-licensed Putin photo, download into `jojo/public/`  
  Verification: `jojo/public/putin.jpg` exists, file size >0  
  PRD: F1 (photo display)

- [ ] **T4: Write biodata component**  
  Files: `jojo/src/App.tsx`  
  Action: Replace default App component with Putin biodata display (name, title, birth date, photo, career paragraphs in Indonesian)  
  Verification: `App.tsx` contains Putin data object, renders photo + text  
  PRD: F1 (all fields)

- [ ] **T5: Style biodata card**  
  Files: `jojo/src/App.css`  
  Action: Center card, responsive layout, professional styling, mobile-first breakpoints  
  Verification: `App.css` contains card styles, media queries for responsive  
  PRD: F2 (responsive layout)

## Verification
- [ ] **T6: Build and verify**  
  Files: `jojo/dist/`  
  Command: `npm run build` (in `jojo/`)  
  Verification: Exit code 0, `jojo/dist/index.html` exists, no TypeScript errors  
  PRD: All features (F1, F2) must compile and bundle
