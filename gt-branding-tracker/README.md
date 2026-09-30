# Global Transport — Branding Tracker

Dashboard del bonus de branding no cobrado de las flotas de Global Transport en Madrid.
Se regenera solo y se publica en GitHub Pages.

## Puesta en marcha

1. **Sube los archivos** a la raíz del repositorio, respetando la estructura.
   `.github/workflows/refresh-gt.yml` es una carpeta oculta en macOS: créalo desde
   *Add file → Create new file* escribiendo la ruta completa en el nombre.

2. **Configura los cuatro secrets** en *Settings → Secrets and variables → Actions*:

   | Secret | Qué es |
   |---|---|
   | `DATABRICKS_HOST` | Host del workspace, sin `https://` |
   | `DATABRICKS_TOKEN` | Personal access token con permiso de uso sobre el warehouse |
   | `DATABRICKS_WAREHOUSE_ID` | ID del SQL warehouse |
   | `SHEET_CSV_URL` | URL de publicación en CSV del sheet de grouping |

3. **Activa Pages** en *Settings → Pages*: Source *Deploy from a branch*, branch `main`, carpeta `/docs`.

4. **Lanza el primer build** en *Actions → Refresh GT tracker → Run workflow*.

## Cuándo se actualiza

Cron `0 7-22 * * *` en UTC. Madrid es UTC+2 en verano y UTC+1 en invierno, así que
esa franja cubre de 9:00 a 23:00 locales todo el año sin tocar el cron dos veces al año.

Los datos van **a día vencido**: cada build incluye todos los días cerrados hasta el
anterior. La visibilidad sigue siendo semanal de lunes a domingo, y la semana viva
aparece marcada como *en curso* con su bonus provisional.

## Congelado mensual

Una semana se atribuye al mes en que cae su **domingo**. Un mes está cerrado cuando su
último domingo ya pasó, y entonces el build escribe `snapshots/YYYY-MM.json` con las
filas, el roster de empresas usado y los totales.

A partir de ese momento el mes se sirve desde el snapshot y no se recalcula ni se
vuelve a leer el sheet. Es lo que evita que borrar una flota del grouping altere un
importe ya pagado: julio conserva sus cinco empresas aunque hoy el sheet solo liste cuatro.

**No borres los snapshots.** Si eliminas uno, el siguiente build recalculará ese mes con
el roster actual y el histórico dejará de cuadrar con lo pagado.

## Mantenimiento

`config.json` concentra todo lo que cambia sin tocar código:

- **`vehicles`** — la lista de vehículos vinilados. No se deriva de
  `car_branding_periods` porque esa tabla conserva períodos aprobados de coches que ya
  retiraron el vinilo. Cuando la flota vinilada cambie, edita esta lista.
  `car_ids` agrupa varios IDs de una misma matrícula cuando el registro se borró y se
  recreó, como en 2555-LWJ.
- **`cohorts` y el campo `cohort` de cada vehículo** — base del rank 0 más los 2 puntos
  del rank 1. `cohort: null` significa que no consta en su historial de campañas y toma
  la cohorte del selector del dashboard.
- **`thresholds`** — leídos de las condiciones reales de la campaña de Madrid.
  No los cambies salvo que la campaña cambie.

El sheet de grouping decide qué empresas pertenecen al Fleet Owner. El build cruza esa
lista con las empresas que tienen vehículos en `config.json`, así que añadir una flota
al sheet no la mete en el alcance hasta que registres sus coches vinilados aquí.

## Metodología

**Horas online y peak.** `SUM(total_adjusted_online_seconds)/3600` de
`etl_category_driver_car_online_hours`. Esa tabla guarda una fila por categoría de
servicio y hora; el campo *adjusted* lleva el tiempo ya prorrateado, así que suma sin
duplicar y reconcilia exacto con el Tiempo de conexión del Fleet Portal.

**Tasa de aceptación.** Los coches de Global Transport no están inscritos en CarBranding,
así que no tienen `acceptance_rate` propio y se replica el de la campaña:

```
AR = (viajes finalizados + rechazos del pasajero)
     ÷ (viajes finalizados + rechazos del pasajero + rechazos del conductor que penalizan)
```

Un rechazo del conductor solo penaliza si el intento **no** figura en
`company_order_try_optional_ride_rules`. Verificado con 99,0% de coincidencias exactas
sobre 1,39 M de semanas-coche, y el criterio de rechazo opcional acierta el 99,96%.

**Base del bonus.** `gmv_eur` de `etl_partner_data`.

**Umbrales.** Nivel 1 con 40h online y 20h de peak. Nivel 2 con 55h y 30h. AR mínimo 0,85
en ambos.

## Avisos conocidos

- Las horas tienen 34 min de desviación media frente a las que calcula la campaña, lo que
  haría cambiar de nivel al 1,9% de las semanas. Revisa las que queden al filo de los umbrales.
- **6415-KRG** tiene inscripción en CarBranding desde el 28 de septiembre de 2026. A partir
  de octubre cobra por campaña y no debe compensarse por esta vía.
- El `docs/index.html` publicado contiene matrículas, nombres de empresa y facturación por
  vehículo. Mantén el repositorio privado.
