const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, DATA_DIR } = require('./db');
const backup = require('./backup');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));
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
  const isPage = req.method === 'GET' && !req.path.startsWith('/uploads') &&
    !req.path.startsWith('/download') && !/\.\w+$/.test(req.path);
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

// ---------- Upload ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sub = file.fieldname === 'video' ? 'videos' : 'covers';
    cb(null, path.join(DATA_DIR, 'uploads', sub));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 Go max
  fileFilter: (req, file, cb) => {
    const ok = file.fieldname === 'video'
      ? /\.mp4$/i.test(file.originalname)
      : /\.(jpe?g|png|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Format non autorisé (vidéo : MP4 / image : jpg, png, webp)'), ok);
  }
});

const removeFile = (sub, name) => {
  if (!name) return;
  fs.unlink(path.join(DATA_DIR, 'uploads', sub, name), () => {});
};

// ---------- Middlewares ----------
const requireLogin = (req, res, next) =>
  req.session.user ? next() : res.redirect('/login');
const requireAdmin = (req, res, next) =>
  req.session.user && ['admin', 'owner'].includes(req.session.user.role)
    ? next() : res.status(403).send('Accès refusé');

// ---------- Création du premier admin ----------
if (process.env.ADMIN_USER && process.env.ADMIN_PASS &&
    !db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.ADMIN_USER)) {
  db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
    .run(process.env.ADMIN_USER, bcrypt.hashSync(process.env.ADMIN_PASS, 10), 'owner');
  console.log('Compte propriétaire créé :', process.env.ADMIN_USER);
  backup.scheduleBackup();
}

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

// ---------- Téléchargement (Android + iOS) ----------
app.get('/download/:id', (req, res) => {
  const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!ep) return res.status(404).send('Épisode introuvable');
  const anime = db.prepare('SELECT title FROM animes WHERE id = ?').get(ep.anime_id);

  const filePath = path.join(DATA_DIR, 'uploads', 'videos', ep.video);
  if (!fs.existsSync(filePath)) return res.status(404).send('Fichier introuvable');

  const stat = fs.statSync(filePath);
  const safeTitle = anime.title.replace(/[^\w\s\-]/g, '').trim() || 'Anime';
  const fileName = `${safeTitle} - Episode ${ep.number}.mp4`;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  );

  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    if (isNaN(start) || start >= stat.size || end >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
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
    r.ok ? `Sauvegarde réussie : ${r.users} membres, ${r.comments} commentaires, ${r.ratings} notes` : 'Échec : ' + r.error));
});

app.post('/admin/backup/restore', requireAdmin, async (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).send('Réservé au propriétaire');
  try {
    const r = await backup.restore();
    res.redirect('/admin/backup?msg=' + encodeURIComponent(
      `Restauré : ${r.users} membres, ${r.animes} animes, ${r.comments} commentaires, ${r.ratings} notes`));
  } catch (e) {
    res.redirect('/admin/backup?msg=' + encodeURIComponent('Échec : ' + e.message));
  }
});

app.get('/admin/anime/new', requireAdmin, (req, res) =>
  res.render('admin-anime-form', { anime: null }));

app.post('/admin/anime', requireAdmin, upload.single('cover'), (req, res) => {
  const { title, synopsis, genres, year, status } = req.body;
  db.prepare(`INSERT INTO animes (title, synopsis, genres, year, status, cover)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(title, synopsis, genres, year || null, status, req.file ? req.file.filename : null);
  backup.scheduleBackup();
  res.redirect('/admin');
});

app.get('/admin/anime/:id/edit', requireAdmin, (req, res) => {
  const anime = db.prepare('SELECT * FROM animes WHERE id = ?').get(req.params.id);
  if (!anime) return res.status(404).send('Introuvable');
  res.render('admin-anime-form', { anime });
});

app.post('/admin/anime/:id', requireAdmin, upload.single('cover'), (req, res) => {
  const { title, synopsis, genres, year, status } = req.body;
  const old = db.prepare('SELECT cover FROM animes WHERE id = ?').get(req.params.id);
  let cover = old ? old.cover : null;
  if (req.file) { removeFile('covers', cover); cover = req.file.filename; }
  db.prepare(`UPDATE animes SET title=?, synopsis=?, genres=?, year=?, status=?, cover=? WHERE id=?`)
    .run(title, synopsis, genres, year || null, status, cover, req.params.id);
  backup.scheduleBackup();
  res.redirect('/admin');
});

app.post('/admin/anime/:id/delete', requireAdmin, (req, res) => {
  const anime = db.prepare('SELECT cover FROM animes WHERE id = ?').get(req.params.id);
  db.prepare('SELECT video FROM episodes WHERE anime_id = ?').all(req.params.id)
    .forEach(e => removeFile('videos', e.video));
  if (anime) removeFile('covers', anime.cover);
  db.prepare('DELETE FROM animes WHERE id = ?').run(req.params.id);
  backup.scheduleBackup();
  res.redirect('/admin');
});

app.get('/admin/anime/:id/episodes', requireAdmin, (req, res) => {
  const anime = db.prepare('SELECT * FROM animes WHERE id = ?').get(req.params.id);
  if (!anime) return res.status(404).send('Introuvable');
  const episodes = db.prepare('SELECT * FROM episodes WHERE anime_id = ? ORDER BY number').all(anime.id);
  res.render('admin-episodes', { anime, episodes, error: null });
});

app.post('/admin/anime/:id/episodes', requireAdmin, (req, res) => {
  upload.single('video')(req, res, err => {
    if (err || !req.file) {
      const message = err
        ? (err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop gros (2 Go maximum)' : err.message)
        : 'Vidéo requise';
      return res.status(400).json({ ok: false, error: message });
    }
    db.prepare('INSERT INTO episodes (anime_id, number, title, video) VALUES (?, ?, ?, ?)')
      .run(req.params.id, req.body.number, req.body.title, req.file.filename);
    res.json({ ok: true, redirect: '/admin/anime/' + req.params.id + '/episodes' });
  });
});

app.post('/admin/episode/:id/delete', requireAdmin, (req, res) => {
  const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (ep) {
    removeFile('videos', ep.video);
    db.prepare('DELETE FROM episodes WHERE id = ?').run(ep.id);
    return res.redirect('/admin/anime/' + ep.anime_id + '/episodes');
  }
  res.redirect('/admin');
});

app.listen(PORT, () => {
  console.log('Otaku FAMILY lancé sur le port ' + PORT);
  backup.start();
});
