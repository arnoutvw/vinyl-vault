'use strict';

/*
 * Extra challenge endpoints (the ones not wired inline in server.js).
 *
 * register(app, ctx) mounts all of these. ctx supplies shared helpers so this
 * module doesn't reach into server internals.
 *
 * SAFETY: a few classes (command injection, SSRF, XXE, ReDoS) are recognised by
 * their payload signature and awarded WITHOUT actually executing a shell,
 * making a network request, expanding external entities, or running a
 * catastrophic regex. The player still performs the real technique; the app
 * just refuses to hurt itself. Everything else (SQLi variants, prototype
 * pollution, SSTI eval, deserialization, JWT tricks, redirects) is genuine.
 */

module.exports.register = function register(app, ctx) {
  const { db, solve, jwt, JWT_SECRET, readToken } = ctx;

  // ---- EASY: forced browsing via robots.txt ------------------------------
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
      'User-agent: *\n' +
      'Disallow: /api/debug\n' +
      'Disallow: /api/staff-lounge\n' +
      'Disallow: /uploads/\n'
    );
  });
  app.get('/api/staff-lounge', (req, res) => {
    solve('forced-browsing-robots', req);
    res.json({ message: 'Staff lounge — coffee machine broken since 2019.', staff_wifi: 'BackRoomBeats' });
  });

  // ---- MEDIUM: ORDER BY injection ----------------------------------------
  // Real injection: `sort` is concatenated into the ORDER BY clause.
  app.get('/api/catalog', (req, res, next) => {
    const sort = req.query.sort || 'id';
    const sql = 'SELECT id,title,artist,genre,year,price FROM products ORDER BY ' + sort;
    try {
      const rows = db.prepare(sql).all();
      if (/[^\w\s]|select|case|when|\(|--/i.test(sort)) solve('order-by-injection', req);
      res.json({ sort, sql, results: rows });
    } catch (err) {
      // A syntax error from injection still counts — you controlled the query.
      if (/[^\w\s]|select|case|when|\(|--/i.test(sort)) solve('order-by-injection', req);
      next(err);
    }
  });

  // ---- MEDIUM: IDOR invoice ----------------------------------------------
  app.get('/api/invoices/:orderId(\\d+)', (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'no such invoice' });
    const claims = readToken(req);
    if (!claims || String(claims.sub) !== String(order.user_id)) solve('idor-invoice', req);
    res.json({
      invoice: 'INV-' + String(order.id).padStart(5, '0'),
      order_id: order.id,
      billed_to_user: order.user_id,
      items: JSON.parse(order.items_json),
      total: order.total,
      address: order.address,
    });
  });

  // ---- MEDIUM: open redirect ---------------------------------------------
  app.get('/api/go', (req, res) => {
    const url = String(req.query.url || '');
    if (/^(https?:)?\/\//i.test(url) || /^[a-z]+:/i.test(url)) solve('open-redirect', req);
    res.redirect(url || '/');
  });

  // ---- HARD: JWT forged with the (weak, committed) HS256 secret ----------
  // Genuinely verifies HS256; a token that verifies but whose subject is not a
  // real admin in the DB must have been forged with the leaked secret.
  app.get('/api/admin/ledger', (req, res) => {
    const raw = bearer(req);
    if (!raw) return res.status(401).json({ error: 'token required' });
    let payload;
    try { payload = jwt.verify(raw, JWT_SECRET, { algorithms: ['HS256'] }); }
    catch (_) { return res.status(401).json({ error: 'invalid token' }); }
    if (payload.role !== 'admin') return res.status(403).json({ error: 'admins only' });
    const dbUser = payload.sub ? db.prepare('SELECT role FROM users WHERE id = ?').get(payload.sub) : null;
    if (!dbUser || dbUser.role !== 'admin') solve('jwt-weak-secret-forge', req);
    res.json({ ledger: [{ month: 'Jun', revenue: 12040 }, { month: 'Jul', revenue: 15990 }] });
  });

  // ---- HARD: blind boolean SQLi (user enumeration) -----------------------
  app.get('/api/check-email', (req, res, next) => {
    const email = String(req.query.email || '');
    const sql = "SELECT COUNT(*) AS c FROM users WHERE email = '" + email + "'";
    try {
      const c = db.prepare(sql).get().c;
      if (/'|--|\bor\b|\band\b|union|select/i.test(email)) solve('blind-sqli-user-enum', req);
      res.json({ available: c === 0 }); // only ever a yes/no
    } catch (err) { next(err); }
  });

  // ---- HARD: SSRF via cover-art import (simulated fetch) ------------------
  app.post('/api/products/:id(\\d+)/cover', (req, res) => {
    const url = String((req.body && req.body.url) || '');
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { return res.status(400).json({ error: 'bad url' }); }
    const internal = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?)/i.test(host);
    if (internal) {
      solve('ssrf-cover-art', req);
      // NOTE: we do NOT actually fetch internal URLs.
      return res.json({ imported: false, note: 'server attempted to fetch ' + host + ' (blocked in demo)' });
    }
    res.json({ imported: true, from: host });
  });

  // ---- HARD: prototype pollution -----------------------------------------
  app.post('/api/preferences', (req, res) => {
    const raw = req.rawBody || JSON.stringify(req.body || {});
    // Detect the pollution attempt on the raw payload FIRST (before any merge
    // touches shared prototypes).
    if (/__proto__|"constructor"|"prototype"/.test(raw)) solve('prototype-pollution', req);
    const target = {};
    try { merge(target, req.body || {}); } catch (_) {}
    delete Object.prototype.polluted; // best-effort cleanup
    res.json({ saved: true, preferences: target });
  });

  // ---- HARD: coupon stacking ---------------------------------------------
  app.post('/api/checkout/apply-coupons', (req, res) => {
    const total = Number((req.body && req.body.total) || 0);
    const codes = Array.isArray(req.body && req.body.codes) ? req.body.codes : [];
    let discount = 0;
    const applied = [];
    for (const code of codes) {
      const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
      if (!coupon) continue;
      // eslint-disable-next-line no-eval
      const d = eval(coupon.formula); // stored formula, reused here too
      discount += d; applied.push({ code, discount: d });
    }
    const finalTotal = total - discount;
    if (applied.length > 1 && discount >= total && total > 0) solve('coupon-stacking', req);
    res.json({ total: finalTotal, discount, applied });
  });

  // ---- HARD: command injection (simulated) -------------------------------
  app.get('/api/tools/ping', (req, res) => {
    const host = String(req.query.host || '');
    if (/[;&|`$(){}\n<>]/.test(host)) {
      solve('command-injection', req);
      // NOTE: no shell is ever executed.
      return res.json({ output: 'sh: injected command recognised (not executed in demo)' });
    }
    res.json({ output: 'PING ' + host + ': 3 packets transmitted, 3 received' });
  });

  // ---- HARD: second-order SQLi -------------------------------------------
  // Uses STORED display names unsafely in a query. Trigger it after saving a
  // display name that contains SQL.
  app.get('/api/admin/audit', (req, res, next) => {
    try {
      const names = db.prepare('SELECT display_name FROM users').all();
      let hit = false;
      for (const { display_name } of names) {
        const sql = "SELECT '" + display_name + "' AS label"; // unsafe reuse of stored data
        try { db.prepare(sql).get(); }
        catch (_) { hit = true; } // stored payload broke the query = injection present
        if (/'|--|;|union|select/i.test(String(display_name))) hit = true;
      }
      if (hit) solve('second-order-sqli', req);
      res.json({ audited: names.length, anomalies: hit });
    } catch (err) { next(err); }
  });

  // ---- HARD: CSV / formula injection in data export ----------------------
  // The shop exports your order history to CSV without neutralising cells that
  // begin with a formula trigger, so a crafted address becomes a live formula
  // when opened in a spreadsheet.
  app.get('/api/account/export.csv', (req, res) => {
    const claims = readToken(req);
    if (!claims || !claims.sub) return res.status(401).json({ error: 'login required' });
    const orders = db.prepare('SELECT id, total, address FROM orders WHERE user_id = ?').all(claims.sub);
    const dangerous = /^[=+\-@\t\r]/;
    let vulnerable = false;
    const lines = ['order_id,total,address'];
    for (const o of orders) {
      const addr = String(o.address || '');
      if (dangerous.test(addr)) vulnerable = true;
      lines.push(o.id + ',' + o.total + ',' + addr); // VULN: no formula escaping/quoting
    }
    if (vulnerable) solve('csv-formula-injection', req);
    res.type('text/csv').send(lines.join('\n'));
  });

  // ---- HARD: insecure deserialization of a prefs cookie ------------------
  app.get('/api/preferences/init', (req, res) => {
    const prefs = Buffer.from(JSON.stringify({ role: 'user', theme: 'dark' })).toString('base64');
    res.cookie('prefs', prefs, { httpOnly: false });
    res.json({ prefs, note: 'stored your preferences in the prefs cookie' });
  });
  app.get('/api/preferences/whoami', (req, res) => {
    // The prefs blob may arrive in the cookie, an X-Prefs header, or a ?prefs=
    // query param (the header/query forms exist so it's testable from a browser
    // fetch, which can't set a Cookie header).
    const raw = (req.cookies && req.cookies.prefs) || req.headers['x-prefs'] || req.query.prefs;
    if (!raw) return res.json({ role: 'guest' });
    let obj = {};
    try { obj = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8')); } catch (_) {}
    if (obj && obj.role === 'admin') { solve('insecure-deserialization-cookie', req); return res.json({ role: 'admin', panel: 'unlocked' }); }
    res.json({ role: (obj && obj.role) || 'guest' });
  });

  // ---- INSANE: server-side template injection (real eval) ----------------
  app.post('/api/orders/:id(\\d+)/message', (req, res) => {
    const template = String((req.body && req.body.template) || '');
    let rendered = template;
    let evaluated = false;
    rendered = template.replace(/\{\{(.+?)\}\}/g, (_m, expr) => {
      evaluated = true;
      try { return String(Function('return (' + expr + ')')()); } // VULN: evaluates template expressions
      catch (e) { return '[err]'; }
    });
    if (evaluated) solve('ssti', req);
    res.json({ rendered });
  });

  // ---- INSANE: XXE (recognised, not resolved) ----------------------------
  app.post('/api/import', (req, res) => {
    const xml = typeof req.body === 'string' ? req.body : String((req.body && req.body.xml) || '');
    if (/<!DOCTYPE/i.test(xml) && /<!ENTITY/i.test(xml)) {
      solve('xxe', req);
      // NOTE: external entities are NOT resolved.
      return res.json({ imported: 0, note: 'DOCTYPE/ENTITY detected — external entities are not expanded in demo' });
    }
    res.json({ imported: (xml.match(/<record>/gi) || []).length });
  });

  // ---- INSANE: JWT read but signature never verified ---------------------
  app.get('/api/premium/lounge', (req, res) => {
    const raw = bearer(req);
    if (!raw) return res.status(401).json({ error: 'token required' });
    const payload = jwt.decode(raw); // VULN: decode, never verify
    if (payload && payload.role === 'admin') { solve('jwt-unverified-endpoint', req); return res.json({ lounge: 'platinum', perks: ['free shipping', 'test pressings'] }); }
    res.status(403).json({ error: 'members only' });
  });

  // ---- INSANE: the vault — requires a REAL database admin ----------------
  app.get('/api/admin/vault', (req, res) => {
    const raw = bearer(req) || (req.cookies && req.cookies.token);
    if (!raw) return res.status(401).json({ error: 'token required' });
    let payload;
    try { payload = jwt.verify(raw, JWT_SECRET, { algorithms: ['HS256'] }); }
    catch (_) { return res.status(401).json({ error: 'invalid token' }); }
    const dbUser = payload && payload.sub ? db.prepare('SELECT role FROM users WHERE id = ?').get(payload.sub) : null;
    if (!dbUser || dbUser.role !== 'admin') return res.status(403).json({ error: 'genuine admin required' });
    solve('admin-flag-captured', req);
    res.json({ flag: 'VV{you_became_a_real_admin}', master_key: '4471' });
  });

  // ---- INSANE: host header injection in reset link -----------------------
  app.post('/api/reset/link', (req, res) => {
    const email = String((req.body && req.body.email) || '');
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) return res.status(404).json({ error: 'no such user' });
    // VULN: the reset link trusts the client's notion of the host. Real proxies
    // pass X-Forwarded-Host; we honour it over Host (and browsers CAN set it,
    // unlike the Host header), so this is fully testable from the HTTP Lab.
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    if (!/^(localhost|127\.0\.0\.1|vinyl-vault)(:\d+)?$/i.test(host)) solve('host-header-injection', req);
    res.json({ reset_link: 'http://' + host + '/reset?token=' + Buffer.from(email).toString('base64') });
  });

  // ---- INSANE: ReDoS (recognised, not executed) --------------------------
  app.get('/api/validate/handle', (req, res) => {
    const h = String(req.query.h || '');
    // Vulnerable pattern would be /^(a+)+$/; we detect the classic trigger
    // shape instead of running it on a long input.
    const evilShape = /^a{24,}[^a]?$/.test(h) || (h.length > 30 && /(.)\1{20,}/.test(h));
    if (evilShape) { solve('redos', req); return res.json({ valid: false, note: 'pattern would catastrophically backtrack (not run in demo)' }); }
    res.json({ valid: /^[a-z0-9_]{3,20}$/.test(h) });
  });

  // ---- INSANE: CORS credential theft -------------------------------------
  app.get('/api/account/secret', (req, res) => {
    // Browsers set Origin themselves and forbid overriding it, so for in-app
    // testing we also accept X-Test-Origin to stand in for a foreign origin.
    const origin = req.headers['x-test-origin'] || req.headers.origin;
    const host = req.headers.host || '';
    if (origin && !origin.includes(host)) {
      // Global CORS already reflects the origin + allows credentials.
      solve('cors-credential-theft', req);
    }
    res.json({ secret: 'loyalty points balance: 4471', note: 'sensitive, credentialed response' });
  });

  // ---- INSANE: JWT kid injection -----------------------------------------
  app.get('/api/reports', (req, res) => {
    const raw = bearer(req);
    if (!raw) return res.status(401).json({ error: 'token required' });
    const decoded = jwt.decode(raw, { complete: true });
    const kid = decoded && decoded.header && decoded.header.kid;
    if (kid && /'|--|union|select|\bor\b/i.test(String(kid))) {
      // The kid would be interpolated into a key-lookup query.
      solve('jwt-kid-injection', req);
      return res.json({ reports: ['weekly', 'monthly'], note: 'kid resolved via injectable lookup' });
    }
    res.status(403).json({ error: 'no valid signing key for kid' });
  });

  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
  }

  function merge(target, source) {
    for (const key of Object.keys(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        // VULN: no guard — assign through to the (shared) prototype.
        try { target[key] = source[key]; } catch (_) {}
        if (source[key] && typeof source[key] === 'object') {
          for (const k of Object.keys(source[key])) {
            try { ({}).__proto__[k] = source[key][k]; } catch (_) {}
          }
        }
        continue;
      }
      if (source[key] && typeof source[key] === 'object') {
        target[key] = target[key] || {};
        merge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
};
