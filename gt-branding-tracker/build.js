#!/usr/bin/env node
/**
 * Global Transport — Branding Tracker
 * Regenera docs/index.html con datos a día vencido.
 *
 * Secrets requeridos como variables de entorno (nunca en el código):
 *   DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID, SHEET_CSV_URL
 *
 * Congelado mensual: los meses cerrados se sirven desde snapshots/YYYY-MM.json
 * y no se vuelven a calcular, de modo que un cambio en el sheet de grouping o
 * un backfill del ETL no altere un importe ya pagado.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CFG  = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SNAP = path.join(__dirname, 'snapshots');
const TZ   = CFG.timezone || 'Europe/Madrid';

const ENV = ['DATABRICKS_HOST','DATABRICKS_TOKEN','DATABRICKS_WAREHOUSE_ID','SHEET_CSV_URL'];
const falta = ENV.filter(k => !process.env[k]);
if (falta.length) { console.error('Faltan variables de entorno: ' + falta.join(', ')); process.exit(1); }

/* ─────────── Fechas en hora de Madrid ─────────── */
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' });
const hora = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, hour:'2-digit', minute:'2-digit', hour12:false });

const hoyMadrid = () => fmt.format(new Date());                       // YYYY-MM-DD
const dias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return fmt.format(d); };
const dow  = iso => { const d = new Date(iso + 'T12:00:00Z'); return d.getUTCDay() === 0 ? 7 : d.getUTCDay(); }; // 1=lun..7=dom
const lunesDe   = iso => dias(iso, -(dow(iso) - 1));
const domingoDe = iso => dias(lunesDe(iso), 6);
const mesDe     = iso => iso.slice(0, 7);

/** Último domingo del mes natural YYYY-MM. Las semanas se atribuyen al mes en
 *  que cae su domingo, así que ese domingo cierra el mes. */
function ultimoDomingoDelMes(ym) {
  const [y, m] = ym.split('-').map(Number);
  const fin = new Date(Date.UTC(y, m, 0, 12));      // último día del mes
  const iso = fmt.format(fin);
  return dias(iso, -(dow(iso) % 7));                 // retrocede al domingo
}
function mesesDesde(primero, hasta) {
  const out = []; let [y, m] = primero.split('-').map(Number);
  const [hy, hm] = hasta.split('-').map(Number);
  while (y < hy || (y === hy && m <= hm)) {
    out.push(`${y}-${String(m).padStart(2,'0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/* ─────────── Databricks SQL ─────────── */
async function sql(query) {
  const host = process.env.DATABRICKS_HOST.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const base = `https://${host}/api/2.0/sql/statements`;
  const cab  = { 'Authorization': `Bearer ${process.env.DATABRICKS_TOKEN}`, 'Content-Type': 'application/json' };

  let r = await fetch(base, { method:'POST', headers:cab, body: JSON.stringify({
    statement: query,
    warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID,
    wait_timeout: '50s',
    format: 'JSON_ARRAY',
    disposition: 'INLINE'
  })});
  if (!r.ok) throw new Error(`SQL HTTP ${r.status}: ${(await r.text()).slice(0,300)}`);
  let j = await r.json();

  while (j.status && (j.status.state === 'PENDING' || j.status.state === 'RUNNING')) {
    await new Promise(s => setTimeout(s, 2500));
    r = await fetch(`${base}/${j.statement_id}`, { headers: cab });
    if (!r.ok) throw new Error(`Poll HTTP ${r.status}`);
    j = await r.json();
  }
  if (!j.status || j.status.state !== 'SUCCEEDED') {
    throw new Error('SQL falló: ' + JSON.stringify(j.status || {}).slice(0,300));
  }
  const cols = ((j.manifest||{}).schema||{}).columns || [];
  const filas = (j.result||{}).data_array || [];
  return filas.map(f => Object.fromEntries(cols.map((c,i) => [c.name, f[i]])));
}

/* ─────────── Roster: empresas del Fleet Owner en el sheet de grouping ─────────── */
const norm = s => String(s||'').toUpperCase().replace(/\s+/g,'');
function csvFilas(txt) {
  const out=[]; let campo='', fila=[], dentro=false;
  for (let i=0;i<txt.length;i++){
    const c=txt[i];
    if (dentro){ if (c==='"'){ if (txt[i+1]==='"'){campo+='"';i++;} else dentro=false; } else campo+=c; }
    else if (c==='"') dentro=true;
    else if (c===',') { fila.push(campo); campo=''; }
    else if (c==='\n'){ fila.push(campo); out.push(fila); fila=[]; campo=''; }
    else if (c!=='\r') campo+=c;
  }
  if (campo!=='' || fila.length) { fila.push(campo); out.push(fila); }
  return out;
}
async function rosterDelSheet() {
  const r = await fetch(process.env.SHEET_CSV_URL);
  if (!r.ok) throw new Error(`Sheet CSV HTTP ${r.status}`);
  const filas = csvFilas(await r.text());
  const fo = norm(CFG.fleet_owner);
  const ids = [];
  for (const f of filas) {
    if (f.length < 3) continue;
    const id = parseInt(String(f[1]).replace(/[^\d]/g,''), 10);
    if (!Number.isFinite(id)) continue;
    if (norm(f[2]) === fo) ids.push(id);
  }
  const unicos = [...new Set(ids)].sort((a,b)=>a-b);
  if (!unicos.length) throw new Error(`El sheet no devolvió ninguna empresa con Fleet Owner = ${CFG.fleet_owner}`);
  return unicos;
}

/* ─────────── Query de métricas por coche y semana ─────────── */
const PEAK = h => `
   (DAYOFWEEK(${h}) IN (2,3,4) AND (HOUR(${h}) BETWEEN 7 AND 9 OR HOUR(${h}) BETWEEN 17 AND 19))
OR (DAYOFWEEK(${h}) = 5     AND (HOUR(${h}) BETWEEN 7 AND 9 OR HOUR(${h}) BETWEEN 17 AND 23))
OR (DAYOFWEEK(${h}) = 6     AND (HOUR(${h}) BETWEEN 0 AND 1 OR HOUR(${h}) BETWEEN 7 AND 9 OR HOUR(${h}) BETWEEN 13 AND 23))
OR (DAYOFWEEK(${h}) IN (1,7) AND (HOUR(${h}) BETWEEN 0 AND 6 OR HOUR(${h}) BETWEEN 11 AND 23))`;

function queryMetricas(desde, hasta) {
  const carIds = CFG.vehicles.flatMap(v => v.car_ids).join(',');
  const antes  = dias(desde, -2), despues = dias(hasta, 2);
  return `
WITH cars AS (
  SELECT id AS car_id, reg_number, company_id FROM main.ng_public.fleet_car
  WHERE id IN (${carIds})
),
oh AS (
  SELECT c.reg_number reg, MAX(c.company_id) cid,
    CAST(DATE_TRUNC('week', o.created_date_local) AS DATE) wks,
    ROUND(SUM(o.total_adjusted_online_seconds)/3600.0, 2) oh,
    ROUND(SUM(CASE WHEN ${PEAK('o.created_hour_local')} THEN o.total_adjusted_online_seconds ELSE 0 END)/3600.0, 2) peak
  FROM main.ng_public.etl_category_driver_car_online_hours o
  JOIN cars c ON c.car_id = o.car_id
  WHERE o.created_date_local BETWEEN '${desde}' AND '${hasta}'
  GROUP BY 1, 3
),
pd AS (
  SELECT c.reg_number reg, CAST(DATE_TRUNC('week', p.created_date_local) AS DATE) wks,
    SUM(p.finished_rides) trips, ROUND(SUM(p.gmv_eur), 2) gmv
  FROM main.ng_public.etl_partner_data p
  JOIN cars c ON c.car_id = p.driver_car_id
  WHERE p.created_date_local BETWEEN '${desde}' AND '${hasta}'
  GROUP BY 1, 2
),
opt AS (
  SELECT DISTINCT order_try_id FROM main.ng_public.company_order_try_optional_ride_rules
  WHERE created_date >= '${antes}' AND created_date <= '${despues}'
),
ot AS (
  SELECT c.reg_number reg,
    CAST(DATE_TRUNC('week', CONVERT_TIMEZONE('${TZ}', t.created)) AS DATE) wks,
    SUM(CASE WHEN t.state IN ('client_cancelled','client_did_not_show') THEN 1 ELSE 0 END) rid,
    SUM(CASE WHEN t.state IN ('driver_rejected','driver_did_not_respond') AND o.order_try_id IS NULL     THEN 1 ELSE 0 END) drv,
    SUM(CASE WHEN t.state IN ('driver_rejected','driver_did_not_respond') AND o.order_try_id IS NOT NULL THEN 1 ELSE 0 END) drv_opt
  FROM main.ng_public.company_order_try t
  JOIN cars c ON c.car_id = t.driver_car_id
  LEFT JOIN opt o ON o.order_try_id = t.id
  WHERE t.created_date >= '${antes}' AND t.created_date <= '${despues}'
    AND CAST(CONVERT_TIMEZONE('${TZ}', t.created) AS DATE) BETWEEN '${desde}' AND '${hasta}'
  GROUP BY 1, 2
)
SELECT h.reg, h.cid,
  CAST(DATE_ADD(h.wks, 6) AS STRING) wke,
  h.oh, h.peak,
  COALESCE(p.trips, 0) trips, COALESCE(p.gmv, 0) gmv,
  COALESCE(o.rid, 0) rid, COALESCE(o.drv, 0) drv, COALESCE(o.drv_opt, 0) drv_opt
FROM oh h
LEFT JOIN pd p ON p.reg = h.reg AND p.wks = h.wks
LEFT JOIN ot o ON o.reg = h.reg AND o.wks = h.wks
ORDER BY h.wke, h.cid, h.reg`;
}

/* ─────────── Cálculo del bonus ─────────── */
const TH = CFG.thresholds;
function nivelDe(oh, pk, ar) {
  if (ar == null || ar < TH.ar_min) return 0;
  if (oh >= TH.t2.oh && pk >= TH.t2.pk) return 2;
  if (oh >= TH.t1.oh && pk >= TH.t1.pk) return 1;
  return 0;
}
function aFila(r) {
  const oh = +r.oh, peak = +r.peak, trips = +r.trips, gmv = +r.gmv;
  const rid = +r.rid, drv = +r.drv, drvOpt = +r.drv_opt;
  const den = trips + rid + drv;
  const ar = den > 0 ? +(((trips + rid) / den).toFixed(4)) : null;
  return [ r.reg, +r.cid, r.wke, Number(r.wke.slice(5,7)), oh, peak, trips, rid, drv, drvOpt, ar, gmv ];
}

/* ─────────── Main ─────────── */
(async () => {
  const hoy = hoyMadrid();
  const dataHasta = dias(hoy, -1);                 // día vencido
  const mesVivo   = mesDe(domingoDe(hoy));         // mes de la semana en curso
  const meses     = mesesDesde(CFG.first_month, mesVivo);

  console.log(`Hoy en Madrid ${hoy} · datos hasta ${dataHasta} · mes de la semana viva ${mesVivo}`);
  console.log(`Meses a publicar: ${meses.join(', ')}`);

  const rosterSheet = await rosterDelSheet();
  console.log(`Roster del sheet para ${CFG.fleet_owner}: ${rosterSheet.join(', ')}`);

  // El sheet define qué empresas pertenecen al Fleet Owner, pero al alcance del
  // bonus solo entran las que tienen algún vehículo vinilado en config.json.
  const conVehiculo = [...new Set(CFG.vehicles.map(v => v.company_id))];
  const rosterVivo  = rosterSheet.filter(id => conVehiculo.includes(id));
  const sinVinilo   = rosterSheet.filter(id => !conVehiculo.includes(id));
  if (sinVinilo.length) console.log(`  sin vehículos vinilados, fuera del alcance: ${sinVinilo.join(', ')}`);
  if (!rosterVivo.length) { console.error('Ninguna empresa del sheet tiene vehículos vinilados. No se publica.'); process.exit(1); }
  console.log(`Alcance del mes en curso: ${rosterVivo.join(', ')}`);

  const sinNombre = rosterVivo.filter(id => !CFG.companies[String(id)]);
  if (sinNombre.length) console.warn(`AVISO · empresas sin nombre en config.json: ${sinNombre.join(', ')}`);

  // Vehículos de config.json cuya empresa ya no figura en el sheet
  const huerfanos = [...new Set(CFG.vehicles.map(v => v.company_id))].filter(id => !rosterSheet.includes(id));
  if (huerfanos.length) console.log(`  empresas en config.json que el sheet ya no asigna al FO: ${huerfanos.join(', ')} (sus coches quedan fuera del mes en curso)`);

  // Un solo barrido de datos desde el primer lunes hasta el día vencido
  const desde = lunesDe(CFG.first_month + '-01');
  const filas = (await sql(queryMetricas(desde, dataHasta))).map(aFila);
  console.log(`Filas coche-semana devueltas: ${filas.length}`);
  if (!filas.length) { console.error('Sin datos, no se publica.'); process.exit(1); }

  // Por mes: snapshot si el mes está cerrado y ya existe; si no, calcular
  const RAW = [];
  const ROSTER = {};
  for (const ym of meses) {
    const m = Number(ym.slice(5,7));
    const cerrado = ultimoDomingoDelMes(ym) <= dataHasta;
    const ruta = path.join(SNAP, `${ym}.json`);

    if (cerrado && fs.existsSync(ruta)) {
      const s = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      RAW.push(...s.rows);
      ROSTER[m] = { ids: s.roster.company_ids, at: s.frozen_at.slice(0,10), cerrado: true };
      console.log(`  ${ym} · desde snapshot (${s.rows.length} filas, ${s.roster.company_ids.length} empresas)`);
      continue;
    }

    const delMes = filas.filter(f => f[3] === m && Number(f[2].slice(0,4)) === Number(ym.slice(0,4)));
    RAW.push(...delMes);
    ROSTER[m] = { ids: rosterVivo, at: null, cerrado };

    if (cerrado) {                                  // primera vez que cierra: congelar
      const enAlcance = delMes.filter(f => rosterVivo.includes(f[1]));
      const gmv = enAlcance.reduce((s,f) => s + f[11], 0);
      const snap = {
        month: ym,
        frozen_at: new Date().toISOString(),
        data_through: dataHasta,
        roster: { fleet_owner: CFG.fleet_owner, company_ids: rosterVivo },
        totals: { gmv: +gmv.toFixed(2), rows: enAlcance.length },
        rows: delMes
      };
      fs.mkdirSync(SNAP, { recursive: true });
      fs.writeFileSync(ruta, JSON.stringify(snap, null, 1));
      ROSTER[m].at = snap.frozen_at.slice(0,10);
      ROSTER[m].cerrado = true;
      console.log(`  ${ym} · CONGELADO ahora (${delMes.length} filas)`);
    } else {
      console.log(`  ${ym} · en curso (${delMes.length} filas, se recalcula cada build)`);
    }
  }

  // Cohortes y nombres
  const CAR_COH = {}, CARID = {};
  for (const v of CFG.vehicles) {
    CAR_COH[v.plate] = { c: v.cohort, src: v.cohort_src, det: v.cohort_det };
    CARID[v.plate]   = v.car_ids.join(' + ');
  }
  const CO = {};
  for (const id of new Set(RAW.map(f => f[1]))) CO[id] = CFG.companies[String(id)] || `Company ${id}`;

  // Rellenar el molde
  const molde = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const html = molde
    .replace('__CO__',        JSON.stringify(CO))
    .replace('__CARID__',     JSON.stringify(CARID))
    .replace('__ROSTER__',    JSON.stringify(ROSTER))
    .replace('__CAR_COH__',   JSON.stringify(CAR_COH))
    .replace('__RAW__',       JSON.stringify(RAW))
    .replace('__DATA_HASTA__', dataHasta)
    .replace('__GENERADO__',  `${hoy} ${hora.format(new Date())} ${TZ.split('/')[1]}`)
    .replace('__T2__',        JSON.stringify(TH.t2))
    .replace('__T1__',        JSON.stringify(TH.t1))
    .replace('__AR_MIN__',    String(TH.ar_min))
    .replace('__COHORTE__',   JSON.stringify(CFG.cohorts))
    .replace('__COH_DEF__',   CFG.default_cohort);

  const pendientes = html.match(/__[A-Z_]+__/g);
  if (pendientes) throw new Error('Quedaron huecos sin rellenar: ' + [...new Set(pendientes)].join(', '));

  fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), html);
  // Evita que GitHub Pages pase el HTML por Jekyll, que falla y no aporta nada
  fs.writeFileSync(path.join(__dirname, 'docs', '.nojekyll'), '');
  console.log(`docs/index.html escrito · ${html.length} bytes · ${RAW.length} filas`);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
