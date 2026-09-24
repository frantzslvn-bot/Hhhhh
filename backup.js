// Sauvegarde sur GitHub (dépôt privé) : membres, animes, épisodes (liens), commentaires, notes.
// Restauration automatique au démarrage si la base est vide (plan gratuit Render).
const { db } = require('./db');

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_BACKUP_REPO;
const API = 'https://api.github.com';
const FILE = 'data.json';

const enabled = () => Boolean(TOKEN && REPO);

const gh = async (method, url, body) => {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'otaku-family-backup',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

const readRepoFile = async (name) => {
  const file = await gh('GET', `/repos/${REPO}/contents/${name}`);
  if (!file) return null;
  let b64 = file.content;
  if (!b64 || file.encoding === 'none') {
    const blob = await gh('GET', `/repos/${REPO}/git/blobs/${file.sha}`);
    b64 = blob.content;
  }
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
};

// Toutes les tables, avec leurs ids : les liens entre tables restent intacts.
const exportAll = () => ({
  users: db.prepare('SELECT id, username, email, password, role, banned, created_at, last_login FROM users').all(),
  animes: db.prepare('SELECT id, title, synopsis, genres, year, status, cover, created_at FROM animes').all(),
  episodes: db.prepare('SELECT id, anime_id, number, title, video, download_url, created_at FROM episodes').all(),
  comments: db.prepare('SELECT id, anime_id, user_id, content, created_at FROM comments').all(),
  ratings: db.prepare('SELECT anime_id, user_id, score FROM ratings').all()
});

const counts = (d) => ({
  users: d.users.length, animes: d.animes.length, episodes: d.episodes.length,
  comments: d.comments.length, ratings: d.ratings.length
});

const backup = async () => {
  if (!enabled()) throw new Error('Sauvegarde non configurée (GITHUB_TOKEN / GITHUB_BACKUP_REPO)');
  const data = exportAll();
  const date = new Date().toISOString();
  const c = counts(data);
  const content = Buffer.from(JSON.stringify({ date, version: 3, ...data }, null, 2));
  if (content.length > 90 * 1024 * 1024) throw new Error('La sauvegarde dépasse 90 Mo');

  const url = `/repos/${REPO}/contents/${FILE}`;
  const existing = await gh('GET', url);
  await gh('PUT', url, {
    message: `Sauvegarde : ${c.users} membres, ${c.animes} animes, ${c.episodes} épisodes, ${c.comments} commentaires`,
    content: content.toString('base64'),
    sha: existing ? existing.sha : undefined
  });
  return { date, ...c };
};

// Restaure sans jamais dupliquer ni écraser l'existant (ids conservés)
const restore = async () => {
  if (!enabled()) throw new Error('Sauvegarde non configurée');
  const data = await readRepoFile(FILE);
  if (!data) throw new Error('Aucune sauvegarde trouvée sur GitHub');

  const res = { users: 0, animes: 0, episodes: 0, comments: 0, ratings: 0 };
  db.transaction(() => {
    const insUser = db.prepare(`INSERT OR IGNORE INTO users (id, username, email, password, role, banned, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const u of data.users || [])
      res.users += insUser.run(u.id, u.username, u.email, u.password, u.role || 'user', u.banned ? 1 : 0, u.created_at, u.last_login).changes;

    const insAnime = db.prepare(`INSERT OR IGNORE INTO animes (id, title, synopsis, genres, year, status, cover, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const a of data.animes || [])
      res.animes += insAnime.run(a.id, a.title, a.synopsis, a.genres || '', a.year, a.status || 'En cours', a.cover, a.created_at).changes;

    const insEp = db.prepare(`INSERT OR IGNORE INTO episodes (id, anime_id, number, title, video, download_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const e of data.episodes || [])
      res.episodes += insEp.run(e.id, e.anime_id, e.number, e.title, e.video, e.download_url || null, e.created_at).changes;

    const insCom = db.prepare(`INSERT OR IGNORE INTO comments (id, anime_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const c of data.comments || [])
      res.comments += insCom.run(c.id, c.anime_id, c.user_id, c.content, c.created_at).changes;

    const insRat = db.prepare(`INSERT OR IGNORE INTO ratings (anime_id, user_id, score) VALUES (?, ?, ?)`);
    for (const r of data.ratings || [])
      res.ratings += insRat.run(r.anime_id, r.user_id, r.score).changes;
  })();
  return res;
};

let lastResult = null;
let timer = null;
let running = false;

const runBackup = async () => {
  if (running) return lastResult;
  running = true;
  try {
    lastResult = { ok: true, ...(await backup()) };
    console.log(`Sauvegarde OK : ${lastResult.users} membres, ${lastResult.animes} animes, ${lastResult.episodes} épisodes, ${lastResult.comments} commentaires, ${lastResult.ratings} notes`);
  } catch (e) {
    lastResult = { ok: false, error: e.message, date: new Date().toISOString() };
    console.error('Sauvegarde échouée :', e.message);
  }
  running = false;
  return lastResult;
};

// À chaque changement : regroupe les envois sur 10 secondes
const scheduleBackup = () => {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(runBackup, 10 * 1000);
};

const start = async () => {
  if (!enabled()) return console.log('Sauvegarde GitHub désactivée (variables manquantes)');

  const empty = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0 &&
                db.prepare('SELECT COUNT(*) c FROM animes').get().c === 0;
  if (empty) {
    try {
      const r = await restore();
      console.log(`Restauré depuis GitHub : ${r.users} membres, ${r.animes} animes, ${r.episodes} épisodes, ${r.comments} commentaires, ${r.ratings} notes`);
    } catch (e) {
      console.log('Pas de restauration :', e.message);
    }
  }

  const hours = parseFloat(process.env.BACKUP_INTERVAL_HOURS || '6');
  setTimeout(runBackup, 60 * 1000);
  setInterval(runBackup, hours * 60 * 60 * 1000);
  console.log(`Sauvegarde GitHub activée (à chaque changement + toutes les ${hours} h)`);
};

module.exports = { enabled, runBackup, restore, scheduleBackup, start, getLast: () => lastResult };
