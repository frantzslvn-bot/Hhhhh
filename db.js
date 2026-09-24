const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'covers'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'videos'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'otaku.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  banned INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);
CREATE TABLE IF NOT EXISTS animes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  synopsis TEXT,
  genres TEXT DEFAULT '',
  year INTEGER,
  status TEXT DEFAULT 'En cours',
  cover TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anime_id INTEGER NOT NULL REFERENCES animes(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT,
  video TEXT NOT NULL,
  download_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anime_id INTEGER NOT NULL REFERENCES animes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ratings (
  anime_id INTEGER NOT NULL REFERENCES animes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  PRIMARY KEY (anime_id, user_id)
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  UNIQUE (visitor_id, day)
);
CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
`);

// Migrations : met à jour une ancienne base sans rien perdre
const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!cols.includes('email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT");
if (!cols.includes('banned')) db.exec("ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0");
if (!cols.includes('last_login')) db.exec("ALTER TABLE users ADD COLUMN last_login DATETIME");
const epCols = db.prepare("PRAGMA table_info(episodes)").all().map(c => c.name);
if (!epCols.includes('download_url')) db.exec("ALTER TABLE episodes ADD COLUMN download_url TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL");

module.exports = { db, DATA_DIR };
