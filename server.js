const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('./db');
const backup = require('./backup');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-moi-en-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// Comptage des visiteurs + vérification des bannis
const COOKIE_MAX = 60 * 60 * 24 * 365;
const getCookie = (req, name) => {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
};

app.use((req, res, next) => {
  if (req.session.user) {
    const fresh = db.prepare('SELECT id, role, banned FROM users WHERE id = ?').get(req.session.user.id);
    if (!fresh || fresh.banned) {
      return req.session.destroy(() => res.status(403).send('Ton compte a été banni.'));
    }
    req.session.user.role = fresh.role;
  }
  res.locals.user = req.session.user || null;

  // Compter chaque visiteur une fois par jour (pages uniquement, pas les fichiers)
  const isPage = req.method === 'GET' && !/\.\w+$/.test(req.path);
  if (isPage) {
    let vid = getCookie(req, 'vid');
    if (!vid) {
      vid = crypto.randomBytes(12).toString('hex');
      res.setHeader('Set-Cookie', `vid=${vid}; Max-Age=${COOKIE_MAX}; Path=/; HttpOnly; SameSite=Lax`);
    }
    const day = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO visits (visitor_id, day) VALUES (?, ?)
                ON CONFLICT(visitor_id, day) DO UPDATE SET hits = hits + 1`).run(vid, day);
  }
  next();
});

// ---------- Liens vidéo / image ----------
const isUrl = (v) => /^https?:\/\/[^\s]+$/i.test((v || '').trim());
const clean = (v) => (v || '').trim();

// Détecte la source d'un lien vidéo et prépare le lecteur + le lien de téléchargement.
// Si un lien de téléchargement dédié est donné, il est utilisé à la place de celui déduit de la vidéo.
const videoInfo = (url, dlOverride) => {
  const u = clean(url);
  const custom = isUrl(dlOverride) ? clean(dlOverride) : null;
  let m, info;
  if ((m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/)) || (m = u.match(/drive\.google\.com\/open\?id=([\w-]+)/)))
    info = { type: 'iframe', src: `https://drive.google.com/file/d/${m[1]}/preview`, download: `https://drive.google.com/uc?export=download&id=${m[1]}`, source: 'Google Drive' };
  else if ((m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/)))
    info = { type: 'iframe', src: `https://www.youtube.com/embed/${m[1]}`, download: null, source: 'YouTube' };
  else if ((m = u.match(/streamable\.com\/(?:e\/)?(\w+)/)))
    info = { type: 'iframe', src: `https://streamable.com/e/${m[1]}`, download: null, source: 'Streamable' };
  else if ((m = u.match(/dailymotion\.com\/video\/(\w+)/)))
    info = { type: 'iframe', src: `https://www.dailymotion.com/embed/video/${m[1]}`, download: null, source: 'Dailymotion' };
  else
    info = { type: 'video', src: u, download: u, source: /catbox\.moe/i.test(u) ? 'Catbox' : 'Lien direct' };
  if (custom) info.download = custom;
  info.hasCustomDownload = Boolean(custom);
  return info;
};
app.use((req, res, next) => { res.locals.videoInfo = videoInfo; next(); });

// ---------- Middlewares ----------
const requireLogin = (req, res, next) =>
  req.session.user ? next() : res.redirect('/login');
const requireAdmin = (req, res, next) =>
  req.session.user && ['admin', 'owner'].includes(req.session.user.role)
    ? next() : res.status(403).send('Accès refusé');

// ---------- Création du premier admin (appelée au démarrage, après restauration) ----------
const ensureOwner = () => {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) return;
  const existing = db.prepare('SELECT id, role FROM users WHERE username = ?').get(process.env.ADMIN_USER);
  if (!existing) {
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
      .run(process.env.ADMIN_USER, bcrypt.hashSync(process.env.ADMIN_PASS, 10), 'owner');
    console.log('Compte propriétaire créé :', process.env.ADMIN_USER);
    backup.scheduleBackup();
  } else if (existing.role !== 'owner') {
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(existing.id);
  }
};

// ---------- Pages publiques ----------
app.get('/', (req, res) => {
  const { q = '', genre = '' } = req.query;
  let sql = `SELECT a.*, ROUND(AVG(r.score),1) AS avg_score, COUNT(r.user_id) AS votes
             FROM animes a LEFT JOIN ratings r ON r.anime_id = a.id WHERE 1=1`;
  const params = [];
  if (q) { sql += ' AND a.title LIKE ?'; params.push(`%${q}%`); }
  if (genre) { sql += " AND (',' || REPLACE(a.genres, ', ', ',') || ',') LIKE ?"; params.push(`%,${genre},%`); }
  sql += ' GROUP BY a.id ORDER BY a.created_at DESC';
  const animes = db.prepare(sql).all(...params);

  const genres = [...new Set(
    db.prepare('SELECT genres FROM animes').all()
      .flatMap(r => r.genres.split(',').map(g => g.trim()).filter(Boolean))
  )].sort();

  res.render('index', { animes, genres, q, genre });
});

app.get('/anime/:id', (req, res) => {
  const anime = db.prepare(`
    SELECT a.*, ROUND(AVG(r.score),1) AS avg_score, COUNT(r.user_id) AS votes
    FROM animes a LEFT JOIN ratings r ON r.anime_id = a.id
    WHERE a.id = ? GROUP BY a.id`).get(req.params.id);
  if (!anime) return res.status(404).send('Anime introuvable');

  const episodes = db.prepare('SELECT * FROM episodes WHERE anime_id = ? ORDER BY number').all(anime.id);
  const comments = db.prepare(`
    SELECT c.*, u.username FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.anime_id = ? ORDER BY c.created_at DESC`).all(anime.id);
  const myRating = req.session.user
    ? (db.prepare('SELECT score FROM ratings WHERE anime_id = ? AND user_id = ?')
        .get(anime.id, req.session.user.id) || {}).score
    : null;

  res.render('anime', { anime, episodes, comments, myRating });
});

app.get('/watch/:id', (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).send('Épisode introuvable');
  const anime = db.prepare('SELECT * FROM animes WHERE id = ?').get(episode.anime_id);
  const episodes = db.prepare('SELECT * FROM episodes WHERE anime_id = ? ORDER BY number').all(anime.id);
  res.render('watch', { episode, anime, episodes });
});

// ---------- Auth ----------
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .get(username, (username || '').toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password))
    return res.render('login', { error: 'Identifiants incorrects' });
  if (u.banned) return res.render('login', { error: 'Ce compte a été banni.' });
  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(u.id);
  req.session.user = { id: u.id, username: u.username, role: u.role };
  res.redirect('/');
});

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', (req, res) => {
  const username = (req.body.username || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (username.length < 3 || password.length < 6)
    return res.render('register', { error: 'Pseudo (3+) et mot de passe (6+ caractères) requis' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.render('register', { error: 'Adresse email invalide' });
  try {
    const info = db.prepare('INSERT INTO users (username, email, password, last_login) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
      .run(username, email, bcrypt.hashSync(password, 10));
    backup.scheduleBackup();
    req.session.user = { id: info.lastInsertRowid, username, role: 'user' };
    res.redirect('/');
  } catch {
    res.render('register', { error: 'Ce pseudo ou cet email est déjà utilisé' });
  }
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ---------- Commentaires & notes ----------
app.post('/anime/:id/comment', requireLogin, (req, res) => {
  const content = (req.body.content || '').trim().slice(0, 1000);
  if (content)
    db.prepare('INSERT INTO comments (anime_id, user_id, content) VALUES (?, ?, ?)')
      .run(req.params.id, req.session.user.id, content);
  backup.scheduleBackup();
  res.redirect('/anime/' + req.params.id);
});

app.post('/anime/:id/rate', requireLogin, (req, res) => {
  const score = parseInt(req.body.score, 10);
  if (score >= 1 && score <= 5)
    db.prepare(`INSERT INTO ratings (anime_id, user_id, score) VALUES (?, ?, ?)
                ON CONFLICT(anime_id, user_id) DO UPDATE SET score = excluded.score`)
      .run(req.params.id, req.session.user.id, score);
  backup.scheduleBackup();
  res.redirect('/anime/' + req.params.id);
});

app.post('/comment/:id/delete', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT anime_id FROM comments WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  backup.scheduleBackup();
  res.redirect(c ? '/anime/' + c.anime_id : '/');
});

// ---------- Admin ----------
app.get('/admin', requireAdmin, (req, res) => {
  const animes = db.prepare('SELECT * FROM animes ORDER BY created_at DESC').all();
  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    today: db.prepare('SELECT COUNT(*) c FROM visits WHERE day = ?').get(today).c,
    total: db.prepare('SELECT COUNT(DISTINCT visitor_id) c FROM visits').get().c,
    week: db.prepare("SELECT COUNT(DISTINCT visitor_id) c FROM visits WHERE day >= date('now','-6 days')").get().c,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    banned: db.prepare('SELECT COUNT(*) c FROM users WHERE banned = 1').get().c
  };
  res.render('admin', { animes, stats });
});

// Espace membres : liste, recherche, promotion, bannissement
app.get('/admin/users', requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim();
  let sql = 'SELECT id, username, email, role, banned, created_at, last_login FROM users';
  const params = [];
  if (q) { sql += ' WHERE username LIKE ? OR email LIKE ?'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  res.render('admin-users', { users: db.prepare(sql).all(...params), q, msg: req.query.msg || null });
});

app.post('/admin/users/:id/role', requireAdmin, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).send('Réservé au propriétaire');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  db.prepare("UPDATE users SET role = ? WHERE id = ? AND role != 'owner'").run(role, req.params.id);
  backup.scheduleBackup();
  res.redirect('/admin/users?msg=' + encodeURIComponent('Rôle mis à jour'));
});

app.post('/admin/users/:id/ban', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.role === 'owner' || target.id === req.session.user.id)
    return res.redirect('/admin/users?msg=' + encodeURIComponent('Action impossible'));
  if (target.role === 'admin' && req.session.user.role !== 'owner')
    return res.redirect('/admin/users?msg=' + encodeURIComponent('Seul le propriétaire peut bannir un admin'));
  const banned = req.body.banned === '1' ? 1 : 0;
  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned, target.id);
  backup.scheduleBackup();
  res.redirect('/admin/users?msg=' + encodeURIComponent(banned ? 'Utilisateur banni' : 'Utilisateur débanni'));
});

// Sauvegarde GitHub (propriétaire uniquement)
app.get('/admin/backup', requireAdmin, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).send('Réservé au propriétaire');
  res.render('admin-backup', { enabled: backup.enabled(), last: backup.getLast(), msg: req.query.msg || null });
});

app.post('/admin/backup/run', requireAdmin, async (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).send('Réservé au propriétaire');
  const r = await backup.runBackup();
  res.redirect('/admin/backup?msg=' + encodeURIComponent(
    r.ok ? `Sauvegarde réussie : ${r.users} membres, ${r.animes} animes, ${r.episodes} épisodes, ${r.comments} commentaires, ${r.ratings} notes` : 'Échec : ' + r.error));
});

app.post('/admin/backup/restore', requireAdmin, async (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).send('Réservé au propriétaire');
  try {
    const r = await backup.restore();
    res.redirect('/admin/backup?msg=' + encodeURIComponent(
      `Restauré : ${r.users} membres, ${r.animes} animes, ${r.episodes} épisodes, ${r.comments} commentaires, ${r.ratings} notes`));
  } catch (e) {
    res.redirect('/admin/backup?msg=' + encodeURIComponent('Échec : ' + e.message));
  }
});

app.get('/admin/anime/new', requireAdmin, (req, res) =>
  res.render('admin-anime-form', { anime: null, error: null }));

// Création : la couverture est un lien d'image (Catbox...)
app.post('/admin/anime', requireAdmin, (req, res) => {
  const { title, synopsis, genres, year, status } = req.body;
  const cover = clean(req.body.cover);
  if (cover && !isUrl(cover))
    return res.render('admin-anime-form', { anime: { ...req.body, id: null }, error: 'Le lien de la couverture doit commencer par http:// ou https://' });
  db.prepare(`INSERT INTO animes (title, synopsis, genres, year, status, cover)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(clean(title), synopsis, genres, year || null, status, cover || null);
  backup.scheduleBackup();
  res.redirect('/admin');
});

app.get('/admin/anime/:id/edit', requireAdmin, (req, res) => {
  const anime = db.prepare('SELECT * FROM animes WHERE id = ?').get(req.params.id);
  if (!anime) return res.status(404).send('Introuvable');
  res.render('admin-anime-form', { anime, error: null });
});

app.post('/admin/anime/:id', requireAdmin, (req, res) => {
  const { title, synopsis, genres, year, status } = req.body;
  const cover = clean(req.body.cover);
  if (cover && !isUrl(cover))
    return res.render('admin-anime-form', { anime: { ...req.body, id: req.params.id }, error: 'Le lien de la couverture doit commencer par http:// ou https://' });
  db.prepare(`UPDATE animes SET title=?, synopsis=?, genres=?, year=?, status=?, cover=? WHERE id=?`)
    .run(clean(title), synopsis, genres, year || null, status, cover || null, req.params.id);
  backup.scheduleBackup();
  res.redirect('/admin');
});

app.post('/admin/anime/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM animes WHERE id = ?').run(req.params.id);
  backup.scheduleBackup();
  res.redirect('/admin');
});

app.get('/admin/anime/:id/episodes', requireAdmin, (req, res) => {
  const anime = db.prepare('SELECT * FROM animes WHERE id = ?').get(req.params.id);
  if (!anime) return res.status(404).send('Introuvable');
  const episodes = db.prepare('SELECT * FROM episodes WHERE anime_id = ? ORDER BY number').all(anime.id);
  res.render('admin-episodes', { anime, episodes, error: req.query.error || null });
});

// Ajout d'un épisode : on colle le lien de la vidéo (Catbox, Drive, YouTube...)
app.post('/admin/anime/:id/episodes', requireAdmin, (req, res) => {
  const back = '/admin/anime/' + req.params.id + '/episodes';
  const video = clean(req.body.video);
  const number = parseInt(req.body.number, 10);
  if (!isUrl(video))
    return res.redirect(back + '?error=' + encodeURIComponent('Le lien de la vidéo doit commencer par http:// ou https://'));
  if (!number || number < 1)
    return res.redirect(back + '?error=' + encodeURIComponent('Numéro d\'épisode invalide'));
  const dl = clean(req.body.download_url);
  if (dl && !isUrl(dl))
    return res.redirect(back + '?error=' + encodeURIComponent('Le lien de téléchargement doit commencer par http:// ou https://'));
  db.prepare('INSERT INTO episodes (anime_id, number, title, video, download_url) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.id, number, clean(req.body.title), video, dl || null);
  backup.scheduleBackup();
  res.redirect(back);
});

app.post('/admin/episode/:id/download', requireAdmin, (req, res) => {
  const ep = db.prepare('SELECT id, anime_id FROM episodes WHERE id = ?').get(req.params.id);
  if (!ep) return res.redirect('/admin');
  const back = '/admin/anime/' + ep.anime_id + '/episodes';
  const dl = clean(req.body.download_url);
  if (dl && !isUrl(dl))
    return res.redirect(back + '?error=' + encodeURIComponent('Le lien de téléchargement doit commencer par http:// ou https://'));
  db.prepare('UPDATE episodes SET download_url = ? WHERE id = ?').run(dl || null, ep.id);
  backup.scheduleBackup();
  res.redirect(back);
});

app.post('/admin/episode/:id/delete', requireAdmin, (req, res) => {
  const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (ep) {
    db.prepare('DELETE FROM episodes WHERE id = ?').run(ep.id);
    backup.scheduleBackup();
    return res.redirect('/admin/anime/' + ep.anime_id + '/episodes');
  }
  res.redirect('/admin');
});

(async () => {
  await backup.start();   // restaure les données depuis GitHub si la base est vide
  ensureOwner();          // crée le propriétaire seulement s'il n'existe pas après restauration
  app.listen(PORT, () => console.log('Otaku FAMILY lancé sur le port ' + PORT));
})();
