# Bewize

An EdTech prototype that turns lesson content into child-friendly learning games.
Teachers write lessons, an LLM (Anthropic Claude) generates **quiz / match / fill**
games that are strictly validated and must be **approved by the teacher** before a
child can play. Children get adaptive, age-appropriate practice; parents get a
progress + learning-speed dashboard; admins manage users.

Runs with **Node 24+** (`node:sqlite`), **Express**, **EJS** and **JWT** cookies.

> On Windows PowerShell run npm via `npm.cmd` (the execution policy blocks `npm.ps1`).

## Quick start

```bash
npm.cmd install          # or: npm install
npm.cmd run seed         # creates data/bewize.db and demo data
npm.cmd start            # http://localhost:3000
```

## Demo accounts

| Role    | Sign-in                                       |
| ------- | --------------------------------------------- |
| Admin   | `admin@bewize.test` / `admin123`             |
| Teacher | `teacher@bewize.test` / `teacher123`         |
| Teacher | `teacher2@bewize.test` / `teacher123`        |
| Parent  | `parent@home.test` / `parent123`             |
| Parent  | `parent2@home.test` / `parent123`             |
| Kid     | `omar` / `omar123` (7, boy, Arabic, standard) |
| Kid     | `sara` / `sara123` (9, girl, English, standard) |
| Kid     | `max` / `max123` (8, boy, French, special needs) |

Everyone signs in on the same page (`/login`) — adults with email, kids with their
login id or name. Lesson 1 (Numbers and
Counting) ships with pre-approved games so you can play immediately.

## Configuration — `.env`

Copy `.env.example` to `.env`. Everything has a safe development default except
the values that need real accounts.

| Variable               | Default                   | Purpose                                   |
| ---------------------- | ------------------------- | ----------------------------------------- |
| `PORT`                 | `3000`                    | Web server port                           |
| `BASE_URL`             | `http://localhost:3000`   | Used for Google OAuth redirect URI        |
| `JWT_SECRET`           | dev fallback              | Signs auth cookies                        |
| `COOKIE_SECRET`        | dev fallback              | Signs flash cookies                       |
| `ANTHROPIC_API_KEY`    | *(empty)*                 | When set, games come from Claude          |
| `ANTHROPIC_MODEL`      | `claude-sonnet-4-20250514`| Claude model used for generation          |
| `GOOGLE_CLIENT_ID`     | *(empty)*                 | Google OAuth (parents)                    |
| `GOOGLE_CLIENT_SECRET` | *(empty)*                 | Google OAuth (parents)                    |

No API key? The app runs in **offline demo mode**: generation is deterministic
(arithmetic practice for math, keyword-fill quizzes for other subjects) so the
whole flow can be tested. The header shows `AI mode: OFFLINE`.

Google OAuth requires the redirect URI `<BASE_URL>/auth/google/callback` to be
registered in the Google Cloud Console.

## How a game gets to a child

1. **Teacher** creates a lesson (`/teacher` → New lesson) with title, content,
   level and pass-score. A difficulty hint for the child profile is suggested
   (`Adaptive` service).
2. Teacher clicks **Generate games** → a background job calls the AI (or offline
   generator) for each `variant × gender_theme` combination relevant to that
   lesson. Generation **never receives a child's real name or personal data** —
   only age band, profile type, gender theme and language.
3. Output is validated against a strict JSON schema (item counts, answer
   alignment, allowed content). Invalid blocks are sent back to the model for a
   fix, up to 3 attempts. A read-along **static version** is derived if the model
   omits one.
4. Teacher **reviews** on the preview page (rendered live) and approves, rejects,
   fixes with AI, or regenerates. Only `approved` games are ever visible to kids.
5. **Child** plays (quiz / match / fill), answers are graded **server-side**, an
   attempt is saved, progress + badges update, and the next lesson unlocks on a
   pass.
6. Kids who struggle get **adaptive boosters** (auto-approved drills derived from
   an approved lesson + the child's own profile). Learning speed is reported to
   parents in plain language.

## Stack & structure

- **Backend**: Express 4, `node:sqlite` (built-in, no native build), JWT + httpOnly
  cookies, cookie-parser (signed flash), bcryptjs, axios (Google token exchange).
- **AI**: `@anthropic-ai/sdk` (lazy-loaded), strict JSON validation with re-prompt.
- **Frontend**: EJS (include-based layout), vanilla JS game renderer in
  `public/js/game-lib.js` (DOM `textContent` only — no `innerHTML` from AI output),
  CSS with RTL support.
- **i18n**: English / French / Arabic, chosen on first visit or from a user's
  stored language. Arabic renders right-to-left.

```
src/
  server.js, app.js        entry + wiring
  db.js                    schema + helpers (node:sqlite)
  i18n.js                  en/fr/ar dictionary
  seed.js                  demo data (run: npm run seed)
  middleware/auth.js       JWT, cookies, roles, flash, language gate
  models/                  SQL per table (user, child, subject, lesson,
                           game, attempt, progress, badge, job, stats)
  controllers/             request handlers per role (auth, admin, teacher,
                           parent, child) — no raw SQL
  services/ai.js           generation, validation, offline fallback
  services/generator.js    background job queue for game generation
  services/grading.js      scoring, attempts, badges, unlock, game selection
  services/adaptive.js     learning-speed report, difficulty suggestion
  services/oauth.js        Google OAuth (parents)
  routes/                  thin routers mapping URL -> controller
views/                     EJS templates (roles + partials)
public/js, public/css      client game renderers + styles
data/bewize.db             SQLite DB (auto-created; delete to re-seed)
```

## Scripts

- `npm.cmd start` — run the server
- `npm.cmd run dev` — run the server (no watcher installed)
- `npm.cmd run seed` — seed demo data (skips if already seeded)
- `npm.cmd run db:init` — recreate schema tables

## Known limits (prototype)

- Generation runs in-process as a background job; no queue persistence across
  restarts (a restart discards in-flight jobs).
- The offline fallback only produces `quiz` games.
- Fixed age bands per level (5–7, 7–9, 9–11, 11–13, 13–15).
- Demonstrator, not production: no rate limiting, password reset or email.