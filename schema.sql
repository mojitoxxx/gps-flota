CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL, creado TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS camiones (
  id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  matricula TEXT NOT NULL, descripcion TEXT DEFAULT '',
  conductor_id INTEGER REFERENCES conductores(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS conductores (
  id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL, codigo TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL, aviso_aceptado TEXT);
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

-- Conductor asignado a cada camión (un conductor solo puede tener un camión)
-- En una base de datos ya creada: ALTER TABLE camiones ADD COLUMN conductor_id INTEGER REFERENCES conductores(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_camion_conductor ON camiones(conductor_id) WHERE conductor_id IS NOT NULL;
