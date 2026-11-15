# HotBox2

Hot Wheels delivery alerts for collectors. Someone spots a chase car on an
endcap, reports it, and everyone watching that shop or that area finds out
within a minute.

Built from [`docs/requirements.md`](docs/requirements.md) (v1.3) and
[`docs/test-checklist.md`](docs/test-checklist.md).

## What actually runs

| Piece | Stack | Port |
| --- | --- | --- |
| API | Kotlin, JDK built-in HTTP server, JSON file persistence | 8080 |
| Web | React 18 + TypeScript + Vite | 5173 |

No database server, no message broker, no paid services. State is a single
atomically-written JSON file, so the whole thing starts in under a second and
costs nothing to host.

## Run it

You need JDK 21+ and Node 20+. The Kotlin compiler is not vendored; point
`KOTLINC` at a Kotlin 2.x distribution (JDK 25 needs 2.4.x, older compilers
crash on it).

```bash
# 1. Build the backend
KOTLINC=/path/to/kotlinc ./backend/build.sh

# 2. Start the API
./scripts/start.sh            # http://localhost:8080

# 3. Build and serve the web client
cd frontend && npm install && npm run build && cd ..
./scripts/web-start.sh        # http://localhost:5173

# 4. Optional: believable community data to click through
./scripts/demo.sh
```

Stop with `./scripts/stop.sh` and `./scripts/web-stop.sh`.

The client calls `/api/...`; Vite proxies that to the backend and strips the
prefix, so the browser only ever sees one origin.

## Try the product loop

```bash
./scripts/demo.sh          # creates 6 reports across Berlin shops
```

Open <http://localhost:5173>, then:

- **Near me** — the seeded reports, newest first, with the distance filter and
  category filter.
- **Report** — submit a sighting. A second report for the same shop and
  category within 60 minutes is merged into the first instead of raising a
  second alert.
- **Account** — sign in as `ben@example.com` (Trusted) or `ada@example.com`
  (Confirmed) to see the tier and point history.
- **Moderation** — sign in as `ally@moderator.hotbox` to see disputed reports,
  flagged shops, and the p95 delivery measurement.

Sign-in is by email address alone, with no password, because there is no mailer
(see *Not production-ready* below).

## Tests

```bash
./scripts/smoke.sh
```

58 end-to-end checks against a **real** backend, each labelled with the
requirement it traces to. The script boots its own instance on port 8099
against `data/smoke.json`, so it is deterministic and never touches your
development data. It also restarts the backend mid-run to prove that reports,
sessions, and the anonymous-evidence counters survive a restart.

Last run: **58 passed, 0 failed**.

To point the suite at an already-running instance instead, pass a base URL —
but that instance must have a fresh database, since the suite asserts on
first-run state:

```bash
./scripts/smoke.sh http://localhost:8080
```

## Layout

```
backend/src/main/kotlin/hotbox/
  Main.kt      entry point; reads PORT and HOTBOX_DATA
  Http.kt      routing, auth guards, role and tier gates
  Api.kt       every endpoint
  Services.kt  merge window, scoring, alert dispatch, predictions
  Store.kt     atomic JSON snapshot read/write
  Seed.kt      50 shops, 4 categories, 4 cases
  Json.kt      small JSON parser and writer
frontend/src/
  App.tsx      all screens
  lib/api.ts   typed client
  lib/hooks.ts session, geolocation, async helper
  components/ui.tsx
scripts/        start, stop, web-start, web-stop, smoke, demo
data/           hotbox.json (state), logs, pidfiles
```

## Rules the code enforces

These are the parts that are easy to get wrong, so they are worth stating
plainly. Each is covered by a named test in `scripts/smoke.sh`.

- **Tier gates.** Reporting needs 15 points. Confirming, disputing, and shop
  work need 30 (Trusted). Confirming is a judgement, so it is gated exactly like
  disputing — a merely-verified collector gets 403.
- **60-minute merge.** A second report for the same shop and category inside
  60 minutes becomes a confirmation on the first report, and raises no second
  alert.
- **Anonymous evidence is not a confirmation.** Anonymous reports are stored
  and counted as `anonymousEvidence` so moderators can see a pattern, but they
  can never be attributed and never raise the confirmation count. An anonymous
  confirmation attempt is refused.
- **No alert from an unconfirmed shop.** A shop awaiting confirmation accepts
  reports (AC-031) but generates no alert (BR-004). When a second collector
  confirms the shop, the held-back subscribers are notified (REQ-F-060).
- **One alert per report.** Matching on both a shop subscription and a radius
  subscription still yields a single alert.
- **Fallback.** No push token means the alert falls back to email, and the
  fallback is visible in the metrics.
- **Withdrawal** is allowed for 15 minutes and sends a correction alert.
- **Unlisting is human-only.** Moderator removal and business opt-out always
  need a human and a recorded reason; there is no automatic removal.

## Not production-ready

This is a working MVP against the requirements, not a deployable service. The
gaps are deliberate and visible rather than hidden:

- **No mailer and no push provider.** `POST /auth/register` returns
  `devVerificationToken` in the response, and sign-in accepts a bare email
  address. Both must be replaced with real email delivery and a verified
  link or token before this is exposed to anyone.
- **Alerts are simulated.** Delivery is recorded, not performed.
- **Single-file storage.** Correct for one process; it does not survive two
  backends writing at once and is not a substitute for a real database.
- **No account deletion** endpoint, and no password reset.
- **Measurement retention is not yet enforced.** `latencies` stores bare
  durations with no timestamps, so the 90-day cutoff in REQ-NF-041 cannot be
  applied to it; `/operator/purge-expired` only prunes reports.
- **Prediction is a simple popularity fallback** for cases with fewer than the
  10 reports REQ-F-077 requires, not a learned model.

Fixing the auth and delivery paths is the prerequisite for anything else.
