# ⛳️ Golf Scorecard

A tiny, offline-first **PWA** for keeping tally on a golf round in real time.
Track gross scores hole by hole and see live **handicap-based Stableford
points** for every player. No accounts, no backend, no build step — open it and
play. Installs to your home screen and keeps working with no signal on the
course.

## Features

- **Stableford scoring with handicaps** — each player's handicap is spread
  across the holes by **Stroke Index (SI)**, and points are awarded against
  *net* score (net par = 2 pts, net birdie = 3, net bogey = 1, …).
- **Live leaderboard** — sorted by points (gross strokes break ties), with a
  "thru" hole count, updated on every tap.
- **Two ways to score** — a focused **Hole** view with tap steppers per player,
  or a full **Scorecard** table showing every hole's gross + points and the
  running totals.
- **Remembered courses** — name a course once and its per-hole **par + SI** are
  saved (par, stroke index, and **slope rating**). Pick it next time to skip
  setup; any par/SI/slope you tweak is written back to the course — and because
  rounds read their course live, editing a course updates its existing
  scorecards too.
- **Real-time save** — state is written to `localStorage` on every change, so a
  reload or an accidental close never loses a stroke.
- **Installable & offline** — web app manifest + service worker cache the shell,
  so it launches standalone and runs without a connection.
- **Mobile-first** — portrait layout, large tap targets, safe-area padding for
  notched phones.

## How scoring works

```
courseHandicap  = round(HCP * slope / 113)   # 18 holes  (halved for 9)
strokesOnHole   = floor(ch / holes) + (SI <= (ch mod holes) ? 1 : 0)
net             = gross - strokesReceived
points          = max(0, par - net + 2)
```

The course **slope** (55–155, 113 = neutral) adjusts the handicap index into the
**course handicap** each player actually plays off; the scorecard shows both
(`HCP 18 → 21`). Example at neutral slope: a handicap of 36 over 18 holes gives 2
strokes on every hole, so a gross 6 on a par 4 is a net 4 → **2 points**.

> Simplified Stableford: it uses handicap index, slope, and stroke index, but
> not course rating, so it won't compute an official competition allowance.

## Run it locally

It's a static site — no dependencies.

```bash
# serve it (service worker + manifest need http, not file://)
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy

Shipped as a static site behind nginx, with a Fly.io config included.

```bash
# Docker (serves on :80)
docker build -t golf-scorecard .
docker run -p 8080:80 golf-scorecard      # http://localhost:8080

# Fly.io  → https://golftally.fly.dev
fly deploy
```

- `nginx.conf` sets the correct `application/manifest+json` MIME type and
  disables caching on `index.html` / `sw.js` / `app.js` so updates ship
  instantly while other assets stay cacheable.
- `fly.toml` runs a single shared-cpu-1x machine in `arn` (Stockholm) that
  scales to zero when idle — fine because all state is client-side.

Being fully static, it also drops onto GitHub Pages, Netlify, Vercel, or
Cloudflare Pages with no build command.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell; mounts into `#app`. |
| `app.js` | All logic — state, Stableford scoring, course memory, views, rendering. |
| `styles.css` | Styling (mobile-first). |
| `manifest.webmanifest` | PWA metadata for install. |
| `sw.js` | Service worker — offline cache of the app shell. |
| `icons/icon.svg` | App icon (maskable). |
| `Dockerfile`, `nginx.conf`, `.dockerignore` | Static hosting via nginx. |
| `fly.toml` | Fly.io deployment config. |

## License

MIT
