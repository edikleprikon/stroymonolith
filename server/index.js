import express from 'express';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!JWT_SECRET || !ADMIN_LOGIN || !ADMIN_PASSWORD_HASH) {
  console.error('❌ Заполните .env: JWT_SECRET, ADMIN_LOGIN, ADMIN_PASSWORD_HASH');
  process.exit(1);
}

// ====== БАЗА ДАННЫХ ======
const db = new Database('./leads.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    type TEXT,
    comment TEXT,
    page TEXT,
    ip TEXT,
    user_agent TEXT,
    status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ====== НАСТРОЙКИ ПО УМОЛЧАНИЮ ======
const DEFAULT_SETTINGS = {
  // Основное
  site_title: 'СтройМонолит',
  site_tagline: 'Строительная компания полного цикла',
  hero_title: 'Строим надёжно. От фундамента до крыши.',
  hero_subtitle: 'Полный цикл строительных работ: монолитные конструкции, фундаменты, кровля. Качество, проверенное десятилетиями.',

  // Статистика
  stat_years: '15+',
  stat_years_label: 'лет на рынке',
  stat_objects: '320+',
  stat_objects_label: 'объектов сдано',
  stat_workers: '48',
  stat_workers_label: 'специалистов',
  stat_warranty: '100%',
  stat_warranty_label: 'гарантия',

  // Контакты
  contact_phone: '+7 (4722) 40-00-00',
  contact_phone_link: '+74722400000',
  contact_phone_hours: 'Звоните с 8:00 до 20:00',
  contact_email: 'info@stroymonolith31.ru',
  contact_email_note: 'Email для заявок',
  contact_address: 'г. Белгород, ул. Строителей, д. 15',
  contact_address_hours: 'Офис: пн–сб 9:00–19:00',
  contact_vk: 'https://vk.com/stroymonolith31',
  contact_max: 'https://max.ru/u/YOUR_ADMIN_CONTACT_LINK',

  // О компании
  about_title: 'О компании «СтройМонолит»',
  about_text_1: 'Мы — строительная компания с 15-летним опытом работы в Белгороде и области. Специализируемся на монолитном строительстве: от фундаментов до кровли.',
  about_text_2: 'Наша команда — это инженеры, проектировщики и строители, которые знают своё дело. Мы работаем по ГОСТ и СНиП, используем сертифицированные материалы и даём гарантию на все виды работ.',
  about_years_big: '15',
  about_years_desc: 'лет безупречной работы',

  // Футер
  footer_brand: 'СтройМонолит',
  footer_text: 'Строительная компания полного цикла. Фундаменты, монолит, кровля. Работаем в Белгороде и области с 2010 года.',
  footer_copyright: '© 2010–2026 СтройМонолит. Все права защищены.'
};

// Заполняем настройки по умолчанию, если их нет
const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const initSettings = db.transaction(() => {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertDefault.run(key, value);
  }
});
initSettings();

// ====== MIDDLEWARE ======
app.use(express.json({ limit: '500kb' }));
app.use(cookieParser());
app.use(cors({
  origin: process.env.SITE_URL || true,
  credentials: true
}));

function authRequired(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Сессия истекла' });
  }
}

// ====== API: НАСТРОЙКИ ======
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  res.json(settings);
});

app.post('/api/settings', authRequired, (req, res) => {
  const updates = req.body || {};
  if (typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Ожидается объект с настройками' });
  }

  const allowedKeys = Object.keys(DEFAULT_SETTINGS);
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `);

  const updateMany = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (!allowedKeys.includes(key)) continue;
      if (typeof value !== 'string') continue;
      stmt.run(key, value.slice(0, 5000));
    }
  });

  try {
    updateMany(Object.entries(updates));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

app.post('/api/settings/reset', authRequired, (req, res) => {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `);
  const resetAll = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      stmt.run(key, value);
    }
  });
  resetAll();
  res.json({ ok: true });
});

// ====== API: ЗАЯВКИ ======
app.post('/api/lead', (req, res) => {
  const { name, phone, type, comment, page } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'Укажите имя' });
  }
  if (!phone || String(phone).replace(/\D/g, '').length < 10) {
    return res.status(400).json({ error: 'Укажите телефон' });
  }

  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';

  const recentCount = db.prepare(`
    SELECT COUNT(*) as c FROM leads
    WHERE ip = ? AND created_at > datetime('now', '-1 hour')
  `).get(ip).c;

  if (recentCount >= 5) {
    return res.status(429).json({ error: 'Слишком много заявок. Попробуйте позже.' });
  }

  const stmt = db.prepare(`
    INSERT INTO leads (name, phone, type, comment, page, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    String(name).trim().slice(0, 100),
    String(phone).trim().slice(0, 30),
    String(type || '').slice(0, 100),
    String(comment || '').slice(0, 2000),
    String(page || '').slice(0, 500),
    String(ip).slice(0, 50),
    String(req.headers['user-agent'] || '').slice(0, 300)
  );

  res.json({ ok: true, id: info.lastInsertRowid });
});

// ====== API: АВТОРИЗАЦИЯ ======
app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {};

  if (!login || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }

  const loginOk = login === ADMIN_LOGIN;
  const passwordOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (!loginOk || !passwordOk) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  const token = jwt.sign({ login }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ login: req.admin.login });
});

// ====== API: СПИСОК ЗАЯВОК ======
app.get('/api/leads', authRequired, (req, res) => {
  const { status, search, limit = 100, offset = 0 } = req.query;

  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }

  if (search) {
    query += ' AND (name LIKE ? OR phone LIKE ? OR comment LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const leads = db.prepare(query).all(...params);

  const total = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const unread = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE status = 'new'`).get().c;

  res.json({ leads, total, unread });
});

app.patch('/api/leads/:id', authRequired, (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  const allowed = ['new', 'in_progress', 'done', 'spam'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Недопустимый статус' });
  }

  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
  res.json({ ok: true });
});

app.delete('/api/leads/:id', authRequired, (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ====== ЭКСПОРТ CSV ======
app.get('/api/leads.csv', authRequired, (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();

  const header = 'ID;Дата;Имя;Телефон;Тип;Комментарий;Статус;Страница\n';
  const rows = leads.map(l =>
    [l.id, l.created_at, l.name, l.phone, l.type, l.comment, l.status, l.page]
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(';')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send('\uFEFF' + header + rows);
});

// ====== СТАТИКА ======
app.use(express.static('../'));

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
  console.log(`   Сайт:    http://localhost:${PORT}/index.html`);
  console.log(`   Админка: http://localhost:${PORT}/admin.html`);
  console.log(`   API:     http://localhost:${PORT}/api/settings`);
});