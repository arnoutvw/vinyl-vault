'use strict';

/*
 * Database layer for Vinyl Vault.
 *
 * Uses better-sqlite3 with a file-backed DB so data survives restarts inside
 * the container volume. On first boot it creates the schema and seeds demo
 * data (products, users, reviews, orders, coupons).
 *
 * NOTE: Passwords here are stored using an intentionally weak scheme
 * (unsalted MD5) — this is part of the training surface, not an accident.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.VV_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'vinyl-vault.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// --- Intentionally weak password hashing (unsalted MD5) --------------------
function weakHash(password) {
  return crypto.createHash('md5').update(String(password)).digest('hex');
}

// --- STRONG hashing for GAME-ADMIN accounts (scrypt, salted). This is CTF
// infrastructure and is deliberately not part of the vulnerable surface. ------
function strongHash(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}
function strongVerify(password, stored) {
  try {
    const [, saltHex, dkHex] = String(stored).split('$');
    const salt = Buffer.from(saltHex, 'hex');
    const dk = crypto.scryptSync(String(password), salt, 32);
    return crypto.timingSafeEqual(dk, Buffer.from(dkHex, 'hex'));
  } catch (_) { return false; }
}

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setConfig(key, value) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT UNIQUE NOT NULL,
      password      TEXT NOT NULL,            -- weak md5 hash
      display_name  TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'customer',
      secret_question TEXT,
      secret_answer   TEXT,                   -- stored in plaintext (flaw)
      team_id       INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS teams (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT UNIQUE NOT NULL,
      join_code   TEXT NOT NULL,
      score       INTEGER NOT NULL DEFAULT 0,
      mode        TEXT NOT NULL DEFAULT 'compete',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Game operators (the CTF admins). Deliberately SEPARATE from the shop's
    -- vulnerable "admin" user role: this table, its password hashing and its
    -- token secret are NOT part of the challenge attack surface.
    CREATE TABLE IF NOT EXISTS game_admins (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT UNIQUE NOT NULL,
      pass_hash   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_solves (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id     INTEGER NOT NULL,
      challenge   TEXT NOT NULL,
      points      INTEGER NOT NULL DEFAULT 0,
      solved_by   INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (team_id, challenge)
    );

    CREATE TABLE IF NOT EXISTS team_hints (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id     INTEGER NOT NULL,
      challenge   TEXT NOT NULL,
      hint_index  INTEGER NOT NULL,
      cost        INTEGER NOT NULL DEFAULT 0,
      unlocked_by INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (team_id, challenge, hint_index)
    );

    CREATE TABLE IF NOT EXISTS first_bloods (
      difficulty  TEXT PRIMARY KEY,
      team_id     INTEGER NOT NULL,
      challenge   TEXT NOT NULL,
      bonus       INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      artist      TEXT NOT NULL,
      genre       TEXT NOT NULL,
      year        INTEGER,
      price       REAL NOT NULL,
      stock       INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      cover       TEXT
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id  INTEGER NOT NULL,
      author      TEXT NOT NULL,
      rating      INTEGER NOT NULL,
      body        TEXT NOT NULL,             -- stored raw -> stored XSS
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      items_json  TEXT NOT NULL,
      total       REAL NOT NULL,
      address     TEXT,
      status      TEXT NOT NULL DEFAULT 'processing',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS coupons (
      code        TEXT PRIMARY KEY,
      description TEXT,
      formula     TEXT NOT NULL              -- evaluated server-side (flaw)
    );
  `);

  // Defensive migration: add users.team_id if an older DB predates it.
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (!cols.some((c) => c.name === 'team_id')) {
    db.exec('ALTER TABLE users ADD COLUMN team_id INTEGER');
  }
  // Defensive migration: add teams.mode for older DBs.
  const teamCols = db.prepare("PRAGMA table_info(teams)").all();
  if (!teamCols.some((c) => c.name === 'mode')) {
    db.exec("ALTER TABLE teams ADD COLUMN mode TEXT NOT NULL DEFAULT 'compete'");
  }
}

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) return; // already seeded

  const insertUser = db.prepare(`
    INSERT INTO users (email, password, display_name, role, secret_question, secret_answer)
    VALUES (@email, @password, @display_name, @role, @secret_question, @secret_answer)
  `);

  const users = [
    {
      email: 'admin@vinylvault.test',
      password: weakHash('Vinyl!Admin2019'),
      display_name: 'Store Admin',
      role: 'admin',
      secret_question: 'First concert you attended?',
      secret_answer: 'Nirvana 1993',
    },
    {
      email: 'dj.mole@vinylvault.test',
      password: weakHash('spinspin'),
      display_name: 'DJ Mole',
      role: 'customer',
      secret_question: 'Name of your first pet?',
      secret_answer: 'Groovy',
    },
    {
      email: 'ripley@vinylvault.test',
      password: weakHash('nostromo'),
      display_name: 'Ellen R.',
      role: 'customer',
      secret_question: 'City you were born in?',
      secret_answer: 'Rotterdam',
    },
    {
      // Hidden "staff backdoor" account with an easily guessed password.
      email: 'support@vinylvault.test',
      password: weakHash('changeme'),
      display_name: 'Support Bot',
      role: 'admin',
      secret_question: 'Internal ticket prefix?',
      secret_answer: 'VV-',
    },
  ];
  const insertMany = db.transaction((rows) => rows.forEach((r) => insertUser.run(r)));
  insertMany(users);

  const insertProduct = db.prepare(`
    INSERT INTO products (title, artist, genre, year, price, stock, description, cover)
    VALUES (@title, @artist, @genre, @year, @price, @stock, @description, @cover)
  `);

  const products = [
    { title: 'Midnight Static', artist: 'The Cathode Rays', genre: 'Synthwave', year: 1984, price: 24.99, stock: 12, description: 'Neon-drenched analog synth grooves. Limited teal pressing.', cover: 'midnight-static.png' },
    { title: 'Deep Cuts Vol. 3', artist: 'Marrow', genre: 'Post-Punk', year: 1991, price: 18.50, stock: 7, description: 'Remastered from the original 1/4" tapes.', cover: 'deep-cuts.png' },
    { title: 'Sunroom Sessions', artist: 'Fenna & the Ferns', genre: 'Folk', year: 2018, price: 21.00, stock: 20, description: 'Warm acoustic recordings from a greenhouse in Utrecht.', cover: 'sunroom.png' },
    { title: 'Concrete Bloom', artist: 'Brutalist Youth', genre: 'Industrial', year: 1997, price: 27.75, stock: 3, description: 'Heavy, mechanical, uncompromising. 180g double LP.', cover: 'concrete-bloom.png' },
    { title: 'Tape Hiss Lullabies', artist: 'Old Reel', genre: 'Ambient', year: 2005, price: 15.99, stock: 33, description: 'Lo-fi bedroom ambient. Comes with a hand-drawn insert.', cover: 'tape-hiss.png' },
    { title: 'Golden Hour Riot', artist: 'The Amber Kids', genre: 'Indie Rock', year: 2021, price: 22.40, stock: 9, description: 'Debut LP. Translucent orange vinyl.', cover: 'golden-hour.png' },
    { title: 'Cassette Culture', artist: 'DJ Mole', genre: 'Hip-Hop', year: 1999, price: 19.95, stock: 14, description: 'Turntablist classic. Signed copies available.', cover: 'cassette-culture.png' },
    { title: 'Employee Pressing (DO NOT SELL)', artist: 'Internal', genre: 'Misc', year: 2020, price: 0.00, stock: 1, description: 'Staff-only test pressing. Should not be visible in the shop.', cover: 'internal.png' },
  ];
  const insertProducts = db.transaction((rows) => rows.forEach((r) => insertProduct.run(r)));
  insertProducts(products);

  const insertReview = db.prepare(`
    INSERT INTO reviews (product_id, author, rating, body) VALUES (?, ?, ?, ?)
  `);
  insertReview.run(1, 'DJ Mole', 5, 'Absolute banger. The B-side melts your face.');
  insertReview.run(1, 'ripley@vinylvault.test', 4, 'Great pressing, minimal surface noise.');
  insertReview.run(3, 'Guest', 5, 'Perfect Sunday morning record.');

  const insertOrder = db.prepare(`
    INSERT INTO orders (user_id, items_json, total, address, status) VALUES (?, ?, ?, ?, ?)
  `);
  insertOrder.run(2, JSON.stringify([{ productId: 1, qty: 1 }]), 24.99, 'Keizersgracht 1, Amsterdam', 'shipped');
  insertOrder.run(3, JSON.stringify([{ productId: 3, qty: 2 }]), 42.00, 'Coolsingel 40, Rotterdam', 'processing');
  // Admin order that reveals an internal note - juicy for IDOR hunting.
  insertOrder.run(1, JSON.stringify([{ productId: 8, qty: 1 }]), 0.0, 'INTERNAL - warehouse pickup. Master key code: 4471', 'internal');

  const insertCoupon = db.prepare(`
    INSERT INTO coupons (code, description, formula) VALUES (?, ?, ?)
  `);
  insertCoupon.run('WELCOME10', '10% off your first order', 'total * 0.10');
  insertCoupon.run('FIVER', 'Flat 5 EUR off', '5');
  insertCoupon.run('BLACKFRIDAY', 'Seasonal deal', 'total * 0.30');
  // No teams are seeded: players create or log into their own team via the
  // team gate before entering the shop.
}

// Set up the game-operator layer: a random token secret (persisted so tokens
// survive restarts) and a default admin account. Runs on every boot but is
// idempotent.
function seedOps() {
  if (!getConfig('gameadmin_secret')) {
    setConfig('gameadmin_secret', crypto.randomBytes(32).toString('hex'));
  }
  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM game_admins').get().c;
  if (adminCount === 0) {
    const user = process.env.VV_GAMEADMIN_USER || 'gameadmin';
    const pass = process.env.VV_GAMEADMIN_PASSWORD || 'vinylvault-ops';
    db.prepare('INSERT INTO game_admins (username, pass_hash) VALUES (?, ?)').run(user, strongHash(pass));
  }
}

initSchema();
seed();
seedOps();

module.exports = {
  db,
  weakHash,
  strongHash,
  strongVerify,
  getConfig,
  setConfig,
  DB_PATH,
  DATA_DIR,
};
