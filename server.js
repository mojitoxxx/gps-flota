// GPS Flota - servidor (Node.js + Express + SQLite)
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Días que se guardan las posiciones. Ajustar con asesoría legal (principio de minimización, art. 5 RGPD).
const RETENCION_DIAS = Number(process.env.RETENCION_DIAS || 90);

const db = new Database(process.env.DB_FILE || path.join(__dirname, 'flota.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL, creado TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS camiones (
  id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  matricula TEXT NOT NULL, descripcion TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS conductores (
  id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL, codigo TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL,
  aviso_aceptado TEXT);
CREATE TABLE IF NOT EXISTS jornadas (
  id INTEGER PRIMARY KEY, conductor_id INTEGER NOT NULL REFERENCES conductores(id) ON DELETE CASCADE,
  camion_id INTEGER NOT NULL REFERENCES camiones(id) ON DELETE CASCADE,
  inicio TEXT NOT NULL, fin TEXT);
CREATE TABLE IF NOT EXISTS posiciones (
  id INTEGER PRIMARY KEY, jornada_id INTEGER NOT NULL REFERENCES jornadas(id) ON DELETE CASCADE,
  lat REAL NOT NULL, lng REAL NOT NULL, precision REAL, velocidad REAL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pos_jornada ON posiciones(jornada_id, ts);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY, tipo TEXT NOT NULL, ref_id INTEGER NOT NULL,
  creado TEXT DEFAULT (datetime('now')));
`);

// ---------- utilidades ----------
function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verificar(pw, guardado) {
  const [salt, h] = guardado.split(':');
  const calc = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
function nuevaSesion(tipo, id) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones (token, tipo, ref_id) VALUES (?,?,?)').run(token, tipo, id);
  return token;
}
function auth(tipo) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const s = db.prepare('SELECT * FROM sesiones WHERE token = ? AND tipo = ?').get(token, tipo);
    if (!s) return res.status(401).json({ error: 'Sesión no válida' });
    req.uid = s.ref_id;
    next();
  };
}
const ahora = () => new Date().toISOString();
const esNum = (v, min, max) => typeof v === 'number' && isFinite(v) && v >= min && v <= max;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- EMPRESA ----------
app.post('/api/empresa/registro', (req, res) => {
  const { nombre, email, password } = req.body || {};
  if (!nombre || !email || !password || password.length < 8)
    return res.status(400).json({ error: 'Faltan datos (contraseña mínimo 8 caracteres)' });
  try {
    const r = db.prepare('INSERT INTO empresas (nombre, email, pass_hash) VALUES (?,?,?)')
      .run(nombre.trim(), email.trim().toLowerCase(), hash(password));
    res.json({ token: nuevaSesion('empresa', r.lastInsertRowid), nombre });
  } catch { res.status(409).json({ error: 'Ese email ya está registrado' }); }
});

app.post('/api/empresa/login', (req, res) => {
  const { email, password } = req.body || {};
  const e = db.prepare('SELECT * FROM empresas WHERE email = ?').get((email || '').trim().toLowerCase());
  if (!e || !verificar(password || '', e.pass_hash)) return res.status(401).json({ error: 'Datos incorrectos' });
  res.json({ token: nuevaSesion('empresa', e.id), nombre: e.nombre });
});

const E = auth('empresa');

app.get('/api/empresa/camiones', E, (req, res) => {
  res.json(db.prepare('SELECT * FROM camiones WHERE empresa_id = ? ORDER BY matricula').all(req.uid));
});
app.post('/api/empresa/camiones', E, (req, res) => {
  const { matricula, descripcion } = req.body || {};
  if (!matricula) return res.status(400).json({ error: 'Falta la matrícula' });
  const r = db.prepare('INSERT INTO camiones (empresa_id, matricula, descripcion) VALUES (?,?,?)')
    .run(req.uid, matricula.trim().toUpperCase(), descripcion || '');
  res.json({ id: r.lastInsertRowid });
});

app.get('/api/empresa/conductores', E, (req, res) => {
  res.json(db.prepare('SELECT id, nombre, codigo, aviso_aceptado FROM conductores WHERE empresa_id = ? ORDER BY nombre').all(req.uid));
});
app.post('/api/empresa/conductores', E, (req, res) => {
  const { nombre } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });
  const codigo = 'C' + crypto.randomInt(100000, 999999);
  const pin = String(crypto.randomInt(100000, 999999));
  db.prepare('INSERT INTO conductores (empresa_id, nombre, codigo, pin_hash) VALUES (?,?,?,?)')
    .run(req.uid, nombre.trim(), codigo, hash(pin));
  // El PIN solo se muestra una vez: la empresa se lo entrega al conductor.
  res.json({ codigo, pin });
});

// Última posición de cada camión con jornada abierta
app.get('/api/empresa/en-directo', E, (req, res) => {
  res.json(db.prepare(`
    SELECT j.id AS jornada_id, c.matricula, co.nombre AS conductor, j.inicio,
           p.lat, p.lng, p.velocidad, p.ts
    FROM jornadas j
    JOIN camiones c ON c.id = j.camion_id
    JOIN conductores co ON co.id = j.conductor_id
    LEFT JOIN posiciones p ON p.id = (SELECT id FROM posiciones WHERE jornada_id = j.id ORDER BY ts DESC LIMIT 1)
    WHERE c.empresa_id = ? AND j.fin IS NULL`).all(req.uid));
});

// Jornadas de un día (fecha AAAA-MM-DD), opcionalmente de un camión
app.get('/api/empresa/historial', E, (req, res) => {
  const fecha = req.query.fecha || ahora().slice(0, 10);
  const params = [req.uid, fecha];
  let filtro = '';
  if (req.query.camion_id) { filtro = 'AND c.id = ?'; params.push(Number(req.query.camion_id)); }
  const jornadas = db.prepare(`
    SELECT j.id, j.inicio, j.fin, c.matricula, co.nombre AS conductor
    FROM jornadas j JOIN camiones c ON c.id = j.camion_id JOIN conductores co ON co.id = j.conductor_id
    WHERE c.empresa_id = ? AND substr(j.inicio,1,10) = ? ${filtro} ORDER BY j.inicio`).all(...params);
  const pos = db.prepare('SELECT lat, lng, velocidad, ts FROM posiciones WHERE jornada_id = ? ORDER BY ts');
  res.json(jornadas.map(j => ({ ...j, puntos: pos.all(j.id) })));
});

// ---------- CONDUCTOR ----------
app.post('/api/conductor/login', (req, res) => {
  const { codigo, pin } = req.body || {};
  const c = db.prepare(`SELECT co.*, e.nombre AS empresa FROM conductores co
    JOIN empresas e ON e.id = co.empresa_id WHERE codigo = ?`).get((codigo || '').trim().toUpperCase());
  if (!c || !verificar(pin || '', c.pin_hash)) return res.status(401).json({ error: 'Código o PIN incorrectos' });
  res.json({ token: nuevaSesion('conductor', c.id), nombre: c.nombre, empresa: c.empresa, aviso_aceptado: c.aviso_aceptado });
});

const C = auth('conductor');

app.post('/api/conductor/aceptar-aviso', C, (req, res) => {
  db.prepare('UPDATE conductores SET aviso_aceptado = ? WHERE id = ?').run(ahora(), req.uid);
  res.json({ ok: true });
});

app.get('/api/conductor/estado', C, (req, res) => {
  const yo = db.prepare('SELECT empresa_id, aviso_aceptado FROM conductores WHERE id = ?').get(req.uid);
  const camiones = db.prepare('SELECT id, matricula, descripcion FROM camiones WHERE empresa_id = ?').all(yo.empresa_id);
  const jornada = db.prepare(`SELECT j.id, j.inicio, c.matricula FROM jornadas j JOIN camiones c ON c.id = j.camion_id
    WHERE j.conductor_id = ? AND j.fin IS NULL`).get(req.uid);
  res.json({ aviso_aceptado: yo.aviso_aceptado, camiones, jornada: jornada || null });
});

app.post('/api/conductor/jornada/iniciar', C, (req, res) => {
  const yo = db.prepare('SELECT empresa_id, aviso_aceptado FROM conductores WHERE id = ?').get(req.uid);
  if (!yo.aviso_aceptado) return res.status(403).json({ error: 'Debes leer el aviso de geolocalización primero' });
  const cam = db.prepare('SELECT id FROM camiones WHERE id = ? AND empresa_id = ?').get(Number(req.body?.camion_id), yo.empresa_id);
  if (!cam) return res.status(400).json({ error: 'Camión no válido' });
  if (db.prepare('SELECT id FROM jornadas WHERE conductor_id = ? AND fin IS NULL').get(req.uid))
    return res.status(409).json({ error: 'Ya tienes una jornada abierta' });
  const r = db.prepare('INSERT INTO jornadas (conductor_id, camion_id, inicio) VALUES (?,?,?)').run(req.uid, cam.id, ahora());
  res.json({ id: r.lastInsertRowid });
});

app.post('/api/conductor/jornada/finalizar', C, (req, res) => {
  db.prepare('UPDATE jornadas SET fin = ? WHERE conductor_id = ? AND fin IS NULL').run(ahora(), req.uid);
  res.json({ ok: true });
});

// Recibe una lista de posiciones (permite enviar las guardadas sin cobertura)
app.post('/api/conductor/posiciones', C, (req, res) => {
  const j = db.prepare('SELECT id FROM jornadas WHERE conductor_id = ? AND fin IS NULL').get(req.uid);
  if (!j) return res.status(409).json({ error: 'No hay jornada abierta: no se registra ubicación' });
  const lista = Array.isArray(req.body) ? req.body.slice(0, 500) : [];
  const ins = db.prepare('INSERT INTO posiciones (jornada_id, lat, lng, precision, velocidad, ts) VALUES (?,?,?,?,?,?)');
  let n = 0;
  db.transaction(() => {
    for (const p of lista) {
      if (!esNum(p.lat, -90, 90) || !esNum(p.lng, -180, 180)) continue;
      ins.run(j.id, p.lat, p.lng, p.precision ?? null, p.velocidad ?? null,
        typeof p.ts === 'string' ? p.ts : ahora());
      n++;
    }
  })();
  res.json({ guardadas: n });
});

// Transparencia: el conductor puede ver sus propios datos (derecho de acceso, art. 15 RGPD)
app.get('/api/conductor/mis-jornadas', C, (req, res) => {
  res.json(db.prepare(`SELECT j.id, j.inicio, j.fin, c.matricula,
      (SELECT COUNT(*) FROM posiciones WHERE jornada_id = j.id) AS puntos
    FROM jornadas j JOIN camiones c ON c.id = j.camion_id
    WHERE j.conductor_id = ? ORDER BY j.inicio DESC LIMIT 50`).all(req.uid));
});

// ---------- Limpieza automática según el plazo de conservación ----------
function limpiar() {
  const r = db.prepare(`DELETE FROM jornadas WHERE fin IS NOT NULL AND julianday(fin) < julianday('now', ?)`)
    .run(`-${RETENCION_DIAS} days`);
  db.prepare(`DELETE FROM sesiones WHERE creado < datetime('now', '-30 days')`).run();
  if (r.changes) console.log(`Limpieza: ${r.changes} jornadas antiguas borradas`);
}
limpiar();
setInterval(limpiar, 6 * 60 * 60 * 1000);

if (require.main === module) {
  app.listen(PORT, () => console.log(`GPS Flota en http://localhost:${PORT}`));
}
module.exports = app;
