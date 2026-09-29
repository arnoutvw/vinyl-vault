'use strict';

/*
 * ============================================================================
 *  VINYL VAULT  --  deliberately insecure retro record shop
 * ============================================================================
 *
 *  A training target in the spirit of OWASP Juice Shop. Every "VULN:" comment
 *  below marks an intentional weakness. Do NOT deploy this on a public network
 *  or reuse any of this code in a real application.
 *
 *  Run it, attack it, learn from it. See CHALLENGES.md for a hunting guide.
 * ============================================================================
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const { db, weakHash, strongVerify, strongHash, getConfig, setConfig } = require('./src/db');
const { register, httpMetricsMiddleware, metrics } = require('./src/metrics');

const app = express();
const PORT = process.env.PORT || 3000;

// VULN: hard-coded, guessable JWT secret checked into the repo.
const JWT_SECRET = process.env.JWT_SECRET || 'vinyl-vault-dev-secret';

// Game-operator tokens use a SEPARATE, strong, per-install secret (persisted in
// the config table). This is intentionally NOT the weak JWT_SECRET above, so no
// challenge (alg:none, weak-secret forge, etc.) can mint an operator token.
const GAMEADMIN_SECRET = getConfig('gameadmin_secret') || require('crypto').randomBytes(32).toString('hex');

function signGameAdminToken(admin) {
  return jwt.sign({ aid: admin.id, uname: admin.username, kind: 'gameadmin' }, GAMEADMIN_SECRET, {
    algorithm: 'HS256',
    expiresIn: '12h',
  });
}
function readGameAdmin(req) {
  const h = req.headers['authorization'] || '';
  const raw = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-ops-token'] || null);
  if (!raw) return null;
  try {
    const p = jwt.verify(raw, GAMEADMIN_SECRET, { algorithms: ['HS256'] });
    if (p && p.kind === 'gameadmin' && p.aid) {
      return db.prepare('SELECT id, username FROM game_admins WHERE id = ?').get(p.aid) || null;
    }
  } catch (_) { /* invalid/expired */ }
  return null;
}
function gameAdminRequired(req, res, next) {
  const admin = readGameAdmin(req);
  if (!admin) return res.status(401).json({ error: 'operator login required' });
  req.gameAdmin = admin;
  next();
}
const VALID_MODES = ['learn', 'compete', 'hardcore'];
function teamMode(team) {
  return team && VALID_MODES.includes(team.mode) ? team.mode : 'compete';
}

// ---------------------------------------------------------------------------
// Match clock / game state machine.
//   status: stopped (pre-game waiting) | running | paused | ended
//   Solves only score while running. The standings are frozen (hidden from
//   teams) during the last 15 minutes and after the game ends, until an
//   operator reveals the winner.
// ---------------------------------------------------------------------------
const FREEZE_MS = 15 * 60 * 1000; // scoreboard blackout window
const DEFAULT_DURATION_MS = 60 * 60 * 1000; // 60 min default round

function defaultGameState() {
  return { status: 'stopped', duration_ms: DEFAULT_DURATION_MS, ends_at: null, remaining_ms: null, winner_revealed: false };
}
function saveGameState(s) { setConfig('game_state', JSON.stringify(s)); }
function gameState() {
  let s;
  try { s = JSON.parse(getConfig('game_state') || 'null'); } catch (_) { s = null; }
  if (!s) { s = defaultGameState(); saveGameState(s); }
  // Lazily transition a running clock to "ended" once time is up.
  if (s.status === 'running' && s.ends_at && Date.now() >= s.ends_at) {
    s.status = 'ended'; s.ends_at = null; s.remaining_ms = 0;
    saveGameState(s);
  }
  return s;
}
function remainingMs(s) {
  if (s.status === 'running' && s.ends_at) return Math.max(0, s.ends_at - Date.now());
  if (s.status === 'paused') return s.remaining_ms || 0;
  if (s.status === 'ended') return 0;
  return s.duration_ms || 0; // stopped: show the configured length
}
function isFrozen(s) {
  if (s.winner_revealed) return false;             // reveal lifts the freeze
  if (s.status === 'ended') return true;           // ended but not revealed = blackout
  if (s.status === 'running' || s.status === 'paused') return remainingMs(s) <= FREEZE_MS;
  return false;
}
function gameRunning() { return gameState().status === 'running'; }
function publicGame() {
  const s = gameState();
  return {
    status: s.status,
    remaining_ms: remainingMs(s),
    duration_ms: s.duration_ms,
    frozen: isFrozen(s),
    freeze_window_ms: FREEZE_MS,
    winner_revealed: !!s.winner_revealed,
  };
}

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

// VULN: reflect any origin AND allow credentials -> effectively open CORS.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf && buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(httpMetricsMiddleware);

// Serve the SPA and uploaded avatars. Uploads are served from web root, so an
// uploaded .html file becomes live content (stored XSS via file upload).
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// CTF scoring
//
// Each challenge is worth points. The FIRST time a team triggers a challenge,
// its score goes up (later repeats by the same team don't stack). Solves are
// attributed to the acting user's team; unauthenticated solves fall back to
// VV_DEFAULT_TEAM (set this per deployment for "one instance per team") or the
// shared "anonymous" bucket in multi-team single-deployment mode.
// ---------------------------------------------------------------------------

const CHALLENGES = require('./src/challenges');
const CHALLENGE_BY_ID = Object.fromEntries(CHALLENGES.map((c) => [c.id, c]));
const CHALLENGE_POINTS = Object.fromEntries(CHALLENGES.map((c) => [c.id, c.points]));

const DEFAULT_TEAM = process.env.VV_DEFAULT_TEAM || null;

function randomJoinCode() {
  return 'VV-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getOrCreateTeam(name, joinCode) {
  let team = db.prepare('SELECT * FROM teams WHERE name = ?').get(name);
  if (!team) {
    const info = db
      .prepare('INSERT INTO teams (name, join_code) VALUES (?, ?)')
      .run(name, joinCode || randomJoinCode());
    team = db.prepare('SELECT * FROM teams WHERE id = ?').get(info.lastInsertRowid);
  }
  return team;
}

// A team "session" is a signed token you get by creating or logging into a
// team at the gate. It is separate from the (deliberately weak) user JWT and
// is only used to attribute CTF progress to a team.
function signTeamToken(team) {
  return jwt.sign({ tid: team.id, tname: team.name, kind: 'team' }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '30d',
  });
}

function teamFromToken(req) {
  if (!req) return null;
  const raw = (req.headers && req.headers['x-team-token']) || (req.cookies && req.cookies.team_token);
  if (!raw) return null;
  try {
    const p = jwt.verify(raw, JWT_SECRET, { algorithms: ['HS256'] });
    if (p && p.kind === 'team' && p.tid) {
      return db.prepare('SELECT * FROM teams WHERE id = ?').get(p.tid) || null;
    }
  } catch (_) { /* invalid/expired team token */ }
  return null;
}

// Resolve the team that should be credited for a solve on this request:
// the team session token first, then a logged-in user's team, then the
// per-deployment default team, then a shared anonymous bucket.
function teamForRequest(req) {
  const sess = teamFromToken(req);
  if (sess) return sess;
  if (req) {
    const claims = readToken(req);
    if (claims && claims.sub) {
      const u = db.prepare('SELECT team_id FROM users WHERE id = ?').get(claims.sub);
      if (u && u.team_id) return db.prepare('SELECT * FROM teams WHERE id = ?').get(u.team_id);
    }
  }
  if (DEFAULT_TEAM) return getOrCreateTeam(DEFAULT_TEAM);
  return getOrCreateTeam('anonymous');
}

function solve(challenge, req) {
  try {
    // Solves only count while the game is running. Before start, when paused,
    // or after the clock has ended, nothing scores.
    if (gameState().status !== 'running') return;
    metrics.challengesSolvedTotal.inc({ challenge });
    const points = CHALLENGE_POINTS[challenge] || 10;
    const team = teamForRequest(req);
    // First solve per (team, challenge) only.
    const existing = db
      .prepare('SELECT id FROM team_solves WHERE team_id = ? AND challenge = ?')
      .get(team.id, challenge);
    if (!existing) {
      const claims = req ? readToken(req) : null;
      db.prepare(
        'INSERT INTO team_solves (team_id, challenge, points, solved_by) VALUES (?, ?, ?, ?)'
      ).run(team.id, challenge, points, claims && claims.sub ? claims.sub : null);
      db.prepare('UPDATE teams SET score = score + ? WHERE id = ?').run(points, team.id);
      const difficulty = (CHALLENGE_BY_ID[challenge] && CHALLENGE_BY_ID[challenge].difficulty) || 'unknown';

      // First blood: the first team to solve ANYTHING in this tier gets a
      // one-off bonus (awarded once, globally, per difficulty).
      const bonus = (CHALLENGES.FIRST_BLOOD && CHALLENGES.FIRST_BLOOD[difficulty]) || 0;
      if (bonus > 0 && !db.prepare('SELECT 1 FROM first_bloods WHERE difficulty = ?').get(difficulty)) {
        db.prepare('INSERT INTO first_bloods (difficulty, team_id, challenge, bonus) VALUES (?, ?, ?, ?)')
          .run(difficulty, team.id, challenge, bonus);
        db.prepare('UPDATE teams SET score = score + ? WHERE id = ?').run(bonus, team.id);
        if (metrics.firstBloodTotal) metrics.firstBloodTotal.inc({ team: team.name, difficulty });
      }

      const newScore = db.prepare('SELECT score FROM teams WHERE id = ?').get(team.id).score;
      metrics.teamScore.set({ team: team.name }, newScore);
      metrics.teamChallengeSolved.set({ team: team.name, challenge, difficulty }, 1);
    }
  } catch (_) { /* never let scoring break a request */ }
}

// The team whose progress a *page view* should reflect: the team session
// token, else the logged-in user's team, else the per-deployment default team,
// else null (no team yet).
function currentTeam(req) {
  const sess = teamFromToken(req);
  if (sess) return sess;
  const claims = readToken(req);
  if (claims && claims.sub) {
    const u = db.prepare('SELECT team_id FROM users WHERE id = ?').get(claims.sub);
    if (u && u.team_id) return db.prepare('SELECT * FROM teams WHERE id = ?').get(u.team_id);
  }
  if (DEFAULT_TEAM) return getOrCreateTeam(DEFAULT_TEAM);
  return null;
}

// Re-populate team gauges from the DB after a (re)start.
function rehydrateTeamMetrics() {
  for (const t of db.prepare('SELECT * FROM teams').all()) {
    metrics.teamScore.set({ team: t.name }, t.score);
  }
  for (const s of db.prepare('SELECT ts.challenge, t.name FROM team_solves ts JOIN teams t ON t.id = ts.team_id').all()) {
    const difficulty = (CHALLENGE_BY_ID[s.challenge] && CHALLENGE_BY_ID[s.challenge].difficulty) || 'unknown';
    metrics.teamChallengeSolved.set({ team: s.name, challenge: s.challenge, difficulty }, 1);
  }
  for (const h of db.prepare('SELECT t.name, SUM(th.cost) AS spent FROM team_hints th JOIN teams t ON t.id = th.team_id GROUP BY th.team_id').all()) {
    metrics.teamPointsSpentHints.set({ team: h.name }, h.spent || 0);
  }
}

function refreshUserGauge() {
  const c = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  metrics.usersRegistered.set(c);
}
refreshUserGauge();
rehydrateTeamMetrics();
if (DEFAULT_TEAM) getOrCreateTeam(DEFAULT_TEAM); // ensure it exists on boot

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.display_name },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '2h' }
  );
}

function readToken(req, awardNone = false) {
  let raw = null;
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Bearer ')) raw = hdr.slice(7);
  if (!raw && req.cookies && req.cookies.token) raw = req.cookies.token;
  if (!raw) return null;
  try {
    // VULN: manual "algorithm agility". If the token header says alg:none we
    // trust the payload without verifying any signature (classic alg:none
    // bypass). Otherwise we verify with the (weak, committed) HS256 secret.
    const decoded = jwt.decode(raw, { complete: true });
    if (decoded && decoded.header && String(decoded.header.alg).toLowerCase() === 'none') {
      if (awardNone) solve('jwt-alg-none', req);
      return decoded.payload;
    }
    return jwt.verify(raw, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_) {
    return null;
  }
}

function authRequired(req, res, next) {
  const claims = readToken(req, true);
  if (!claims) return res.status(401).json({ error: 'authentication required' });
  req.user = claims;
  next();
}

// VULN: "admin" is granted if EITHER the token says so OR the caller sends a
// forgeable X-User-Role header. Trusting a client header for authorization is
// the core flaw here.
function adminOnly(req, res, next) {
  const claims = readToken(req, true);
  const headerRole = req.headers['x-user-role'];
  const isAdmin = (claims && claims.role === 'admin') || headerRole === 'admin';
  if (!isAdmin) return res.status(403).json({ error: 'admins only' });
  if (headerRole === 'admin' && !(claims && claims.role === 'admin')) {
    solve('broken-access-control-header', req);
  }
  req.user = claims || { role: 'admin', email: 'header-admin' };
  next();
}

// ---------------------------------------------------------------------------
// Product catalogue
// ---------------------------------------------------------------------------

// Normal listing hides the internal "DO NOT SELL" pressing (genre 'Misc').
app.get('/api/products', (req, res) => {
  const rows = db
    .prepare("SELECT * FROM products WHERE genre != 'Misc' ORDER BY id")
    .all();
  res.json(rows);
});

// VULN: SQL injection. The `q` parameter is concatenated straight into the
// query. The catalogue listing hides internal products, but this search does
// not filter them, and a UNION/OR injection exposes everything.
//   e.g.  /api/products/search?q=%' OR '1'='1
//   e.g.  /api/products/search?q=%' UNION SELECT id,email,password,role,... --
app.get('/api/products/search', (req, res, next) => {
  const q = req.query.q || '';
  const sql =
    "SELECT * FROM products WHERE title LIKE '%" + q + "%' OR artist LIKE '%" + q + "%'";
  // Reflected XSS: the query is echoed back and rendered by the SPA verbatim.
  if (/<script|onerror=|onload=|<img|<svg/i.test(q)) solve('reflected-xss-search', req);
  // UNION-based exfiltration from the users table.
  if (/union\s+select/i.test(q) && /users|password|email/i.test(q)) solve('sqli-union-users', req);
  try {
    const rows = db.prepare(sql).all();
    if (rows.some((r) => r.genre === 'Misc')) solve('sqli-search-internal-product', req);
    const hardcore = teamMode(currentTeam(req)) === 'hardcore';
    res.json({ query: q, sql: hardcore ? undefined : sql, results: rows }); // echoing SQL is an info leak (hidden in hardcore)
  } catch (err) {
    next(err); // verbose error handler leaks the failing SQL + stack
  }
});

app.get('/api/products/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// ---------------------------------------------------------------------------
// Reviews  (stored XSS)
// ---------------------------------------------------------------------------

app.get('/api/products/:id/reviews', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY id DESC')
    .all(req.params.id);
  res.json(rows);
});

// VULN: no authentication required, and the body is stored verbatim and later
// rendered with innerHTML on the client -> persistent (stored) XSS.
app.post('/api/products/:id/reviews', (req, res) => {
  const { author, rating, body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const info = db
    .prepare('INSERT INTO reviews (product_id, author, rating, body) VALUES (?, ?, ?, ?)')
    .run(req.params.id, author || 'Anonymous', Number(rating) || 5, body);
  metrics.reviewsPostedTotal.inc();
  if (/<script|onerror=|onload=|<img/i.test(body)) solve('stored-xss-review', req);
  res.status(201).json({ id: info.lastInsertRowid });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

app.post('/api/register', (req, res, next) => {
  try {
    const { email, password, display_name, secret_question, secret_answer } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    // VULN: role can be supplied by the client at registration (mass assignment).
    const role = (req.body && req.body.role) || 'customer';
    const info = db
      .prepare(
        `INSERT INTO users (email, password, display_name, role, secret_question, secret_answer)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(email, weakHash(password), display_name || email, role, secret_question || null, secret_answer || null);
    refreshUserGauge();
    if (role === 'admin') solve('mass-assignment-register-admin', req);
    // Optionally join a team right away (by join code) or auto-join the
    // per-deployment default team when VV_DEFAULT_TEAM is set.
    let teamId = null;
    if (req.body && req.body.team_code) {
      const t = db.prepare('SELECT id FROM teams WHERE join_code = ?').get(req.body.team_code);
      if (t) teamId = t.id;
    } else if (DEFAULT_TEAM) {
      teamId = getOrCreateTeam(DEFAULT_TEAM).id;
    }
    if (teamId) db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(teamId, info.lastInsertRowid);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// VULN: SQL injection in the email field + no rate limiting (brute force).
//   email:  ' OR role='admin' --      password: anything
app.post('/api/login', (req, res, next) => {
  const { email, password } = req.body || {};
  const hashed = weakHash(password || '');
  const sql =
    "SELECT * FROM users WHERE email = '" + (email || '') + "' AND password = '" + hashed + "'";
  try {
    const user = db.prepare(sql).get();
    if (!user) {
      metrics.loginAttemptsTotal.inc({ result: 'failure' });
      return res.status(401).json({ error: 'invalid credentials' });
    }
    metrics.loginAttemptsTotal.inc({ result: 'success' });
    // Injection that logs in without a matching password counts as solved.
    if (email && (email.includes("'") || /--/.test(email))) solve('sqli-login-bypass', req);
    // Signing in with the shipped support account + default password.
    if (email === 'support@vinylvault.test' && password === 'changeme') solve('default-credentials', req);
    res.cookie('token', signToken(user), { httpOnly: false }); // VULN: JS-readable cookie
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

app.get('/api/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(publicUser(user));
});

// VULN: mass assignment. The update copies every field from the request body,
// including `role`, letting a customer promote themselves to admin.
app.put('/api/me', authRequired, (req, res, next) => {
  try {
    const allowed = ['display_name', 'email', 'password', 'role', 'secret_question', 'secret_answer'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (key in (req.body || {})) {
        let val = req.body[key];
        if (key === 'password') val = weakHash(val);
        updates.push(`${key} = ?`);
        values.push(val);
        if (key === 'role' && val === 'admin') solve('mass-assignment-profile-admin', req);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'nothing to update' });
    values.push(req.user.sub);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

// VULN: IDOR + excessive data exposure. Any authenticated user can read ANY
// user record by id, and the response includes the password hash and the
// plaintext security answer.
app.get('/api/users/:id', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (String(req.user.sub) !== String(req.params.id)) solve('idor-user-record', req);
  res.json(user); // returns password + secret_answer, no field filtering
});

function publicUser(u) {
  let team = null;
  if (u.team_id) {
    const t = db.prepare('SELECT id, name, score FROM teams WHERE id = ?').get(u.team_id);
    if (t) team = t;
  }
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    team,
    created_at: u.created_at,
  };
}

// ---------------------------------------------------------------------------
// Teams & CTF scoreboard
// ---------------------------------------------------------------------------

const TOTAL_POINTS = Object.values(CHALLENGE_POINTS).reduce((a, b) => a + b, 0);

// Public scoreboard: teams ranked by score, with solve counts. Aggregating
// across per-team deployments is done in Grafana/Prometheus instead.
app.get('/api/teams/scoreboard', (req, res) => {
  const game = publicGame();
  // During the freeze window (last 15 min / after end, pre-reveal), teams may
  // not see who is where. Operators use /api/gameadmin/results instead.
  if (game.frozen && !readGameAdmin(req)) {
    const names = db.prepare('SELECT name FROM teams ORDER BY name ASC').all().map((t) => t.name);
    return res.json({
      frozen: true,
      game,
      message: game.status === 'ended'
        ? 'The game has ended — standings are hidden until the winner is revealed.'
        : 'Final minutes: the scoreboard is frozen.',
      total_challenges: Object.keys(CHALLENGE_POINTS).length,
      total_points: TOTAL_POINTS,
      team_names: names,
      teams: [],
      first_bloods: [],
    });
  }
  const teams = db
    .prepare(
      `SELECT t.id, t.name, t.score,
              (SELECT COUNT(*) FROM team_solves ts WHERE ts.team_id = t.id) AS solved,
              (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id) AS members
       FROM teams t
       ORDER BY t.score DESC, solved DESC, t.name ASC`
    )
    .all();
  const firstBloods = db
    .prepare(`SELECT fb.difficulty, fb.bonus, fb.team_id, t.name AS team_name
              FROM first_bloods fb JOIN teams t ON t.id = fb.team_id`)
    .all();
  res.json({
    frozen: false,
    game,
    total_challenges: Object.keys(CHALLENGE_POINTS).length,
    total_points: TOTAL_POINTS,
    teams,
    first_bloods: firstBloods,
  });
});

// Public match-clock state (drives the waiting / running / frozen / ended /
// results screens in the browser).
app.get('/api/game', (req, res) => res.json(publicGame()));

// Detail for one team: which challenges it has solved (numeric id only, so it
// doesn't shadow /api/teams/me or /api/teams/login).
app.get('/api/teams/:id(\\d+)', (req, res) => {
  const team = db.prepare('SELECT id, name, score FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'no such team' });
  const solves = db
    .prepare('SELECT challenge, points, created_at FROM team_solves WHERE team_id = ? ORDER BY created_at')
    .all(team.id);
  res.json({ ...team, solves });
});

// Create a team. Returns a join code others use to join.
app.post('/api/teams', (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'team name required' });
    const teamName = String(name).trim();
    if (db.prepare('SELECT 1 FROM teams WHERE name = ?').get(teamName)) {
      return res.status(409).json({ error: 'that team name is already taken' });
    }
    const joinCode = randomJoinCode();
    const info = db.prepare('INSERT INTO teams (name, join_code) VALUES (?, ?)').run(teamName, joinCode);
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(info.lastInsertRowid);
    metrics.teamScore.set({ team: teamName }, 0);
    // If a shop user happens to be logged in, attach them too (optional).
    const claims = readToken(req);
    if (claims && claims.sub) {
      db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(team.id, claims.sub);
    }
    res.status(201).json({
      id: team.id,
      name: team.name,
      score: team.score,
      join_code: joinCode,
      team_token: signTeamToken(team),
    });
  } catch (err) {
    next(err);
  }
});

// Log in as a team using its name + join code. Returns a team session token.
app.post('/api/teams/login', (req, res, next) => {
  try {
    const { name, join_code } = req.body || {};
    if (!join_code) return res.status(400).json({ error: 'join code required' });
    let team;
    if (name && String(name).trim()) {
      team = db.prepare('SELECT * FROM teams WHERE name = ?').get(String(name).trim());
      if (!team || team.join_code !== join_code) {
        return res.status(401).json({ error: 'wrong team name or join code' });
      }
    } else {
      // Name optional: the join code alone identifies the team.
      team = db.prepare('SELECT * FROM teams WHERE join_code = ?').get(join_code);
      if (!team) return res.status(401).json({ error: 'invalid join code' });
    }
    res.json({
      id: team.id,
      name: team.name,
      score: team.score,
      join_code: team.join_code,
      team_token: signTeamToken(team),
    });
  } catch (err) {
    next(err);
  }
});

// Lightweight progress feed for the in-browser poller: the current team's
// solved challenges (with titles) and the global first-blood awards. The SPA
// diffs this against what it already knows to fire confetti/toasts/sounds.
app.get('/api/teams/feed', (req, res) => {
  const team = teamFromToken(req);
  const game = publicGame();
  // During the freeze window teams cannot see their own progress or score, and
  // celebrations are suppressed. Everything returns once the winner is revealed.
  if (game.frozen) {
    return res.json({ team: team ? { id: team.id, name: team.name } : null, frozen: true, game, score: null, solved: [], first_bloods: [] });
  }
  const firstBloods = db
    .prepare(`SELECT fb.difficulty, fb.challenge, fb.bonus, fb.team_id, t.name AS team_name
              FROM first_bloods fb JOIN teams t ON t.id = fb.team_id`)
    .all()
    .map((fb) => ({ ...fb, mine: team ? fb.team_id === team.id : false }));
  if (!team) return res.json({ team: null, frozen: false, game, score: 0, solved: [], first_bloods: firstBloods });
  const solved = db.prepare('SELECT challenge FROM team_solves WHERE team_id = ?').all(team.id)
    .map((r) => {
      const meta = CHALLENGE_BY_ID[r.challenge];
      return { id: r.challenge, title: meta ? meta.title : r.challenge, difficulty: meta ? meta.difficulty : 'unknown' };
    });
  res.json({ team: { id: team.id, name: team.name }, frozen: false, game, score: team.score, solved, first_bloods: firstBloods });
});

// Who is the current team session? (null if not logged in as a team.)
app.get('/api/teams/me', (req, res) => {
  const team = teamFromToken(req);
  if (!team) return res.json({ team: null });
  const solved = db.prepare('SELECT COUNT(*) AS c FROM team_solves WHERE team_id = ?').get(team.id).c;
  res.json({ team: { id: team.id, name: team.name, score: team.score, join_code: team.join_code, solved } });
});

// Attach a logged-in shop user to an existing team by join code (optional;
// the team gate is the primary flow).
app.post('/api/teams/join', authRequired, (req, res, next) => {
  try {
    const { join_code } = req.body || {};
    const team = db.prepare('SELECT * FROM teams WHERE join_code = ?').get(join_code);
    if (!team) return res.status(404).json({ error: 'invalid join code' });
    db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(team.id, req.user.sub);
    res.json({ id: team.id, name: team.name, score: team.score });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Challenges & hints
//
// The board shows only a title, a spoiler-free description, and per-team
// progress. Hint TEXT is only sent once a team has unlocked it. The first hint
// of each challenge is free; later hints deduct points from the team's score.
// ---------------------------------------------------------------------------

app.get('/api/challenges', (req, res) => {
  const team = currentTeam(req);
  const mode = teamMode(team);
  const game = publicGame();
  const frozen = game.frozen;
  const solvedRows = team
    ? db.prepare('SELECT challenge, created_at FROM team_solves WHERE team_id = ?').all(team.id)
    : [];
  const solvedMap = Object.fromEntries(solvedRows.map((r) => [r.challenge, r.created_at]));
  const hintRows = team
    ? db.prepare('SELECT challenge, hint_index, cost FROM team_hints WHERE team_id = ?').all(team.id)
    : [];

  const list = CHALLENGES.map((c) => {
    const unlocked = hintRows
      .filter((h) => h.challenge === c.id)
      .map((h) => h.hint_index)
      .sort((a, b) => a - b);
    const nextIndex = unlocked.length;
    const nextHint = c.hints[nextIndex];
    // Hide solved status during the freeze window; it returns after the reveal.
    const solved = !frozen && (c.id in solvedMap);

    // Mode-dependent scaffolding.
    // - templates: learn (all tiers) + compete (easy/medium only); hardcore none
    // - explanations & primers: learn/compete; hardcore none
    // - hints: learn = free; compete = costed; hardcore = disabled
    const templateAllowed = mode === 'learn' || (mode === 'compete' && (c.difficulty === 'easy' || c.difficulty === 'medium'));
    const scaffolding = mode !== 'hardcore';
    let nextHintOut = null;
    if (mode !== 'hardcore' && nextHint) {
      const free = mode === 'learn' || nextHint.cost === 0;
      nextHintOut = { index: nextIndex, cost: free ? 0 : nextHint.cost, free };
    }
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      difficulty: c.difficulty,
      points: c.points,
      category: c.category,
      starter: c.starter,
      depends: c.depends,
      total_hints: c.hints.length,
      solved,
      solved_at: frozen ? null : (solvedMap[c.id] || null),
      hints_unlocked: unlocked.map((i) => ({ index: i, text: c.hints[i].text })),
      next_hint: nextHintOut,
      hints_disabled: mode === 'hardcore',
      template: templateAllowed ? c.template : null,
      // Only reveal the "why/fix" explanation once solved (and not in hardcore).
      explain: scaffolding && solved ? c.explain : null,
    };
  });

  const TIER_ORDER = CHALLENGES.TIER_ORDER || ['easy', 'medium', 'hard', 'insane'];
  const tiers = TIER_ORDER.map((tier) => {
    const items = list.filter((c) => c.difficulty === tier);
    return {
      difficulty: tier,
      points_each: (CHALLENGES.POINTS && CHALLENGES.POINTS[tier]) || (items[0] && items[0].points) || 0,
      total: items.length,
      solved: items.filter((c) => c.solved).length,
      challenges: items,
    };
  });

  res.json({
    team: team ? { id: team.id, name: team.name, score: frozen ? null : team.score, mode } : null,
    mode,
    game,
    frozen,
    total_challenges: CHALLENGES.length,
    total_points: TOTAL_POINTS,
    tier_order: TIER_ORDER,
    tiers,
    challenges: list,
    primers: mode !== 'hardcore' ? CHALLENGES.CATEGORY_PRIMERS : null,
  });
});

// Unlock the next hint for the requesting user's team. First hint is free;
// subsequent hints deduct their cost from the team score (never below 0).
app.post('/api/challenges/:id/hint', (req, res, next) => {
  try {
    const challenge = CHALLENGE_BY_ID[req.params.id];
    if (!challenge) return res.status(404).json({ error: 'no such challenge' });
    const team = currentTeam(req);
    if (!team) return res.status(400).json({ error: 'join a team before requesting hints' });
    const mode = teamMode(team);
    if (mode === 'hardcore') return res.status(403).json({ error: 'hints are disabled in hardcore mode' });

    const taken = db
      .prepare('SELECT hint_index FROM team_hints WHERE team_id = ? AND challenge = ?')
      .all(team.id, challenge.id).length;
    if (taken >= challenge.hints.length) {
      return res.status(409).json({ error: 'no more hints for this challenge' });
    }
    // In learn mode every hint is free and no points are deducted.
    const cost = mode === 'learn' ? 0 : challenge.hints[taken].cost;
    const hint = { text: challenge.hints[taken].text, cost };
    const claims = readToken(req);

    db.prepare(
      'INSERT INTO team_hints (team_id, challenge, hint_index, cost, unlocked_by) VALUES (?, ?, ?, ?, ?)'
    ).run(team.id, challenge.id, taken, hint.cost, claims && claims.sub ? claims.sub : null);

    if (hint.cost > 0) {
      // Deduct, clamped at zero.
      db.prepare('UPDATE teams SET score = MAX(0, score - ?) WHERE id = ?').run(hint.cost, team.id);
      metrics.teamHintsUsed.inc({ team: team.name });
      const spent = db
        .prepare('SELECT COALESCE(SUM(cost),0) AS s FROM team_hints WHERE team_id = ?')
        .get(team.id).s;
      metrics.teamPointsSpentHints.set({ team: team.name }, spent);
    }
    const newScore = db.prepare('SELECT score FROM teams WHERE id = ?').get(team.id).score;
    metrics.teamScore.set({ team: team.name }, newScore);

    res.status(201).json({
      index: taken,
      cost: hint.cost,
      free: hint.cost === 0,
      text: hint.text,
      remaining_hints: challenge.hints.length - taken - 1,
      team_score: newScore,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Orders & checkout
// ---------------------------------------------------------------------------

// VULN: IDOR. No ownership check -> any user can read any order, including the
// internal admin order that leaks the warehouse master key code.
app.get('/api/orders/:id', authRequired, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  if (String(order.user_id) !== String(req.user.sub)) solve('idor-order', req);
  res.json(order);
});

app.get('/api/orders', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.user.sub);
  res.json(rows);
});

// VULN: server-side evaluation of a coupon "formula" pulled from the DB, and
// the discount is not clamped -> a coupon can drive the total negative, and a
// crafted coupon formula executes arbitrary JS (eval injection).
function applyCoupon(total, code, req) {
  if (!code) return { total, discount: 0 };
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
  if (!coupon) return { total, discount: 0, note: 'unknown coupon' };
  // eslint-disable-next-line no-eval
  const discount = eval(coupon.formula); // VULN: eval on stored data
  const newTotal = total - discount;
  if (newTotal < 0) solve('coupon-negative-total', req);
  return { total: newTotal, discount, formula: coupon.formula };
}

app.post('/api/checkout/apply-coupon', (req, res, next) => {
  try {
    const { total, code } = req.body || {};
    res.json(applyCoupon(Number(total) || 0, code, req));
  } catch (err) {
    next(err);
  }
});

app.post('/api/orders', authRequired, (req, res, next) => {
  try {
    const { items, address, coupon } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
    let total = 0;
    for (const it of items) {
      const p = db.prepare('SELECT price FROM products WHERE id = ?').get(it.productId);
      const qty = Number(it.qty);
      if (Number.isFinite(qty) && qty < 0) solve('negative-quantity', req);
      // VULN: if the client supplies a price, the server trusts it over the
      // catalogue price (price tampering).
      const unit = (it.price !== undefined) ? Number(it.price) : (p ? p.price : 0);
      if (p && it.price !== undefined && Number(it.price) < p.price) solve('price-tampering', req);
      total += unit * (Number.isFinite(qty) ? qty : 1);
    }
    const { total: finalTotal } = applyCoupon(total, coupon, req);
    const info = db
      .prepare('INSERT INTO orders (user_id, items_json, total, address) VALUES (?, ?, ?, ?)')
      .run(req.user.sub, JSON.stringify(items), finalTotal, address || '');
    metrics.ordersCreatedTotal.inc();
    metrics.orderValue.observe(Math.max(0, finalTotal));
    res.status(201).json({ id: info.lastInsertRowid, total: finalTotal });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// VULN: protected only by the forgeable header/weak check in adminOnly.
app.get('/api/admin/users', adminOnly, (req, res) => {
  const rows = db.prepare('SELECT * FROM users').all(); // dumps hashes + answers
  res.json(rows);
});

app.get('/api/admin/stats', adminOnly, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const orders = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(total),0) AS revenue FROM orders').get();
  res.json({ users, orders: orders.c, revenue: orders.revenue });
});

// ---------------------------------------------------------------------------
// File download / upload
// ---------------------------------------------------------------------------

// VULN: path traversal. `file` is joined onto the ftp/ directory without
// sanitisation, so ../ escapes the intended folder.
//   /api/download?file=coupons.json          (intended)
//   /api/download?file=../src/db.js           (traversal)
//   /api/download?file=../../etc/passwd       (traversal)
app.get('/api/download', (req, res, next) => {
  try {
    const file = req.query.file || '';
    const target = path.join(__dirname, 'ftp', file);
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      return res.status(404).json({ error: 'file not found', resolved: target });
    }
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(__dirname, 'ftp'))) solve('path-traversal-download', req);
    res.download(resolved);
  } catch (err) {
    next(err);
  }
});

// VULN: insecure upload. Keeps the client-supplied filename, no type/size
// checks, writes into the publicly served /public/uploads directory. Uploading
// an .html/.svg file yields stored XSS; the original name enables overwrite.
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'public', 'uploads'),
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
});
app.post('/api/upload', upload.single('avatar'), (req, res) => {
  // JSON alternative (so it works from the HTTP Lab, which can't send multipart
  // file parts): POST { filename, content }. Same insecure behaviour — arbitrary
  // filename + content written and served back.
  if (!req.file && req.body && req.body.filename) {
    const filename = String(req.body.filename).replace(/[/\\]/g, '_');
    const content = req.body.content != null ? String(req.body.content) : '';
    try {
      fs.writeFileSync(path.join(__dirname, 'public', 'uploads', filename), content);
    } catch (e) {
      return res.status(500).json({ error: 'write failed' });
    }
    if (/\.(html?|svg|js)$/i.test(filename)) solve('insecure-upload-active-content', req);
    return res.status(201).json({ url: '/uploads/' + filename, stored: filename });
  }
  if (!req.file) return res.status(400).json({ error: 'no file' });
  if (/\.(html?|svg|js)$/i.test(req.file.originalname)) solve('insecure-upload-active-content', req);
  res.status(201).json({ url: '/uploads/' + req.file.originalname, stored: req.file.originalname });
});

// ---------------------------------------------------------------------------
// Password reset  (weak)
// ---------------------------------------------------------------------------

// VULN: the reset flow relies on the security answer, which is disclosed via
// the IDOR user endpoint above. Answer known -> account takeover.
app.post('/api/reset/request', (req, res) => {
  const { email } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'no such user' });
  res.json({ email, security_question: user.secret_question }); // leaks the question
});

app.post('/api/reset/confirm', (req, res) => {
  const { email, answer, new_password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'no such user' });
  // VULN: string comparison of a plaintext answer, no attempt limiting.
  if (String(answer) !== String(user.secret_answer)) {
    return res.status(401).json({ error: 'wrong answer' });
  }
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(weakHash(new_password), user.id);
  solve('weak-password-reset', req);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Debug / metrics
// ---------------------------------------------------------------------------

// VULN: debug endpoint exposes secrets and environment. Left enabled in prod.
app.get('/api/debug/config', (req, res) => {
  solve('debug-config-exposed', req);
  res.json({
    jwt_secret: JWT_SECRET,
    node_env: process.env.NODE_ENV || 'development',
    db_path: require('./src/db').DB_PATH,
    accepted_jwt_algorithms: ['HS256', 'none'],
    admin_seed_hint: 'admin@vinylvault.test',
    env: process.env,
  });
});

// Prometheus scrape endpoint (this one is intended to be open for the demo).
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'vinyl-vault' }));

// ---------------------------------------------------------------------------
// Game operator console (separate, secure admin layer — NOT the vulnerable
// shop "admin" role). Namespaced under /api/gameadmin so it never overlaps the
// deliberately-weak /api/admin/* challenge endpoints.
// ---------------------------------------------------------------------------

app.post('/api/gameadmin/login', (req, res) => {
  const { username, password } = req.body || {};
  const admin = db.prepare('SELECT * FROM game_admins WHERE username = ?').get(String(username || ''));
  if (!admin || !strongVerify(password || '', admin.pass_hash)) {
    return res.status(401).json({ error: 'invalid operator credentials' });
  }
  res.json({ username: admin.username, ops_token: signGameAdminToken(admin) });
});

app.get('/api/gameadmin/me', (req, res) => {
  const admin = readGameAdmin(req);
  res.json({ admin: admin ? { id: admin.id, username: admin.username } : null });
});

app.get('/api/gameadmin/teams', gameAdminRequired, (req, res) => {
  const teams = db.prepare(`
    SELECT t.id, t.name, t.mode, t.score, t.join_code,
           (SELECT COUNT(*) FROM team_solves ts WHERE ts.team_id = t.id) AS solved
    FROM teams t ORDER BY t.score DESC, t.name ASC`).all();
  res.json({ modes: VALID_MODES, teams });
});

// Requirement 1: only a game operator can switch a team's mode on/off.
app.post('/api/gameadmin/teams/:id(\\d+)/mode', gameAdminRequired, (req, res) => {
  const mode = String((req.body && req.body.mode) || '');
  if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'mode must be one of ' + VALID_MODES.join(', ') });
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'no such team' });
  db.prepare('UPDATE teams SET mode = ? WHERE id = ?').run(mode, team.id);
  res.json({ id: team.id, name: team.name, mode });
});

app.get('/api/gameadmin/admins', gameAdminRequired, (req, res) => {
  const admins = db.prepare('SELECT id, username, created_at FROM game_admins ORDER BY id').all();
  res.json({ admins });
});

app.post('/api/gameadmin/admins', gameAdminRequired, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (db.prepare('SELECT 1 FROM game_admins WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'that operator name is taken' });
  }
  const info = db.prepare('INSERT INTO game_admins (username, pass_hash) VALUES (?, ?)').run(String(username), strongHash(password));
  res.status(201).json({ id: info.lastInsertRowid, username });
});

// Reset the competition (scores, solves, first bloods) for a fresh round.
app.post('/api/gameadmin/reset-scores', gameAdminRequired, (req, res) => {
  db.prepare('UPDATE teams SET score = 0').run();
  db.prepare('DELETE FROM team_solves').run();
  db.prepare('DELETE FROM team_hints').run();
  db.prepare('DELETE FROM first_bloods').run();
  metrics.resetScoreboard();
  res.json({ ok: true, message: 'all team scores, solves, hints and first bloods cleared' });
});

// ---- Match clock control -------------------------------------------------
app.get('/api/gameadmin/game', gameAdminRequired, (req, res) => res.json(publicGame()));

app.post('/api/gameadmin/game/start', gameAdminRequired, (req, res) => {
  const minutes = Number((req.body && req.body.minutes) || 0);
  const durationMs = minutes > 0 ? Math.round(minutes * 60 * 1000) : DEFAULT_DURATION_MS;
  saveGameState({ status: 'running', duration_ms: durationMs, ends_at: Date.now() + durationMs, remaining_ms: null, winner_revealed: false });
  res.json(publicGame());
});

app.post('/api/gameadmin/game/pause', gameAdminRequired, (req, res) => {
  const s = gameState();
  if (s.status !== 'running') return res.status(409).json({ error: 'game is not running' });
  saveGameState({ ...s, status: 'paused', remaining_ms: remainingMs(s), ends_at: null });
  res.json(publicGame());
});

app.post('/api/gameadmin/game/resume', gameAdminRequired, (req, res) => {
  const s = gameState();
  if (s.status !== 'paused') return res.status(409).json({ error: 'game is not paused' });
  const rem = s.remaining_ms || 0;
  saveGameState({ ...s, status: 'running', ends_at: Date.now() + rem, remaining_ms: null });
  res.json(publicGame());
});

// Stop = end the game now (blackout until the winner is revealed).
app.post('/api/gameadmin/game/stop', gameAdminRequired, (req, res) => {
  const s = gameState();
  saveGameState({ ...s, status: 'ended', ends_at: null, remaining_ms: 0 });
  res.json(publicGame());
});

// Reset back to the pre-game waiting state.
app.post('/api/gameadmin/game/reset', gameAdminRequired, (req, res) => {
  const s = gameState();
  saveGameState({ status: 'stopped', duration_ms: s.duration_ms || DEFAULT_DURATION_MS, ends_at: null, remaining_ms: null, winner_revealed: false });
  res.json(publicGame());
});

app.post('/api/gameadmin/game/reveal', gameAdminRequired, (req, res) => {
  const s = gameState();
  saveGameState({ ...s, winner_revealed: true });
  res.json(publicGame());
});

// Full standings for the operator reveal page (always visible to operators).
app.get('/api/gameadmin/results', gameAdminRequired, (req, res) => {
  const teams = db.prepare(`
    SELECT t.id, t.name, t.score,
           (SELECT COUNT(*) FROM team_solves ts WHERE ts.team_id = t.id) AS solved
    FROM teams t ORDER BY t.score DESC, solved DESC, t.name ASC`).all();
  const game = publicGame();
  res.json({ game, revealed: game.winner_revealed, winner: teams[0] || null, teams });
});


require('./src/challenge-routes').register(app, {
  db, solve, jwt, JWT_SECRET, readToken, teamFromToken, metrics, weakHash,
});

// SPA fallback for client-side routes.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// VULN: verbose error handler returns the stack trace and failing SQL.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Verbose by default (a deliberate info leak that helps learners); in hardcore
  // mode the target behaves realistically and hides the details.
  let hardcore = false;
  try { hardcore = teamMode(currentTeam(req)) === 'hardcore'; } catch (_) { /* ignore */ }
  if (hardcore) return res.status(500).json({ error: 'internal server error' });
  res.status(500).json({
    error: err.message,
    stack: err.stack,
    sql: err.sql || undefined,
  });
});

app.listen(PORT, () => {
  console.log(`\n  🎵  Vinyl Vault listening on http://localhost:${PORT}`);
  console.log(`     Metrics at  http://localhost:${PORT}/metrics`);
  console.log(`     WARNING: intentionally insecure. Do not expose publicly.\n`);
});

module.exports = app;
