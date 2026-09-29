# 🎵 Vinyl Vault

A **deliberately insecure** retro record shop, built as a self-hosted security
training target in the spirit of [OWASP Juice Shop](https://github.com/juice-shop/juice-shop).
It is a *brand-new shop* with its **own set of vulnerabilities** — same classes
you'd expect from the OWASP Top 10, but placed in different endpoints and often
implemented in a different way than Juice Shop does.

It keeps Juice Shop's deployment philosophy: one command with Docker Compose,
Prometheus metrics on `/metrics`, and a provisioned **Grafana dashboard**.

> ⚠️ **This application is intentionally vulnerable. Never deploy it on a public
> network, and never reuse its code.** Run it locally / in an isolated lab.

---

## Quickstart

### Option A — Docker Compose (app + Prometheus + Grafana)

```bash
docker compose up --build
```

| Service      | URL                              | Notes |
|--------------|----------------------------------|-------|
| Vinyl Vault  | http://localhost:3000            | the shop |
| Metrics      | http://localhost:3000/metrics    | Prometheus format |
| Prometheus   | http://localhost:9090            | targets & queries |
| Grafana      | http://localhost:3001            | dashboard auto-provisioned (login `admin`/`admin`, or anonymous viewer) |

The Grafana dashboards are **auto-provisioned**:
- **"Vinyl Vault — Shop & Security Overview"** — request rates, latency,
  response codes, order value, login attempts (great for spotting brute force),
  and a live count of which challenges have been solved.
- **"Vinyl Vault — CTF Scoreboard"** — per-team score, standings, score over
  time, and a per-challenge solve state per team.

### Option B — plain Node

```bash
npm install
npm start        # http://localhost:3000
```

(You'll only get the app; run Prometheus + Grafana separately if you want the
dashboards.)

---

## What's inside

```
vinyl-vault/
├── server.js                 # Express app; every "VULN:" comment = an intentional flaw
├── src/
│   ├── db.js                 # SQLite schema + demo seed (weak MD5 hashing)
│   └── metrics.js            # Prometheus metrics (prom-client)
├── public/                   # vanilla-JS single-page shop (client-side XSS sinks)
├── ftp/                      # download folder (path-traversal target)
├── monitoring/
│   ├── prometheus/prometheus.yml
│   └── grafana/provisioning/ # datasource + dashboard, auto-loaded
├── Dockerfile
└── docker-compose.yml
```

**Stack:** Node.js + Express, SQLite (`better-sqlite3`), vanilla-JS front-end,
`prom-client` for metrics — chosen to mirror Juice Shop's "clone, compose, go"
workflow while staying small enough to read end-to-end in one sitting.

---

## The vulnerabilities (short version)

Injection (SQLi in search + login, `eval`'d coupons), broken access control
(IDOR on orders & users, mass-assignment privilege escalation, a forgeable
`X-User-Role` admin check), stored & reflected XSS, insecure file upload, path
traversal, weak auth (unsalted MD5, `alg:none` JWT, committed JWT secret, no
rate limiting), a config/debug endpoint that leaks secrets, open CORS, and
verbose error stack traces.

Full walkthrough with exact payloads and OWASP mapping: see
[`CHALLENGES.md`](./CHALLENGES.md).

Each solved challenge increments
`vv_challenges_solved_total{challenge="..."}`, so you can watch your progress on
the Grafana panel **"Challenges solved by type."**

---

## Teams & CTF scoring

Play it like a capture-the-flag: every challenge is worth points, and the
**first** time a team triggers a flaw its score goes up (repeats by the same
team don't stack). Solves are attributed to the acting team's session.

There are **40 challenges** split across **4 difficulty tiers of 10**, and
harder tiers are worth more:

| Tier | Points each | Challenges | Subtotal |
|------|-------------|-----------|----------|
| Easy | 10 | 10 | 100 |
| Medium | 25 | 10 | 250 |
| Hard | 40 | 10 | 400 |
| Insane | 60 | 10 | 600 |
| **Total** | | **40** | **1350** |

**First-blood bonus.** The *first team to solve anything* in a given tier earns a
one-off bonus on top of the challenge points — Easy +5, Medium +10, Hard +20,
Insane +30. It's awarded once per tier, globally, so there's a race to draw
first blood in each category. Awards show on the scoreboard and roll up in
Grafana via `vv_first_blood_total`.

**Celebrations.** Whenever your team lands a challenge, the app fires a burst of
confetti, a banner across the top ("Gefeliciteerd! Challenge behaald: …") and a
short victory sound — with a louder fanfare and red-gold confetti for a first
blood. The browser polls the server a few times a minute, so the celebration
fires even when the exploit was launched from `curl` or a separate tool rather
than the shop UI. (Sounds are synthesised in-browser, so they work offline; your
browser may need one click first to allow audio.)

The tiers span deliberately different vulnerability classes — from simple access
control, business logic and reflected XSS at the easy end, through SQLi
variants, SSRF, prototype pollution and command injection, up to SSTI, XXE,
JWT confusion and a full privilege-escalation chain at the insane end. The full
list with solutions is in `CHALLENGES.md` (operators only).

**In-app scoreboard:** open **🏆 Scoreboard** in the shop, or `GET /api/teams/scoreboard`.

**HTTP Lab:** open **🧪 HTTP Lab** in the shop for a built-in request console —
pick the method, type a URL and headers, and send a JSON or raw body with live
JSON validation and syntax highlighting on both the request and the response.
Your team's `X-Team-Token` (and, optionally, your shop-login `Authorization`
header) is attached automatically, so anything you solve from the Lab is
credited to your team and triggers the usual confetti. Use same-origin paths
like `/api/...`; cross-origin URLs may be blocked by the browser.

**Tools:** open **🛠 Tools** for offline helpers — decode/forge JWTs (HS256 with
the weak secret, or `alg:none`), Base64 encode/decode, and URL-encode. "Build
token → Use in HTTP Lab as Bearer" wires a forged token straight into a request.

### Difficulty modes (beginner-friendly, set by operators)

Every team plays in one of three modes, and **only a game operator** can switch
a team's mode:

- **learn** — hints are free (no point cost), per-challenge **HTTP Lab
  templates** are offered on every tier, category **primers** and a
  "start here" path are shown, and verbose errors / SQL echo stay on.
- **compete** (default) — hints cost points, templates appear on easy/medium
  only, scored play.
- **hardcore** — no hints, no templates, no primers, and the target behaves
  realistically (no SQL echo, terse errors). For advanced players who want a
  harder, quieter target.

Extra beginner scaffolding (learn/compete): each solved challenge reveals a
**"why it worked & how to fix"** card, cards show their **vulnerability
category** and **dependencies** ("builds on …"), and good first challenges get a
**⭐ Start here** badge. None of this changes the exploit itself — it lowers the
on-ramp without making the challenge easier.

### Operator console (game admins)

Open **🔧 Operator console** from the team gate. Game operators are a **separate,
secure account system** — deliberately *not* the shop's vulnerable `admin` role,
so no challenge can escalate into game control. From the console you can set each
team's mode, create more operator accounts, and reset all scores for a new round.

Default operator login: **`gameadmin` / `vinylvault-ops`** (override with
`VV_GAMEADMIN_USER` / `VV_GAMEADMIN_PASSWORD`). Change it before any shared use.

### Match clock (game timer)

The competition runs on a clock that operators control from the **⏱ Match
clock** panel in the operator console:

- **The game is stopped by default.** Teams can create/join a team, but until
  an operator starts the round they see a **waiting screen** — no challenge
  scores while stopped.
- **Start** takes a duration in minutes; **Pause** / **Resume** freeze and
  resume the countdown; **Stop** ends the round immediately; **Reset** returns
  to the pre-game waiting state.
- **Solves only count while the clock is running.** When the timer hits 0:00 the
  game ends automatically and teams can no longer score (they see a "time's up"
  screen).
- **Scoreboard freeze:** during the **last 15 minutes** (and after the game ends,
  until the winner is revealed) the standings are hidden from teams — they can't
  see who's ahead, their own score, or which challenges they've solved. Points
  are still being recorded; only the *view* is frozen, so the finish stays tense.
- **Reveal:** the operator's **🏁 Results** page shows the winner and the full
  ranked list (operators can always see it). Clicking **Reveal winner** lifts the
  freeze for everyone — teams can then see their solved challenges and score
  again.

So the normal flow is: teams join → operator **Start**s the clock → teams play →
final 15 min freeze → clock ends → operator opens **Results** and **Reveal**s the
winner.

**Challenges board & hints:** open **🎯 Challenges** in the shop. It shows every
challenge as a card with a short title, a deliberately vague, spoiler-free
description, the points on offer, and whether *your team* has solved it. It
never reveals how to solve anything.

Stuck? Each card has a **💡 Hint** button. The **first hint per challenge is
free**; every hint after that deducts points from your team's score (shown on
the button, e.g. `−5 pts`). Hints get progressively more explicit, so you only
pay for as much help as you need. Unlocked hints are remembered per team.

| Endpoint | What it does |
|----------|--------------|
| `GET /api/challenges` | board: titles, descriptions, per-team solved status, and only the hints your team has unlocked |
| `POST /api/challenges/:id/hint` | unlock the next hint (first free, then costs points) |

### The team gate

When you open the app you're not in the shop yet — you land on a **team gate**
with two options:

- **Log in as a team** — enter your team name + join code.
- **Create a team** — pick a name and get a join code to share with teammates.

Either way you get a **team session** (a signed `team_token`, stored in the
browser and sent as the `X-Team-Token` header), and only then does the shop,
challenges board, and scoreboard unlock. Use **Leave** in the header to end the
session and return to the gate. No teams are seeded — the scoreboard starts
empty and fills as people create teams.

The team session is separate from the shop's own (deliberately weak) user
login: log in as a team to track your score, then attack the shop — which has
its own vulnerable accounts — inside.

**Team endpoints**

| Endpoint | What it does |
|----------|--------------|
| `POST /api/teams` `{name}` | create a team → returns `join_code` + `team_token` |
| `POST /api/teams/login` `{name, join_code}` | log in as a team → returns `team_token` |
| `GET /api/teams/me` | current team session (or `null`) |
| `GET /api/teams/scoreboard` | ranked standings |
| `GET /api/teams/:id` | one team's solved challenges |

### Two ways to run a competition

**1. Many teams, one deployment (default).** Everyone hits the same instance;
each team logs in at the gate and hunts. `docker compose up` is all you need.
Per-team metrics (`vv_team_score`, `vv_team_challenge_solved`) feed the CTF
Scoreboard dashboard.

**2. One deployment per team, aggregated (single Prometheus + single Grafana).**
Give each instance `VV_DEFAULT_TEAM="<team>"`; all of its metrics are then
labelled `team="<team>"`, and unauthenticated solves credit that team too. A
single Prometheus scrapes every instance and one Grafana rolls them up:

```bash
docker compose -f docker-compose.ctf.yml up --build
```

That example spins up three isolated team instances (ports 3000/3010/3020) plus
one shared Prometheus (9090) and Grafana (3001). Because the `team` label comes
from the app in both modes, the same `sum by (team) (vv_team_score)` query
works either way.

#### Generating the CTF stack

Don't hand-edit the CTF files — generate them for your team count:

```bash
node scripts/gen-ctf.js --teams 5
# or name the teams explicitly:
node scripts/gen-ctf.js --names "Team Red,Team Blue,Team Green"
```

The generator writes `docker-compose.ctf.yml` and
`monitoring/prometheus/prometheus.ctf.yml` with, per team: its own docker
network (teams cannot reach each other's instances), a random JWT secret, a
1 CPU / 512M resource cap, and a healthcheck on `/api/health`. Each instance
also gets a 10-port slot (3000, 3010, …).

The generated compose file contains secrets (JWT + Grafana admin password), so
it is gitignored — keep it on the operator machine and regenerate per event.
The Grafana admin password is printed in the file itself.

Reset the whole competition (wipes every team's DB, scores and solve history):

```bash
scripts/reset-ctf.sh
```

Operator checklist for event day: snapshot the host VM before teams connect,
keep `CHALLENGES.md` off any shared location (it's the solutions guide), and if
teams are remote, put the stack behind a VPN or reverse proxy with HTTPS — the
app is deliberately vulnerable and must never touch the public internet.

---

## How this differs from Juice Shop

- **Different domain & data model** — a record shop (albums, artists, coupons,
  test pressings) rather than a juice store.
- **Different placement of flaws** — e.g. SQLi lives in product *search* and in
  the *email* field of login; privilege escalation is via *mass assignment*
  on registration/profile and a *header-trust* admin check rather than Juice
  Shop's specific mechanisms.
- **Different implementations** — coupons are a server-side `eval()` of a stored
  formula; JWTs accept `alg:none`; passwords use unsalted MD5; the password
  reset chains off an IDOR that leaks the security answer.
- **Same operational shape** — Docker Compose, `/metrics`, and a Grafana
  dashboard, so it slots into the same demos and CI/lab setups.

---

## Resetting state

```bash
docker compose down -v      # wipes the SQLite + Grafana/Prometheus volumes
docker compose up --build
```

For plain Node, delete the `data/` directory to re-seed.

## License

MIT — for education and authorized testing only.
