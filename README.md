# CTRL v2 — with AXIS, your scheduling co-pilot

Mobile-first PWA with browser-local personal data and a small stateless Node/Express AI relay.
AXIS plans your week deterministically (no AI in the slot-fitting), while a free-tier
LLM (Gemini → Groq automatic failover) handles natural language: task classification,
disruption dialogs, and morning/evening briefings.

## Stack

- **Server:** Node 22+, Express. It serves the PWA and relays AI calls without storing personal data.
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
| `PORT` | default 8787 |

Never commit `.env` (already gitignored).

## Deploy (DigitalOcean droplet)

1. Point DNS: `ctrl.nimit.site` A-record → `167.71.228.73`.
2. Copy this folder to the droplet, then `npm install --omit=dev`.
3. Create `.env` from `.env.example` and fill in only the AI provider keys you want to use.
4. `pm2 start server/index.js --name ctrl && pm2 save` (survives reboot).
5. Reverse-proxy `ctrl.nimit.site` → `127.0.0.1:8787` with HTTPS (certbot). HTTPS is
   required for service worker + push.
6. On iPhone: open in Safari → Share → **Add to Home Screen**.

## Privacy and storage

Each browser installation keeps its own profile, tasks, plans, preferences, and AXIS
history in browser local storage. The server does not have endpoints to read or write
that data. Existing CTRL v2 browser data is migrated locally on first use.

AI prompts are sent to the configured provider only to produce the current response;
they are not written to the CTRL server database. Local browser storage is not a
cross-device backup, so clearing Safari website data clears that device's CTRL data.

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
POST /api/chat                 stateless AXIS response; no request is persisted
POST /api/tasks/classify       stateless natural-language task classification
```

## Notes

- The local planner keeps fixed blocks separate from scheduled tasks.
- If both AI providers fail, the local planner and task management continue to work.
