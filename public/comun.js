// Funciones compartidas por las páginas
async function api(url, cuerpo, token) {
  const opciones = { method: cuerpo ? 'POST' : 'GET', headers: {} };
  if (cuerpo) { opciones.headers['Content-Type'] = 'application/json'; opciones.body = JSON.stringify(cuerpo); }
  if (token) opciones.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(url, opciones);
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(datos.error || 'Error ' + r.status); e.status = r.status; throw e; }
  return datos;
}

function sesion(tipo) {
  const clave = 'gpsflota_' + tipo;
  const leer = () => { try { return JSON.parse(localStorage.getItem(clave)) || {}; } catch { return {}; } };
  return {
    datos: leer,
    token: () => leer().token,
    guardar: d => { try { localStorage.setItem(clave, JSON.stringify(d)); } catch {} },
    borrar: () => { try { localStorage.removeItem(clave); } catch {} },
  };
}

// Mapa base de OpenStreetMap (licencia ODbL: la atribución es obligatoria)
function crearMapa(id) {
  const m = L.map(id).setView([40.2, -3.7], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">colaboradores de OpenStreetMap</a>',
  }).addTo(m);
  return m;
}

// Placa de matrícula española (franja azul con la E)
const placa = m => `<span class="placa"><span>${esc(m)}</span></span>`;

// Marcador de camión: círculo azul (amarillo si está en ruta) con la placa debajo
const SVG_CAMION = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 6h11v9H2zM13 9h4l3 3.5V15h-7z" fill="#fff"/><circle cx="6" cy="16.5" r="2" fill="#fff"/><circle cx="16.5" cy="16.5" r="2" fill="#fff"/></svg>';
function iconoCamion(matricula, activo = true) {
  return L.divIcon({
    className: 'marcador-camion' + (activo ? ' activo' : ''),
    html: `<div class="cuerpo"><div class="icono">${SVG_CAMION}</div>${matricula ? placa(matricula) : ''}</div>`,
    iconSize: [90, 64], iconAnchor: [45, 22], popupAnchor: [0, -24],
  });
}

// Tablas de camiones y conductores (panel de empresa y panel de administrador).
// acciones: { asignar, desasignar, quitar(tipo, id), nuevoPin(id), mostrarPin(nombre, codigo, pin), error(tipo, mensaje), recargar() }
function pintarFlota(cams, cs, tbodyCamiones, tbodyConductores, acciones) {
  tbodyCamiones.innerHTML = cams.map(c => {
    const ids = c.conductores.map(x => x.id);
    const libres = cs.filter(x => !ids.includes(x.id));
    return `<tr><td>${placa(c.matricula)}</td><td>${esc(c.descripcion)}</td>
      <td><div class="chips">${c.conductores.map(x => `<span class="chip">${esc(x.nombre)}<button class="desasignar" data-camion="${c.id}" data-conductor="${x.id}" aria-label="Quitar a ${esc(x.nombre)} de ${esc(c.matricula)}" title="Quitar de este camión">×</button></span>`).join('')}
        ${libres.length ? `<select class="asignar" data-camion="${c.id}" aria-label="Añadir conductor a ${esc(c.matricula)}"><option value="">Añadir conductor…</option>${libres.map(x => `<option value="${x.id}">${esc(x.nombre)}</option>`).join('')}</select>` : ''}
        ${!c.conductores.length && !libres.length ? '<span class="nota">Crea conductores para asignarlos</span>' : ''}</div></td>
      <td class="acciones"><button class="quitar" data-tipo="camiones" data-id="${c.id}" data-nombre="el camión ${esc(c.matricula)}">Quitar</button></td></tr>`;
  }).join('') || '<tr><td colspan="4" class="nota">Todavía no hay camiones. Añade el primero con su matrícula.</td></tr>';

  const camionesDe = id => cams.filter(c => c.conductores.some(x => x.id === id));
  tbodyConductores.innerHTML = cs.map(c => `<tr><td>${esc(c.nombre)}</td><td data-etiqueta="Código"><code>${c.codigo}</code></td>
      <td>${camionesDe(c.id).map(k => placa(k.matricula)).join(' ') || '<span class="nota">Sin camión</span>'}</td>
      <td data-etiqueta="Aviso leído">${c.aviso_aceptado ? fecha(c.aviso_aceptado) : 'Pendiente'}</td>
      <td class="acciones"><button class="sec nuevo-pin" data-id="${c.id}" data-nombre="${esc(c.nombre)}">Cambiar PIN</button> <button class="quitar" data-tipo="conductores" data-id="${c.id}" data-nombre="a ${esc(c.nombre)}">Quitar</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="nota">Todavía no hay conductores. Añádelos para darles su código y PIN.</td></tr>';

  const intentar = async (tipo, fn) => { try { await fn(); } catch (e) { acciones.error(tipo, e.message); return; } acciones.recargar(); };
  tbodyCamiones.querySelectorAll('select.asignar').forEach(s => s.onchange = () =>
    s.value && intentar('camiones', () => acciones.asignar(Number(s.dataset.camion), Number(s.value))));
  tbodyCamiones.querySelectorAll('button.desasignar').forEach(b => b.onclick = () =>
    intentar('camiones', () => acciones.desasignar(Number(b.dataset.camion), Number(b.dataset.conductor))));
  tbodyConductores.querySelectorAll('button.nuevo-pin').forEach(b => b.onclick = async () => {
    const pin = prompt(`PIN nuevo para ${b.dataset.nombre}.\n\nEscribe uno de 4 a 8 cifras, o déjalo vacío para generar uno al azar.\nEl PIN anterior dejará de servir y se cerrará su sesión en el móvil.`, '');
    if (pin === null) return;  // cancelado
    try { const r = await acciones.nuevoPin(Number(b.dataset.id), pin.trim()); acciones.mostrarPin(b.dataset.nombre, r.codigo, r.pin); }
    catch (e) { acciones.error('conductores', e.message); }
  });
    [tbodyCamiones, tbodyConductores].forEach(t => t.querySelectorAll('button.quitar').forEach(b => b.onclick = () => {
    const aviso = b.dataset.tipo === 'camiones'
      ? `¿Quitar ${b.dataset.nombre}? También se borrará el historial de rutas de ese camión.`
      : `¿Quitar ${b.dataset.nombre}? Ya no podrá entrar en la app y se borrará su historial de jornadas.`;
    if (confirm(aviso)) intentar(b.dataset.tipo, () => acciones.quitar(b.dataset.tipo, Number(b.dataset.id)));
  }));
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fecha = iso => new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });

// ---------- Aviso de versión nueva de la app Android ----------
// La app añade "GPSFlotaApp/<número de versión>" a su identificador de navegador.
// Si /app-version.json indica una versión mayor, se avisa al conductor para que la instale.
(function avisoVersionApp() {
  const m = navigator.userAgent.match(/GPSFlotaApp\/(\d+)/);
  if (!m) return;
  const actual = Number(m[1]);
  document.documentElement.classList.add('en-app');
  const comprobar = async () => {
    let v;
    try { v = await (await fetch('/app-version.json', { cache: 'no-store' })).json(); } catch { return; }
    if (!v || !(v.versionCode > actual) || document.querySelector('.aviso-version')) return;
    try { if (sessionStorage.getItem('gpsflota_aviso_oculto') === String(v.versionCode)) return; } catch {}
    const barra = document.createElement('div');
    barra.className = 'aviso-version';
    barra.setAttribute('role', 'status');
    barra.innerHTML = `<span>Hay una versión nueva de la app. Tienes la ${esc('1.' + actual)}.</span>
      <a href="/api/app/descargar?v=${v.versionCode}">Actualizar a la ${esc(v.versionName || v.versionCode)}</a><button type="button">Más tarde</button>`;
    barra.querySelector('button').onclick = () => {
      barra.remove();
      try { sessionStorage.setItem('gpsflota_aviso_oculto', String(v.versionCode)); } catch {}
    };
    document.body.prepend(barra);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', comprobar); else comprobar();
  setInterval(comprobar, 30 * 60 * 1000);  // también mientras la app sigue abierta
})();
