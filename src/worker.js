// GPS Flota - servidor para Cloudflare Workers + D1
// Las páginas de /public las sirve Cloudflare directamente; aquí solo llega /api/*.

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const deHex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));
const ahora = () => new Date().toISOString();
const esNum = (v, min, max) => typeof v === 'number' && isFinite(v) && v >= min && v <= max;
const aleatorio = (min, max) => min + (crypto.getRandomValues(new Uint32Array(1))[0] % (max - min));

// Contraseñas: PBKDF2-SHA256 con 100.000 iteraciones y sal aleatoria
async function derivar(pw, sal) {
  const clave = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: 100000 }, clave, 256);
}
async function hash(pw) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return hex(sal) + ':' + hex(await derivar(pw, sal));
}
async function verificar(pw, guardado) {
  const [sal, h] = guardado.split(':');
  const calc = hex(await derivar(pw, deHex(sal)));
  let dif = calc.length ^ h.length;
  for (let i = 0; i < calc.length; i++) dif |= calc.charCodeAt(i) ^ h.charCodeAt(i);
  return dif === 0;
}

const json = (datos, status = 200) => new Response(JSON.stringify(datos), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
const error = (msg, status) => json({ error: msg }, status);

async function nuevaSesion(db, tipo, id) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare('INSERT INTO sesiones (token, tipo, ref_id) VALUES (?,?,?)').bind(token, tipo, id).run();
  return token;
}
async function usuario(req, db, tipo) {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return null;
  const s = await db.prepare('SELECT ref_id FROM sesiones WHERE token = ? AND tipo = ?').bind(token, tipo).first();
  return s ? s.ref_id : null;
}

// ---------------- Rutas ----------------
const rutas = {
  // ---------- EMPRESA ----------
  'POST /api/empresa/registro': async ({ db, body }) => {
    const { nombre, email, password } = body;
    if (!nombre || !email || !password || password.length < 8)
      return error('Faltan datos (contraseña mínimo 8 caracteres)', 400);
    try {
      const r = await db.prepare('INSERT INTO empresas (nombre, email, pass_hash) VALUES (?,?,?)')
        .bind(nombre.trim(), email.trim().toLowerCase(), await hash(password)).run();
      return json({ token: await nuevaSesion(db, 'empresa', r.meta.last_row_id), nombre });
    } catch { return error('Ese email ya está registrado', 409); }
  },

  'POST /api/empresa/login': async ({ db, body }) => {
    const e = await db.prepare('SELECT * FROM empresas WHERE email = ?').bind((body.email || '').trim().toLowerCase()).first();
    if (!e || !(await verificar(body.password || '', e.pass_hash))) return error('Datos incorrectos', 401);
    return json({ token: await nuevaSesion(db, 'empresa', e.id), nombre: e.nombre });
  },

  'GET /api/empresa/camiones': async ({ db, uid }) =>
    json((await db.prepare(`SELECT c.*, co.nombre AS conductor FROM camiones c
      LEFT JOIN conductores co ON co.id = c.conductor_id
      WHERE c.empresa_id = ? ORDER BY c.matricula`).bind(uid).all()).results),

  // Quitar un camión (y su historial de rutas)
  'POST /api/empresa/camiones/quitar': async ({ db, uid, body }) => {
    const cam = await db.prepare('SELECT id FROM camiones WHERE id = ? AND empresa_id = ?').bind(Number(body.id), uid).first();
    if (!cam) return error('Camión no válido', 400);
    if (await db.prepare('SELECT id FROM jornadas WHERE camion_id = ? AND fin IS NULL').bind(cam.id).first())
      return error('Ese camión está en ruta. Espera a que el conductor finalice la jornada para quitarlo.', 409);
    await db.batch([
      db.prepare('DELETE FROM posiciones WHERE jornada_id IN (SELECT id FROM jornadas WHERE camion_id = ?)').bind(cam.id),
      db.prepare('DELETE FROM jornadas WHERE camion_id = ?').bind(cam.id),
      db.prepare('DELETE FROM camiones WHERE id = ?').bind(cam.id),
    ]);
    return json({ ok: true });
  },

  // Quitar un conductor (su acceso, sus jornadas y su asignación de camión)
  'POST /api/empresa/conductores/quitar': async ({ db, uid, body }) => {
    const co = await db.prepare('SELECT id FROM conductores WHERE id = ? AND empresa_id = ?').bind(Number(body.id), uid).first();
    if (!co) return error('Conductor no válido', 400);
    if (await db.prepare('SELECT id FROM jornadas WHERE conductor_id = ? AND fin IS NULL').bind(co.id).first())
      return error('Ese conductor está en ruta. Espera a que finalice la jornada para quitarlo.', 409);
    await db.batch([
      db.prepare('UPDATE camiones SET conductor_id = NULL WHERE conductor_id = ?').bind(co.id),
      db.prepare(`DELETE FROM sesiones WHERE tipo = 'conductor' AND ref_id = ?`).bind(co.id),
      db.prepare('DELETE FROM posiciones WHERE jornada_id IN (SELECT id FROM jornadas WHERE conductor_id = ?)').bind(co.id),
      db.prepare('DELETE FROM jornadas WHERE conductor_id = ?').bind(co.id),
      db.prepare('DELETE FROM conductores WHERE id = ?').bind(co.id),
    ]);
    return json({ ok: true });
  },

  // Asignar (o quitar, con conductor_id vacío) el conductor de un camión
  'POST /api/empresa/asignar': async ({ db, uid, body }) => {
    const cam = await db.prepare('SELECT id FROM camiones WHERE id = ? AND empresa_id = ?').bind(Number(body.camion_id), uid).first();
    if (!cam) return error('Camión no válido', 400);
    const conductorId = body.conductor_id ? Number(body.conductor_id) : null;
    if (conductorId) {
      const co = await db.prepare('SELECT id FROM conductores WHERE id = ? AND empresa_id = ?').bind(conductorId, uid).first();
      if (!co) return error('Conductor no válido', 400);
      if (await db.prepare('SELECT id FROM jornadas WHERE conductor_id = ? AND fin IS NULL').bind(conductorId).first())
        return error('Ese conductor está en ruta. Espera a que finalice la jornada para cambiarle el camión.', 409);
    }
    const ocupado = await db.prepare(`SELECT j.id FROM jornadas j WHERE j.camion_id = ? AND j.fin IS NULL`).bind(cam.id).first();
    if (ocupado) return error('Ese camión está en ruta. Espera a que finalice la jornada para cambiar el conductor.', 409);
    await db.batch([
      // un conductor solo puede llevar un camión: se le quita del anterior
      db.prepare('UPDATE camiones SET conductor_id = NULL WHERE conductor_id = ? AND empresa_id = ?').bind(conductorId, uid),
      db.prepare('UPDATE camiones SET conductor_id = ? WHERE id = ?').bind(conductorId, cam.id),
    ]);
    return json({ ok: true });
  },

  'POST /api/empresa/camiones': async ({ db, uid, body }) => {
    if (!body.matricula) return error('Falta la matrícula', 400);
    const r = await db.prepare('INSERT INTO camiones (empresa_id, matricula, descripcion) VALUES (?,?,?)')
      .bind(uid, body.matricula.trim().toUpperCase(), body.descripcion || '').run();
    return json({ id: r.meta.last_row_id });
  },

  'GET /api/empresa/conductores': async ({ db, uid }) =>
    json((await db.prepare('SELECT id, nombre, codigo, aviso_aceptado FROM conductores WHERE empresa_id = ? ORDER BY nombre').bind(uid).all()).results),

  'POST /api/empresa/conductores': async ({ db, uid, body }) => {
    if (!body.nombre) return error('Falta el nombre', 400);
    const pin = String(aleatorio(100000, 1000000));
    for (let intento = 0; intento < 5; intento++) {
      const codigo = 'C' + aleatorio(100000, 1000000);
      try {
        await db.prepare('INSERT INTO conductores (empresa_id, nombre, codigo, pin_hash) VALUES (?,?,?,?)')
          .bind(uid, body.nombre.trim(), codigo, await hash(pin)).run();
        return json({ codigo, pin }); // el PIN solo se muestra esta vez
      } catch { /* código repetido: probar otro */ }
    }
    return error('No se pudo crear el conductor, inténtalo de nuevo', 500);
  },

  'GET /api/empresa/en-directo': async ({ db, uid }) => json((await db.prepare(`
    SELECT j.id AS jornada_id, c.matricula, co.nombre AS conductor, j.inicio,
           p.lat, p.lng, p.velocidad, p.ts
    FROM jornadas j
    JOIN camiones c ON c.id = j.camion_id
    JOIN conductores co ON co.id = j.conductor_id
    LEFT JOIN posiciones p ON p.id = (SELECT id FROM posiciones WHERE jornada_id = j.id ORDER BY ts DESC LIMIT 1)
    WHERE c.empresa_id = ? AND j.fin IS NULL`).bind(uid).all()).results),

  'GET /api/empresa/historial': async ({ db, uid, url }) => {
    const fecha = url.searchParams.get('fecha') || ahora().slice(0, 10);
    const camion = url.searchParams.get('camion_id');
    const params = [uid, fecha];
    let filtro = '';
    if (camion) { filtro = 'AND c.id = ?'; params.push(Number(camion)); }
    const jornadas = (await db.prepare(`
      SELECT j.id, j.inicio, j.fin, c.matricula, co.nombre AS conductor
      FROM jornadas j JOIN camiones c ON c.id = j.camion_id JOIN conductores co ON co.id = j.conductor_id
      WHERE c.empresa_id = ? AND substr(j.inicio,1,10) = ? ${filtro} ORDER BY j.inicio`).bind(...params).all()).results;
    if (!jornadas.length) return json([]);
    const consulta = db.prepare('SELECT lat, lng, velocidad, ts FROM posiciones WHERE jornada_id = ? ORDER BY ts');
    const puntos = await db.batch(jornadas.map(j => consulta.bind(j.id)));
    return json(jornadas.map((j, i) => ({ ...j, puntos: puntos[i].results })));
  },

  // ---------- CONDUCTOR ----------
  'POST /api/conductor/login': async ({ db, body }) => {
    const c = await db.prepare(`SELECT co.*, e.nombre AS empresa FROM conductores co
      JOIN empresas e ON e.id = co.empresa_id WHERE codigo = ?`).bind((body.codigo || '').trim().toUpperCase()).first();
    if (!c || !(await verificar(body.pin || '', c.pin_hash))) return error('Código o PIN incorrectos', 401);
    return json({ token: await nuevaSesion(db, 'conductor', c.id), nombre: c.nombre, empresa: c.empresa, aviso_aceptado: c.aviso_aceptado });
  },

  'POST /api/conductor/aceptar-aviso': async ({ db, uid }) => {
    await db.prepare('UPDATE conductores SET aviso_aceptado = ? WHERE id = ?').bind(ahora(), uid).run();
    return json({ ok: true });
  },

  'GET /api/conductor/estado': async ({ db, uid }) => {
    const yo = await db.prepare('SELECT empresa_id, aviso_aceptado FROM conductores WHERE id = ?').bind(uid).first();
    const [camion, jornada] = await db.batch([
      db.prepare('SELECT id, matricula, descripcion FROM camiones WHERE conductor_id = ?').bind(uid),
      db.prepare(`SELECT j.id, j.inicio, c.matricula FROM jornadas j JOIN camiones c ON c.id = j.camion_id
        WHERE j.conductor_id = ? AND j.fin IS NULL`).bind(uid),
    ]);
    return json({ aviso_aceptado: yo.aviso_aceptado, camion: camion.results[0] || null, jornada: jornada.results[0] || null });
  },

  'POST /api/conductor/jornada/iniciar': async ({ db, uid }) => {
    const yo = await db.prepare('SELECT aviso_aceptado FROM conductores WHERE id = ?').bind(uid).first();
    if (!yo.aviso_aceptado) return error('Debes leer el aviso de geolocalización primero', 403);
    // El camión es el que la empresa ha asignado al conductor
    const cam = await db.prepare('SELECT id FROM camiones WHERE conductor_id = ?').bind(uid).first();
    if (!cam) return error('Tu empresa todavía no te ha asignado un camión.', 409);
    if (await db.prepare('SELECT id FROM jornadas WHERE conductor_id = ? AND fin IS NULL').bind(uid).first())
      return error('Ya tienes una jornada abierta', 409);
    const r = await db.prepare('INSERT INTO jornadas (conductor_id, camion_id, inicio) VALUES (?,?,?)').bind(uid, cam.id, ahora()).run();
    return json({ id: r.meta.last_row_id });
  },

  'POST /api/conductor/jornada/finalizar': async ({ db, uid }) => {
    await db.prepare('UPDATE jornadas SET fin = ? WHERE conductor_id = ? AND fin IS NULL').bind(ahora(), uid).run();
    return json({ ok: true });
  },

  'POST /api/conductor/posiciones': async ({ db, uid, body }) => {
    const j = await db.prepare('SELECT id FROM jornadas WHERE conductor_id = ? AND fin IS NULL').bind(uid).first();
    if (!j) return error('No hay jornada abierta: no se registra ubicación', 409);
    const lista = (Array.isArray(body) ? body.slice(0, 500) : [])
      .filter(p => esNum(p.lat, -90, 90) && esNum(p.lng, -180, 180));
    if (lista.length) {
      const ins = db.prepare('INSERT INTO posiciones (jornada_id, lat, lng, precision, velocidad, ts) VALUES (?,?,?,?,?,?)');
      await db.batch(lista.map(p => ins.bind(j.id, p.lat, p.lng,
        esNum(p.precision, 0, 1e6) ? p.precision : null, esNum(p.velocidad, 0, 400) ? p.velocidad : null,
        typeof p.ts === 'string' ? p.ts.slice(0, 30) : ahora())));
    }
    return json({ guardadas: lista.length });
  },

  'GET /api/conductor/mis-jornadas': async ({ db, uid }) => json((await db.prepare(`
    SELECT j.id, j.inicio, j.fin, c.matricula,
      (SELECT COUNT(*) FROM posiciones WHERE jornada_id = j.id) AS puntos
    FROM jornadas j JOIN camiones c ON c.id = j.camion_id
    WHERE j.conductor_id = ? ORDER BY j.inicio DESC LIMIT 50`).bind(uid).all()).results),
};

const publicas = new Set(['POST /api/empresa/registro', 'POST /api/empresa/login', 'POST /api/conductor/login']);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    const clave = `${req.method} ${url.pathname}`;
    const ruta = rutas[clave];
    if (!ruta) return error('No encontrado', 404);

    const db = env.DB;
    let uid = null;
    if (!publicas.has(clave)) {
      uid = await usuario(req, db, url.pathname.startsWith('/api/empresa/') ? 'empresa' : 'conductor');
      if (!uid) return error('Sesión no válida', 401);
    }
    let body = {};
    if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
    if (body === null || typeof body !== 'object') body = {};
    try { return await ruta({ db, uid, body, url, env }); }
    catch (e) { console.error(e); return error('Error del servidor', 500); }
  },

  // Limpieza automática (cada 6 horas, ver wrangler.jsonc)
  async scheduled(evento, env) {
    const dias = Number(env.RETENCION_DIAS || 90);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM posiciones WHERE jornada_id IN
        (SELECT id FROM jornadas WHERE fin IS NOT NULL AND julianday(fin) < julianday('now', ?))`).bind(`-${dias} days`),
      env.DB.prepare(`DELETE FROM jornadas WHERE fin IS NOT NULL AND julianday(fin) < julianday('now', ?)`).bind(`-${dias} days`),
      env.DB.prepare(`DELETE FROM sesiones WHERE creado < datetime('now', '-30 days')`),
    ]);
  },
};
