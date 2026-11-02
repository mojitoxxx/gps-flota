// Funciones compartidas por las páginas
async function api(url, cuerpo, token) {
  const opciones = { method: cuerpo ? 'POST' : 'GET', headers: {} };
  if (cuerpo) { opciones.headers['Content-Type'] = 'application/json'; opciones.body = JSON.stringify(cuerpo); }
  if (token) opciones.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(url, opciones);
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(datos.error || 'Error ' + r.status);
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

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fecha = iso => new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
