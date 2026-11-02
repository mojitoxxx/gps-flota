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

// PIN elegido por la empresa: de 4 a 8 cifras y que no sea demasiado fácil (1111, 1234, 4321...)
function pinElegido(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return { pin: String(aleatorio(100000, 1000000)) };
  const pin = String(valor).trim();
  if (!/^\d{4,8}$/.test(pin)) return { error: 'El PIN debe tener entre 4 y 8 cifras, solo números.' };
  const d = [...pin].map(Number);
  const iguales = d.every(x => x === d[0]);
  const sube = d.every((x, i) => i === 0 || x === (d[i - 1] + 1) % 10);
  const baja = d.every((x, i) => i === 0 || x === (d[i - 1] + 9) % 10);
  if (iguales || sube || baja) return { error: 'Ese PIN es demasiado fácil de adivinar. Elige otro.' };
  return { pin };
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
    json((await db.prepare(`SELECT c.id, c.matricula, c.descripcion,
      (SELECT json_group_array(json_object('id', co.id, 'nombre', co.nombre)) FROM asignaciones a
        JOIN conductores co ON co.id = a.conductor_id WHERE a.camion_id = c.id) AS conductores
      FROM camiones c WHERE c.empresa_id = ? ORDER BY c.matricula`).bind(uid).all()).results
      .map(c => ({ ...c, conductores: JSON.parse(c.conductores || '[]').sort((x, y) => x.nombre.localeCompare(y.nombre)) }))),

  // Quitar un camión (y su historial de rutas)
  'POST /api/empresa/camiones/quitar': async ({ db, uid, body }) => {
    const cam = await db.prepare('SELECT id FROM camiones WHERE id = ? AND empresa_id = ?').bind(Number(body.id), uid).first();
    if (!cam) return error('Camión no válido', 400);
    if (await db.prepare('SELECT id FROM jornadas WHERE camion_id = ? AND fin IS NULL').bind(cam.id).first())
      return error('Ese camión está en ruta. Espera a que el conductor finalice la jornada para quitarlo.', 409);
    await db.batch([
      db.prepare('DELETE FROM posiciones WHERE jornada_id IN (SELECT id FROM jornadas WHERE camion_id = ?)').bind(cam.id),
      db.prepare('DELETE FROM jornadas WHERE camion_id = ?').bind(cam.id),
      db.prepare('DELETE FROM asignaciones WHERE camion_id = ?').bind(cam.id),
      db.prepare('DELETE FROM camiones WHERE id = ?').bind(cam.id),
    ]);
    return json({ ok: true });
  },

  // Cambiar el PIN de un conductor: el que elija la empresa o uno al azar (se guarda cifrado y no se puede leer)
  'POST /api/empresa/conductores/nuevo-pin': async ({ db, uid, body }) => {
    const co = await db.prepare('SELECT id, codigo FROM conductores WHERE id = ? AND empresa_id = ?').bind(Number(body.id), uid).first();
    if (!co) return error('Conductor no válido', 400);
    const elegido = pinElegido(body.pin);
    if (elegido.error) return error(elegido.error, 400);
    const pin = elegido.pin;
    await db.batch([
      db.prepare('UPDATE conductores SET pin_hash = ? WHERE id = ?').bind(await hash(pin), co.id),
      // se cierran sus sesiones abiertas: tendrá que entrar con el PIN nuevo
      db.prepare(`DELETE FROM sesiones WHERE tipo = 'conductor' AND ref_id = ?`).bind(co.id),
    ]);
    return json({ codigo: co.codigo, pin }); // se muestra solo esta vez
  },

  // Quitar un conductor (su acceso, sus jornadas y su asignación de camión)
  'POST /api/empresa/conductores/quitar': async ({ db, uid, body }) => {
    const co = await db.prepare('SELECT id FROM conductores WHERE id = ? AND empresa_id = ?').bind(Number(body.id), uid).first();
    if (!co) return error('Conductor no válido', 400);
    if (await db.prepare('SELECT id FROM jornadas WHERE conductor_id = ? AND fin IS NULL').bind(co.id).first())
      return error('Ese conductor está en ruta. Espera a que finalice la jornada para quitarlo.', 409);
    await db.batch([
      db.prepare('UPDATE camiones SET conductor_id = NULL WHERE conductor_id = ?').bind(co.id),
      db.prepare('DELETE FROM asignaciones WHERE conductor_id = ?').bind(co.id),
      db.prepare(`DELETE FROM sesiones WHERE tipo = 'conductor' AND ref_id = ?`).bind(co.id),
      db.prepare('DELETE FROM posiciones WHERE jornada_id IN (SELECT id FROM jornadas WHERE conductor_id = ?)').bind(co.id),
      db.prepare('DELETE FROM jornadas WHERE conductor_id = ?').bind(co.id),
      db.prepare('DELETE FROM conductores WHERE id = ?').bind(co.id),
    ]);
    return json({ ok: true });
  },

  // Añadir un conductor a un camión (un camión puede tener varios conductores)
  'POST /api/empresa/asignar': async ({ db, uid, body }) => {
    const cam = await db.prepare('SELECT id FROM camiones WHERE id = ? AND empresa_id = ?').bind(Number(body.camion_id), uid).first();
    if (!cam) return error('Camión no válido', 400);
    const co = await db.prepare('SELECT id FROM conductores WHERE id = ? AND empresa_id = ?').bind(Number(body.conductor_id), uid).first();
    if (!co) return error('Conductor no válido', 400);
    await db.prepare('INSERT OR IGNORE INTO asignaciones (camion_id, conductor_id) VALUES (?,?)').bind(cam.id, co.id).run();
    return json({ ok: true });
  },

  // Quitar a un conductor de un camión
  'POST /api/empresa/desasignar': async ({ db, uid, body }) => {
    const cam = await db.prepare('SELECT id FROM camiones WHERE id = ? AND empresa_id = ?').bind(Number(body.camion_id), uid).first();
    if (!cam) return error('Camión no válido', 400);
    const conductorId = Number(body.conductor_id);
    if (await db.prepare('SELECT id FROM jornadas WHERE camion_id = ? AND conductor_id = ? AND fin IS NULL').bind(cam.id, conductorId).first())
      return error('Ese conductor está en ruta con este camión. Espera a que finalice la jornada.', 409);
    await db.batch([
      db.prepare('DELETE FROM asignaciones WHERE camion_id = ? AND conductor_id = ?').bind(cam.id, conductorId),
      db.prepare('UPDATE camiones SET conductor_id = NULL WHERE id = ? AND conductor_id = ?').bind(cam.id, conductorId),
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
    const elegido = pinElegido(body.pin);
    if (elegido.error) return error(elegido.error, 400);
    const pin = elegido.pin;
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

  // ---------- APP ANDROID ----------
  // Descarga de la APK con la versión en el nombre del archivo (GPS-Flota-1.3.apk)
  'GET /api/app/descargar': async ({ env, url }) => {
    const apk = await env.ASSETS.fetch(new URL('/gps-flota.apk', url));
    if (!apk.ok) return error('La app todavía no está disponible.', 404);
    let version = null;
    try { version = await (await env.ASSETS.fetch(new URL('/app-version.json', url))).json(); } catch {}
    const nombre = version && version.versionName ? `GPS-Flota-${version.versionName}.apk` : 'GPS-Flota.apk';
    return new Response(apk.body, {
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="${nombre}"`,
        'Cache-Control': 'no-store',
      },
    });
  },

  // ---------- ADMINISTRADOR DE LA APLICACIÓN ----------
  'POST /api/admin/login': async ({ db, body }) => {
    const a = await db.prepare('SELECT * FROM admins WHERE usuario = ?').bind((body.usuario || '').trim().toLowerCase()).first();
    if (!a || !(await verificar(body.password || '', a.pass_hash))) return error('Datos incorrectos', 401);
    return json({ token: await nuevaSesion(db, 'admin', a.id), usuario: a.usuario });
  },

  'GET /api/admin/empresas': async ({ db }) => json((await db.prepare(`
    SELECT e.id, e.nombre, e.email, e.creado,
      (SELECT COUNT(*) FROM camiones WHERE empresa_id = e.id) AS camiones,
      (SELECT COUNT(*) FROM conductores WHERE empresa_id = e.id) AS conductores,
      (SELECT COUNT(*) FROM jornadas j JOIN camiones c ON c.id = j.camion_id WHERE c.empresa_id = e.id AND j.fin IS NULL) AS en_ruta
    FROM empresas e ORDER BY e.nombre`).all()).results),

  'POST /api/admin/empresas': async ({ db, body }) => {
    const { nombre, email, password } = body;
    if (!nombre || !email || !password || password.length < 8)
      return error('Faltan datos (contraseña mínimo 8 caracteres)', 400);
    try {
      const r = await db.prepare('INSERT INTO empresas (nombre, email, pass_hash) VALUES (?,?,?)')
        .bind(nombre.trim(), email.trim().toLowerCase(), await hash(password)).run();
      return json({ id: r.meta.last_row_id });
    } catch { return error('Ese email ya está registrado', 409); }
  },

  // Quitar una empresa con todo lo suyo: camiones, conductores, rutas y sesiones
  'POST /api/admin/empresas/quitar': async ({ db, body }) => {
    const e = await db.prepare('SELECT id FROM empresas WHERE id = ?').bind(Number(body.id)).first();
    if (!e) return error('Empresa no válida', 400);
    const enRuta = await db.prepare(`SELECT COUNT(*) AS n FROM jornadas j JOIN camiones c ON c.id = j.camion_id
      WHERE c.empresa_id = ? AND j.fin IS NULL`).bind(e.id).first();
    if (enRuta.n) return error('Esta empresa tiene camiones en ruta. Espera a que finalicen las jornadas para quitarla.', 409);
    await db.batch([
      db.prepare(`DELETE FROM posiciones WHERE jornada_id IN (SELECT j.id FROM jornadas j JOIN camiones c ON c.id = j.camion_id WHERE c.empresa_id = ?)`).bind(e.id),
      db.prepare('DELETE FROM jornadas WHERE camion_id IN (SELECT id FROM camiones WHERE empresa_id = ?)').bind(e.id),
      db.prepare(`DELETE FROM sesiones WHERE tipo = 'conductor' AND ref_id IN (SELECT id FROM conductores WHERE empresa_id = ?)`).bind(e.id),
      db.prepare(`DELETE FROM sesiones WHERE tipo = 'empresa' AND ref_id = ?`).bind(e.id),
      db.prepare('DELETE FROM asignaciones WHERE camion_id IN (SELECT id FROM camiones WHERE empresa_id = ?)').bind(e.id),
      db.prepare('UPDATE camiones SET conductor_id = NULL WHERE empresa_id = ?').bind(e.id),
      db.prepare('DELETE FROM conductores WHERE empresa_id = ?').bind(e.id),
      db.prepare('DELETE FROM camiones WHERE empresa_id = ?').bind(e.id),
      db.prepare('DELETE FROM empresas WHERE id = ?').bind(e.id),
    ]);
    return json({ ok: true });
  },

  'GET /api/admin/en-directo': async ({ db }) => json((await db.prepare(`
    SELECT j.id AS jornada_id, c.matricula, co.nombre AS conductor, e.nombre AS empresa, j.inicio,
           p.lat, p.lng, p.velocidad, p.ts
    FROM jornadas j
    JOIN camiones c ON c.id = j.camion_id
    JOIN empresas e ON e.id = c.empresa_id
    JOIN conductores co ON co.id = j.conductor_id
    LEFT JOIN posiciones p ON p.id = (SELECT id FROM posiciones WHERE jornada_id = j.id ORDER BY ts DESC LIMIT 1)
    WHERE j.fin IS NULL`).all()).results),

  // Gestionar una empresa concreta reutilizando las mismas operaciones que usa la propia empresa
  'POST /api/admin/gestionar': async (ctx) => {
    const { db, body } = ctx;
    const permitidas = ['GET camiones', 'GET conductores', 'POST camiones', 'POST conductores',
      'POST asignar', 'POST desasignar', 'POST camiones/quitar', 'POST conductores/quitar',
      'POST conductores/nuevo-pin'];
    if (!permitidas.includes(body.accion)) return error('Acción no permitida', 400);
    const e = await db.prepare('SELECT id FROM empresas WHERE id = ?').bind(Number(body.empresa_id)).first();
    if (!e) return error('Empresa no válida', 400);
    const [metodo, ruta] = body.accion.split(' ');
    const datos = body.datos && typeof body.datos === 'object' ? body.datos : {};
    return rutas[`${metodo} /api/empresa/${ruta}`]({ ...ctx, uid: e.id, body: datos });
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
    const [camiones, jornada] = await db.batch([
      db.prepare(`SELECT c.id, c.matricula, c.descripcion,
        EXISTS (SELECT 1 FROM jornadas j WHERE j.camion_id = c.id AND j.fin IS NULL) AS en_ruta
        FROM asignaciones a JOIN camiones c ON c.id = a.camion_id WHERE a.conductor_id = ? ORDER BY c.matricula`).bind(uid),
      db.prepare(`SELECT j.id, j.inicio, c.matricula FROM jornadas j JOIN camiones c ON c.id = j.camion_id
        WHERE j.conductor_id = ? AND j.fin IS NULL`).bind(uid),
    ]);
    return json({ aviso_aceptado: yo.aviso_aceptado, camiones: camiones.results, jornada: jornada.results[0] || null });
  },

  'POST /api/conductor/jornada/iniciar': async ({ db, uid, body }) => {
    const yo = await db.prepare('SELECT aviso_aceptado FROM conductores WHERE id = ?').bind(uid).first();
    if (!yo.aviso_aceptado) return error('Debes leer el aviso de geolocalización primero', 403);
    // Solo puede salir con un camión que la empresa le haya asignado
    const suyos = (await db.prepare('SELECT camion_id AS id FROM asignaciones WHERE conductor_id = ?').bind(uid).all()).results;
    if (!suyos.length) return error('Tu empresa todavía no te ha asignado un camión.', 409);
    const cam = body.camion_id ? suyos.find(c => c.id === Number(body.camion_id)) : (suyos.length === 1 ? suyos[0] : null);
    if (!cam) return error('Elige uno de tus camiones asignados.', 400);
    if (await db.prepare('SELECT id FROM jornadas WHERE camion_id = ? AND fin IS NULL').bind(cam.id).first())
      return error('Ese camión ya está en ruta con otro conductor.', 409);
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

const publicas = new Set(['POST /api/empresa/registro', 'POST /api/empresa/login', 'POST /api/conductor/login', 'POST /api/admin/login',
  'GET /api/app/descargar']);
const tipoDeRuta = p => p.startsWith('/api/empresa/') ? 'empresa' : p.startsWith('/api/admin/') ? 'admin' : 'conductor';

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
      uid = await usuario(req, db, tipoDeRuta(url.pathname));
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
