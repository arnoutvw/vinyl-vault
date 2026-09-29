/*
 * Vinyl Vault front-end.
 *
 * VULN (client side): review bodies and the search query are injected into the
 * DOM with innerHTML, so stored/reflected XSS from the API executes here.
 * The auth token is kept in a JS-readable cookie + localStorage.
 */

const emoji = ['💿', '📀', '🎸', '🎧', '🎹', '🥁', '🎺', '📼'];
const cover = (id) => emoji[id % emoji.length];

const Shop = {
  cart: JSON.parse(localStorage.getItem('vv_cart') || '[]'),
  token: localStorage.getItem('vv_token') || null,
  teamToken: localStorage.getItem('vv_team_token') || null,
  opsToken: localStorage.getItem('vv_ops_token') || null,
  game: null, // current match-clock state
  team: null, // current team session {id,name,score,...}

  async api(pathname, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    if (this.teamToken) headers['X-Team-Token'] = this.teamToken;
    const res = await fetch('/api' + pathname, { ...opts, headers, credentials: 'include' });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: res.ok, status: res.status, data: text }; }
  },

  saveCart() {
    localStorage.setItem('vv_cart', JSON.stringify(this.cart));
    document.getElementById('cart-count').textContent =
      this.cart.reduce((n, i) => n + i.qty, 0);
  },

  add(id, title, price) {
    const line = this.cart.find((i) => i.productId === id);
    if (line) line.qty++;
    else this.cart.push({ productId: id, title, price, qty: 1 });
    this.saveCart();
    this.toast(`Added “${title}” to cart`);
  },

  toast(msg) {
    const v = document.getElementById('view');
    const n = document.createElement('div');
    n.className = 'notice ok';
    n.textContent = msg;
    v.prepend(n);
    setTimeout(() => n.remove(), 2500);
  },

  // --- Celebrations: poll for new solves, then confetti + banner + sound ----

  startCelebrations() {
    this.stopCelebrations();
    this.knownSolved = null;          // null => first poll seeds silently
    this.knownFirstBloods = null;
    this.tick();                      // immediate
    this._pollTimer = setInterval(() => this.tick(), 3000);
  },

  stopCelebrations() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this.knownSolved = null;
    this.knownFirstBloods = null;
  },

  async tick() {
    await this.pollGame();
    const g = this.game;
    // Celebrate only while the game is running AND standings aren't frozen.
    if (g && g.status === 'running' && !g.frozen) {
      this.pollFeed();
    } else {
      // Blackout / not running: seed silently so we don't confetti the backlog
      // when things unfreeze.
      this.knownSolved = null;
      this.knownFirstBloods = null;
    }
  },

  async pollGame() {
    let data;
    try { data = (await this.api('/game')).data; } catch (_) { return; }
    if (!data || !data.status) return;
    const prevKey = this.game ? this.game.status + ':' + this.game.winner_revealed + ':' + this.game.frozen : '';
    this.game = data;
    this.renderGameChrome();
    // When the game state meaningfully changes, refresh the current view.
    const key = data.status + ':' + data.winner_revealed + ':' + data.frozen;
    if (prevKey && prevKey !== key && this.team) {
      if (this._route === 'challenges') this.challenges();
      else if (this._route === 'scoreboard') this.scoreboard();
    }
  },

  renderGameChrome() {
    const clock = document.getElementById('game-clock');
    const g = this.game;
    if (!clock) return;
    if (!this.team || !g) { clock.innerHTML = ''; this.gameOverlay(null); return; }
    const fmt = (ms) => {
      const s = Math.max(0, Math.round(ms / 1000));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    if (g.status === 'running') {
      clock.innerHTML = `⏱ <b>${fmt(g.remaining_ms)}</b>` + (g.frozen ? ' · <span style="color:#7fd0ff">🧊 frozen</span>' : '');
    } else if (g.status === 'paused') {
      clock.innerHTML = '⏸ paused';
    } else if (g.status === 'ended') {
      clock.innerHTML = '🏁 ended';
    } else {
      clock.innerHTML = '⏳ not started';
    }
    // Overlay for states where teams cannot play.
    const revealed = g.winner_revealed;
    if (g.status === 'stopped') this.gameOverlay('waiting');
    else if (g.status === 'paused') this.gameOverlay('paused');
    else if (g.status === 'ended' && !revealed) this.gameOverlay('ended');
    else this.gameOverlay(null);
    this.renderChrome();
  },

  gameOverlay(kind) {
    let el = document.getElementById('game-overlay');
    if (!kind) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'game-overlay'; document.body.appendChild(el); }
    const teamName = this.team ? escapeHtml(this.team.name) : '';
    const content = {
      waiting: { icon: '⏳', title: 'Waiting for the game to start', body: `You're logged in as <b>${teamName}</b>. The organizer hasn't started the round yet — hang tight, it'll begin automatically here.` },
      paused: { icon: '⏸', title: 'Game paused', body: 'The organizer has paused the match. Sit tight — it will resume shortly.' },
      ended: { icon: '🏁', title: "Time's up!", body: 'The round has ended. Waiting for the organizer to reveal the results…' },
    }[kind];
    el.innerHTML = `<div class="game-overlay-card">
      <div style="font-size:44px">${content.icon}</div>
      <h1 style="margin:8px 0">${content.title}</h1>
      <p class="muted" style="max-width:420px;margin:0 auto">${content.body}</p>
      <p style="margin-top:18px"><a href="#" onclick="Shop.leaveTeam();return false" style="color:var(--muted);font-size:13px">Leave team</a></p>
    </div>`;
  },

  async pollFeed() {
    if (!this.team) return;
    let data;
    try { ({ data } = await this.api('/teams/feed')); } catch (_) { return; }
    if (!data || data.frozen || !data.solved) return;
    const solvedIds = new Set(data.solved.map((s) => s.id));
    const myFbKeys = new Set((data.first_bloods || []).filter((f) => f.mine).map((f) => f.difficulty));

    if (typeof data.score === 'number' && this.team) { this.team.score = data.score; this.renderChrome(); }

    // First poll after (re)joining: remember state without celebrating history.
    if (this.knownSolved === null) {
      this.knownSolved = solvedIds;
      this.knownFirstBloods = myFbKeys;
      return;
    }

    const newSolves = data.solved.filter((s) => !this.knownSolved.has(s.id));
    const newFirstBloods = (data.first_bloods || [])
      .filter((f) => f.mine && !this.knownFirstBloods.has(f.difficulty));
    this.knownSolved = solvedIds;
    this.knownFirstBloods = myFbKeys;

    let delay = 0;
    newSolves.forEach((s) => { setTimeout(() => this.celebrate(s), delay); delay += 700; });
    newFirstBloods.forEach((f) => { setTimeout(() => this.celebrateFirstBlood(f), delay); delay += 900; });

    // Refresh the board/scoreboard in place if the player is looking at it.
    if (newSolves.length && (this._route === 'challenges')) this.challenges();
    if (newSolves.length && (this._route === 'scoreboard')) this.scoreboard();
  },

  celebrate(solved) {
    this.banner(
      `🎉 Gefeliciteerd! Challenge behaald: <b>${escapeHtml(solved.title)}</b>`,
      'solve'
    );
    this.fireConfetti(120);
    this.playSolveSound();
  },

  celebrateFirstBlood(fb) {
    const tier = (fb.difficulty || '').toUpperCase();
    this.banner(
      `🩸 FIRST BLOOD — ${tier}! Jouw team was als eerste in deze categorie. <b>+${fb.bonus} bonus</b>`,
      'firstblood'
    );
    this.fireConfetti(260, ['#ff3b3b', '#ffd23b', '#ff8c1a', '#ffffff']);
    this.playFirstBloodSound();
  },

  banner(html, kind) {
    let host = document.getElementById('celebrations');
    if (!host) {
      host = document.createElement('div');
      host.id = 'celebrations';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'celebrate-banner' + (kind === 'firstblood' ? ' firstblood' : '');
    el.innerHTML = html;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, kind === 'firstblood' ? 5200 : 3600);
  },

  fireConfetti(count, palette) {
    const colors = palette || ['#7c5cff', '#37d6a0', '#ffd23b', '#ff6ec7', '#4ab1ff', '#ffffff'];
    let canvas = document.getElementById('confetti-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'confetti-canvas';
      document.body.appendChild(canvas);
    }
    const ctx = canvas.getContext('2d');
    const DPR = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * DPR;
    canvas.height = window.innerHeight * DPR;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.scale(DPR, DPR);
    const W = window.innerWidth, H = window.innerHeight;
    const parts = [];
    for (let i = 0; i < count; i++) {
      parts.push({
        x: W / 2 + (Math.random() - 0.5) * W * 0.3,
        y: H * 0.28 + (Math.random() - 0.5) * 60,
        vx: (Math.random() - 0.5) * 12,
        vy: Math.random() * -12 - 4,
        g: 0.28 + Math.random() * 0.2,
        size: 5 + Math.random() * 7,
        color: colors[(Math.random() * colors.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        life: 0,
        max: 90 + Math.random() * 50,
      });
    }
    this._confetti = (this._confetti || []).concat(parts);
    if (this._confettiRAF) return; // one animation loop drives all bursts
    const step = () => {
      ctx.clearRect(0, 0, W, H);
      this._confetti = this._confetti.filter((p) => p.life < p.max && p.y < H + 40);
      for (const p of this._confetti) {
        p.life++; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (this._confetti.length) { this._confettiRAF = requestAnimationFrame(step); }
      else { this._confettiRAF = null; ctx.clearRect(0, 0, W, H); }
    };
    this._confettiRAF = requestAnimationFrame(step);
  },

  // Web Audio: synthesised so it works fully offline (no audio files).
  initAudio() {
    if (this._audio) { if (this._audio.state === 'suspended') this._audio.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this._audio = new AC();
    } catch (_) { /* audio unavailable */ }
  },

  tone(freq, start, dur, type, peak) {
    if (!this._audio) return;
    const ac = this._audio;
    const t0 = ac.currentTime + start;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type || 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak || 0.25, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  },

  playSolveSound() {
    this.initAudio();
    // Bright ascending arpeggio: C5 - E5 - G5 - C6.
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, i * 0.09, 0.22, 'triangle', 0.22));
  },

  playFirstBloodSound() {
    this.initAudio();
    // A little fanfare: G5, C6, E6, G6 held, with a shimmer on top.
    [783.99, 1046.5, 1318.5].forEach((f, i) => this.tone(f, i * 0.12, 0.3, 'sawtooth', 0.2));
    this.tone(1567.98, 0.36, 0.55, 'triangle', 0.28);
    this.tone(2093.0, 0.44, 0.5, 'sine', 0.16);
  },

  // --- Team session / gate -------------------------------------------------

  async init() {
    this.saveCart();
    // Unlock the audio context on the first user gesture (autoplay policy).
    const unlock = () => { this.initAudio(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    const { data } = await this.api('/teams/me');
    this.team = (data && data.team) || null;
    if (!this.team) { this.teamToken = null; localStorage.removeItem('vv_team_token'); }
    this.renderChrome();
    if (this.team) { this.startCelebrations(); this.home(); }
    else if (this.opsToken) this.opsConsole();
    else this.teamGate();
  },

  // Show/hide the shop chrome depending on whether a team is logged in.
  renderChrome() {
    const nav = document.getElementById('mainnav');
    const search = document.getElementById('searchwrap');
    const status = document.getElementById('team-status');
    const show = !!this.team;
    nav.style.display = show ? 'flex' : 'none';
    search.style.display = show ? 'flex' : 'none';
    if (this.team) {
      const frozen = this.game && this.game.frozen;
      const pts = frozen ? '🧊 hidden' : `<span class="pts">${this.team.score} pts</span>`;
      status.innerHTML = `Team <b>${escapeHtml(this.team.name)}</b> · ${pts}
        <button onclick="Shop.leaveTeam()">Leave</button>`;
    } else {
      status.innerHTML = '';
    }
  },

  teamGate() {
    this.team = null;
    this.renderChrome();
    const view = document.getElementById('view');
    view.innerHTML = `
      <div style="text-align:center;margin:20px 0 30px">
        <h1 style="font-size:34px;letter-spacing:2px"><span style="color:var(--accent)">◉</span> VINYL VAULT</h1>
        <p class="muted">A capture-the-flag playground. Log in as your team or create a new one to start playing.</p>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:900px;margin:0 auto">
        <div class="panel">
          <h2>Log in as a team</h2>
          <p class="muted" style="margin-top:0">Already have a team? Enter its name and join code.</p>
          <label>Team name</label><input id="tl-name" placeholder="The Wax Wizards" />
          <label>Join code</label><input id="tl-code" placeholder="VV-XXXXXX"
            onkeydown="if(event.key==='Enter') Shop.teamLogin()" />
          <button class="primary" style="margin-top:16px;width:100%" onclick="Shop.teamLogin()">Log in</button>
          <div id="tl-result"></div>
        </div>
        <div class="panel">
          <h2>Create a team</h2>
          <p class="muted" style="margin-top:0">New here? Pick a name — you'll get a join code to share with teammates.</p>
          <label>Team name</label><input id="tc-name" placeholder="Choose a team name"
            onkeydown="if(event.key==='Enter') Shop.teamCreate()" />
          <button class="primary" style="margin-top:16px;width:100%" onclick="Shop.teamCreate()">Create team &amp; start</button>
          <div id="tc-result"></div>
        </div>
      </div>
      <p class="muted" style="text-align:center;margin-top:24px;font-size:12px">
        Intentionally insecure training app — run locally only.
        · <a href="#" onclick="Shop.opsConsole();return false" style="color:var(--muted)">🔧 Operator console</a></p>`;
  },

  async teamLogin() {
    const name = document.getElementById('tl-name').value;
    const join_code = document.getElementById('tl-code').value.trim();
    if (!join_code) return;
    const { ok, data } = await this.api('/teams/login', {
      method: 'POST', body: JSON.stringify({ name, join_code }),
    });
    if (!ok) { this.gateError('tl-result', data.error || 'Login failed'); return; }
    this.setTeam(data);
  },

  async teamCreate() {
    const name = document.getElementById('tc-name').value.trim();
    if (!name) return;
    const { ok, data } = await this.api('/teams', { method: 'POST', body: JSON.stringify({ name }) });
    if (!ok) { this.gateError('tc-result', data.error || 'Could not create team'); return; }
    const box = document.getElementById('tc-result');
    if (box) box.innerHTML = `<div class="notice ok" style="margin-top:14px">
      Team created! Your join code (share with teammates): <b>${escapeHtml(data.join_code)}</b></div>`;
    this.setTeam(data, 1400);
  },

  gateError(id, msg) {
    const box = document.getElementById(id);
    if (box) box.innerHTML = `<div class="notice warn" style="margin-top:14px">${escapeHtml(msg)}</div>`;
  },

  setTeam(data, delay = 0) {
    this.teamToken = data.team_token;
    localStorage.setItem('vv_team_token', data.team_token);
    this.team = { id: data.id, name: data.name, score: data.score || 0 };
    this.renderChrome();
    this.startCelebrations();
    setTimeout(() => this.home(), delay);
  },

  leaveTeam() {
    this.teamToken = null; this.team = null; this.game = null;
    localStorage.removeItem('vv_team_token');
    this.stopCelebrations();
    this.gameOverlay(null);
    const clock = document.getElementById('game-clock'); if (clock) clock.innerHTML = '';
    this.teamGate();
  },

  // --- Operator (game-admin) console --------------------------------------

  async opsApi(pathname, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.opsToken) headers['Authorization'] = 'Bearer ' + this.opsToken;
    const res = await fetch('/api/gameadmin' + pathname, { ...opts, headers });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: res.ok, status: res.status, data: text }; }
  },

  async opsConsole() {
    // Hide the player chrome; the console is operator-only.
    this.team = null; this.renderChrome();
    if (this.opsToken) {
      const { ok } = await this.opsApi('/me');
      if (ok) return this.renderOpsConsole();
      this.opsToken = null; localStorage.removeItem('vv_ops_token');
    }
    const view = document.getElementById('view');
    view.innerHTML = `
      <div style="max-width:420px;margin:40px auto">
        <h1>🔧 Operator console</h1>
        <p class="muted">Game-admin sign-in. This is separate from the shop's (vulnerable) accounts.</p>
        <div class="panel">
          <label>Username</label><input id="ops-user" value="gameadmin" />
          <label>Password</label><input id="ops-pass" type="password" placeholder="••••••••"
            onkeydown="if(event.key==='Enter')Shop.opsLogin()" />
          <button class="primary" style="margin-top:14px;width:100%" onclick="Shop.opsLogin()">Sign in</button>
          <div id="ops-login-msg"></div>
        </div>
        <p class="muted" style="text-align:center;margin-top:16px;font-size:12px">
          <a href="#" onclick="Shop.init();return false" style="color:var(--muted)">← back to the game</a></p>
      </div>`;
  },

  async opsLogin() {
    const username = document.getElementById('ops-user').value.trim();
    const password = document.getElementById('ops-pass').value;
    const { ok, data } = await this.opsApi('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (!ok) {
      const m = document.getElementById('ops-login-msg');
      if (m) m.innerHTML = `<div class="notice warn" style="margin-top:12px">${escapeHtml((data && data.error) || 'Login failed')}</div>`;
      return;
    }
    this.opsToken = data.ops_token;
    localStorage.setItem('vv_ops_token', data.ops_token);
    this.renderOpsConsole();
  },

  async renderOpsConsole() {
    const view = document.getElementById('view');
    const { ok, data } = await this.opsApi('/teams');
    if (!ok) { this.opsToken = null; localStorage.removeItem('vv_ops_token'); return this.opsConsole(); }
    const modeDesc = {
      learn: 'free hints, templates on all tiers, primers, verbose errors',
      compete: 'costed hints, templates on easy/medium, scored play',
      hardcore: 'no hints, no templates, no primers, terse errors — realistic target',
    };
    const rows = data.teams.map((t) => `
      <tr>
        <td>${escapeHtml(t.name)}</td>
        <td>${t.score}</td>
        <td>${t.solved}</td>
        <td>
          <select onchange="Shop.opsSetMode(${t.id}, this.value)">
            ${data.modes.map((m) => `<option value="${m}"${m === t.mode ? ' selected' : ''}>${m}</option>`).join('')}
          </select>
        </td>
      </tr>`).join('');
    const g = (await this.opsApi('/game')).data || { status: 'stopped', remaining_ms: 0, duration_ms: 3600000, winner_revealed: false };
    const mins = Math.round((g.duration_ms || 3600000) / 60000);
    const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const statusColor = { running: '#37d6a0', paused: '#e0b341', ended: '#ff6b6b', stopped: 'var(--muted)' }[g.status] || 'var(--muted)';
    view.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <h1 style="margin-right:auto">🔧 Operator console</h1>
        <button onclick="Shop.init()">← Game</button>
        <button onclick="Shop.opsLogout()">Sign out</button>
      </div>
      <div class="panel">
        <h3 style="margin-top:0">⏱ Match clock</h3>
        <p style="margin:0 0 10px">
          Status: <b style="color:${statusColor}">${g.status}</b>
          · Remaining: <b>${fmt(g.remaining_ms)}</b>
          ${g.frozen ? '· <span style="color:#7fd0ff">🧊 standings frozen</span>' : ''}
          ${g.winner_revealed ? '· <span style="color:#37d6a0">winner revealed</span>' : ''}
        </p>
        <p class="muted" style="margin:0 0 10px">Default is <b>stopped</b> — teams can log in but see a waiting screen until you start. The last 15 min are frozen; the game ends automatically at 0:00.</p>
        <div class="lab-opts">
          <label class="chk">Duration (min) <input id="ops-mins" type="number" min="1" value="${mins}" class="lab-url" style="max-width:90px" /></label>
          <button class="primary" onclick="Shop.opsGame('start')">▶ Start</button>
          <button onclick="Shop.opsGame('pause')">⏸ Pause</button>
          <button onclick="Shop.opsGame('resume')">⏯ Resume</button>
          <button onclick="Shop.opsGame('stop')">⏹ Stop (end)</button>
          <button onclick="Shop.opsGame('reset')">↺ Reset to waiting</button>
          <button onclick="Shop.opsResults()">🏁 Results &amp; reveal</button>
        </div>
        <div id="ops-game-msg"></div>
      </div>
      <div class="panel" style="margin-top:14px">
        <h3 style="margin-top:0">Per-team mode</h3>
        <p class="muted" style="margin-top:0">Set difficulty scaffolding per team. Only operators can change this.</p>
        <ul class="muted" style="margin:6px 0 12px;font-size:13px">
          <li><b>learn</b> — ${modeDesc.learn}</li>
          <li><b>compete</b> — ${modeDesc.compete}</li>
          <li><b>hardcore</b> — ${modeDesc.hardcore}</li>
        </ul>
        <table>
          <thead><tr><th>Team</th><th>Score</th><th>Solved</th><th>Mode</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="muted">No teams yet.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="panel" style="margin-top:14px">
        <h3 style="margin-top:0">Operators</h3>
        <div id="ops-admins" class="muted" style="font-size:13px">loading…</div>
        <div class="lab-opts" style="margin-top:10px">
          <input id="ops-new-user" placeholder="new operator username" style="flex:1;min-width:160px" class="lab-url" />
          <input id="ops-new-pass" type="password" placeholder="password" class="lab-url" style="max-width:200px" />
          <button class="primary" onclick="Shop.opsCreateAdmin()">Add operator</button>
        </div>
        <div id="ops-admin-msg"></div>
      </div>
      <div class="panel" style="margin-top:14px">
        <h3 style="margin-top:0">Danger zone</h3>
        <p class="muted" style="margin-top:0">Wipe every team's score, solves, hints and first bloods for a fresh round.</p>
        <button onclick="Shop.opsResetScores()">Reset all scores</button>
        <span id="ops-reset-msg"></span>
      </div>`;
    this.opsLoadAdmins();
  },

  async opsGame(action) {
    let body = {};
    if (action === 'start') {
      const mins = Number(document.getElementById('ops-mins').value) || 60;
      body = { minutes: mins };
    }
    const { ok, data } = await this.opsApi('/game/' + action, { method: 'POST', body: JSON.stringify(body) });
    const msg = document.getElementById('ops-game-msg');
    if (msg) msg.innerHTML = ok
      ? `<div class="notice ok" style="margin-top:10px">Clock: ${escapeHtml(data.status)}</div>`
      : `<div class="notice warn" style="margin-top:10px">${escapeHtml((data && data.error) || 'failed')}</div>`;
    this.renderOpsConsole();
  },

  async opsResults() {
    const view = document.getElementById('view');
    const { ok, data } = await this.opsApi('/results');
    if (!ok) return this.renderOpsConsole();
    const rows = data.teams.map((t, i) => {
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      return `<tr><td>${medal}</td><td><b>${escapeHtml(t.name)}</b></td><td>${t.score}</td><td>${t.solved}</td></tr>`;
    }).join('');
    const winner = data.winner;
    const revealBlock = data.revealed
      ? `<div class="notice ok">Winner revealed to all teams ✓ — teams can see their results again.</div>`
      : `<button class="primary" onclick="Shop.opsReveal()">🎉 Reveal winner to teams</button>
         <p class="muted" style="font-size:12px;margin-top:6px">Until you reveal, teams see a blackout. You (operator) see the full standings below.</p>`;
    view.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <h1 style="margin-right:auto">🏁 Results</h1>
        <button onclick="Shop.renderOpsConsole()">← Console</button>
      </div>
      <div class="panel" style="text-align:center;padding:30px 20px">
        <div style="font-size:40px">🏆</div>
        <h2 style="margin:6px 0">${winner ? escapeHtml(winner.name) : 'No teams yet'}</h2>
        ${winner ? `<p class="muted">${winner.score} points · ${winner.solved} challenges</p>` : ''}
        <div style="margin-top:14px">${revealBlock}</div>
      </div>
      <div class="panel" style="margin-top:14px">
        <h3 style="margin-top:0">Full standings</h3>
        <table>
          <thead><tr><th></th><th>Team</th><th>Score</th><th>Solved</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="muted">No teams yet.</td></tr>'}</tbody>
        </table>
      </div>`;
  },

  async opsReveal() {
    await this.opsApi('/game/reveal', { method: 'POST' });
    this.opsResults();
  },

  async opsLoadAdmins() {
    const { ok, data } = await this.opsApi('/admins');
    const box = document.getElementById('ops-admins');
    if (box && ok) box.innerHTML = 'Current: ' + data.admins.map((a) => `<b>${escapeHtml(a.username)}</b>`).join(', ');
  },

  async opsSetMode(id, mode) {
    await this.opsApi('/teams/' + id + '/mode', { method: 'POST', body: JSON.stringify({ mode }) });
    this.toast('Mode updated to ' + mode);
  },

  async opsCreateAdmin() {
    const username = document.getElementById('ops-new-user').value.trim();
    const password = document.getElementById('ops-new-pass').value;
    const msg = document.getElementById('ops-admin-msg');
    if (!username || !password) { if (msg) msg.innerHTML = '<div class="notice warn" style="margin-top:10px">Username and password required</div>'; return; }
    const { ok, data } = await this.opsApi('/admins', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (msg) msg.innerHTML = `<div class="notice ${ok ? 'ok' : 'warn'}" style="margin-top:10px">${ok ? 'Operator created' : escapeHtml(data.error || 'failed')}</div>`;
    if (ok) { document.getElementById('ops-new-user').value = ''; document.getElementById('ops-new-pass').value = ''; this.opsLoadAdmins(); }
  },

  async opsResetScores() {
    if (!confirm('Reset ALL team scores, solves, hints and first bloods?')) return;
    const { ok } = await this.opsApi('/reset-scores', { method: 'POST' });
    const m = document.getElementById('ops-reset-msg');
    if (m) m.innerHTML = ok ? ' <span class="ok-txt">done</span>' : ' <span class="err-txt">failed</span>';
    this.renderOpsConsole();
  },

  opsLogout() {
    this.opsToken = null; localStorage.removeItem('vv_ops_token');
    this.opsConsole();
  },

  go(route, arg) {
    if (!this.team) return this.teamGate(); // gated until logged in as a team
    this._route = route;
    if (route === 'home') return this.home();
    if (route === 'product') return this.product(arg);
    if (route === 'cart') return this.cartView();
    if (route === 'account') return this.account();
    if (route === 'scoreboard') return this.scoreboard();
    if (route === 'challenges') return this.challenges();
    if (route === 'httplab') return this.httpLab();
    if (route === 'tools') return this.tools();
  },

  async challenges() {
    this._route = 'challenges';
    const { data } = await this.api('/challenges');
    if (data.team && this.team) { this.team.score = data.team.score; this.team.mode = data.mode; this.renderChrome(); }
    // Cache per-challenge data (templates, titles) for "Load in Lab" + deps.
    this._chData = {};
    (data.challenges || []).forEach((c) => { this._chData[c.id] = c; });
    const view = document.getElementById('view');
    const modeBadge = {
      learn: '<span class="tag" style="border-color:#37d6a0;color:#37d6a0">Learn mode</span>',
      compete: '<span class="tag" style="border-color:#4ab1ff;color:#4ab1ff">Compete mode</span>',
      hardcore: '<span class="tag" style="border-color:#ff6b6b;color:#ff6b6b">Hardcore mode</span>',
    }[data.mode] || '';
    const teamLine = data.team
      ? `Playing as <b>${escapeHtml(data.team.name)}</b> — ${data.team.score} pts.`
      : `<span class="notice warn" style="display:inline-block">Log in as a team to track progress and unlock hints.</span>`;
    const solvedCount = data.challenges.filter((c) => c.solved).length;
    const tiers = data.tiers || [];
    const meta = {
      easy: { label: 'Easy', color: 'var(--accent-2)' },
      medium: { label: 'Medium', color: '#e0b341' },
      hard: { label: 'Hard', color: '#e08341' },
      insane: { label: 'Insane', color: '#e05a5a' },
    };
    // Primers panel (learn/compete only).
    let primersHtml = '';
    if (data.primers) {
      const cats = [...new Set(data.challenges.map((c) => c.category))].filter((x) => data.primers[x]);
      primersHtml = `
        <details class="panel" style="margin:12px 0">
          <summary style="cursor:pointer"><b>New to this? Category primers</b> <span class="muted">— what each vulnerability class is</span></summary>
          <div style="margin-top:10px">${cats.map((cat) =>
            `<p style="margin:8px 0"><b>${escapeHtml(cat)}.</b> <span class="muted">${escapeHtml(data.primers[cat])}</span></p>`).join('')}</div>
        </details>`;
    }
    const starterIds = data.challenges.filter((c) => c.starter && !c.solved).map((c) => c.title);
    const startHint = (data.mode !== 'hardcore' && starterIds.length)
      ? `<p class="muted" style="margin-top:4px">⭐ New here? Good first challenges: ${starterIds.slice(0, 4).map(escapeHtml).join(', ')}.</p>` : '';
    const frozen = data.frozen;
    const progressLine = frozen
      ? `🧊 <b>Standings frozen</b> — your progress and score are hidden until the results are revealed. You can keep hacking!`
      : `${solvedCount} / ${data.total_challenges} solved · ${data.total_points} points on offer. ${teamLine}`;
    view.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h1 style="margin:0">🎯 Challenges</h1> ${modeBadge}
      </div>
      <p class="muted" style="margin:8px 0 0">${progressLine}</p>
      ${startHint}
      ${primersHtml}
      <div id="tierwrap"></div>`;
    const wrap = document.getElementById('tierwrap');
    tiers.forEach((t) => {
      const m = meta[t.difficulty] || { label: t.difficulty, color: 'var(--accent)' };
      const section = document.createElement('section');
      section.style.margin = '22px 0';
      section.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;border-left:4px solid ${m.color};padding-left:12px;margin-bottom:12px">
          <h2 style="margin:0;color:${m.color}">${m.label}</h2>
          <span class="tag" style="border-color:${m.color};color:${m.color}">${t.points_each} pts each</span>
          <span class="muted">${t.solved} / ${t.total} solved</span>
        </div>
        <div class="grid" id="grid-${t.difficulty}"></div>`;
      wrap.appendChild(section);
      const grid = section.querySelector('#grid-' + t.difficulty);
      t.challenges.forEach((c) => grid.appendChild(this.challengeCard(c, m.color)));
    });
  },

  challengeCard(c, tierColor) {
    const el = document.createElement('div');
    el.className = 'card';
    el.style.padding = '16px';
    const badge = c.solved
      ? `<span class="tag" style="border-color:var(--accent-2);color:var(--accent-2)">✓ Solved</span>`
      : `<span class="tag" style="border-color:${tierColor || 'var(--line)'};color:${tierColor || 'var(--muted)'}">${c.points} pts</span>`;
    const starter = (c.starter && !c.solved)
      ? `<span class="tag" style="border-color:#37d6a0;color:#37d6a0">⭐ Start here</span>` : '';
    const category = c.category ? `<span class="tag muted">${escapeHtml(c.category)}</span>` : '';
    // Dependency note (resolve titles from cache if available).
    let depNote = '';
    if (c.depends && c.depends.length) {
      const titles = c.depends.map((id) => (this._chData[id] && this._chData[id].title) || id);
      depNote = `<p class="muted" style="font-size:12px;margin:6px 0"><b>Builds on:</b> ${titles.map(escapeHtml).join(', ')}</p>`;
    }
    const hints = c.hints_unlocked.map((h) =>
      `<div class="notice ok" style="margin:6px 0"><b>Hint ${h.index + 1}:</b> ${escapeHtml(h.text)}</div>`).join('');
    let tipBtn = '';
    if (c.hints_disabled) {
      tipBtn = `<span class="muted" style="font-size:12px">Hints disabled (hardcore)</span>`;
    } else if (c.next_hint) {
      const label = c.next_hint.free ? '💡 Free hint' : `💡 Hint (−${c.next_hint.cost} pts)`;
      tipBtn = `<button onclick="Shop.getHint('${c.id}', ${c.next_hint.free}, ${c.next_hint.cost})">${label}</button>`;
    } else {
      tipBtn = `<span class="muted" style="font-size:12px">No more hints</span>`;
    }
    const loadBtn = c.template
      ? `<button onclick="Shop.loadTemplate('${c.id}')">🧪 Load in Lab</button>` : '';
    const explain = (c.solved && c.explain)
      ? `<details class="notice" style="margin-top:10px;background:var(--panel-2)">
           <summary style="cursor:pointer"><b>Why it worked &amp; how to fix</b></summary>
           <p style="margin:8px 0 4px"><b>Why:</b> ${escapeHtml(c.explain.why)}</p>
           <p style="margin:4px 0 0"><b>Fix:</b> ${escapeHtml(c.explain.fix)}</p>
         </details>` : '';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:start;gap:8px">
        <h3 style="margin:0">${escapeHtml(c.title)}</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${starter}${badge}</div>
      </div>
      <div style="margin:6px 0">${category}</div>
      <p class="muted" style="margin:8px 0 6px">${escapeHtml(c.description)}</p>
      ${depNote}
      <div class="chints">${hints}</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">${loadBtn}${tipBtn}</div>
      ${explain}`;
    return el;
  },

  loadTemplate(id) {
    const c = this._chData && this._chData[id];
    if (!c || !c.template) { this.toast('No template for this challenge'); return; }
    const t = c.template;
    this._labPrefill = { method: t.method || 'GET', url: t.url || '', headers: t.headers || '', body: t.body != null ? t.body : '' };
    this.go('httplab');
    this.toast('Loaded "' + c.title + '" into the Lab — fill in the payload');
  },

  async getHint(id, free, cost) {
    if (!free && !confirm(`This hint costs ${cost} points from your team's score. Reveal it?`)) return;
    const { ok, data } = await this.api(`/challenges/${id}/hint`, { method: 'POST' });
    if (!ok) { this.toast(data.error || 'Could not get hint'); return; }
    if (this.team && typeof data.team_score === 'number') { this.team.score = data.team_score; this.renderChrome(); }
    this.challenges(); // re-render with the newly revealed hint
    if (!free) this.toast(`Hint revealed — ${cost} pts spent (team score: ${data.team_score})`);
  },

  async scoreboard() {
    this._route = 'scoreboard';
    const { data } = await this.api('/teams/scoreboard');
    const view = document.getElementById('view');
    if (data.frozen) {
      const names = (data.team_names || []).map((n) => `<span class="tag">${escapeHtml(n)}</span>`).join(' ');
      view.innerHTML = `
        <h1>🏆 CTF Scoreboard</h1>
        <div class="panel" style="text-align:center;padding:40px 20px">
          <div style="font-size:44px">🧊</div>
          <h2 style="margin:8px 0">Scoreboard frozen</h2>
          <p class="muted">${escapeHtml(data.message || 'Standings are hidden right now.')}</p>
          <div style="margin-top:14px">${names}</div>
        </div>`;
      return;
    }
    const rows = (data.teams || []).map((t, i) => {
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      const pct = data.total_points ? Math.round((t.score / data.total_points) * 100) : 0;
      return `<tr>
        <td>${medal}</td>
        <td><b>${escapeHtml(t.name)}</b></td>
        <td>${t.score}</td>
        <td>${t.solved} / ${data.total_challenges}</td>
        <td>${t.members}</td>
        <td><div style="background:var(--panel-2);border-radius:6px;overflow:hidden;height:10px;width:120px">
          <div style="height:100%;width:${pct}%;background:var(--accent)"></div></div></td>
      </tr>`;
    }).join('');
    const tierOrder = ['easy', 'medium', 'hard', 'insane'];
    const fbMap = Object.fromEntries((data.first_bloods || []).map((f) => [f.difficulty, f]));
    const fbLine = tierOrder.map((tier) => {
      const f = fbMap[tier];
      const label = tier[0].toUpperCase() + tier.slice(1);
      return f
        ? `<span class="tag" style="border-color:#ff6b6b;color:#ff9a9a">🩸 ${label}: <b>${escapeHtml(f.team_name)}</b> +${f.bonus}</span>`
        : `<span class="tag muted">🩸 ${label}: up for grabs</span>`;
    }).join(' ');
    view.innerHTML = `
      <h1>🏆 CTF Scoreboard</h1>
      <p class="muted">${data.total_challenges} challenges · ${data.total_points} points total.
        Log in as a team, then start hunting — every first solve scores for your team.</p>
      <div style="margin:10px 0 18px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <b style="margin-right:4px">First blood:</b> ${fbLine}
      </div>
      <table>
        <thead><tr><th></th><th>Team</th><th>Score</th><th>Solved</th><th>Members</th><th>Progress</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">No teams yet.</td></tr>'}</tbody>
      </table>
      <p class="muted" style="margin-top:20px">Aggregating multiple per-team deployments? The same numbers roll up in Grafana via <code>vv_team_score</code>.</p>`;
  },

  // --- HTTP Lab: an in-app request console ---------------------------------

  httpLab() {
    this._route = 'httplab';
    this._labMode = this._labMode || 'json';
    const view = document.getElementById('view');
    const teamNote = this.team
      ? `X-Team-Token for <b>${escapeHtml(this.team.name)}</b> is added automatically.`
      : `No team session — log in as a team so your requests are attributed.`;
    view.innerHTML = `
      <h1>🧪 HTTP Lab</h1>
      <p class="muted">Fire raw HTTP requests at the shop to test and exploit it. ${teamNote}</p>
      <div class="lab">
        <div class="lab-line">
          <select id="lab-method" class="lab-method" onchange="Shop.labMethodChanged()">
            ${['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map((m) => `<option${m==='GET'?' selected':''}>${m}</option>`).join('')}
          </select>
          <input id="lab-url" class="lab-url" placeholder="/api/products/search?q=test" value="/api/products/search?q=test"
                 onkeydown="if(event.key==='Enter'&&(event.metaKey||event.ctrlKey))Shop.sendLabRequest()" />
          <button class="primary" onclick="Shop.sendLabRequest()">Send ▸</button>
        </div>

        <div class="lab-opts">
          <label class="chk"><input type="checkbox" id="lab-team" checked ${this.teamToken ? '' : 'disabled'}/> Add <code>X-Team-Token</code></label>
          <label class="chk"><input type="checkbox" id="lab-auth" ${this.token ? 'checked' : 'disabled'}/> Add <code>Authorization</code> (shop login)</label>
          <span class="lab-mode">
            Body:
            <button id="lab-tab-json" class="lab-tab active" onclick="Shop.labSetMode('json')">JSON</button>
            <button id="lab-tab-raw" class="lab-tab" onclick="Shop.labSetMode('raw')">Raw</button>
            <button class="lab-tab" onclick="Shop.labFormat()">Format</button>
          </span>
        </div>

        <label class="lab-label">Headers <span class="muted">(one per line, <code>Name: value</code>)</span></label>
        <textarea id="lab-headers" class="lab-ta" rows="2" spellcheck="false" placeholder="X-User-Role: admin"></textarea>

        <label class="lab-label">Body <span id="lab-json-status" class="muted"></span></label>
        <textarea id="lab-body" class="lab-ta code" rows="7" spellcheck="false"
          oninput="Shop.labBodyChanged()" placeholder='{\n  "example": true\n}'></textarea>
        <pre id="lab-body-preview" class="lab-pre"></pre>

        <div id="lab-response"></div>
      </div>`;
    this.labMethodChanged();
    this.labBodyChanged();
    if (this._labPrefill) {
      const p = this._labPrefill; this._labPrefill = null;
      if (p.method) document.getElementById('lab-method').value = p.method;
      if (p.url) document.getElementById('lab-url').value = p.url;
      if (p.headers) document.getElementById('lab-headers').value = p.headers;
      if (p.body != null) { document.getElementById('lab-body').value = p.body; }
      this.labMethodChanged();
      this.labBodyChanged();
    }
  },

  labSetMode(mode) {
    this._labMode = mode;
    document.getElementById('lab-tab-json').classList.toggle('active', mode === 'json');
    document.getElementById('lab-tab-raw').classList.toggle('active', mode === 'raw');
    this.labBodyChanged();
  },

  labMethodChanged() {
    const m = document.getElementById('lab-method').value;
    const bodyless = m === 'GET' || m === 'HEAD';
    const ta = document.getElementById('lab-body');
    ta.disabled = bodyless;
    ta.style.opacity = bodyless ? 0.5 : 1;
  },

  labBodyChanged() {
    const ta = document.getElementById('lab-body');
    const pre = document.getElementById('lab-body-preview');
    const status = document.getElementById('lab-json-status');
    const text = ta.value;
    if (this._labMode === 'json') {
      pre.style.display = 'block';
      pre.innerHTML = this.hlJSON(text);
      if (!text.trim()) { status.textContent = ''; }
      else {
        try { JSON.parse(text); status.innerHTML = '<span class="ok-txt">✓ valid JSON</span>'; }
        catch (e) { status.innerHTML = `<span class="err-txt">✗ ${escapeHtml(e.message)}</span>`; }
      }
    } else {
      pre.style.display = 'none';
      status.textContent = '';
    }
  },

  labFormat() {
    if (this._labMode !== 'json') return;
    const ta = document.getElementById('lab-body');
    try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); this.labBodyChanged(); }
    catch (_) { this.toast('Cannot format: body is not valid JSON'); }
  },

  async sendLabRequest() {
    const method = document.getElementById('lab-method').value;
    const url = document.getElementById('lab-url').value.trim();
    if (!url) { this.toast('Enter a URL'); return; }
    const bodyText = document.getElementById('lab-body').value;
    const headers = {};
    document.getElementById('lab-headers').value.split('\n').forEach((line) => {
      const i = line.indexOf(':');
      if (i > 0) { const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim(); if (k) headers[k] = v; }
    });
    const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
    const bodyless = method === 'GET' || method === 'HEAD';
    const hasBody = !bodyless && bodyText.trim() !== '';
    if (this._labMode === 'json' && hasBody && !has('content-type')) headers['Content-Type'] = 'application/json';
    if (document.getElementById('lab-team').checked && this.teamToken && !has('x-team-token')) headers['X-Team-Token'] = this.teamToken;
    if (document.getElementById('lab-auth').checked && this.token && !has('authorization')) headers['Authorization'] = 'Bearer ' + this.token;
    if (this._labMode === 'json' && hasBody) {
      try { JSON.parse(bodyText); } catch (e) { if (!confirm('Body is not valid JSON — send it anyway?')) return; }
    }
    const opts = { method, headers, credentials: 'include' };
    if (hasBody) opts.body = bodyText;
    const box = document.getElementById('lab-response');
    box.innerHTML = `<div class="muted" style="margin-top:14px">Sending ${escapeHtml(method)} ${escapeHtml(url)}…</div>`;
    const t0 = performance.now();
    let res, text;
    try { res = await fetch(url, opts); text = await res.text(); }
    catch (e) {
      box.innerHTML = `<div class="notice warn" style="margin-top:14px">Request failed: ${escapeHtml(String(e))}<br><span class="muted">Cross-origin URLs may be blocked by the browser; use a path on this origin.</span></div>`;
      return;
    }
    this.renderLabResponse(res, text, Math.round(performance.now() - t0), opts);
    setTimeout(() => this.pollFeed(), 300); // fire celebrations promptly if this solved something
  },

  renderLabResponse(res, text, ms, opts) {
    const box = document.getElementById('lab-response');
    const cls = res.status < 300 ? 'st-2xx' : res.status < 400 ? 'st-3xx' : res.status < 500 ? 'st-4xx' : 'st-5xx';
    const hdrs = [];
    res.headers.forEach((v, k) => hdrs.push(`${k}: ${v}`));
    let bodyHtml, contentType = res.headers.get('content-type') || '';
    if (/json/i.test(contentType) || /^[\s]*[{[]/.test(text)) {
      try { bodyHtml = this.hlJSON(JSON.stringify(JSON.parse(text), null, 2)); }
      catch (_) { bodyHtml = escapeHtml(text); }
    } else { bodyHtml = escapeHtml(text); }
    const sentHdrs = Object.entries(opts.headers).map(([k, v]) => {
      const masked = /token|authorization/i.test(k) ? v.slice(0, 12) + '…' : v;
      return `${k}: ${masked}`;
    });
    box.innerHTML = `
      <div class="lab-resp-head">
        <span class="st-badge ${cls}">${res.status} ${escapeHtml(res.statusText || '')}</span>
        <span class="muted">${ms} ms · ${text.length} bytes</span>
      </div>
      <details class="lab-det"><summary>Request headers sent (${sentHdrs.length})</summary><pre class="lab-pre">${escapeHtml(sentHdrs.join('\n'))}</pre></details>
      <details class="lab-det" open><summary>Response headers (${hdrs.length})</summary><pre class="lab-pre">${escapeHtml(hdrs.join('\n'))}</pre></details>
      <label class="lab-label">Response body</label>
      <pre class="lab-pre code">${bodyHtml}</pre>`;
  },

  // Minimal offline JSON syntax highlighter.
  hlJSON(str) {
    if (str == null) return '';
    const esc = String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
      (m) => {
        let cls = 'num';
        if (/^"/.test(m)) cls = /:\s*$/.test(m) ? 'key' : 'str';
        else if (/^(true|false)$/.test(m)) cls = 'bool';
        else if (m === 'null') cls = 'null';
        return `<span class="j-${cls}">${m}</span>`;
      }
    );
  },

  // --- Tools: JWT, Base64, URL encoding (all offline, in-browser) ----------

  tools() {
    this._route = 'tools';
    const view = document.getElementById('view');
    view.innerHTML = `
      <h1>🛠 Tools</h1>
      <p class="muted">Everything you need to craft payloads without leaving the app. Build a token here, then hand it straight to the HTTP Lab.</p>

      <div class="panel" style="margin-top:14px">
        <h3 style="margin-top:0">JWT — decode &amp; forge</h3>
        <label class="lab-label">Decode a token</label>
        <textarea id="jwt-in" class="lab-ta code" rows="2" spellcheck="false" placeholder="paste a JWT…" oninput="Shop.jwtDecode()"></textarea>
        <pre id="jwt-decoded" class="lab-pre"></pre>

        <label class="lab-label">Forge a token</label>
        <div class="tool-grid">
          <div>
            <span class="muted" style="font-size:12px">Header</span>
            <textarea id="jwt-h" class="lab-ta code" rows="3" spellcheck="false">{ "alg": "HS256", "typ": "JWT" }</textarea>
          </div>
          <div>
            <span class="muted" style="font-size:12px">Payload</span>
            <textarea id="jwt-p" class="lab-ta code" rows="3" spellcheck="false">{ "sub": 1, "role": "admin" }</textarea>
          </div>
        </div>
        <div class="lab-opts" style="margin-top:8px">
          <label class="chk">alg
            <select id="jwt-alg" class="lab-method" style="min-width:90px" onchange="Shop.jwtAlgChanged()">
              <option>HS256</option><option>none</option>
            </select>
          </label>
          <label class="chk" id="jwt-secret-wrap">secret
            <input id="jwt-secret" class="lab-url" style="max-width:260px" value="vinyl-vault-dev-secret" />
          </label>
          <button class="primary" onclick="Shop.jwtBuild()">Build token</button>
        </div>
        <pre id="jwt-out" class="lab-pre"></pre>
        <div id="jwt-actions"></div>
      </div>

      <div class="panel" style="margin-top:14px">
        <h3 style="margin-top:0">Base64</h3>
        <textarea id="b64-in" class="lab-ta code" rows="2" spellcheck="false" placeholder='e.g. {"role":"admin"}'></textarea>
        <div class="lab-opts" style="margin-top:8px">
          <button onclick="Shop.b64('enc')">Encode ▸</button>
          <button onclick="Shop.b64('encurl')">Encode URL-safe ▸</button>
          <button onclick="Shop.b64('dec')">◂ Decode</button>
        </div>
        <pre id="b64-out" class="lab-pre"></pre>
      </div>

      <div class="panel" style="margin-top:14px">
        <h3 style="margin-top:0">URL encoding</h3>
        <textarea id="url-in" class="lab-ta code" rows="2" spellcheck="false" placeholder="e.g. %' OR '1'='1"></textarea>
        <div class="lab-opts" style="margin-top:8px">
          <button onclick="Shop.urlenc('enc')">Encode ▸</button>
          <button onclick="Shop.urlenc('dec')">◂ Decode</button>
        </div>
        <pre id="url-out" class="lab-pre"></pre>
      </div>`;
    this.jwtAlgChanged();
  },

  jwtAlgChanged() {
    const none = document.getElementById('jwt-alg').value === 'none';
    document.getElementById('jwt-secret-wrap').style.opacity = none ? 0.4 : 1;
    document.getElementById('jwt-secret').disabled = none;
  },

  jwtDecode() {
    const out = document.getElementById('jwt-decoded');
    const t = document.getElementById('jwt-in').value.trim();
    if (!t) { out.innerHTML = ''; return; }
    const parts = t.split('.');
    if (parts.length < 2) { out.innerHTML = '<span class="err-txt">Not a JWT</span>'; return; }
    try {
      const dec = (s) => JSON.parse(this.b64urlDecode(s));
      out.innerHTML = '<b>header</b>\n' + this.hlJSON(JSON.stringify(dec(parts[0]), null, 2)) +
        '\n\n<b>payload</b>\n' + this.hlJSON(JSON.stringify(dec(parts[1]), null, 2));
    } catch (e) { out.innerHTML = '<span class="err-txt">Cannot decode: ' + escapeHtml(e.message) + '</span>'; }
  },

  async jwtBuild() {
    const out = document.getElementById('jwt-out');
    let header, payload;
    try { header = JSON.parse(document.getElementById('jwt-h').value); }
    catch (e) { out.innerHTML = '<span class="err-txt">Header is not valid JSON</span>'; return; }
    try { payload = JSON.parse(document.getElementById('jwt-p').value); }
    catch (e) { out.innerHTML = '<span class="err-txt">Payload is not valid JSON</span>'; return; }
    const alg = document.getElementById('jwt-alg').value;
    header.alg = alg;
    const h = this.b64urlEncode(JSON.stringify(header));
    const p = this.b64urlEncode(JSON.stringify(payload));
    let token;
    if (alg === 'none') {
      token = h + '.' + p + '.';
    } else {
      const secret = document.getElementById('jwt-secret').value;
      const sig = await this.hmacSha256(secret, h + '.' + p);
      token = h + '.' + p + '.' + sig;
    }
    out.textContent = token;
    document.getElementById('jwt-actions').innerHTML =
      '<div class="lab-opts" style="margin-top:8px">' +
      '<button onclick="Shop.copyText(Shop._lastJwt)">Copy</button>' +
      '<button class="primary" onclick="Shop.sendJwtToLab(Shop._lastJwt)">→ Use in HTTP Lab as Bearer</button>' +
      '</div>';
    this._lastJwt = token;
  },

  sendJwtToLab(token) {
    this._labPrefill = { method: 'GET', url: '/api/admin/stats', headers: 'Authorization: Bearer ' + token };
    this.go('httplab');
  },

  b64(op) {
    const inp = document.getElementById('b64-in').value;
    const out = document.getElementById('b64-out');
    try {
      if (op === 'dec') out.textContent = this.b64decode(inp.trim());
      else { let s = btoa(unescape(encodeURIComponent(inp))); if (op === 'encurl') s = s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); out.textContent = s; }
    } catch (e) { out.innerHTML = '<span class="err-txt">' + escapeHtml(e.message) + '</span>'; }
  },

  urlenc(op) {
    const inp = document.getElementById('url-in').value;
    const out = document.getElementById('url-out');
    try { out.textContent = op === 'dec' ? decodeURIComponent(inp) : encodeURIComponent(inp); }
    catch (e) { out.innerHTML = '<span class="err-txt">' + escapeHtml(e.message) + '</span>'; }
  },

  copyText(t) { if (navigator.clipboard) navigator.clipboard.writeText(t); this.toast('Copied'); },

  b64urlEncode(str) {
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return decodeURIComponent(escape(atob(str)));
  },
  b64decode(str) { return decodeURIComponent(escape(atob(str))); },
  async hmacSha256(secret, data) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
    let bin = '';
    new Uint8Array(sig).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },

  async home() {
    const { data } = await this.api('/products');
    const view = document.getElementById('view');
    view.innerHTML = `<h1>New in the crates</h1><div class="grid" id="grid"></div>`;
    const grid = document.getElementById('grid');
    data.forEach((p) => grid.appendChild(this.cardEl(p)));
  },

  cardEl(p) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="cover">${cover(p.id)}</div>
      <div class="body">
        <h3>${escapeHtml(p.title)}</h3>
        <div class="artist">${escapeHtml(p.artist)} · ${p.year || ''}</div>
        <div class="row">
          <span class="price">€${p.price.toFixed(2)}</span>
          <span class="tag">${escapeHtml(p.genre)}</span>
        </div>
      </div>`;
    el.querySelector('.cover').onclick = () => this.product(p.id);
    el.querySelector('h3').onclick = () => this.product(p.id);
    const btnRow = document.createElement('div');
    btnRow.style.padding = '0 14px 14px';
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.style.width = '100%';
    btn.textContent = 'Add to cart';
    btn.onclick = () => this.add(p.id, p.title, p.price);
    btnRow.appendChild(btn);
    el.appendChild(btnRow);
    return el;
  },

  async search() {
    const q = document.getElementById('search').value;
    const { data } = await this.api('/products/search?q=' + encodeURIComponent(q));
    const view = document.getElementById('view');
    // VULN: the raw query is reflected into the DOM via innerHTML.
    view.innerHTML = `<h1>Results for “${q}”</h1><div class="grid" id="grid"></div>`;
    const grid = document.getElementById('grid');
    (data.results || []).forEach((p) => grid.appendChild(this.cardEl(p)));
    if (!(data.results || []).length) grid.innerHTML = '<p class="muted">No records found.</p>';
  },

  async product(id) {
    const { data: p } = await this.api('/products/' + id);
    const { data: reviews } = await this.api(`/products/${id}/reviews`);
    const view = document.getElementById('view');
    view.innerHTML = `
      <button onclick="Shop.go('home')">← Back</button>
      <div class="detail" style="margin-top:16px">
        <div class="cover">${cover(p.id)}</div>
        <div>
          <h1>${escapeHtml(p.title)}</h1>
          <p class="muted">${escapeHtml(p.artist)} · ${escapeHtml(p.genre)} · ${p.year || ''}</p>
          <p>${escapeHtml(p.description || '')}</p>
          <p class="price" style="font-size:22px">€${p.price.toFixed(2)}</p>
          <button class="primary" onclick="Shop.add(${p.id}, ${JSON.stringify(p.title)}, ${p.price})">
            Add to cart
          </button>
        </div>
      </div>
      <div class="reviews">
        <h2>Reviews</h2>
        <div id="reviewlist"></div>
        <div class="panel" style="max-width:none;margin-top:16px">
          <h3>Leave a review</h3>
          <label>Name</label><input id="r-author" placeholder="Your name" />
          <label>Rating (1-5)</label><input id="r-rating" type="number" min="1" max="5" value="5" />
          <label>Review</label><textarea id="r-body"></textarea>
          <button class="primary" style="margin-top:12px" onclick="Shop.postReview(${p.id})">Post review</button>
        </div>
      </div>`;
    const list = document.getElementById('reviewlist');
    if (!reviews.length) list.innerHTML = '<p class="muted">No reviews yet.</p>';
    reviews.forEach((r) => {
      const el = document.createElement('div');
      el.className = 'review';
      // VULN: review body rendered as raw HTML -> stored XSS executes here.
      el.innerHTML = `<div class="meta">★${r.rating} · ${escapeHtml(r.author)} · ${r.created_at}</div>
                      <div class="rbody">${r.body}</div>`;
      list.appendChild(el);
    });
  },

  async postReview(id) {
    const body = {
      author: document.getElementById('r-author').value || 'Anonymous',
      rating: document.getElementById('r-rating').value,
      body: document.getElementById('r-body').value,
    };
    await this.api(`/products/${id}/reviews`, { method: 'POST', body: JSON.stringify(body) });
    this.product(id);
  },

  cartView() {
    const view = document.getElementById('view');
    const total = this.cart.reduce((t, i) => t + i.price * i.qty, 0);
    view.innerHTML = `<h1>Your cart</h1>`;
    if (!this.cart.length) { view.innerHTML += '<p class="muted">Cart is empty.</p>'; return; }
    let rows = this.cart.map((i) =>
      `<tr><td>${escapeHtml(i.title)}</td><td>${i.qty}</td><td>€${(i.price * i.qty).toFixed(2)}</td></tr>`).join('');
    view.innerHTML += `
      <table><thead><tr><th>Record</th><th>Qty</th><th>Subtotal</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="panel" style="margin-top:20px">
        <label>Coupon code</label><input id="coupon" placeholder="WELCOME10" />
        <label>Shipping address</label><input id="addr" placeholder="Street, City" />
        <p style="margin-top:12px">Total: <span class="price" id="total">€${total.toFixed(2)}</span></p>
        <button onclick="Shop.applyCoupon(${total})">Apply coupon</button>
        <button class="primary" onclick="Shop.checkout()">Place order</button>
      </div>`;
  },

  async applyCoupon(total) {
    const code = document.getElementById('coupon').value;
    const { data } = await this.api('/checkout/apply-coupon', {
      method: 'POST', body: JSON.stringify({ total, code }),
    });
    document.getElementById('total').textContent = '€' + Number(data.total).toFixed(2);
  },

  async checkout() {
    if (!this.token) { this.toast('Please sign in first'); return this.account(); }
    const coupon = (document.getElementById('coupon') || {}).value;
    const address = (document.getElementById('addr') || {}).value;
    const { ok, data } = await this.api('/orders', {
      method: 'POST',
      body: JSON.stringify({ items: this.cart, coupon, address }),
    });
    if (ok) {
      this.cart = []; this.saveCart();
      this.toast(`Order #${data.id} placed — total €${Number(data.total).toFixed(2)}`);
      this.home();
    } else { this.toast('Checkout failed'); }
  },

  async account() {
    const view = document.getElementById('view');
    if (this.token) {
      const { data: me } = await this.api('/me');
      const { data: orders } = await this.api('/orders');
      const teamBlock = this.team
        ? `<p>Playing as <b>${escapeHtml(this.team.name)}</b> — ${this.team.score} pts.</p>
           <div style="display:flex;gap:6px">
             <button onclick="Shop.go('challenges')">View challenges</button>
             <button onclick="Shop.go('scoreboard')">Scoreboard</button>
             <button onclick="Shop.leaveTeam()">Leave team</button>
           </div>`
        : `<p class="muted">No team session.</p>`;
      view.innerHTML = `
        <h1>Account</h1>
        <div class="panel">
          <h3 style="margin-top:0">Shop account</h3>
          <p><b>${escapeHtml(me.display_name || me.email)}</b> — ${escapeHtml(me.email)}</p>
          <p class="muted">Role: ${escapeHtml(me.role)} · id: ${me.id}</p>
          <button onclick="Shop.logout()">Sign out of shop account</button>
        </div>
        <div class="panel" style="margin-top:16px">
          <h3 style="margin-top:0">Team (CTF)</h3>
          ${teamBlock}
        </div>
        <h2 style="margin-top:24px">Your orders</h2>
        <div id="orders"></div>`;
      const o = document.getElementById('orders');
      if (!orders.length) o.innerHTML = '<p class="muted">No orders yet.</p>';
      orders.forEach((ord) => {
        const el = document.createElement('div');
        el.className = 'review';
        el.innerHTML = `<div class="meta">Order #${ord.id} · ${ord.status} · €${ord.total.toFixed(2)}</div>
                        <div>${escapeHtml(ord.address || '')}</div>`;
        o.appendChild(el);
      });
      return;
    }
    view.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:960px">
        <div class="panel">
          <h2>Sign in</h2>
          <label>Email</label><input id="li-email" />
          <label>Password</label><input id="li-pass" type="password" />
          <button class="primary" style="margin-top:14px" onclick="Shop.login()">Sign in</button>
        </div>
        <div class="panel">
          <h2>Create account</h2>
          <label>Email</label><input id="rg-email" />
          <label>Display name</label><input id="rg-name" />
          <label>Password</label><input id="rg-pass" type="password" />
          <button class="primary" style="margin-top:14px" onclick="Shop.register()">Register</button>
        </div>
      </div>`;
  },

  async login() {
    const email = document.getElementById('li-email').value;
    const password = document.getElementById('li-pass').value;
    const { ok, data } = await this.api('/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (ok) { this.token = data.token; localStorage.setItem('vv_token', data.token); this.account(); }
    else { this.toast('Login failed'); }
  },

  async register() {
    const body = {
      email: document.getElementById('rg-email').value,
      display_name: document.getElementById('rg-name').value,
      password: document.getElementById('rg-pass').value,
    };
    const { ok, data } = await this.api('/register', { method: 'POST', body: JSON.stringify(body) });
    if (ok) { this.token = data.token; localStorage.setItem('vv_token', data.token); this.account(); }
    else { this.toast('Registration failed'); }
  },

  logout() {
    this.token = null; localStorage.removeItem('vv_token');
    document.cookie = 'token=; Max-Age=0';
    this.account();
  },
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

Shop.init();
