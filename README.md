# GPS Flota — versión web 0.1

Seguimiento de camiones para empresas de transporte: el conductor inicia la jornada en su móvil, la app envía su posición y la empresa ve la flota en directo y el historial de rutas.

## Arrancar (Windows con WSL, Linux o Mac)

Necesitas Node.js 20 o superior.

```bash
cd gps-flota
npm install
npm start
```

Abre http://localhost:3000

1. Entra en **Soy empresa**, registra la empresa, añade un camión y un conductor (apunta el código y el PIN).
2. En otra pestaña o en el móvil, entra en **Soy conductor** con ese código y PIN, lee el aviso, elige camión e inicia la jornada.
3. Vuelve al panel de empresa: verás el camión en el mapa. En **Historial de rutas** se dibuja el recorrido.

**Probar desde el móvil:** el navegador solo da la ubicación GPS en `localhost` o en páginas `https://`. Para probar con el móvil antes de tener servidor, usa un túnel como `cloudflared tunnel --url http://localhost:3000` y abre la dirección https que te da.

## Configuración

| Variable | Por defecto | Qué hace |
|---|---|---|
| `PORT` | 3000 | Puerto del servidor |
| `RETENCION_DIAS` | 90 | Días que se guardan las rutas antes de borrarse solas |
| `DB_FILE` | `flota.db` | Archivo de la base de datos SQLite |

## Qué incluye ya para cumplir la ley

- La ubicación **solo se graba con la jornada iniciada** (botón Iniciar / Finalizar).
- El conductor **no puede iniciar jornada sin haber leído el aviso** de geolocalización (art. 90 LOPDGDD); queda guardada la fecha en que lo leyó.
- El conductor puede ver sus propias jornadas registradas.
- Borrado automático de rutas antiguas (`RETENCION_DIAS`).
- Cada empresa solo ve sus propios camiones y conductores.
- Contraseñas y PIN guardados cifrados (scrypt).
- Mapa de OpenStreetMap con su atribución obligatoria.

Los textos `public/aviso-conductor.html` y `public/privacidad.html` son **borradores**: hay que completar los datos entre [corchetes] y que los revise un abogado de protección de datos.

## Siguientes pasos

1. **Publicarlo en internet con HTTPS** (hosting en la UE).
2. **Contrato de encargado del tratamiento** (art. 28 RGPD) que acepta cada empresa al registrarse.
3. **App Android**: envolver la web con Capacitor y añadir un servicio en primer plano de ubicación, para que siga grabando con la pantalla apagada. Requiere la declaración de ubicación en segundo plano en Play Console.
4. Mejoras: borrar conductores y camiones, exportar rutas, recuperar contraseña.
5. Teselas de mapa: los servidores de OpenStreetMap no admiten uso intensivo. Con muchos usuarios hay que usar un proveedor de teselas (MapTiler, Stadia, etc.) o un servidor propio.
