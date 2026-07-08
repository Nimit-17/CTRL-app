# CTRL v2 — with AXIS, your scheduling co-pilot

Single-user mobile PWA (iPhone-first) + Node/Express/SQLite backend.
AXIS plans your week deterministically (no AI in the slot-fitting), while a free-tier
LLM (Gemini → Groq automatic failover) handles natural language: task classification,
disruption dialogs, and morning/evening briefings.

## Stack

- **Server:** Node 22+, Express, better-sqlite3 (single file DB in `data/ctrl.sqlite`), node-cron, web-push
- **LLM:** Gemini `gemini-2.5-flash` primary → Groq `llama-3.3-70b-versatile` failover (both free tier, keys server-side only)
- **Frontend:** vanilla JS PWA in `public/` — no build step

## Run locally

```bash
npm install
cp .env.example .env          # fill in keys (see below)
npx web-push generate-vapid-keys   # paste into .env
npm start                     # → http://localhost:8787
```

## .env

| var | where to get it |
|---|---|
| `GEMINI_API_KEY` | aistudio.google.com → Get API key (starts with `AIza…`) — do NOT enable billing |
| `GROQ_API_KEY` | console.groq.com → API Keys |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` (run once) |
| `VAPID_SUBJECT` | `mailto:you@example.com` |
| `OWNER_TOKEN` | optional — any secret string; if set, the app prompts for it once and sends it as `X-Owner-Token` |
| `PORT` | default 8787 |

Never commit `.env` (already gitignored, along with `data/`).

## Deploy (DigitalOcean droplet)

1. Point DNS: `ctrl.nimit.site` A-record → `167.71.228.73`.
2. Copy this folder to the droplet, then `npm install --omit=dev`.
3. Create `.env` from `.env.example`, fill keys + VAPID.
4. `pm2 start server/index.js --name ctrl && pm2 save` (survives reboot).
5. Reverse-proxy `ctrl.nimit.site` → `127.0.0.1:8787` with HTTPS (certbot). HTTPS is
   required for service worker + push.
6. On iPhone: open in Safari → Share → **Add to Home Screen** → open the installed app →
   More → Settings → **Enable Notifications** (iOS 16.4+ only allows web push for
   installed PWAs).

## First launch & data migration

On first load the frontend reads the old `ctrl_v8` localStorage (and the legacy key
chain), POSTs it to `/api/sync`, and the server seeds the SQLite DB **only if empty**.
Nothing is deleted client-side; localStorage keeps acting as an offline cache. The
server DB is the source of truth from then on — republish/redeploys can no longer wipe
data, and it syncs across devices.

## Daily flow

- **Plan tab** → "⚡ Plan my week": the deterministic scheduler packs tasks around your
  fixed blocks inside your day window (default 08:00–24:00), ordered by arc-deadline
  urgency → priority → duration. The LLM only writes the one-paragraph rationale.
- **Tasks tab** → Quick Add: type "dentist thursday 4pm" → AXIS classifies it as a dated
  one-off (confirm before save); "meditate daily" → recurring.
- **AXIS tab**: talk to it. "I'm 2h behind" → it identifies affected items and asks
  keep / move / drop for each; moves use the scheduler's next-viable-slot proposal and
  nothing is rewritten until you confirm. Mention a new sleep schedule and it updates
  your day window.
- **Briefings**: 08:00 morning briefing + 21:00 evening check-in (Asia/Kolkata), posted
  into the AXIS chat and pushed to your phone. Times editable in More → Settings
  (restart server to apply). Test manually:
  `curl -X POST localhost:8787/api/push/test-morning`

## API map

```
POST /api/sync                 seed DB from legacy localStorage (once) / GET full state
CRUD /api/tasks                + POST /api/tasks/classify (NL → structured task)
     /api/tasks/:id/complete   check/counter completion
GET/POST /api/prefs            + CRUD /api/prefs/blocks (fixed blocks)
GET/POST /api/plan             deterministic weekly plan (+LLM rationale)
PUT  /api/plan/item/:id        move / done / drop a scheduled item
POST /api/plan/propose         next viable slot for a task
GET/POST /api/chat             AXIS conversation (disruptions, prefs, planning)
POST /api/push/subscribe       store web-push subscription
POST /api/push/test-morning|test-evening   fire a briefing now
GET  /api/health               { ok, today, rss_mb }
```

## Notes

- Scheduler never double-books fixed blocks; unplaceable tasks are reported as
  "Couldn't fit" instead of being silently dropped.
- If both LLM providers fail, every AI feature degrades gracefully (schedule still
  generates, chat says it's offline) — the app never crashes on LLM errors.
- Provider used for each call is logged (`[brain] served by …`) — useful for verifying
  the failover.
