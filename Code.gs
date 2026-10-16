/**
 * GESTIONES AAD - Backend (Google Apps Script)
 * ------------------------------------------------
 * Este script convierte tu Google Sheet en una API web que la aplicación
 * (alojada en Vercel) consume para leer y escribir datos.
 *
 * NO REQUIERE variables de entorno ni claves secretas: todo vive acá dentro.
 *
 * INSTALACIÓN (una sola vez):
 *  1. Abrí tu Google Sheet "Gestiones AAD".
 *  2. Menú Extensiones > Apps Script.
 *  3. Borrá el contenido de "Código.gs" y pegá TODO este archivo.
 *  4. Ejecutá una vez la función `setup` (menú "Ejecutar" > elegí "setup").
 *     La primera vez te va a pedir autorización: aceptá los permisos.
 *  5. Menú "Implementar" > "Nueva implementación" > tipo "Aplicación web".
 *     - Ejecutar como: Yo (tu cuenta)
 *     - Quién tiene acceso: Cualquier usuario
 *  6. Copiá la URL que te da ("URL de la aplicación web") y pegala en
 *     config.js del proyecto frontend, en APPS_SCRIPT_URL.
 *
 * Cada vez que modifiques este código, tenés que hacer
 * "Implementar" > "Administrar implementaciones" > lápiz > "Nueva versión".
 */

// ======= CONFIGURACIÓN =======
const SHEET_DATA = 'Gestiones Plan';   // nombre de la hoja con los datos
const SHEET_USERS = 'Usuarios';        // nombre de la hoja con usuarios
const SHEET_CERT = 'Certificaciones';  // nombre de la hoja del módulo de certificaciones
const SHEET_PROY = 'Proyectos';        // nombre de la hoja del módulo de proyectos
const HEADER_ROW = 3;                  // fila donde están los títulos de columna
const FIRST_DATA_ROW = 4;              // primera fila con datos reales
const ID_COLUMN = 37;                  // columna AK: identificador interno único
const LAST_COLUMN = 36;                // columna AJ: última columna de datos (A..AJ)

// Campos numéricos de cada módulo (trámites / certificaciones / proyectos). Se usan para
// convertir explícitamente a Number antes de escribir en la planilla — ver _numOrRaw() más abajo.
const NUMBER_FIELD_KEYS = new Set([
  'anio','plazoEntrega','cantidadesIIBB','presOficialUnitario','presupuestoOficialRubro',
  'adjudicadoUnitario','totalAdjudicado','ampliacionPlazo','cantidadProyectos','kmLineaPC',
  'cantTotalIIBBProyectados','proyectadosAcumulados','pctIIBBProyectados','certificadosAAD',
  'pctAvanceCertificacion','sumatoriaMultas','cantidadCertificadosProcesados',
  'montoCertificado','montoReconocimiento','montoMultas','iibbCertificados',
  'iibbProyecto','montoProyecto',
  // Módulo de Compras v2 (Trámites/Entregas, modelo plano):
  'cantidad','montoUnitOficial','montoSubtotalOficial','cantidadPlanificada',
  'montoUnitAdjudicado','montoSubtotalAdjudicado','monto','plazo','plazoEntrega'
]);

// Campos del trámite que SIEMPRE se calculan solos (nunca los carga el usuario a mano): al crear
// un trámite nuevo (incluido "Clonar trámite", que copia todos los valores del original) hay que
// ignorar cualquier valor que venga en `datos` para estas claves — si no, un trámite nuevo podría
// arrancar con un % de avance o una cantidad de proyectos "heredada" de otro registro o de una
// carga vieja de antes de que existiera el módulo de Proyectos/Certificaciones, y ese valor
// heredado nunca se corrige solo hasta que alguien edite una certificación o proyecto puntual.
const DERIVED_FIELDS = new Set([
  'presupuestoOficialRubro','totalAdjudicado','fechaFinContrato','fechaFinPlazoAmpliada',
  'pctAvanceCertificacion','pctIIBBProyectados','certificadosAAD','sumatoriaMultas',
  'cantidadCertificadosProcesados','cantidadProyectos','cantTotalIIBBProyectados','proyectadosAcumulados'
]);

// Subconjunto de DERIVED_FIELDS que en _crearRegistro se descarta de "datos" porque el propio
// backend lo recalcula después (rollups de Certificaciones/Proyectos, que arrancan en 0 en un
// trámite recién creado — ver _recalcularRollupTramite/_recalcularRollupProyectosTramite).
// Los otros DERIVED_FIELDS (Presupuesto Oficial, Total Adjudicado, Fechas de Fin) los calcula el
// FORMULARIO en el navegador a partir de Cantidad/Unitario/Fecha Inicio Real, y si se descartaran
// acá el trámite quedaría creado con esos campos en blanco hasta la primera edición posterior
// (que sí los guarda, porque _actualizarRegistro no tiene este mismo descarte).
const SERVER_ROLLUP_FIELDS = new Set([
  'pctAvanceCertificacion','pctIIBBProyectados','certificadosAAD','sumatoriaMultas',
  'cantidadCertificadosProcesados','cantidadProyectos','cantTotalIIBBProyectados','proyectadosAcumulados'
]);

/**
 * Convierte a Number un valor numérico ANTES de escribirlo en la planilla con setValue/setValues.
 * Es clave hacerlo así y no dejar pasar el string tal cual: si se guarda un STRING como "784.619"
 * en una celda, Google Sheets lo reinterpreta según el idioma/configuración regional de la planilla
 * (en español/Argentina, el punto es separador de MILES) y lo puede convertir en 784619, borrando
 * el decimal que el usuario realmente quiso cargar. Al mandar un Number real de JavaScript en vez
 * de texto, Sheets lo guarda tal cual, sin adivinar ni reinterpretar nada.
 */
function _numOrRaw(key, valor) {
  if (!NUMBER_FIELD_KEYS.has(key)) return valor;
  if (valor === '' || valor === null || valor === undefined) return valor;
  const n = parseFloat(valor);
  return isNaN(n) ? valor : n;
}

// Mapeo de columnas 1..36 = A..AJ, según tu Excel original + el campo agregado en AJ.
// key = nombre interno usado por el frontend. col = número de columna (1=A).
const FIELDS = [
  { key: 'pospre', col: 1, label: 'Cuenta (Pospre)' },
  { key: 'anio', col: 2, label: 'Año de la Gestión' },
  { key: 'previstoPlan', col: 3, label: 'Previsto en Plan (Si/No)' },
  { key: 'sucursal', col: 4, label: 'Sucursal/Área' },
  { key: 'agenciaSector', col: 5, label: 'Agencia/Sector' },
  { key: 'rubro', col: 6, label: 'Rubro / AjAlz' },
  { key: 'detalleRubro', col: 7, label: 'R Nº / Detalle del Rubro / Ag / Pzo / Nº Cesta / Mov Insp / IIBB' },
  { key: 'expediente', col: 8, label: 'N° Expte. Original / N° de Adjudicación' },
  { key: 'fechaInicioExpte', col: 9, label: 'Fecha Inicio Expte.' },
  { key: 'plazoEntrega', col: 10, label: 'Plazo de Entrega (días corridos)' },
  { key: 'cantidadesIIBB', col: 11, label: 'Cantidades / ítems Base (IIBB)' },
  { key: 'presOficialUnitario', col: 12, label: '$ Unitario Oficial (I.B./Ud.)' },
  { key: 'presupuestoOficialRubro', col: 13, label: '$ Presupuesto Oficial Rubro (sin IVA)' },
  { key: 'movilidadInspeccion', col: 14, label: 'Movilidad p/ inspección (Si/No)' },
  { key: 'fechaPedidoCompras', col: 15, label: 'Fecha de Apertura' },
  { key: 'nroPedidoCompras', col: 16, label: 'Nº Pedido de Compras (SAP)' },
  { key: 'adjudicatario', col: 17, label: 'Adjudicatario / Pre-Adjudicatario' },
  { key: 'adjudicadoUnitario', col: 18, label: '$ Adjudicado Unitario (Cant./IIBB) sin IVA' },
  { key: 'totalAdjudicado', col: 19, label: '$ Total Adjudicado (sin IVA)' },
  { key: 'estado', col: 20, label: 'Estado (Adjudicado/Desierto/Relanzado/Finalizado)' },
  { key: 'fechaActoAdmin', col: 21, label: 'Fecha Acto Admin de Adjudicación' },
  { key: 'fechaInicioReal', col: 22, label: 'Fecha Inicio Real' },
  { key: 'fechaFinContrato', col: 23, label: 'Fecha Fin de Contrato' },
  { key: 'ampliacionPlazo', col: 24, label: 'Ampliación de Plazo (días corridos)' },
  { key: 'fechaFinPlazoAmpliada', col: 25, label: 'Fecha Fin de Plazo Ampliada' },
  { key: 'cantidadProyectos', col: 26, label: 'Cantidad de Proyectos' },
  { key: 'kmLineaPC', col: 27, label: '$ Km de LAMT del Contrato (Obra Menor)' },
  { key: 'mmAAkmLAMT', col: 28, label: 'Mes/Año de Cálculo del Km de LAMT' },
  { key: 'cantTotalIIBBProyectados', col: 29, label: 'Cant. Total de IIBB Proyectados Acumulados' },
  { key: 'proyectadosAcumulados', col: 30, label: '$ Proyectados Acumulados' },
  { key: 'pctIIBBProyectados', col: 31, label: '% de IIBB Proyectados respecto IIBB Gestionados' },
  { key: 'certificadosAAD', col: 32, label: '$ certificados por AAD (sin IVA) del Rubro' },
  { key: 'pctAvanceCertificacion', col: 33, label: '% de Avance por Certificación' },
  { key: 'sumatoriaMultas', col: 34, label: 'Sumatoria de Importes de Multas (sin IVA)' },
  { key: 'observaciones', col: 35, label: 'Observaciones' },
  { key: 'cantidadCertificadosProcesados', col: 36, label: 'Cantidad de Certificados Procesados' },
  // Seguimiento (columna nueva, AM): texto libre para anotar en qué instancia está el trámite
  // dentro de la organización (a qué área/persona se giró, qué falta, etc.). Va en columna 39,
  // NO en 37/38: esas dos ya están ocupadas por columnas técnicas (ID interno y vínculo con
  // Compras) que no forman parte de FIELDS — hay que dejarlas intactas para no romper nada de lo
  // ya cargado. Ver SHEET_TOTAL_COLUMNS más abajo, que agrupa el rango real de lectura/escritura.
  { key: 'seguimiento', col: 39, label: 'Seguimiento' },
  // Estadío Administrativo (columnas 41/42 — NO 40): este par es ESTRUCTURADO — un valor de
  // ESTADIOS_ADMINISTRATIVOS (ver más abajo, junto a STAGES) + la fecha en la que se puso ese
  // valor. La fecha se sugiere sola (ver _aplicarCambioEstadio) pero se puede corregir a mano.
  // Mismo par de campos (mismas claves) en COMPRAS_TRAMITES_FIELDS más abajo, a propósito: es el
  // mismo concepto en los dos módulos, no una reinvención por módulo.
  //
  // *** OJO — LA COLUMNA 40 ESTÁ OCUPADA (COMPRAS_TRAMITE_LINK_COLUMN, más abajo en este archivo,
  // ID técnico de la fila espejo de cada trámite de Compras) Y NO SE DEBE VOLVER A USAR ACÁ. ***
  // Antes esta columna era 40 y colisionaba exactamente con esa columna técnica: cada vez que
  // alguien cambiaba el Estadío Administrativo de una fila espejo (generada automáticamente desde
  // Compras), se pisaba sin darse cuenta el ID de vínculo de esa fila con su trámite de origen —
  // el próximo cambio en ese trámite ya no encontraba la fila espejo original y creaba una fila
  // NUEVA, duplicando el trámite. Antes de agregar una columna nueva en este archivo, correr
  // `_verificarColumnasSinColision()` (ver más abajo) para confirmar que el número elegido no está
  // en uso por ningún otro lado.
  { key: 'estadioActual', col: 41, label: 'Estadío Administrativo Actual' },
  { key: 'estadioDesde', col: 42, label: 'En este Estadío desde' },
  // Marca de AMPLIACIÓN DE CONTRATO (columna 43): queda con el N° del Pedido de Compras del que se
  // amplió ("PC 123") o "Sí" si ese trámite no tenía número. Vacía = trámite original. La carga el
  // frontend al iniciar una gestión por el flujo "Ampliación de contrato" y se muestra como badge
  // en Registros y Dashboard. NO confundir con 'ampliacionPlazo' (col 24), que es otra cosa
  // (ampliación de plazo en días).
  { key: 'ampliacionDe', col: 43, label: 'Ampliación de contrato (origen)' }
];
// Ancho total a leer/escribir de una sola vez en "Gestiones Plan": cubre FIELDS (1-36), la columna
// técnica de ID (37), la de vínculo con Compras — modelo viejo (38), Seguimiento (39), la de
// vínculo con Compras — modelo nuevo (40, ver COMPRAS_TRAMITE_LINK_COLUMN) y el Estadío
// Administrativo (41-42) y la marca de Ampliación de contrato (43). Como FIELDS ya no termina justo en LAST_COLUMN, cualquier lectura/
// escritura masiva de la fila completa tiene que usar este ancho (42), no LAST_COLUMN (36, que
// sigue siendo el límite de los datos "de negocio" originales).
const SHEET_TOTAL_COLUMNS = 43;

/**
 * Verificación de seguridad: confirma que ninguna columna de "Gestiones Plan" esté siendo usada
 * para dos cosas distintas a la vez — el bug que hizo que cambiar el Estadío Administrativo
 * duplicara trámites de Compras (ver el comentario grande junto a FIELDS.estadioActual, arriba):
 * la columna 40 se usó por error para ese campo, pisando en silencio COMPRAS_TRAMITE_LINK_COLUMN
 * (que ya la usaba para identificar la fila espejo de cada trámite de Compras). Esta función corre
 * sola al ejecutar setup(); si alguna vez se agrega una columna nueva en este archivo sin revisar
 * las demás, esto frena con un error claro ANTES de escribir nada, en vez de corromper datos en
 * silencio como pasó acá. Solo mira "Gestiones Plan": las otras hojas (Compras, Certificaciones,
 * Proyectos, etc.) numeran sus propias columnas de forma independiente, sin riesgo de cruzarse
 * con esta.
 */
function _verificarColumnasSinColision() {
  const usos = {}; // número de columna -> lista de qué la está usando
  const marcar = (col, desc) => {
    if (!usos[col]) usos[col] = [];
    usos[col].push(desc);
  };
  FIELDS.forEach(f => marcar(f.col, 'FIELDS.' + f.key));
  marcar(ID_COLUMN, 'ID_COLUMN');
  marcar(COMPRAS_LINK_COLUMN, 'COMPRAS_LINK_COLUMN (vínculo con Compras, modelo viejo)');
  marcar(COMPRAS_TRAMITE_LINK_COLUMN, 'COMPRAS_TRAMITE_LINK_COLUMN (vínculo con Compras, modelo nuevo)');
  const colisiones = Object.keys(usos).filter(col => usos[col].length > 1);
  if (colisiones.length) {
    const detalle = colisiones.map(col => 'columna ' + col + ': ' + usos[col].join(' Y ')).join(' | ');
    throw new Error('COLISIÓN DE COLUMNAS en "Gestiones Plan" — corregir antes de seguir: ' + detalle);
  }
  Logger.log('Verificación de columnas de "Gestiones Plan": sin colisiones. OK.');
}

/**
 * MIGRACIÓN ÚNICA — marca como "Ampliación de contrato" (columna 43) los trámites cargados ANTES de
 * existir esa marca. Criterio: el flujo "Ampliación de contrato" siempre antepone a Observaciones
 * una nota que empieza con "Ampliación de contrato del Pedido de Compras Nº <N>"; si la fila la
 * tiene y la columna 43 está vacía, se completa con "PC <N>" (o "Sí" si no tenía número).
 * No pisa marcas existentes ni toca ninguna otra columna. Es idempotente (se puede correr de nuevo).
 *
 * USO: 1) ejecutar `marcarAmpliacionesExistentes_SIMULACRO` y revisar el Registro de ejecución
 *      (Ver > Registros) para ver QUÉ filas se marcarían; 2) si está bien, ejecutar
 *      `marcarAmpliacionesExistentes`. Las ampliaciones cuya nota se borró a mano de Observaciones
 *      no se pueden detectar: esas se marcan escribiendo "Sí" en la columna 43.
 */
function marcarAmpliacionesExistentes_SIMULACRO() { return _marcarAmpliacionesExistentes(false); }
function marcarAmpliacionesExistentes() { return _marcarAmpliacionesExistentes(true); }

function _marcarAmpliacionesExistentes(aplicar) {
  _verificarColumnasSinColision();
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) { Logger.log('No hay trámites.'); return 0; }
  const colObs = _colDeCampo(FIELDS, 'observaciones');
  const colAmp = _colDeCampo(FIELDS, 'ampliacionDe');
  const colExp = _colDeCampo(FIELDS, 'expediente');
  const n = lastRow - FIRST_DATA_ROW + 1;
  const obs = sh.getRange(FIRST_DATA_ROW, colObs, n, 1).getValues();
  const amp = sh.getRange(FIRST_DATA_ROW, colAmp, n, 1).getValues();
  const exp = sh.getRange(FIRST_DATA_ROW, colExp, n, 1).getValues();
  const re = /^\s*Ampliaci[oó]n de contrato del Pedido de Compras N[º°o]?\s*(.*?)\s*[—–-]\s*se solicita/i;
  let marcadas = 0;
  for (let i = 0; i < n; i++) {
    if (amp[i][0] !== '' && amp[i][0] !== null) continue; // ya tiene marca
    const m = re.exec(String(obs[i][0] || ''));
    if (!m) continue;
    const nro = (m[1] || '').replace(/^\(sin número\)$/i, '').trim();
    const valor = nro ? 'PC ' + nro : 'Sí';
    Logger.log((aplicar ? 'MARCA' : 'MARCARÍA') + ' fila ' + (FIRST_DATA_ROW + i) + ' (expediente ' + exp[i][0] + ') -> ' + valor);
    if (aplicar) sh.getRange(FIRST_DATA_ROW + i, colAmp).setValue(valor);
    marcadas++;
  }
  Logger.log((aplicar ? 'Filas marcadas: ' : 'Filas que se marcarían: ') + marcadas);
  return marcadas;
}

// Etapas de la "vida del trámite"
const STAGES = [
  { id: 'lanzamiento', label: 'Lanzamiento del Trámite', ranges: [[1, 13]] },
  // 39-42 (Seguimiento + Estadío Administrativo) quedan en Adjudicación junto al resto de esa
  // etapa, no en un lugar aparte: es donde ya vivía "Seguimiento" antes de este cambio.
  { id: 'adjudicacion', label: 'Adjudicación', ranges: [[14, 20], [39, 43]] },
  { id: 'proyectos', label: 'Proyectos (solo Obra Menor)', ranges: [[26, 31]] },
  { id: 'certificacion', label: 'Certificación', ranges: [[21, 25], [32, 36]] }
];

// Estadío Administrativo — mismo concepto (y misma lista) para Contrataciones (FIELDS, arriba) y
// para Compras (COMPRAS_TRAMITES_FIELDS, más abajo). NO es una lista cerrada: el frontend la trata
// como un desplegable DINÁMICO (mismo mecanismo que ya usa para Pospre/Sucursal — ver
// DYNAMIC_SELECT_FIELDS en app.js), que se arma con lo que YA se usó en cualquiera de los dos
// módulos + esta semilla, y siempre deja la opción "+ Otra (nueva)" para escribir un estadío que
// todavía no existe. Por eso arranca vacía: no tiene sentido que el sistema le proponga a la
// empresa una lista de estadíos inventada por quien escribió este código — se va a ir completando
// sola con lo que cada usuario tipee la primera vez que use cada estadío real (Legales, Directorio,
// el área que corresponda, etc.). Si preferís precargar algunos de entrada para no arrancar de
// cero, agregalos como strings acá (ej.: 'Legales', 'Directorio', 'Con el proveedor').
const ESTADIOS_ADMINISTRATIVOS = [];

/**
 * Si "datos.estadioActual" viene presente y es distinto del valor previo (estadioActualPrevio:
 * '' en un trámite/registro nuevo), se necesita una fecha en "datos.estadioDesde". Si quien llama
 * ya mandó una (por ejemplo, alguien cargando con demora, que sabe que el trámite ya lleva unos
 * días en ese estadío), se respeta esa fecha tal cual — NUNCA se pisa una fecha que ya vino. Si no
 * vino ninguna, se completa sola con la de hoy. Es la ÚNICA función que aplica esta regla — la usan
 * tanto _crearRegistro/_actualizarRegistro (Contrataciones) como _crearComprasTramite/
 * _actualizarComprasTramite (Compras), para no terminar con dos implementaciones que se puedan
 * desalinear con el tiempo.
 */
function _aplicarCambioEstadio(datos, estadioActualPrevio) {
  if (datos && Object.prototype.hasOwnProperty.call(datos, 'estadioActual')
      && String(datos.estadioActual || '') !== String(estadioActualPrevio || '')
      && !datos.estadioDesde) {
    datos.estadioDesde = _hoyStr();
  }
  return datos;
}

/** Busca en una lista de campos (FIELDS o COMPRAS_TRAMITES_FIELDS) la columna de una clave dada. */
function _colDeCampo(fields, key) {
  const f = fields.find(x => x.key === key);
  return f ? f.col : -1;
}

// ======= MÓDULO DE CERTIFICACIONES (hoja aparte, relacionada por ID_Interno del trámite) =======
// Columnas dentro de la hoja "Certificaciones" (numeración propia, 1 = A):
//  1: ID_Certificacion (interno, oculto) | 2: ID_Tramite (vínculo con Gestiones Plan)
const CERT_ID_COLUMN = 1;
const CERT_TRAMITE_ID_COLUMN = 2;
const CERT_FIRST_DATA_ROW = 2;
const CERT_LAST_COLUMN = 16;
const CERT_FIELDS = [
  { key: 'pospre', col: 3, label: 'Pospre' },
  { key: 'expediente', col: 4, label: 'Expediente' },
  { key: 'nroPedidoCompras', col: 5, label: 'Pedido de Compras' },
  { key: 'contratista', col: 6, label: 'Contratista' },
  { key: 'fechaInicioContrato', col: 7, label: 'Fecha de Inicio de Contrato' },
  { key: 'expedienteCertificacion', col: 16, label: 'Expediente de Certificación' },
  { key: 'numeroCertificado', col: 8, label: 'Número de Certificado' },
  { key: 'mesAnioCertificacion', col: 9, label: 'Mes/Año de Certificación' },
  { key: 'iibbCertificados', col: 10, label: 'IIBB Certificados' },
  { key: 'montoCertificado', col: 11, label: '$ Certificados' },
  { key: 'montoReconocimiento', col: 12, label: '$ de Reconocimiento' },
  { key: 'montoMultas', col: 13, label: '$ Multas' },
  { key: 'pctAvance', col: 14, label: '% del Adjudicado que representa este Certificado' },
  { key: 'observaciones', col: 15, label: 'Observaciones' }
];

// Columnas dentro de la hoja "Proyectos" (numeración propia, 1 = A):
//  1: ID_Proyecto (interno, oculto) | 2: ID_Tramite (vínculo con Gestiones Plan)
const PROY_ID_COLUMN = 1;
const PROY_TRAMITE_ID_COLUMN = 2;
const PROY_FIRST_DATA_ROW = 2;
const PROY_LAST_COLUMN = 15;
const PROY_FIELDS = [
  { key: 'pospre', col: 3, label: 'Pospre' },
  { key: 'sucursal', col: 4, label: 'Sucursal' },
  { key: 'nroPedidoCompras', col: 5, label: 'Pedido de Compras' },
  { key: 'contratista', col: 6, label: 'Contratista' },
  { key: 'nroExpedienteProyecto', col: 7, label: 'N° de Expediente de Proyecto' },
  { key: 'numeroProyecto', col: 8, label: 'Número de Proyecto' },
  { key: 'montoKmLAMT', col: 9, label: '$ Km de LAMT' },
  { key: 'mesAnioKmLAMT', col: 10, label: 'Mes/Año Km de LAMT' },
  { key: 'descripcionProyecto', col: 11, label: 'Descripción del Proyecto' },
  { key: 'iibbProyecto', col: 12, label: 'IIBB del Proyecto' },
  { key: 'montoProyecto', col: 13, label: '$ del Proyecto' },
  { key: 'pctIIBBProyecto', col: 14, label: '% IIBB Proyectados de los IIBB del PC' },
  { key: 'observaciones', col: 15, label: 'Observaciones' }
];

// ======= UTILIDADES =======
function _ss() {
  return SpreadsheetApp.getActiveSpreadsheet();
}
function _sheetData() {
  return _ss().getSheetByName(SHEET_DATA);
}
function _sheetUsers() {
  return _ss().getSheetByName(SHEET_USERS);
}
function _sheetCert() {
  return _ss().getSheetByName(SHEET_CERT);
}
function _sheetProy() {
  return _ss().getSheetByName(SHEET_PROY);
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _hash(text) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

/** Crea la hoja de Usuarios si no existe, y asigna ID interno a filas viejas. */
function setup() {
  _verificarColumnasSinColision(); // frena acá si alguna columna de "Gestiones Plan" quedó pisada
  const ss = _ss();
  let users = ss.getSheetByName(SHEET_USERS);
  if (!users) {
    users = ss.insertSheet(SHEET_USERS);
    users.getRange(1, 1, 1, 5).setValues([['Usuario', 'ClaveHash', 'Nombre', 'Rol', 'Sucursales Restringidas (opcional, separadas por coma)']]);
    users.getRange(2, 1, 1, 5).setValues([
      ['admin', _hash('admin123'), 'Administrador', 'admin', '']
    ]);
    users.getRange(1, 1, 1, 5).setFontWeight('bold');
  } else {
    // Sheet ya existente: (re)pone el título de la columna E, tanto si nunca existió como si
    // quedó con el nombre viejo ("Sucursal Restringida", singular, de una versión anterior de la
    // app) — no toca ningún usuario ya cargado, solo el texto del encabezado.
    users.getRange(1, 5).setValue('Sucursales Restringidas (opcional, separadas por coma)');
    users.getRange(1, 5).setFontWeight('bold');
  }

  const data = _sheetData();
  if (!data) {
    throw new Error('No se encontró la hoja "' + SHEET_DATA + '". Revisá el nombre exacto de la pestaña.');
  }
  // Encabezado de la columna ID interno
  if (data.getRange(HEADER_ROW, ID_COLUMN).getValue() === '') {
    data.getRange(HEADER_ROW, ID_COLUMN).setValue('ID_Interno');
  }
  // Encabezados de Estadío Administrativo (columnas nuevas 40/41) — mismo criterio que ID_Interno:
  // solo se completan si están vacíos, para no pisar nada que ya tengas tipeado ahí.
  FIELDS.filter(f => f.key === 'estadioActual' || f.key === 'estadioDesde' || f.key === 'ampliacionDe').forEach(f => {
    if (data.getRange(HEADER_ROW, f.col).getValue() === '') {
      data.getRange(HEADER_ROW, f.col).setValue(f.label);
    }
  });
  const lastRow = data.getLastRow();
  if (lastRow >= FIRST_DATA_ROW) {
    const n = lastRow - FIRST_DATA_ROW + 1;
    const ids = data.getRange(FIRST_DATA_ROW, ID_COLUMN, n, 1).getValues();
    for (let i = 0; i < n; i++) {
      if (!ids[i][0]) {
        ids[i][0] = Utilities.getUuid();
      }
    }
    data.getRange(FIRST_DATA_ROW, ID_COLUMN, n, 1).setValues(ids);
  }

  // Crea la hoja "Certificaciones" si no existe
  let cert = ss.getSheetByName(SHEET_CERT);
  if (!cert) {
    cert = ss.insertSheet(SHEET_CERT);
    const headers = ['ID_Certificacion', 'ID_Tramite'].concat(CERT_FIELDS.map(f => f.label));
    cert.getRange(1, 1, 1, headers.length).setValues([headers]);
    cert.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else if (cert.getLastColumn() < CERT_LAST_COLUMN) {
    // La hoja ya existía de antes (sin la columna "Expediente de Certificación"): se agrega
    // el encabezado en la columna 16, sin tocar ninguna columna ni fila existente.
    const campo = CERT_FIELDS.find(f => f.col === CERT_LAST_COLUMN);
    cert.getRange(1, CERT_LAST_COLUMN).setValue(campo.label);
    cert.getRange(1, CERT_LAST_COLUMN).setFontWeight('bold');
  }

  // Crea la hoja "Proyectos" si no existe
  let proy = ss.getSheetByName(SHEET_PROY);
  if (!proy) {
    proy = ss.insertSheet(SHEET_PROY);
    const headersProy = ['ID_Proyecto', 'ID_Tramite'].concat(PROY_FIELDS.map(f => f.label));
    proy.getRange(1, 1, 1, headersProy.length).setValues([headersProy]);
    proy.getRange(1, 1, 1, headersProy.length).setFontWeight('bold');
  }

  // Crea las 3 hojas del módulo de Compras (modelo viejo, árbol) si no existen.
  _setupCompras();
  // Crea las 2 hojas del módulo de Compras v2 (Trámites/Entregas, modelo plano) si no existen.
  // Conviven en paralelo con las de arriba — ver el comentario grande antes de SHEET_COMPRAS_TRAMITES.
  _setupComprasTramites();

  // Crea "Historial KPIs" (snapshots fechados) si no existe.
  _setupHistorialKPIs();

  return 'Setup OK. Usuario admin creado con clave admin123 (cambiala apenas puedas).';
}

/** Verifica usuario y clave contra la hoja Usuarios. Devuelve fila de datos o null. */
function _authenticate(usuario, clave) {
  const sh = _sheetUsers();
  if (!sh) return null;
  const values = sh.getDataRange().getValues();
  const hash = _hash(clave || '');
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[0]).trim().toLowerCase() === String(usuario || '').trim().toLowerCase()
        && String(row[1]) === hash) {
      return { usuario: row[0], nombre: row[2], rol: row[3] || 'editor', sucursalesRestringidas: _parseSucursalesRestringidas(row[4]) };
    }
  }
  return null;
}

/** La columna E de Usuarios guarda las sucursales separadas por coma (o vacía = sin restricción,
 *  ve todas). Devuelve siempre un array (posiblemente vacío). */
function _parseSucursalesRestringidas(celda) {
  return String(celda || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Trámites de "Gestiones Plan" que este usuario puede ver: todos, salvo que tenga una o más
 *  Sucursales Restringidas asignadas, en cuyo caso solo ve los de esas sucursales (comparación
 *  exacta de texto, igual que aparece en el campo Sucursal/Área del trámite). */
function _registrosVisiblesParaUsuario(user) {
  const registros = _listarRegistros();
  if (!user || !user.sucursalesRestringidas || !user.sucursalesRestringidas.length) return registros;
  const set = new Set(user.sucursalesRestringidas);
  return registros.filter(r => set.has(String(r.sucursal || '').trim()));
}

// ======= ENDPOINTS =======
function doGet(e) {
  if (e && e.parameter && e.parameter.diagnostico) {
    return _json(_diagnostico());
  }
  return _json({ ok: true, mensaje: 'API Gestiones AAD activa. Usá POST.' });
}

function _diagnostico() {
  try {
    const ss = _ss();
    const data = _sheetData();
    const info = {
      ok: true,
      VERSION_DE_CODIGO: 'v2026-09-08-cero-recalcula-y-leyenda', // <- cambia cada vez que se publica una actualización; compará este valor con lo que Claude te diga que espera
      accionesDisponibles: ['listar','crear','actualizar','eliminar','usuarios_listar','usuarios_crear','recalcular_todos','completar_valores_iniciales','corregir_iva','unificar_valores','certificaciones_listar','certificaciones_crear','certificaciones_actualizar','certificaciones_eliminar','proyectos_listar','proyectos_crear','proyectos_actualizar','proyectos_eliminar','compras_listar','compras_exp_crear','compras_exp_actualizar','compras_exp_eliminar','compras_pc_crear','compras_pc_actualizar','compras_pc_eliminar','compras_pos_crear','compras_pos_actualizar','compras_pos_eliminar','compras_importar','compras_tramites_listar','compras_tramite_crear','compras_tramite_actualizar','compras_tramite_eliminar','compras_tramite_clonar','compras_entrega_crear','compras_entrega_actualizar','compras_entrega_eliminar','compras_migrar_a_tramites','historial_kpis_listar','historial_kpis_guardar'],
      pestaniasEsperadas: [SHEET_DATA, SHEET_USERS, SHEET_CERT, SHEET_PROY, SHEET_COMPRAS_EXP, SHEET_COMPRAS_PC, SHEET_COMPRAS_POS, SHEET_COMPRAS_TRAMITES, SHEET_COMPRAS_ENTREGAS, SHEET_HISTORIAL],
      spreadsheetName: ss.getName(),
      spreadsheetUrl: ss.getUrl(),
      todasLasPestanias: ss.getSheets().map(s => s.getName()),
      pestaniaBuscada: SHEET_DATA,
      pestaniaEncontrada: !!data
    };
    if (data) {
      info.ultimaFilaConDatos = data.getLastRow();
      info.ultimaColumnaConDatos = data.getLastColumn();
      info.filaDeEncabezados = HEADER_ROW;
      info.primeraFilaDeDatosEsperada = FIRST_DATA_ROW;
      info.muestraFila4 = data.getRange(FIRST_DATA_ROW, 1, 1, 10).getValues()[0];
    }
    // Diagnóstico específico de Compras: detecta posiciones con fechas que NO tienen formato
    // válido (típicamente, filas cargadas antes de un cambio de columnas, que quedaron
    // desalineadas). Lee las celdas CRUDAS (sin el blindaje que ya aplica la app al mostrarlas),
    // así se ve exactamente qué quedó mal cargado. Si esta lista no está vacía, conviene editar
    // y volver a guardar esas posiciones desde la app para que se reordenen bien.
    try {
      const shPos = _sheetComprasPos();
      const posConProblemas = [];
      if (shPos) {
        const lastRow = shPos.getLastRow();
        if (lastRow >= COMPRAS_POS_FIRST_ROW) {
          const n = lastRow - COMPRAS_POS_FIRST_ROW + 1;
          const valores = shPos.getRange(COMPRAS_POS_FIRST_ROW, 1, n, COMPRAS_POS_LAST_COL).getValues();
          const colPosicion = COMPRAS_POS_FIELDS.find(f => f.key === 'posicion').col;
          ['fechaContratoFija','fechaContratoPlanificada','fechaContratoAmpliacion'].forEach(key => {
            const campo = COMPRAS_POS_FIELDS.find(f => f.key === key);
            valores.forEach((fila, i) => {
              if (!fila[0]) return; // fila vacía
              const crudo = fila[campo.col - 1];
              const esValida = !crudo || crudo instanceof Date || /^\d{4}-\d{2}-\d{2}/.test(String(crudo));
              if (crudo && !esValida) {
                posConProblemas.push({
                  fila: COMPRAS_POS_FIRST_ROW + i, posicion: fila[colPosicion - 1],
                  campo: campo.label, valorEncontrado: crudo
                });
              }
            });
          });
        }
      }
      info.comprasPosicionesConFechaInvalida = posConProblemas;
    } catch (errCompras) {
      info.comprasDiagnosticoError = errCompras.message;
    }
    return info;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;

    if (action === 'login') {
      const user = _authenticate(body.usuario, body.clave);
      if (!user) return _json({ ok: false, error: 'Usuario o clave incorrectos.' });
      return _json({ ok: true, user: user });
    }

    // Todas las demás acciones requieren credenciales válidas
    const user = _authenticate(body.usuario, body.clave);
    if (!user) return _json({ ok: false, error: 'Sesión inválida. Volvé a iniciar sesión.' });

    switch (action) {
      case 'listar':
        return _json({ ok: true, campos: FIELDS, etapas: STAGES, estadiosAdministrativos: ESTADIOS_ADMINISTRATIVOS, registros: _registrosVisiblesParaUsuario(user) });
      case 'crear':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede cargar trámites.' });
        return _json({ ok: true, id: _crearRegistro(body.datos, user) });
      case 'actualizar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede editar trámites.' });
        _actualizarRegistro(body.id, body.datos, user);
        return _json({ ok: true });
      case 'eliminar':
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede eliminar.' });
        _eliminarRegistro(body.id);
        return _json({ ok: true });
      case 'usuarios_listar':
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede ver usuarios.' });
        return _json({ ok: true, usuarios: _listarUsuarios() });
      case 'usuarios_crear':
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede crear usuarios.' });
        _crearUsuario(body.usuario_nuevo, body.clave_nueva, body.nombre_nuevo, body.rol_nuevo, body.sucursales_restringidas_nuevas);
        return _json({ ok: true });
      case 'recalcular_todos':
      case 'completar_valores_iniciales':
      case 'corregir_iva':
        // Deshabilitado a pedido del usuario: estas operaciones masivas ya no están
        // disponibles desde la app, se hicieron una sola vez sobre la base original.
        return _json({ ok: false, error: 'Esta función fue deshabilitada.' });
      case 'unificar_valores':
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede unificar valores.' });
        return _json({ ok: true, actualizados: _unificarValores(body.campo, body.valoresViejos, body.valorNuevo) });
      case 'certificaciones_listar': {
        let certs = _listarCertificaciones(body.idTramite);
        if (user.sucursalesRestringidas && user.sucursalesRestringidas.length) {
          const idsPermitidos = new Set(_registrosVisiblesParaUsuario(user).map(r => r._id));
          certs = certs.filter(c => idsPermitidos.has(c.idTramite));
        }
        return _json({ ok: true, campos: CERT_FIELDS, certificaciones: certs });
      }
      case 'certificaciones_crear':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede cargar certificaciones.' });
        return _json({ ok: true, id: _crearCertificacion(body.datos) });
      case 'certificaciones_actualizar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede editar certificaciones.' });
        _actualizarCertificacion(body.id, body.datos);
        return _json({ ok: true });
      case 'certificaciones_eliminar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede eliminar certificaciones.' });
        _eliminarCertificacion(body.id);
        return _json({ ok: true });
      case 'proyectos_listar': {
        let proys = _listarProyectos(body.idTramite);
        if (user.sucursalesRestringidas && user.sucursalesRestringidas.length) {
          const idsPermitidosProy = new Set(_registrosVisiblesParaUsuario(user).map(r => r._id));
          proys = proys.filter(p => idsPermitidosProy.has(p.idTramite));
        }
        return _json({ ok: true, campos: PROY_FIELDS, proyectos: proys });
      }
      case 'proyectos_crear':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede cargar proyectos.' });
        return _json({ ok: true, id: _crearProyecto(body.datos) });
      case 'proyectos_actualizar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede editar proyectos.' });
        _actualizarProyecto(body.id, body.datos);
        return _json({ ok: true });
      case 'proyectos_eliminar':
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede eliminar proyectos.' });
        _eliminarProyecto(body.id);
        return _json({ ok: true });

      // ---- MÓDULO DE COMPRAS ----
      case 'compras_listar':
        return _json({ ok: true, camposExp: COMPRAS_EXP_FIELDS, camposPC: COMPRAS_PC_FIELDS, camposPos: COMPRAS_POS_FIELDS, expedientes: _listarCompras() });
      case 'compras_exp_crear':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede cargar compras.' });
        return _json({ ok: true, id: _crearComprasExpediente(body.datos) });
      case 'compras_exp_actualizar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede editar compras.' });
        _actualizarComprasExpediente(body.id, body.datos);
        return _json({ ok: true });
      case 'compras_exp_eliminar':
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede eliminar un expediente de compras.' });
        _eliminarComprasExpediente(body.id);
        return _json({ ok: true });
      case 'compras_pc_crear':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede cargar pedidos de compra.' });
        return _json({ ok: true, id: _crearComprasPC(body.datos) });
      case 'compras_pc_actualizar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede editar pedidos de compra.' });
        _actualizarComprasPC(body.id, body.datos);
        return _json({ ok: true });
      case 'compras_pc_eliminar':
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede eliminar un pedido de compra.' });
        _eliminarComprasPC(body.id, false);
        return _json({ ok: true });
      case 'compras_pos_crear':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede cargar posiciones.' });
        return _json({ ok: true, id: _crearComprasPos(body.datos) });
      case 'compras_pos_actualizar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede editar posiciones.' });
        _actualizarComprasPos(body.id, body.datos);
        return _json({ ok: true });
      case 'compras_pos_eliminar':
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede eliminar una posición.' });
        _eliminarComprasPos(body.id);
        return _json({ ok: true });
      case 'compras_importar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede importar compras.' });
        return _json({ ok: true, resultado: _comprasImportar(body.expedientes) });

      // ---- MÓDULO DE COMPRAS v2 (Trámites/Entregas, modelo plano) ----
      case 'compras_tramites_listar':
        return _json({
          ok: true,
          camposTramite: COMPRAS_TRAMITES_FIELDS,
          camposEntrega: COMPRAS_ENTREGAS_FIELDS,
          estados: COMPRAS_TRAMITES_ESTADOS,
          estadiosAdministrativos: ESTADIOS_ADMINISTRATIVOS,
          tiposEntrega: COMPRAS_ENTREGAS_TIPOS,
          pctMaximoAmpliacion: COMPRAS_AMPLIACION_PCT_MAXIMO,
          tramites: _listarComprasTramitesConSaldos()
        });
      case 'compras_tramite_crear':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede cargar trámites de compras.' });
        return _json({ ok: true, id: _crearComprasTramite(body.datos) });
      case 'compras_tramite_actualizar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede editar trámites de compras.' });
        _actualizarComprasTramite(body.id, body.datos);
        return _json({ ok: true });
      case 'compras_tramite_eliminar':
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede eliminar un trámite de compras.' });
        _eliminarComprasTramite(body.id);
        return _json({ ok: true });
      case 'compras_tramite_clonar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede clonar trámites de compras.' });
        return _json({ ok: true, id: _clonarComprasTramite(body.id) });
      case 'compras_entrega_crear':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede cargar entregas.' });
        return _json({ ok: true, id: _crearComprasEntrega(body.datos) });
      case 'compras_entrega_actualizar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede editar entregas.' });
        _actualizarComprasEntrega(body.id, body.datos);
        return _json({ ok: true });
      case 'compras_entrega_eliminar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede eliminar entregas.' });
        _eliminarComprasEntrega(body.id);
        return _json({ ok: true });
      case 'compras_migrar_a_tramites':
        // Migración manual, aditiva, corrible varias veces sin duplicar — ver el comentario grande
        // arriba de _migrarComprasATramites. Solo un administrador puede dispararla.
        if (user.rol !== 'admin') return _json({ ok: false, error: 'Solo un administrador puede correr la migración de Compras.' });
        return _json({ ok: true, resultado: _migrarComprasATramites() });

      // ---- HISTORIAL DE KPIs (snapshots fechados para comparar "esto cambió desde el último corte") ----
      case 'historial_kpis_listar':
        return _json({ ok: true, historial: _listarHistorialKPIs() });
      case 'historial_kpis_guardar':
        if (user.rol === 'consulta') return _json({ ok: false, error: 'Tu usuario es de solo consulta y no puede guardar snapshots.' });
        return _json({ ok: true, fecha: _guardarSnapshotHistorial(body.datos) });

      default:
        return _json({ ok: false, error: 'Acción desconocida: ' + action });
    }
  } catch (err) {
    return _json({ ok: false, error: 'Error del servidor: ' + err.message });
  }
}

// Campos que son "Mes/Año" (input type="month"): si Google Sheets los guardó como fecha completa
// (pasa seguido, según el formato de la celda), hay que devolverlos truncados a "yyyy-MM" — si no,
// el navegador rechaza el valor del input type="month" y lo deja vacío al editar.
const MONTH_KEYS = new Set(['mesAnioCertificacion', 'mmAAkmLAMT']);

/**
 * Interpreta una fecha venga como venga: un objeto Date real de Sheets, o texto en alguno de los
 * formatos típicos del Excel original migrado (ISO "2017-09-28", ISO con hora "2017-09-28T07:00:00.000Z",
 * o día/mes/año "28/09/2017" — la convención argentina, que el parser nativo de JavaScript NO entiende
 * bien: por defecto asume mes/día/año y falla o interpreta mal cualquier fecha con día > 12).
 * Devuelve un objeto Date válido, o null si el texto no matchea ningún formato conocido (para no
 * arriesgar una interpretación incorrecta con datos que no sean realmente una fecha).
 */
function _parsearFechaFlexible(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;

  // ISO "yyyy-MM-dd" (con o sin hora al final): año-mes-día no es ambiguo, se puede tomar tal cual.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/AAAA o DD-MM-AAAA (convención argentina: día primero) — formato típico del Excel original.
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const d = new Date(yyyy, mm - 1, dd);
      return isNaN(d.getTime()) ? null : d;
    }
  }

  return null;
}

function _formatDateField(key, v) {
  const d = _parsearFechaFlexible(v);
  if (!d) return v; // no se pudo interpretar como fecha: se devuelve tal cual, sin romper nada
  return Utilities.formatDate(d, Session.getScriptTimeZone(), MONTH_KEYS.has(key) ? 'yyyy-MM' : 'yyyy-MM-dd');
}

function _rowToRecord(rowValues, rowIndex) {
  const rec = { _row: rowIndex, _id: rowValues[ID_COLUMN - 1] };
  FIELDS.forEach(f => {
    rec[f.key] = _formatDateField(f.key, rowValues[f.col - 1]);
  });
  return rec;
}

function _listarRegistros() {
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return [];
  const n = lastRow - FIRST_DATA_ROW + 1;
  const values = sh.getRange(FIRST_DATA_ROW, 1, n, SHEET_TOTAL_COLUMNS).getValues();
  // Columnas técnicas de vínculo con Compras (38 = modelo viejo por Expediente, 40 = modelo nuevo
  // por Trámite) — se leen aparte, sin ensanchar SHEET_TOTAL_COLUMNS (que también se usa para
  // escribir filas enteras en _crearRegistro/_actualizarRegistro; más vale no tocarlo). Sirven para
  // que Registros sepa, al hacer click en una fila, si viene de Compras y hacia dónde llevar al
  // usuario (ver _comprasLinkColumns más abajo y su uso en el frontend).
  const linkViejo = sh.getRange(FIRST_DATA_ROW, COMPRAS_LINK_COLUMN, n, 1).getValues();
  const linkNuevo = sh.getRange(FIRST_DATA_ROW, COMPRAS_TRAMITE_LINK_COLUMN, n, 1).getValues();
  const out = [];
  for (let i = 0; i < n; i++) {
    // Saltear filas totalmente vacías
    const row = values[i];
    const hasData = row.slice(0, LAST_COLUMN).some(v => v !== '' && v !== null);
    if (!hasData) continue;
    const rec = _rowToRecord(row, FIRST_DATA_ROW + i);
    if (linkViejo[i][0]) rec._comprasExpedienteId = linkViejo[i][0];
    if (linkNuevo[i][0]) rec._comprasTramiteId = linkNuevo[i][0];
    out.push(rec);
  }
  return out;
}

function _findRowById(id) {
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return -1;
  const n = lastRow - FIRST_DATA_ROW + 1;
  const ids = sh.getRange(FIRST_DATA_ROW, ID_COLUMN, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    if (ids[i][0] === id) return FIRST_DATA_ROW + i;
  }
  return -1;
}

function _crearRegistro(datos, user) {
  const sh = _sheetData();
  const newRow = sh.getLastRow() + 1;
  const id = Utilities.getUuid();
  // Trámite nuevo: si ya viene con un Estadío Administrativo elegido, se completa su fecha (hoy,
  // salvo que ya haya venido una propia — ver _aplicarCambioEstadio).
  _aplicarCambioEstadio(datos, '');
  // Ancho completo (41): incluye Seguimiento (col 39) y Estadío Administrativo (40-41). La columna
  // técnica de vínculo con Compras (38) queda en blanco a propósito: este es un trámite normal,
  // no generado desde Compras.
  const rowValues = new Array(SHEET_TOTAL_COLUMNS).fill('');
  FIELDS.forEach(f => {
    if (SERVER_ROLLUP_FIELDS.has(f.key)) return; // estos sí los calcula el backend, más abajo (0 al crear)
    if (datos && Object.prototype.hasOwnProperty.call(datos, f.key)) {
      rowValues[f.col - 1] = _numOrRaw(f.key, datos[f.key]);
    }
  });
  rowValues[ID_COLUMN - 1] = id;
  sh.getRange(newRow, 1, 1, SHEET_TOTAL_COLUMNS).setValues([rowValues]);

  // Recalculamos de una los acumulados de Certificaciones y Proyectos para este trámite recién
  // creado: normalmente da todo en 0 (todavía no tiene certificaciones/proyectos propios), pero
  // así queda garantizado que NUNCA arranca con un valor heredado de otro lado.
  _recalcularRollupTramite(id);
  _recalcularRollupProyectosTramite(id);
  return id;
}

function _actualizarRegistro(id, datos, user) {
  const row = _findRowById(id);
  if (row === -1) throw new Error('Registro no encontrado.');
  const sh = _sheetData();
  // Ancho completo (41): sin esto, "actuales" no llegaría hasta Estadío Administrativo (col 41) y
  // el chequeo de "sin cambios" de más abajo lo compararía siempre contra undefined.
  const actuales = sh.getRange(row, 1, 1, SHEET_TOTAL_COLUMNS).getValues()[0];
  // Si cambió el Estadío Administrativo respecto del que ya estaba guardado, se completa su fecha
  // (hoy, salvo que ya haya venido una propia) — ver _aplicarCambioEstadio(). Va ANTES del forEach
  // de abajo para que el nuevo valor de "estadioDesde" se escriba en el mismo pase, como cualquier
  // otro campo.
  const colEstadioActual = _colDeCampo(FIELDS, 'estadioActual');
  _aplicarCambioEstadio(datos, colEstadioActual > 0 ? actuales[colEstadioActual - 1] : '');

  FIELDS.forEach(f => {
    if (!datos || !Object.prototype.hasOwnProperty.call(datos, f.key)) return;
    const nuevo = datos[f.key];
    let actual = actuales[f.col - 1];
    if (actual instanceof Date) {
      actual = Utilities.formatDate(actual, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    const nuevoStr = (nuevo === null || nuevo === undefined) ? '' : String(nuevo);
    const actualStr = (actual === null || actual === undefined) ? '' : String(actual);
    if (nuevoStr === actualStr) return; // sin cambios: no se toca esa celda (evita validaciones innecesarias y llamadas de más)

    try {
      sh.getRange(row, f.col).setValue(_numOrRaw(f.key, nuevo));
    } catch (err) {
      throw new Error('No se pudo guardar el campo "' + f.label + '": ' + err.message);
    }
  });

  // El $ Total Adjudicado y las Cantidades/IIBB del trámite pueden haber cambiado con esta edición
  // (por ejemplo, al corregir el $ Unitario Oficial). Volvemos a calcular el "% del Adjudicado" de
  // cada Certificación y el "% IIBB Proyectados" de cada Proyecto ya cargados para este trámite,
  // para que dejen de mostrar 0%/valores viejos por quedarse desactualizados.
  _recalcularRollupTramite(id);
  _recalcularRollupProyectosTramite(id);
}

function _eliminarRegistro(id) {
  const row = _findRowById(id);
  if (row === -1) throw new Error('Registro no encontrado.');
  _sheetData().deleteRow(row);
}

function _listarUsuarios() {
  const sh = _sheetUsers();
  const values = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    out.push({ usuario: values[i][0], nombre: values[i][2], rol: values[i][3], sucursalesRestringidas: _parseSucursalesRestringidas(values[i][4]) });
  }
  return out;
}

function _crearUsuario(usuario, clave, nombre, rol, sucursalesRestringidas) {
  if (!usuario || !clave) throw new Error('Usuario y clave son obligatorios.');
  const sh = _sheetUsers();
  // sucursalesRestringidas puede llegar como array (desde el frontend) o como string ya armado.
  const celda = Array.isArray(sucursalesRestringidas) ? sucursalesRestringidas.filter(Boolean).join(', ') : (sucursalesRestringidas || '');
  sh.appendRow([usuario, _hash(clave), nombre || usuario, rol || 'editor', celda]);
}

/**
 * CORRECCIÓN DE IVA — operación de una sola vez.
 * Divide por 1,21 los 6 campos monetarios "base" (los que no son calculados a partir de otros):
 *  - $ Pres. Oficial Unitario, $ Adjudicado Unitario, $ Km de Línea del PC,
 *    $ Proyectados Acumulados, $ certificados por AAD, Sumatoria de Multas.
 * Y en el mismo paso recalcula, con esos valores YA corregidos:
 *  - $ Presupuesto Oficial Rubro = Cantidad * Pres. Oficial Unitario (corregido)
 *  - $ Total Adjudicado = Cantidad * Adjudicado Unitario (corregido)
 *  - % de Avance por Certificación = Certificado (corregido) / Total Adjudicado (corregido) * 100
 * Solo escribe estas 9 columnas puntuales — nunca la fila completa (evita tocar Pospre u otras
 * columnas con validación de datos).
 * IMPORTANTE: no debe ejecutarse dos veces, o dividiría el IVA otra vez sobre datos ya corregidos.
 */

/**
 * MANTENIMIENTO — correr UNA VEZ manualmente desde este editor (elegir esta función
 * en el desplegable de arriba y apretar ▶ Ejecutar), no se llama desde la app.
 *
 * Corrige columnas de fecha que quedaron guardadas como TEXTO (ej: "2017-09-28T07:00:00.000Z")
 * en vez de como fecha real de Google Sheets, producto de la recuperación del Excel original.
 * Mientras estén como texto, el calendario y los filtros de fecha de la app no las reconocen.
 * Es segura de correr varias veces: si una celda ya es una fecha real, no la toca.
 */
function repararFechasTexto() {
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return;
  const n = lastRow - FIRST_DATA_ROW + 1;

  // Columnas con fechas cargadas por el usuario (no calculadas por el script).
  const COLUMNAS_FECHA = [9, 15, 21, 22]; // Fecha Inicio Expte. / Fecha de Apertura / Fecha Acto Admin / Fecha Inicio Real

  let corregidas = 0;
  COLUMNAS_FECHA.forEach(col => {
    const range = sh.getRange(FIRST_DATA_ROW, col, n, 1);
    const values = range.getValues();
    let cambios = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i][0];
      if (typeof v === 'string' && v.trim() !== '') {
        // Antes usaba el parser nativo `new Date(v)`, que interpreta las fechas como mes/día/año
        // y falla (o las interpreta mal) con el formato día/mes/año típico del Excel original
        // ("28/09/2017" no lo entiende, porque no existe el mes 28). _parsearFechaFlexible sí
        // reconoce ese formato correctamente.
        const d = _parsearFechaFlexible(v);
        if (d) {
          values[i][0] = d;
          cambios = true;
          corregidas++;
        }
      }
    }
    if (cambios) range.setValues(values);
  });

  Logger.log('Fechas corregidas: ' + corregidas);
  return corregidas;
}

function _corregirValoresPorIVA() {
  const IVA = 1.21;
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return 0;
  const n = lastRow - FIRST_DATA_ROW + 1;
  const values = sh.getRange(FIRST_DATA_ROW, 1, n, LAST_COLUMN).getValues();

  const colPresUnit = [];     // col 12
  const colAdjUnit = [];      // col 18
  const colKmLinea = [];      // col 27
  const colProyectados = [];  // col 30
  const colCertificado = [];  // col 32
  const colMultas = [];       // col 34
  const colPresOficial = [];  // col 13 (recalculado)
  const colTotalAdj = [];     // col 19 (recalculado)
  const colPctAvance = [];    // col 33 (recalculado)
  let count = 0;

  for (let i = 0; i < n; i++) {
    const row = values[i];
    const hasDatos = row.slice(0, LAST_COLUMN).some(v => v !== '' && v !== null);
    if (!hasDatos) {
      colPresUnit.push([row[11]]);
      colAdjUnit.push([row[17]]);
      colKmLinea.push([row[26]]);
      colProyectados.push([row[29]]);
      colCertificado.push([row[31]]);
      colMultas.push([row[33]]);
      colPresOficial.push([row[12]]);
      colTotalAdj.push([row[18]]);
      colPctAvance.push([row[32]]);
      continue;
    }

    const cantidad = parseFloat(row[10]) || 0;         // col 11
    const presUnitOrig = parseFloat(row[11]) || 0;      // col 12
    const adjUnitOrig = parseFloat(row[17]) || 0;       // col 18
    const kmLineaOrig = parseFloat(row[26]) || 0;       // col 27
    const proyectadosOrig = parseFloat(row[29]) || 0;   // col 30
    const certificadoOrig = parseFloat(row[31]) || 0;   // col 32
    const multasOrig = parseFloat(row[33]) || 0;        // col 34

    const presUnitNuevo = presUnitOrig / IVA;
    const adjUnitNuevo = adjUnitOrig / IVA;
    const kmLineaNuevo = kmLineaOrig / IVA;
    const proyectadosNuevo = proyectadosOrig / IVA;
    const certificadoNuevo = certificadoOrig / IVA;
    const multasNuevo = multasOrig / IVA;

    colPresUnit.push([presUnitNuevo]);
    colAdjUnit.push([adjUnitNuevo]);
    colKmLinea.push([kmLineaNuevo]);
    colProyectados.push([proyectadosNuevo]);
    colCertificado.push([certificadoNuevo]);
    colMultas.push([multasNuevo]);

    const presOficialNuevo = cantidad * presUnitNuevo;
    const totalAdjNuevo = cantidad * adjUnitNuevo;
    colPresOficial.push([presOficialNuevo]);
    colTotalAdj.push([totalAdjNuevo]);
    colPctAvance.push([totalAdjNuevo > 0 ? (certificadoNuevo / totalAdjNuevo) * 100 : 0]);
    count++;
  }

  sh.getRange(FIRST_DATA_ROW, 12, n, 1).setValues(colPresUnit);
  sh.getRange(FIRST_DATA_ROW, 18, n, 1).setValues(colAdjUnit);
  sh.getRange(FIRST_DATA_ROW, 27, n, 1).setValues(colKmLinea);
  sh.getRange(FIRST_DATA_ROW, 30, n, 1).setValues(colProyectados);
  sh.getRange(FIRST_DATA_ROW, 32, n, 1).setValues(colCertificado);
  sh.getRange(FIRST_DATA_ROW, 34, n, 1).setValues(colMultas);
  sh.getRange(FIRST_DATA_ROW, 13, n, 1).setValues(colPresOficial);
  sh.getRange(FIRST_DATA_ROW, 19, n, 1).setValues(colTotalAdj);
  sh.getRange(FIRST_DATA_ROW, 33, n, 1).setValues(colPctAvance);
  return count;
}

/**
 * Recalcula los campos derivados de TODOS los trámites existentes:
 *  - Presupuesto Oficial Rubro = Cantidades/IIBB * Pres. Oficial Unitario
 *  - Total Adjudicado = Cantidades/IIBB * Adjudicado Unitario
 *  - Fecha Fin de Contrato / Fecha Fin de Plazo Ampliada = Fecha Base + Plazo de Entrega (+ Ampliación),
 *    donde Fecha Base es: el contrato debe iniciar antes de los 40 días corridos posteriores a la
 *    Fecha Acto Admin de Adjudicación (tope: Fecha Acto Admin + 40d). Si la Fecha Inicio Real está
 *    cargada y cae dentro de ese tope, la Fecha Base es la Fecha Inicio Real; si no (todavía no hay
 *    Fecha Inicio Real, o quedó después del tope), la Fecha Base es el tope (Fecha Acto Admin + 40d).
 *  - % de Avance por Certificación = $ certificados por AAD / $ Total Adjudicado * 100
 */
function _recalcularTodos() {
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return 0;
  const n = lastRow - FIRST_DATA_ROW + 1;
  const values = sh.getRange(FIRST_DATA_ROW, 1, n, LAST_COLUMN).getValues();
  const ids = sh.getRange(FIRST_DATA_ROW, ID_COLUMN, n, 1).getValues();

  // Solo escribimos estas columnas puntuales — nunca la fila completa,
  // para no rozar columnas con validación de datos (ej: Pospre en A).
  const colPresOficial = [];   // col 13
  const colTotalAdj = [];      // col 19
  const colFechaFin = [];      // col 23
  const colFechaFinAmpl = [];  // col 25
  const colPctIIBB = [];       // col 31
  const colPctAvance = [];     // col 33
  let count = 0;

  // Mapa idTramite -> $ Total Adjudicado (con el valor recién recalculado), para poder
  // recalcular después el "% del Adjudicado" de cada certificación cargada (más abajo).
  const totalAdjPorTramite = {};

  for (let i = 0; i < n; i++) {
    const row = values[i];
    const idTramite = ids[i][0];
    const plazoEntrega = parseFloat(row[9]) || 0;        // col 10
    const cantidad = parseFloat(row[10]) || 0;           // col 11
    const presUnit = parseFloat(row[11]) || 0;           // col 12
    const adjUnit = parseFloat(row[17]) || 0;            // col 18
    const fechaActoAdmin = row[20];                      // col 21
    const fechaInicioReal = row[21];                     // col 22
    const ampliacion = parseFloat(row[23]) || 0;         // col 24
    const cantTotalIIBBProy = parseFloat(row[28]) || 0;  // col 29
    const certificado = parseFloat(row[31]) || 0;        // col 32

    const hasDatos = row.slice(0, LAST_COLUMN).some(v => v !== '' && v !== null);
    if (!hasDatos) {
      colPresOficial.push([row[12]]);
      colTotalAdj.push([row[18]]);
      colFechaFin.push([row[22]]);
      colFechaFinAmpl.push([row[24]]);
      colPctIIBB.push([row[30]]);
      colPctAvance.push([row[32]]);
      if (idTramite) totalAdjPorTramite[idTramite] = parseFloat(row[18]) || 0;
      continue;
    }

    const presOficial = cantidad * presUnit;
    const totalAdj = cantidad * adjUnit;
    colPresOficial.push([presOficial]);
    colTotalAdj.push([totalAdj]);
    if (idTramite) totalAdjPorTramite[idTramite] = totalAdj;

    // Fecha Base para contar el plazo y calcular la fecha de fin: el contrato debe iniciar antes
    // de los 40 días corridos posteriores a la Fecha Acto Admin de Adjudicación (tope: Fecha Acto
    // Admin + 40d).
    //  a) Si la Fecha Inicio Real está cargada y cae dentro de ese tope, se usa la Fecha Inicio Real.
    //  b) Si no (todavía no hay Fecha Inicio Real, o quedó después del tope), se usa el tope
    //     (Fecha Acto Admin + 40d).
    // Si no hay Fecha Acto Admin cargada, no se puede aplicar el tope: se usa la Fecha Inicio Real
    // tal cual (comportamiento previo, para trámites viejos que no tengan ese dato).
    const dActoAdmin = _parsearFechaFlexible(fechaActoAdmin);
    const fInicioReal = _parsearFechaFlexible(fechaInicioReal);
    let dLimite = null;
    if (dActoAdmin) {
      dLimite = new Date(dActoAdmin.getTime());
      dLimite.setDate(dLimite.getDate() + 40);
    }

    let fechaBase = null;
    if (fInicioReal && dLimite && fInicioReal.getTime() <= dLimite.getTime()) {
      fechaBase = fInicioReal;
    } else if (dLimite) {
      fechaBase = dLimite;
    } else if (fInicioReal) {
      fechaBase = fInicioReal;
    }

    if (fechaBase) {
      const dFin = new Date(fechaBase.getTime());
      dFin.setDate(dFin.getDate() + plazoEntrega);
      colFechaFin.push([dFin]);

      const dFinAmpliada = new Date(fechaBase.getTime());
      dFinAmpliada.setDate(dFinAmpliada.getDate() + plazoEntrega + ampliacion);
      colFechaFinAmpl.push([dFinAmpliada]);
    } else {
      colFechaFin.push([row[22]]);
      colFechaFinAmpl.push([row[24]]);
    }

    colPctIIBB.push([cantidad > 0 ? (cantTotalIIBBProy / cantidad) * 100 : 0]);
    colPctAvance.push([totalAdj > 0 ? (certificado / totalAdj) * 100 : 0]);
    count++;
  }

  sh.getRange(FIRST_DATA_ROW, 13, n, 1).setValues(colPresOficial);
  sh.getRange(FIRST_DATA_ROW, 19, n, 1).setValues(colTotalAdj);
  sh.getRange(FIRST_DATA_ROW, 23, n, 1).setValues(colFechaFin);
  sh.getRange(FIRST_DATA_ROW, 25, n, 1).setValues(colFechaFinAmpl);
  sh.getRange(FIRST_DATA_ROW, 31, n, 1).setValues(colPctIIBB);
  sh.getRange(FIRST_DATA_ROW, 33, n, 1).setValues(colPctAvance);

  _recalcularPctAvanceCertificaciones(totalAdjPorTramite);
  return count;
}

/**
 * Recalcula, para CADA certificación ya cargada, el "% del Adjudicado que representa este
 * Certificado" (columna 14 de la hoja "Certificaciones"), usando el $ Total Adjudicado del
 * trámite al que pertenece cada una (recién actualizado en _recalcularTodos).
 * Corrige certificaciones que quedaron en 0% por haberse cargado antes de que el trámite
 * tuviera su $ Adjudicado Unitario / Cantidades bien cargados.
 */
function _recalcularPctAvanceCertificaciones(totalAdjPorTramite) {
  const certSheet = _sheetCert();
  if (!certSheet) return;
  const lastRow = certSheet.getLastRow();
  if (lastRow < CERT_FIRST_DATA_ROW) return;
  const n = lastRow - CERT_FIRST_DATA_ROW + 1;
  const values = certSheet.getRange(CERT_FIRST_DATA_ROW, 1, n, CERT_LAST_COLUMN).getValues();

  const colPctAvance = values.map(row => {
    const idTramite = row[CERT_TRAMITE_ID_COLUMN - 1];
    if (!idTramite || !row[CERT_ID_COLUMN - 1]) return [row[13]]; // fila vacía: no la tocamos
    const montoCert = parseFloat(row[10]) || 0; // col 11: montoCertificado
    const totalAdj = totalAdjPorTramite[idTramite] || 0;
    return [totalAdj > 0 ? (montoCert / totalAdj) * 100 : 0];
  });

  certSheet.getRange(CERT_FIRST_DATA_ROW, 14, n, 1).setValues(colPctAvance);
}

/**
 * Completa, SOLO donde estén vacíos, 4 campos que no existían en la base original:
 *  - Cantidades/IIBB = 1
 *  - $ Pres. Oficial Unitario = $ Presupuesto Oficial Rubro (ya cargado)
 *  - $ Adjudicado Unitario = $ Presupuesto Oficial Rubro (ya cargado)
 *  - $ Total Adjudicado = Cantidades/IIBB * Adjudicado Unitario (= Presupuesto Oficial Rubro)
 * No toca ninguna fila que ya tenga esos 4 campos cargados con datos reales,
 * y solo escribe esas 4 columnas puntuales (nunca la fila completa).
 */
function _completarValoresIniciales() {
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return 0;
  const n = lastRow - FIRST_DATA_ROW + 1;
  const values = sh.getRange(FIRST_DATA_ROW, 1, n, LAST_COLUMN).getValues();

  const colCantidad = [];  // col 11
  const colPresUnit = [];  // col 12
  const colAdjUnit = [];   // col 18
  const colTotalAdj = [];  // col 19
  let count = 0;

  for (let i = 0; i < n; i++) {
    const row = values[i];
    const cantidad = row[10];          // col 11: cantidadesIIBB
    const presUnit = row[11];          // col 12: presOficialUnitario
    const adjUnit = row[17];           // col 18: adjudicadoUnitario
    const totalAdj = row[18];          // col 19: totalAdjudicado
    const presOficial = parseFloat(row[12]) || 0; // col 13: presupuestoOficialRubro (ya cargado)

    const estanVacios = (cantidad === '' || cantidad === null)
      && (presUnit === '' || presUnit === null)
      && (adjUnit === '' || adjUnit === null)
      && (totalAdj === '' || totalAdj === null);

    if (estanVacios && presOficial > 0) {
      colCantidad.push([1]);
      colPresUnit.push([presOficial]);
      colAdjUnit.push([presOficial]);
      colTotalAdj.push([presOficial]);
      count++;
    } else {
      colCantidad.push([cantidad]);
      colPresUnit.push([presUnit]);
      colAdjUnit.push([adjUnit]);
      colTotalAdj.push([totalAdj]);
    }
  }

  sh.getRange(FIRST_DATA_ROW, 11, n, 1).setValues(colCantidad);
  sh.getRange(FIRST_DATA_ROW, 12, n, 1).setValues(colPresUnit);
  sh.getRange(FIRST_DATA_ROW, 18, n, 1).setValues(colAdjUnit);
  sh.getRange(FIRST_DATA_ROW, 19, n, 1).setValues(colTotalAdj);
  return count;
}

/**
 * Unifica variantes duplicadas de un valor (ej: distintas formas de escribir el mismo Pospre
 * o la misma Sucursal) reemplazándolas por un único valor canónico.
 * Solo permitido sobre 'pospre' (columna A) y 'sucursal' (columna D) — los dos campos que
 * suelen tener variantes de tipeo. Escribe SOLO esa columna, nunca la fila completa.
 * Nota: la columna Pospre puede tener validación de datos en el Sheet; si el valor nuevo no
 * está permitido por esa validación, la escritura va a fallar con un error claro.
 */
const UNIFICABLE_COLUMNS = { pospre: 1, sucursal: 4 };
function _unificarValores(campo, valoresViejos, valorNuevo) {
  const col = UNIFICABLE_COLUMNS[campo];
  if (!col) throw new Error('Ese campo no se puede unificar. Solo se permite "pospre" o "sucursal".');
  const nuevo = String(valorNuevo || '').trim();
  if (!nuevo) throw new Error('Falta indicar el valor nuevo (canónico).');

  const viejosSet = {};
  (valoresViejos || []).forEach(v => { viejosSet[String(v).trim()] = true; });

  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return 0;
  const n = lastRow - FIRST_DATA_ROW + 1;
  const range = sh.getRange(FIRST_DATA_ROW, col, n, 1);
  const values = range.getValues();
  let count = 0;

  for (let i = 0; i < n; i++) {
    const actual = String(values[i][0] || '').trim();
    if (viejosSet[actual] && actual !== nuevo) {
      values[i][0] = nuevo;
      count++;
    }
  }
  if (count > 0) range.setValues(values);
  return count;
}

// ======= MÓDULO DE CERTIFICACIONES =======

function _certRowToRecord(rowValues, rowIndex) {
  const rec = { _row: rowIndex, _id: rowValues[CERT_ID_COLUMN - 1], idTramite: rowValues[CERT_TRAMITE_ID_COLUMN - 1] };
  CERT_FIELDS.forEach(f => {
    rec[f.key] = _formatDateField(f.key, rowValues[f.col - 1]);
  });
  return rec;
}

function _listarCertificaciones(idTramiteFiltro) {
  const sh = _sheetCert();
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < CERT_FIRST_DATA_ROW) return [];
  const n = lastRow - CERT_FIRST_DATA_ROW + 1;
  const values = sh.getRange(CERT_FIRST_DATA_ROW, 1, n, CERT_LAST_COLUMN).getValues();
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = values[i];
    if (!row[CERT_ID_COLUMN - 1]) continue; // fila vacía
    if (idTramiteFiltro && row[CERT_TRAMITE_ID_COLUMN - 1] !== idTramiteFiltro) continue;
    out.push(_certRowToRecord(row, CERT_FIRST_DATA_ROW + i));
  }
  return out;
}

function _findCertRowById(id) {
  const sh = _sheetCert();
  const lastRow = sh.getLastRow();
  if (lastRow < CERT_FIRST_DATA_ROW) return -1;
  const n = lastRow - CERT_FIRST_DATA_ROW + 1;
  const ids = sh.getRange(CERT_FIRST_DATA_ROW, CERT_ID_COLUMN, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    if (ids[i][0] === id) return CERT_FIRST_DATA_ROW + i;
  }
  return -1;
}

/**
 * IIBB Certificados se calcula solo: $ Certificados / $ Adjudicado Unitario del trámite.
 * Se recalcula acá en el servidor (no solo en el frontend) para que el dato quede siempre
 * consistente aunque cambie el valor unitario del trámite después de cargada la certificación.
 */
function _iibbCertificadosCalculado(idTramite, montoCertificado) {
  const monto = parseFloat(montoCertificado) || 0;
  const tramiteRow = _findRowById(idTramite);
  if (tramiteRow === -1) return 0;
  const adjUnitario = parseFloat(_sheetData().getRange(tramiteRow, 18).getValue()) || 0; // col 18: adjudicadoUnitario
  if (adjUnitario <= 0) return 0;
  return Math.round((monto / adjUnitario) * 100) / 100; // redondeado a 2 decimales
}

function _crearCertificacion(datos) {
  if (!datos || !datos.idTramite) throw new Error('Falta indicar a qué trámite corresponde la certificación.');
  const sh = _sheetCert();
  const newRow = sh.getLastRow() + 1;
  const id = Utilities.getUuid();
  const rowValues = new Array(CERT_LAST_COLUMN).fill('');
  rowValues[CERT_ID_COLUMN - 1] = id;
  rowValues[CERT_TRAMITE_ID_COLUMN - 1] = datos.idTramite;
  CERT_FIELDS.forEach(f => {
    if (f.key !== 'pctAvance' && f.key !== 'iibbCertificados' && Object.prototype.hasOwnProperty.call(datos, f.key)) {
      rowValues[f.col - 1] = _numOrRaw(f.key, datos[f.key]);
    }
  });
  // IIBB Certificados: se recalcula siempre en el servidor, ignorando lo que haya llegado del frontend.
  const colIIBB = CERT_FIELDS.find(f => f.key === 'iibbCertificados').col;
  rowValues[colIIBB - 1] = _iibbCertificadosCalculado(datos.idTramite, datos.montoCertificado);

  sh.getRange(newRow, 1, 1, CERT_LAST_COLUMN).setValues([rowValues]);
  _recalcularRollupTramite(datos.idTramite);
  return id;
}

function _actualizarCertificacion(id, datos) {
  const row = _findCertRowById(id);
  if (row === -1) throw new Error('Certificación no encontrada.');
  const sh = _sheetCert();
  const idTramiteActual = sh.getRange(row, CERT_TRAMITE_ID_COLUMN).getValue();
  const idTramite = (datos && datos.idTramite) || idTramiteActual;
  const cambioDeTramite = idTramite !== idTramiteActual;

  // Si la certificación se reasigna a otro trámite (ej: estaba vinculada al trámite equivocado
  // entre varios que comparten el mismo N° de Pedido de Compras), hay que actualizar también
  // la columna de vínculo — antes quedaba escrita la de siempre y la reasignación no se guardaba.
  if (cambioDeTramite) {
    sh.getRange(row, CERT_TRAMITE_ID_COLUMN).setValue(idTramite);
  }

  CERT_FIELDS.forEach(f => {
    if (!datos || !Object.prototype.hasOwnProperty.call(datos, f.key)) return;
    if (f.key === 'pctAvance') return; // se recalcula solo, más abajo
    let valor = datos[f.key];
    if (f.key === 'iibbCertificados') valor = _iibbCertificadosCalculado(idTramite, datos.montoCertificado);
    sh.getRange(row, f.col).setValue(_numOrRaw(f.key, valor));
  });

  _recalcularRollupTramite(idTramite);
  // Si cambió de trámite, el trámite ANTERIOR también hay que recalcularlo (le sacamos este
  // certificado): la prioridad la tiene siempre lo que hay realmente cargado en Certificaciones.
  if (cambioDeTramite) _recalcularRollupTramite(idTramiteActual);
}

function _eliminarCertificacion(id) {
  const row = _findCertRowById(id);
  if (row === -1) throw new Error('Certificación no encontrada.');
  const sh = _sheetCert();
  const idTramite = sh.getRange(row, CERT_TRAMITE_ID_COLUMN).getValue();
  sh.deleteRow(row);
  _recalcularRollupTramite(idTramite);
}

/**
 * Recalcula, a partir de TODAS las certificaciones cargadas para un trámite:
 *  - $ certificados por AAD (col 32) = suma de $ Certificados
 *  - % de Avance por Certificación (col 33) = esa suma / $ Total Adjudicado * 100
 *  - Sumatoria de Multas (col 34) = suma de $ Multas
 *  - Cantidad de Certificados Procesados (col 36) = cantidad de certificaciones cargadas
 * y actualiza el % de Avance en todas las filas de "Certificaciones" de ese trámite,
 * para que muestren el avance acumulado real. Escribe solo celdas puntuales.
 */
function _recalcularRollupTramite(idTramite) {
  if (!idTramite) return;
  const certSheet = _sheetCert();
  const lastRow = certSheet.getLastRow();

  let sumaCertificado = 0, sumaMultas = 0, cantidad = 0;
  const filasDelTramite = [];
  const montosPorFila = [];

  if (lastRow >= CERT_FIRST_DATA_ROW) {
    const n = lastRow - CERT_FIRST_DATA_ROW + 1;
    const values = certSheet.getRange(CERT_FIRST_DATA_ROW, 1, n, CERT_LAST_COLUMN).getValues();
    for (let i = 0; i < n; i++) {
      const row = values[i];
      if (row[CERT_TRAMITE_ID_COLUMN - 1] !== idTramite) continue;
      const montoCert = parseFloat(row[10]) || 0; // col 11: montoCertificado
      sumaCertificado += montoCert;
      sumaMultas += parseFloat(row[12]) || 0;      // col 13: montoMultas
      cantidad++;
      filasDelTramite.push(CERT_FIRST_DATA_ROW + i);
      montosPorFila.push(montoCert);
    }
  }

  const tramiteRow = _findRowById(idTramite);
  if (tramiteRow === -1) return;
  const sh = _sheetData();
  const totalAdj = parseFloat(sh.getRange(tramiteRow, 19).getValue()) || 0; // col 19: totalAdjudicado
  const pctAvanceGeneral = totalAdj > 0 ? (sumaCertificado / totalAdj) * 100 : 0;

  sh.getRange(tramiteRow, 32).setValue(sumaCertificado); // certificadosAAD
  sh.getRange(tramiteRow, 33).setValue(pctAvanceGeneral); // pctAvanceCertificacion (del trámite completo)
  sh.getRange(tramiteRow, 34).setValue(sumaMultas);      // sumatoriaMultas
  sh.getRange(tramiteRow, 36).setValue(cantidad);        // cantidadCertificadosProcesados

  // % Avance por FILA: lo que representa ESE certificado puntual sobre el total adjudicado del
  // trámite (no el % de avance acumulado del PC — ese ya se ve en Registros/Dashboard).
  filasDelTramite.forEach((fila, idx) => {
    const pctFila = totalAdj > 0 ? (montosPorFila[idx] / totalAdj) * 100 : 0;
    certSheet.getRange(fila, 14).setValue(pctFila);
  });
}

// ======= MÓDULO DE PROYECTOS =======

function _proyRowToRecord(rowValues, rowIndex) {
  const rec = { _row: rowIndex, _id: rowValues[PROY_ID_COLUMN - 1], idTramite: rowValues[PROY_TRAMITE_ID_COLUMN - 1] };
  PROY_FIELDS.forEach(f => {
    let v = rowValues[f.col - 1];
    if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    rec[f.key] = v;
  });
  return rec;
}

function _listarProyectos(idTramiteFiltro) {
  const sh = _sheetProy();
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < PROY_FIRST_DATA_ROW) return [];
  const n = lastRow - PROY_FIRST_DATA_ROW + 1;
  const values = sh.getRange(PROY_FIRST_DATA_ROW, 1, n, PROY_LAST_COLUMN).getValues();

  // Autocorrección: los proyectos que se cargaron ANTES de arreglar la fórmula del "$ del Proyecto"
  // quedaron guardados con el valor viejo (Cantidad de IIBB TOTAL del trámite × $ Adjudicado Unitario
  // — el mismo importe para todos los proyectos de un mismo Pedido de Compras). Cada vez que se listan
  // los proyectos se detectan y corrigen esas filas desactualizadas, sin necesidad de reabrirlas y
  // guardarlas una por una. Las filas que ya están bien (con la fórmula correcta) no se tocan.
  const dataSheet = _sheetData();
  const adjUnitarioCache = {}; // idTramite -> $ Adjudicado Unitario (una sola lectura por trámite)
  const colIIBB = PROY_FIELDS.find(f => f.key === 'iibbProyecto').col;
  const colMonto = PROY_FIELDS.find(f => f.key === 'montoProyecto').col;
  const idsTramiteACorregir = {};

  for (let i = 0; i < n; i++) {
    const row = values[i];
    const idTramite = row[PROY_TRAMITE_ID_COLUMN - 1];
    if (!row[PROY_ID_COLUMN - 1] || !idTramite) continue;
    if (!(idTramite in adjUnitarioCache)) {
      const tramiteRow = _findRowById(idTramite);
      adjUnitarioCache[idTramite] = tramiteRow === -1 ? 0 : (parseFloat(dataSheet.getRange(tramiteRow, 18).getValue()) || 0); // col 18: adjudicadoUnitario
    }
    const iibb = parseFloat(row[colIIBB - 1]) || 0;
    const montoCorrecto = iibb * adjUnitarioCache[idTramite];
    const montoGuardado = parseFloat(row[colMonto - 1]) || 0;
    if (Math.abs(montoCorrecto - montoGuardado) > 0.01) {
      const fila = PROY_FIRST_DATA_ROW + i;
      sh.getRange(fila, colMonto).setValue(montoCorrecto);
      values[i][colMonto - 1] = montoCorrecto; // para que ya salga bien en esta misma respuesta
      idsTramiteACorregir[idTramite] = true;
    }
  }
  // Con el $ del Proyecto ya corregido, recalculamos también los acumulados del/los trámite(s) afectados
  // (Cant. Total de IIBB Proyectados, $ Proyectados Acumulados, % IIBB Proyectados de cada fila).
  Object.keys(idsTramiteACorregir).forEach(idT => _recalcularRollupProyectosTramite(idT));

  const out = [];
  for (let i = 0; i < n; i++) {
    const row = values[i];
    if (!row[PROY_ID_COLUMN - 1]) continue; // fila vacía
    if (idTramiteFiltro && row[PROY_TRAMITE_ID_COLUMN - 1] !== idTramiteFiltro) continue;
    out.push(_proyRowToRecord(row, PROY_FIRST_DATA_ROW + i));
  }
  return out;
}

function _findProyRowById(id) {
  const sh = _sheetProy();
  const lastRow = sh.getLastRow();
  if (lastRow < PROY_FIRST_DATA_ROW) return -1;
  const n = lastRow - PROY_FIRST_DATA_ROW + 1;
  const ids = sh.getRange(PROY_FIRST_DATA_ROW, PROY_ID_COLUMN, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    if (ids[i][0] === id) return PROY_FIRST_DATA_ROW + i;
  }
  return -1;
}

/**
 * $ del Proyecto se calcula solo: Cantidad de IIBB Proyectados de ESTE proyecto × $ Adjudicado
 * Unitario del trámite. (Antes usaba por error la Cantidad de IIBB total del trámite, dando
 * el mismo monto —el Total Adjudicado completo— en todos los proyectos de un mismo PC).
 * Se recalcula acá en el servidor (no solo en el frontend) para que el dato quede siempre
 * consistente aunque cambie el $ Adjudicado Unitario del trámite después de cargado el proyecto.
 */
function _montoProyectoCalculado(idTramite, iibbProyecto) {
  const tramiteRow = _findRowById(idTramite);
  if (tramiteRow === -1) return 0;
  const sh = _sheetData();
  const iibb = parseFloat(iibbProyecto) || 0;
  const adjUnitario = parseFloat(sh.getRange(tramiteRow, 18).getValue()) || 0; // col 18: adjudicadoUnitario
  return iibb * adjUnitario;
}

function _crearProyecto(datos) {
  if (!datos || !datos.idTramite) throw new Error('Falta indicar a qué trámite corresponde el proyecto.');
  const sh = _sheetProy();
  const newRow = sh.getLastRow() + 1;
  const id = Utilities.getUuid();
  const rowValues = new Array(PROY_LAST_COLUMN).fill('');
  rowValues[PROY_ID_COLUMN - 1] = id;
  rowValues[PROY_TRAMITE_ID_COLUMN - 1] = datos.idTramite;
  PROY_FIELDS.forEach(f => {
    if (f.key !== 'pctIIBBProyecto' && Object.prototype.hasOwnProperty.call(datos, f.key)) {
      rowValues[f.col - 1] = _numOrRaw(f.key, datos[f.key]);
    }
  });
  // $ del Proyecto: se recalcula siempre en el servidor, ignorando lo que haya llegado del frontend.
  const colMontoProyecto = PROY_FIELDS.find(f => f.key === 'montoProyecto').col;
  rowValues[colMontoProyecto - 1] = _montoProyectoCalculado(datos.idTramite, datos.iibbProyecto);

  sh.getRange(newRow, 1, 1, PROY_LAST_COLUMN).setValues([rowValues]);
  _recalcularRollupProyectosTramite(datos.idTramite);
  return id;
}

function _actualizarProyecto(id, datos) {
  const row = _findProyRowById(id);
  if (row === -1) throw new Error('Proyecto no encontrado.');
  const sh = _sheetProy();
  const idTramiteActual = sh.getRange(row, PROY_TRAMITE_ID_COLUMN).getValue();
  const idTramite = (datos && datos.idTramite) || idTramiteActual;
  const cambioDeTramite = idTramite !== idTramiteActual;

  // Si el proyecto se reasigna a otro trámite (ej: había quedado "huérfano", vinculado a un trámite
  // ya borrado), hay que actualizar también la columna de vínculo — antes quedaba escrita la de
  // siempre y la reasignación no se guardaba.
  if (cambioDeTramite) {
    sh.getRange(row, PROY_TRAMITE_ID_COLUMN).setValue(idTramite);
  }

  // Si el IIBB Proyectado no viene en este guardado puntual, usamos el que ya estaba cargado en la fila.
  const colIIBBProyecto = PROY_FIELDS.find(f => f.key === 'iibbProyecto').col;
  const iibbProyecto = (datos && Object.prototype.hasOwnProperty.call(datos, 'iibbProyecto'))
    ? datos.iibbProyecto
    : sh.getRange(row, colIIBBProyecto).getValue();

  PROY_FIELDS.forEach(f => {
    if (!datos || !Object.prototype.hasOwnProperty.call(datos, f.key)) return;
    if (f.key === 'pctIIBBProyecto') return; // se recalcula solo, más abajo
    let valor = datos[f.key];
    if (f.key === 'montoProyecto') valor = _montoProyectoCalculado(idTramite, iibbProyecto);
    sh.getRange(row, f.col).setValue(_numOrRaw(f.key, valor));
  });

  _recalcularRollupProyectosTramite(idTramite);
  // Si cambió de trámite, el trámite ANTERIOR también hay que recalcularlo (le sacamos este
  // proyecto) — salvo que ya no exista (por ejemplo, si era el trámite borrado que causó el huérfano).
  if (cambioDeTramite && idTramiteActual) {
    try { _recalcularRollupProyectosTramite(idTramiteActual); } catch (err) { /* trámite anterior ya no existe: nada que recalcular */ }
  }
}

function _eliminarProyecto(id) {
  const row = _findProyRowById(id);
  if (row === -1) throw new Error('Proyecto no encontrado.');
  const sh = _sheetProy();
  const idTramite = sh.getRange(row, PROY_TRAMITE_ID_COLUMN).getValue();
  sh.deleteRow(row);
  _recalcularRollupProyectosTramite(idTramite);
}

/**
 * Recalcula, a partir de TODOS los proyectos cargados para un trámite:
 *  - Cantidad de Proyectos (col 26) = cantidad de proyectos cargados
 *  - Cant. Total de IIBB Proyectados Acumulados (col 29) = suma de IIBB del Proyecto
 *  - $ Proyectados Acumulados (col 30) = suma de $ del Proyecto
 *  - % de IIBB Proyectados respecto IIBB Gestionados (col 31) = esa suma / Cantidades-IIBB del trámite * 100
 * y actualiza el % IIBB de cada fila de "Proyectos" de ese trámite (relativo a los IIBB del PC).
 *
 * El $ Km de Línea del PC (col 27) y su Mes/Año (col 28) NO se calculan más acá: son un dato que se
 * carga directamente en la etapa Ejecución del trámite (columnas editables como cualquier otra), y
 * de ahí lo toman todos los proyectos del mismo Pedido de Compras. Por eso esta función ya no las toca.
 *
 * Escribe solo celdas puntuales.
 */
function _recalcularRollupProyectosTramite(idTramite) {
  if (!idTramite) return;
  const proySheet = _sheetProy();
  const lastRow = proySheet.getLastRow();

  let sumaIIBB = 0, sumaMonto = 0, cantidad = 0;
  const filasDelTramite = [];
  const iibbPorFila = [];

  if (lastRow >= PROY_FIRST_DATA_ROW) {
    const n = lastRow - PROY_FIRST_DATA_ROW + 1;
    const values = proySheet.getRange(PROY_FIRST_DATA_ROW, 1, n, PROY_LAST_COLUMN).getValues();
    for (let i = 0; i < n; i++) {
      const row = values[i];
      if (row[PROY_TRAMITE_ID_COLUMN - 1] !== idTramite) continue;
      const iibb = parseFloat(row[11]) || 0;  // col 12: iibbProyecto
      sumaIIBB += iibb;
      sumaMonto += parseFloat(row[12]) || 0;  // col 13: montoProyecto
      cantidad++;
      filasDelTramite.push(PROY_FIRST_DATA_ROW + i);
      iibbPorFila.push(iibb);
    }
  }

  const tramiteRow = _findRowById(idTramite);
  if (tramiteRow === -1) return;
  const sh = _sheetData();
  const cantidadIIBBTramite = parseFloat(sh.getRange(tramiteRow, 11).getValue()) || 0; // col 11: cantidadesIIBB
  const pctIIBBGeneral = cantidadIIBBTramite > 0 ? (sumaIIBB / cantidadIIBBTramite) * 100 : 0;

  sh.getRange(tramiteRow, 26).setValue(cantidad);              // cantidadProyectos
  sh.getRange(tramiteRow, 29).setValue(sumaIIBB);              // cantTotalIIBBProyectados
  sh.getRange(tramiteRow, 30).setValue(sumaMonto);             // proyectadosAcumulados
  sh.getRange(tramiteRow, 31).setValue(pctIIBBGeneral);        // pctIIBBProyectados

  filasDelTramite.forEach((fila, idx) => {
    const pctFila = cantidadIIBBTramite > 0 ? (iibbPorFila[idx] / cantidadIIBBTramite) * 100 : 0;
    proySheet.getRange(fila, 14).setValue(pctFila); // % IIBB Proyectados de los IIBB del PC, por fila
  });
}

// ============================================================
// IMPORTACIÓN PUNTUAL: Proyectos desde UTR_Proyectos_2026-08-04.csv (otra app)
// ============================================================
// Ejecutar UNA sola vez desde el editor de Apps Script (menú "Ejecutar" > elegir
// "importarProyectosUTR" > Ejecutar). Mirá el "Registro de ejecución" al terminar:
// ahí aparece el resumen de cuántos se importaron y cuáles se omitieron (y por qué).
//
// REGLAS DE SEGURIDAD:
//  - NUNCA toca la hoja "Gestiones Plan" (los trámites/Pedidos de Compras ya cargados
//    no se modifican en absolutamente ningún aspecto, ni un solo campo).
//  - Solo AGREGA filas nuevas a la hoja "Proyectos".
//  - Si una fila del CSV no tiene N° de Pedido, o ese N° de Pedido no existe entre los
//    trámites ya cargados, o hay más de un trámite con ese mismo PC y no se puede saber
//    con certeza a cuál corresponde: NO se importa esa fila, se deja para carga manual.
//  - Si se ejecuta más de una vez por error, no duplica: antes de crear una fila revisa
//    si ya existe un proyecto con el mismo trámite + N° de Expediente + N° de Proyecto.
//  - El $ del Proyecto NO se toma del CSV: se calcula con la misma fórmula que usa el
//    resto de la app (IIBB Proyectados de este proyecto × $ Adjudicado Unitario del
//    trámite), para que quede coherente con todo lo demás.
const DATOS_IMPORTAR_PROYECTOS_UTR = [{"tipo": "LABT", "anio": "2025", "expediente": "1-25-1190922", "numeroProyecto": "1", "descripcion": "Cambio 2000m LABT P70- B° S. Genaro Norte - TOS", "sucursalCsv": "Noroeste", "nroPedido": "4060006623", "contratistaCsv": "GNG", "iibbUnitCsv": 109248.64, "iibbProyecto": 506.32, "observaciones": "EPE SOCIAL"}, {"tipo": "LMAT", "anio": "2025", "expediente": "1-25-1106329", "numeroProyecto": "1", "descripcion": "ANILLADO SAL2 - LOS CERRILLOS", "sucursalCsv": "Santa Fe Norte", "nroPedido": "4060006219", "contratistaCsv": "AUDITAR", "iibbUnitCsv": 89000.0, "iibbProyecto": 87.87, "observaciones": "Falta info en memoria descriptiva. Falta PC"}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-25-1187126", "numeroProyecto": "1", "descripcion": "CAMBIO 35AlAl x 50/8AlAc - 13-ATA RED PRIMARIA 3000m", "sucursalCsv": "Rafaela", "nroPedido": "4060006263", "contratistaCsv": "COEMYC", "iibbUnitCsv": 90757.73, "iibbProyecto": 192.24, "observaciones": "no adjuntan PC"}, {"tipo": "OM", "anio": "2025", "expediente": "1-25-1171556", "numeroProyecto": "1", "descripcion": "siria y damas mendocinas", "sucursalCsv": "A.D.Rosario", "nroPedido": "4110003476", "contratistaCsv": "GLOBAL", "iibbUnitCsv": 87092.28, "iibbProyecto": 557.261, "observaciones": "reclamado por ADR 05/12/25"}, {"tipo": "LABT", "anio": "2025", "expediente": "1-25-1192918", "numeroProyecto": "9", "descripcion": "Recambio Pre 70 5200m V. Minetti", "sucursalCsv": "Noroeste", "nroPedido": "4060006217", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 85536.6, "iibbProyecto": 602.0, "observaciones": ""}, {"tipo": "SETAS", "anio": "2025", "expediente": "1-25-1182249", "numeroProyecto": "6, 7 Y 8", "descripcion": "Unificación 3 Proy. SETA 689", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 907.4, "observaciones": "Se unifica: 1-25-1182249, 1182259 y 1182258"}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-25-1193603", "numeroProyecto": "21", "descripcion": "300M LAMT + SETA 160 + 2X SETAS 100 kVA", "sucursalCsv": "Reconquista", "nroPedido": "4060006204", "contratistaCsv": "", "iibbUnitCsv": 102300.0, "iibbProyecto": null, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-25-1194053", "numeroProyecto": "4", "descripcion": "B° GUEMES TOSTADO - 280M LAMT + SETA 315", "sucursalCsv": "Noroeste", "nroPedido": "4060006623", "contratistaCsv": "GNG", "iibbUnitCsv": 109248.64, "iibbProyecto": 225.02, "observaciones": ""}, {"tipo": "LMAT", "anio": "2025", "expediente": "1-25-1190871", "numeroProyecto": "5", "descripcion": "Mad x Col HA 12/1200 + 959m Cond 3*50/8 - Cnel Dom.", "sucursalCsv": "Villa Constitución", "nroPedido": "4060006262", "contratistaCsv": "GRUPO ELECTRO DOS S.R.L", "iibbUnitCsv": null, "iibbProyecto": null, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-25-1192388", "numeroProyecto": "4", "descripcion": "Mad x Col HA 9/750 y 9/3000 ZR Pavón Arriba", "sucursalCsv": "Villa Constitución", "nroPedido": "4060006262", "contratistaCsv": "GRUPO ELECTRO DOS S.R.L", "iibbUnitCsv": null, "iibbProyecto": null, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-25-1180781", "numeroProyecto": "5", "descripcion": "SETA 33-AER004 - 630KVA", "sucursalCsv": "Rosario Oeste", "nroPedido": "4060005477", "contratistaCsv": "JVS", "iibbUnitCsv": 42660.0, "iibbProyecto": 155.83, "observaciones": ""}, {"tipo": "LAMT 13", "anio": "2025", "expediente": "1-25-1189892", "numeroProyecto": "13", "descripcion": "Remodelación LAMT 13 RP sur ER Recreo - B° Astorino", "sucursalCsv": "Centro", "nroPedido": "4060006261", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 78323.35, "iibbProyecto": 315.89, "observaciones": "No adjuntan PC"}, {"tipo": "LS", "anio": "2025", "expediente": "1-25-1183756", "numeroProyecto": "4", "descripcion": "Reemplazo CAS 3 de Febrero 2300 - 2400 - Vereda Sur", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 632.85, "observaciones": "Anexa al proy el 1-25-1183758 x Mejora Alim Sal 6 SET 75 ALVEAR"}, {"tipo": "LS", "anio": "2025", "expediente": "1-25-1171734", "numeroProyecto": "3", "descripcion": "Mejora CAS Rondeau y Remedios de escalada", "sucursalCsv": "A.D.Rosario", "nroPedido": "4110003467", "contratistaCsv": "GLOBAL", "iibbUnitCsv": 87092.28, "iibbProyecto": 409.24, "observaciones": ""}, {"tipo": "OM LAMT + SETA", "anio": "2025", "expediente": "1-25-1195680", "numeroProyecto": "24", "descripcion": "SETA en distrito F. Olmos", "sucursalCsv": "Reconquista", "nroPedido": "4060006204", "contratistaCsv": "", "iibbUnitCsv": 102300.0, "iibbProyecto": null, "observaciones": ""}, {"tipo": "OM BT", "anio": "2025", "expediente": "1-25-1194532", "numeroProyecto": "23", "descripcion": "ACTUALIZACIÓN RED BT POZO DE LOS INDIOS", "sucursalCsv": "Reconquista", "nroPedido": "4060006204", "contratistaCsv": "", "iibbUnitCsv": 102300.0, "iibbProyecto": null, "observaciones": ""}, {"tipo": "LS", "anio": "2026", "expediente": "1-24-1157198", "numeroProyecto": "14", "descripcion": "RECAMBIO COND SAL. 2 SET 0682 - GALERÍA PELLEGRINI", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.63, "iibbProyecto": 235.79, "observaciones": ""}, {"tipo": "LS", "anio": "2026", "expediente": "1-25-1187876", "numeroProyecto": "13", "descripcion": "CTES. PJE. PERITO MORENO 1200 VEREDA ESTE", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 787.85, "observaciones": ""}, {"tipo": "LAMT", "anio": "2026", "expediente": "1-26-1197858", "numeroProyecto": "11", "descripcion": "480m LAMT 13 + 2 SETAS 160kVA en Villa Minetti - Ag TOS", "sucursalCsv": "Noroeste", "nroPedido": "4060006217", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 85536.6, "iibbProyecto": 159.34, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-25-1173002", "numeroProyecto": "12", "descripcion": "REMODELACIÓN RP SGU", "sucursalCsv": "Noroeste", "nroPedido": "4060006217", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 85536.6, "iibbProyecto": 430.52, "observaciones": "se adjunta 1-26-1198440 - Proy 13"}, {"tipo": "LS", "anio": "2026", "expediente": "1-26-1198844", "numeroProyecto": "8", "descripcion": "NVAS LS SALIDAS SETA 1061 - STO TOMÉ", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060006233", "contratistaCsv": "BASE", "iibbUnitCsv": 103927.67, "iibbProyecto": 98.52, "observaciones": ""}, {"tipo": "LS", "anio": "2026", "expediente": "1-25-188666", "numeroProyecto": "16", "descripcion": "300 m de cas 4*3*185+95 Al Montevideo 1000 VS y Sarmiento 1600 VE", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 624.55, "observaciones": ""}, {"tipo": "LS", "anio": "2026", "expediente": "1-25-1182673", "numeroProyecto": "15", "descripcion": "Mejora CDS ctes. Urquiza 2500 a 2700 y Pueyrredón 500", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 265.95, "observaciones": ""}, {"tipo": "LS", "anio": "2026", "expediente": "1-25-1182974", "numeroProyecto": "18", "descripcion": "Mejora CDS ctes. SLO 800", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 498.34, "observaciones": ""}, {"tipo": "LS", "anio": "2026", "expediente": "1-25-1187274", "numeroProyecto": "17", "descripcion": "MEJORA CDS CTES. URQUIZA 1000 VS Y RETIRO CONEX PROV", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 412.93, "observaciones": ""}, {"tipo": "LS", "anio": "2026", "expediente": "1-25-1182987", "numeroProyecto": "19", "descripcion": "", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 643.8425, "observaciones": ""}, {"tipo": "LM + 2 SETAS", "anio": "2026", "expediente": "1-26-1199119", "numeroProyecto": "13", "descripcion": "TENDIDO 460m LM + 2 SETAS 315kVA - SCRI", "sucursalCsv": "Noroeste", "nroPedido": "4060006217", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 85536.6, "iibbProyecto": 301.33, "observaciones": "66.76% de IIBB Proyectados Acumulados Con Este Proy. (PACEP)"}, {"tipo": "LS", "anio": "2026", "expediente": "1-25-1183263", "numeroProyecto": "20", "descripcion": "CDS - ctes tucuman 1800 vs e italia 400 vo - cs 25067", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 483.11, "observaciones": ""}, {"tipo": "LS", "anio": "2026", "expediente": "1-25-1182756", "numeroProyecto": "21", "descripcion": "CDS - TENDIDO CAS Y G4V - SET 689 CASIANO V", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 809.2, "observaciones": "tiene fusionado 1-25-1182774 a fs.13"}, {"tipo": "LABT", "anio": "2026", "expediente": "1-26-1200276", "numeroProyecto": "9", "descripcion": "REMOD LABT AD STF", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060006233", "contratistaCsv": "BASE", "iibbUnitCsv": 103927.67, "iibbProyecto": 512.79, "observaciones": ""}, {"tipo": "LS", "anio": "2025", "expediente": "1-25-1195893", "numeroProyecto": "22", "descripcion": "MEJORA CDS 3 FEB 1000 Y S. MARTÍN 1200 CS25-093", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UT", "iibbUnitCsv": 79884.3, "iibbProyecto": 314.84, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-23-1192537", "numeroProyecto": "5", "descripcion": "CIERRE SAL 49 CON SAL 48", "sucursalCsv": "Rosario Norte", "nroPedido": "4060006264", "contratistaCsv": "PELLEGRINI MONTAJES SRL", "iibbUnitCsv": 86535.25, "iibbProyecto": 729.0, "observaciones": ""}, {"tipo": "LS", "anio": "2025", "expediente": "1-26-1195545", "numeroProyecto": "23", "descripcion": "CD 025-089", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 484.24, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-26-1200281", "numeroProyecto": "6", "descripcion": "MAD X COL HA ZR", "sucursalCsv": "Villa Constitución", "nroPedido": "4060006262", "contratistaCsv": "GRUPO ELECTRO DOS S.R.L", "iibbUnitCsv": 90940.33, "iibbProyecto": 126.76, "observaciones": "personal Ag. Alvarez 22km de dist."}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-26-1200760", "numeroProyecto": "14", "descripcion": "RP 1 Y 2 - ER FRANCK", "sucursalCsv": "Centro", "nroPedido": "4060006261", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 78323.35, "iibbProyecto": 951.1, "observaciones": ""}, {"tipo": "LAMT", "anio": "2026", "expediente": "1-26-1201730", "numeroProyecto": "2", "descripcion": "CAMBIO POSTE POR COLUMNA 33-SJA-COL TERESA", "sucursalCsv": "Santa Fe Norte", "nroPedido": "4060006219", "contratistaCsv": "AUDITAR", "iibbUnitCsv": 89000.0, "iibbProyecto": 839.7, "observaciones": "SIN FIRMAS EN ORIG. ARMADO DESDE AAD / ADTZN"}, {"tipo": "LAMT + SETA", "anio": "2025", "expediente": "1-26-1200635", "numeroProyecto": "5", "descripcion": "LAMT + SETA BELGRANO 1000 - PEREZ - ROS O", "sucursalCsv": "Rosario Oeste", "nroPedido": "4060006218", "contratistaCsv": "COTRASER", "iibbUnitCsv": 83254.77, "iibbProyecto": 102.97, "observaciones": ""}, {"tipo": "LAMT", "anio": "2026", "expediente": "1-25-1181745", "numeroProyecto": "5", "descripcion": "SETA 315kVA CALLE COLÓN MÁXIMO PAZ", "sucursalCsv": "Sur", "nroPedido": "4060006206", "contratistaCsv": "GNG", "iibbUnitCsv": 86000.0, "iibbProyecto": 260.0, "observaciones": "LEVANTAMIENTO DE SUSPENSIÓN x ACC. FATAL"}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00004127-APPSF-OD", "numeroProyecto": "16", "descripcion": "REMODELACIÓN Y RECAMBIO DE CONDUCTOR DE LAMT 13,2 KV - SALIDA RURAL SAN CRISTÓBAL", "sucursalCsv": "Noroeste", "nroPedido": "4060006217", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 85536.6, "iibbProyecto": 556.36, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00004126-APPSF-OD", "numeroProyecto": "15", "descripcion": "LAMT MORTEROS - SUARDI + SBC + SETA 160kVA", "sucursalCsv": "Noroeste", "nroPedido": "4060006217", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 85536.56, "iibbProyecto": 412.34, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00004123-APPSF-OD", "numeroProyecto": "14", "descripcion": "Remod LAMT 35/6 Huanqueros - E Rams", "sucursalCsv": "Noroeste", "nroPedido": "4060006217", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 85536616.6, "iibbProyecto": 711.35, "observaciones": ""}, {"tipo": "LABT", "anio": "2025", "expediente": "EE-2026-00004128-APPSF-OD", "numeroProyecto": "17", "descripcion": "CONV * PRENS SCRI (180+420+495+275+300+400+110)", "sucursalCsv": "Noroeste", "nroPedido": "4060006217", "contratistaCsv": "LAS HERAS", "iibbUnitCsv": 85536.6, "iibbProyecto": 410.06, "observaciones": "Planos viejos desactualizados"}, {"tipo": "OM", "anio": "2025", "expediente": "EE-2026-00003086-APPSF-OD", "numeroProyecto": "", "descripcion": "DISTRIBUIDOR DOS LAGUNAS NORTE. BARRIO LAS ALMENAS", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060006233", "contratistaCsv": "BASE", "iibbUnitCsv": 103927.67, "iibbProyecto": 97.08, "observaciones": "Corregido 3*1*185 1.1kV"}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00004913-APPSF-OD", "numeroProyecto": "4", "descripcion": "LAMT Y SETA EN OLIVEROS", "sucursalCsv": "San Lorenzo", "nroPedido": "4060006205", "contratistaCsv": "DIANA BEE", "iibbUnitCsv": 98860.0, "iibbProyecto": 405.61, "observaciones": ""}, {"tipo": "BT", "anio": "2025", "expediente": "1-25-1187901", "numeroProyecto": "24", "descripcion": "FELIPE MORE 1200 CS 25-075", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE", "iibbUnitCsv": 79884.3, "iibbProyecto": 685.4, "observaciones": ""}, {"tipo": "LABT", "anio": "2025", "expediente": "EE-2026-00005983-APPSF-OD", "numeroProyecto": "1", "descripcion": "PROYECTO N° 1 - CABAÑA LEIVA", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE", "iibbUnitCsv": 128006.99, "iibbProyecto": 697.57, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00006023-APPSF", "numeroProyecto": "13", "descripcion": "SISTEMATIZACIÓN SETA N° 611 - REMODELACIÓN DE L", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060006233", "contratistaCsv": "BASE", "iibbUnitCsv": 103927.67, "iibbProyecto": 605.42, "observaciones": ""}, {"tipo": "EPE SOCIAL SETA 655", "anio": "2026", "expediente": "EE-2026-00005982-APPSF-", "numeroProyecto": "2", "descripcion": "EPE SOCIAL // PC: 4060007102 // PROYECTO 2 - SET", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE", "iibbUnitCsv": 128006.99, "iibbProyecto": 503.8, "observaciones": ""}, {"tipo": "LAMT", "anio": "2026", "expediente": "EE-2026-00005981-APPSF-OD", "numeroProyecto": "3", "descripcion": "EPE SOCIAL // PC:4060007102 // PROYECTO N° 3 - SETA 84. SANTA FE", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE", "iibbUnitCsv": 128006.99, "iibbProyecto": 653.71, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00007211-APPSF-OD", "numeroProyecto": "1", "descripcion": "BAJA TENSIÓN PARAJE GARABATO", "sucursalCsv": "Reconquista", "nroPedido": "4060007050", "contratistaCsv": "ELECTROMECÁNICA Y CIVIL SAS", "iibbUnitCsv": 116730.49, "iibbProyecto": 382.68, "observaciones": ""}, {"tipo": "LAMT", "anio": "2026", "expediente": "EE-2026-00005978-APPSF-OD", "numeroProyecto": "5", "descripcion": "PROYECTO N° 5 - SETA 593 VILLA HIPÓDROMO. SANTA", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE", "iibbUnitCsv": 128006.99, "iibbProyecto": 668.85, "observaciones": ""}, {"tipo": "SETA", "anio": "2025", "expediente": "1-26-1203171", "numeroProyecto": "7", "descripcion": "SETA CALLE SARMIENTO 1755 FUNES", "sucursalCsv": "Rosario Oeste", "nroPedido": "4060006218", "contratistaCsv": "COTRASER", "iibbUnitCsv": 83254.77, "iibbProyecto": 64.29, "observaciones": ""}, {"tipo": "", "anio": "", "expediente": "EE-2026-00005792-APPSF", "numeroProyecto": "14", "descripcion": "TENDIDO DE CONDUCTOR SUBTERRÁNEO POR REEMPLAZO DE ESTRUCTURA - BARRIO CENTENARIO", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060006233", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 103927.67, "iibbProyecto": 5.91, "observaciones": "Ampliación de un Proy. anterior."}, {"tipo": "LABT", "anio": "2025", "expediente": "EE-2026-00005979-APPSF-OD", "numeroProyecto": "4", "descripcion": "EPE SOCIAL // PC:4060007102 // PROYECTO N° 4 - LA SALLE", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 128006.99, "iibbProyecto": 438.94, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00005977-APPSF-O", "numeroProyecto": "6", "descripcion": "Sistematización SETA N° 342 – Barrio Sarmiento", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 128006.99, "iibbProyecto": 830.47, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00005976-APPSF-O", "numeroProyecto": "7", "descripcion": "Sistematización SETA N° 338", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 128006.99, "iibbProyecto": 861.46, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00005975-APPSF-O", "numeroProyecto": "8", "descripcion": "Sistematización LABT – Barrio Villa del Parque", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 128006.99, "iibbProyecto": 689.36, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00009019-APPSF-OD", "numeroProyecto": "15", "descripcion": "Reemplazo de conductores y reconfiguración de red – SETA 955", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060006623", "contratistaCsv": "GNG ELECTROMECÁNICA SAS", "iibbUnitCsv": 109249.64, "iibbProyecto": 511.22, "observaciones": ""}, {"tipo": "LSMT", "anio": "2025", "expediente": "EE-2026-00007074-APPSF-OD", "numeroProyecto": "1", "descripcion": "Proyecto N°1: CDG subterráneo Lavalle", "sucursalCsv": "Oeste", "nroPedido": "4060007052", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 132664.58, "iibbProyecto": 679.94, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00007073-APPSF-OD", "numeroProyecto": "2", "descripcion": "Proyecto N°2: CDG vinculación calle centenario", "sucursalCsv": "Oeste", "nroPedido": "4060007052", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 132664.58, "iibbProyecto": 60.28, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00009267-APPSF-OD", "numeroProyecto": "3", "descripcion": "Extensión LAMT 33Kv y SETA Piamonte", "sucursalCsv": "Oeste", "nroPedido": "4060007052", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 132664.58, "iibbProyecto": 132.63, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-26-1197043", "numeroProyecto": "26", "descripcion": "Vínculo en MT entre Paraje 109 a 119 - F. Olmos", "sucursalCsv": "Reconquista", "nroPedido": "4060006204", "contratistaCsv": "PROEMO INGENIERÍA S.R.L", "iibbUnitCsv": 102300.0, "iibbProyecto": 96.33, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-2024-1158788", "numeroProyecto": "6", "descripcion": "REEMPLAZO MAD X H°A° - ARMINDA", "sucursalCsv": "Villa Constitución", "nroPedido": "4110003608", "contratistaCsv": "GRUPO ELECTRO DOS S.R.L", "iibbUnitCsv": 90940.33, "iibbProyecto": 126.78, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00009266-APPSF-OD", "numeroProyecto": "4", "descripcion": "Extensión LAMT 33KV aprox 240 mts y estructura SETA - Carlos Pellegrini", "sucursalCsv": "Oeste", "nroPedido": "4060007052", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 132664.58, "iibbProyecto": 96.71, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00009596-APPSF-OD", "numeroProyecto": "5", "descripcion": "Extensión LAMT 13.2Kv con 50/8 protegido y SETA Final - recambio de conductor 35Al por 50/8 y columnas pasantes", "sucursalCsv": "Oeste", "nroPedido": "4060007052", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 132664.58, "iibbProyecto": 276.99, "observaciones": ""}, {"tipo": "LABT", "anio": "2025", "expediente": "EE-2026-00005974-APPSF-OD", "numeroProyecto": "9", "descripcion": "VILLA OCULTA SANTA FE", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 128006.99, "iibbProyecto": 683.22, "observaciones": ""}, {"tipo": "LAMT + LS", "anio": "2025", "expediente": "EE-2026-00009598-APPSF-OD", "numeroProyecto": "6", "descripcion": "nuevo tendido de subterráneo desde ET y recambio de conductores y pasantes salida 3 de San Jorge", "sucursalCsv": "Oeste", "nroPedido": "4060007052", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 132664.58, "iibbProyecto": 751.1, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "EE-2026-00011118-APPSF-OD", "numeroProyecto": "2", "descripcion": "TENDIDO DE 840 M LAMT 13,2 KV EN ALVAREZ, DTO ROSARIO", "sucursalCsv": "Villa Constitución", "nroPedido": "4060006262", "contratistaCsv": "GRUPO ELECTRO DOS S.R.L", "iibbUnitCsv": 90940.33, "iibbProyecto": 236.02, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "1-2025-1.182.034", "numeroProyecto": "10", "descripcion": "ETA 159 PADRE CATENA Y DEL TRABA", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 128005.99, "iibbProyecto": 470.26, "observaciones": ""}, {"tipo": "LSMT", "anio": "2025", "expediente": "1-2026-1201518", "numeroProyecto": "16", "descripcion": "250m LSMT P/VINCULAR SAL. 7 C/ SAL4 ET ESP", "sucursalCsv": "Centro", "nroPedido": "4060006261", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 78323.35, "iibbProyecto": 347.78, "observaciones": ""}, {"tipo": "", "anio": "2025", "expediente": "1-2024-1.158.788", "numeroProyecto": "", "descripcion": "consolidados", "sucursalCsv": "Centro", "nroPedido": "4060006261", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 78323.35, "iibbProyecto": 7273.0, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-2026-1201523", "numeroProyecto": "14", "descripcion": "250m LAMT VINCULAR SAL3 Y SAL4 ET ESP", "sucursalCsv": "Centro", "nroPedido": "4060006261", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 78323.35, "iibbProyecto": 196.38, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00007211-APPSF-OD", "numeroProyecto": "2", "descripcion": "RENOVACIÓN RED BAJA TENSIÓN PARAJE GARABATO - AGENCIA VILLA OCAMPO", "sucursalCsv": "Reconquista", "nroPedido": "4060007050", "contratistaCsv": "ELECTROMECÁNICA Y CIVIL SAS", "iibbUnitCsv": 116730.49, "iibbProyecto": 382.68, "observaciones": ""}, {"tipo": "LAMT", "anio": "2026", "expediente": "1-2026-1.196.577", "numeroProyecto": "EE-2026-00007222-APPSF-", "descripcion": "CONSTRUCCIÓN NEXO LMAT 13.2KV Y SETA EN LA LOCALIDAD DE FLORENC", "sucursalCsv": "Reconquista", "nroPedido": "4060007050", "contratistaCsv": "ELECTROMECÁNICA Y CIVIL SAS", "iibbUnitCsv": 116730.49, "iibbProyecto": 119.61, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "1-2026-1.196.577", "numeroProyecto": "4", "descripcion": "RENOVACIÓN RED DE BAJA TENSIÓN DISTRITO CAÑADA OMBÚ - AGENCIA VILLA OCAMP", "sucursalCsv": "Reconquista", "nroPedido": "4060007050", "contratistaCsv": "ELECTROMECÁNICA Y CIVIL SAS", "iibbUnitCsv": 116730.49, "iibbProyecto": 247.97, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00009629-APPSF-O", "numeroProyecto": "5", "descripcion": "ACTUALIZACIÓN LABT DISTRITO TARTAGAL - AGENCIA VILLA OCAMPO", "sucursalCsv": "Reconquista", "nroPedido": "4060007050", "contratistaCsv": "ELECTROMECÁNICA Y CIVIL SAS", "iibbUnitCsv": 116730.49, "iibbProyecto": 153.5, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00009667-APPSF-OD", "numeroProyecto": "6", "descripcion": "LABT DISTRITO GUADALUPE NORT", "sucursalCsv": "Reconquista", "nroPedido": "4060007050", "contratistaCsv": "ELECTROMECÁNICA Y CIVIL SAS", "iibbUnitCsv": 116730.49, "iibbProyecto": 103.23, "observaciones": ""}, {"tipo": "LSMT", "anio": "2025", "expediente": "EE-2026-00012098-APPSF-OD", "numeroProyecto": "1", "descripcion": "RECAMBIO DE LSMT 13,2 KV SALIDAS 1 Y 2 DE LA ET E", "sucursalCsv": "Centro", "nroPedido": "4110003590", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 78323.35, "iibbProyecto": 919.98, "observaciones": ""}, {"tipo": "LSMT", "anio": "2025", "expediente": "EE-2026-00004732-APPSF-O", "numeroProyecto": "6", "descripcion": "LSMT NVO COND 185MM2 - SAL6 - 13,2KV E.T.C.B", "sucursalCsv": "Rosario Norte", "nroPedido": "4060006264", "contratistaCsv": "PELLEGRINI MONTAJES SRL", "iibbUnitCsv": 86535.25, "iibbProyecto": 207.0, "observaciones": ""}, {"tipo": "LSMT+SETA+P95", "anio": "2025", "expediente": "EE-2026-00003997-APPSF-O", "numeroProyecto": "7", "descripcion": "LSMT+SETA-CRUCERO GRAL BELG Y MALV ARG GB", "sucursalCsv": "Rosario Norte", "nroPedido": "4060006264", "contratistaCsv": "PELLEGRINI MONTAJES SRL", "iibbUnitCsv": 85535.25, "iibbProyecto": 638.0, "observaciones": ""}, {"tipo": "SETA LAMT", "anio": "2026", "expediente": "1-2025-1.182.034", "numeroProyecto": "11", "descripcion": "OM x EPE SOCIAL BASE ING", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 128006.99, "iibbProyecto": 815.34, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-26-1201523", "numeroProyecto": "17", "descripcion": "CONST. 250m LAMT 13,2kV P/VINCULO SAL3 Y 7 ET ESP", "sucursalCsv": "Centro", "nroPedido": "4060006261", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 78323.35, "iibbProyecto": 196.38, "observaciones": ""}, {"tipo": "LAMT", "anio": "2026", "expediente": "EE-2026-00005969-APPSF-O", "numeroProyecto": "12", "descripcion": "P12 - SETA 1476 B° 12 DE SEPT. SANTO TOMÉ", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007102", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 128006.99, "iibbProyecto": 378.18, "observaciones": ""}, {"tipo": "LSMT", "anio": "2025", "expediente": "EE-2026-00012101-APPSF-O", "numeroProyecto": "2", "descripcion": "RECAMBIO LSMT 13,2KV SAL 3 Y 4 - ET ESP", "sucursalCsv": "Centro", "nroPedido": "4110003590", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 78323.35, "iibbProyecto": 932.2, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-2024-1.158.789", "numeroProyecto": "8", "descripcion": "Vinculo Alim 33-AER004 Y 33-AER005 - FUNES", "sucursalCsv": "Rosario Oeste", "nroPedido": "4060006218", "contratistaCsv": "COTRASER LTDA", "iibbUnitCsv": 83254.77, "iibbProyecto": 459.91, "observaciones": ""}, {"tipo": "LAMT", "anio": "2025", "expediente": "1-2024-1.158.789", "numeroProyecto": "4", "descripcion": "EXT LAMT 13,2 + SETA CALLE GUEMES 1800", "sucursalCsv": "Rosario Oeste", "nroPedido": "4060006218", "contratistaCsv": "COTRASER LTDA", "iibbUnitCsv": 83254.77, "iibbProyecto": 4.0, "observaciones": ""}, {"tipo": "LSBT", "anio": "2026", "expediente": "1-26-12022589", "numeroProyecto": "1", "descripcion": "TENDIDO CAS 3*185/95 Al + G4V CALLE A. BROWN Y GUEMES", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060007335", "contratistaCsv": "GLOBAL ACCELERATOR S.R.L", "iibbUnitCsv": 64267.05, "iibbProyecto": 680.89, "observaciones": ""}, {"tipo": "LSBT", "anio": "2026", "expediente": "1-25-1165484", "numeroProyecto": "2", "descripcion": "TENDIDO CAS 3/185/95 + G4V C. MENDOZA Y CRESPO SET 1700", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060007335", "contratistaCsv": "GLOBAL ACCELERATOR S.R.L", "iibbUnitCsv": 64267.05, "iibbProyecto": 446.41, "observaciones": ""}, {"tipo": "LABT", "anio": "2025", "expediente": "EE-2026-00004719-APPSF-OD", "numeroProyecto": "3", "descripcion": "RECAMBIO COL. X RETENSIÓN", "sucursalCsv": "Villa Constitución", "nroPedido": "4110003608", "contratistaCsv": "GRUPO ELECTRO DOS S.R.L", "iibbUnitCsv": 90940.33, "iibbProyecto": 180.73, "observaciones": ""}, {"tipo": "LSMT", "anio": "2025", "expediente": "1-26-1201299", "numeroProyecto": "3", "descripcion": "RECAMBIO DE LSMT 13,2 KV SALIDAS 5 Y 6 DE LA ET ESP", "sucursalCsv": "Centro", "nroPedido": "4110003590", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 78323.35, "iibbProyecto": 920.4, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00015988-APPSF-O", "numeroProyecto": "1", "descripcion": "REC_3500_M_LABT CONV x P70 – SGU-NOCS: 10300000160", "sucursalCsv": "Noroeste", "nroPedido": "4060007051", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 128311.85, "iibbProyecto": 789.25, "observaciones": ""}, {"tipo": "LAMT", "anio": "2026", "expediente": "EE-2026-00013273-APPSF-O", "numeroProyecto": "2", "descripcion": "450M LAMT + SETA - BARRIO SAN CARLOS", "sucursalCsv": "Noroeste", "nroPedido": "4060007051", "contratistaCsv": "LAS HERAS S.A", "iibbUnitCsv": 128311.85, "iibbProyecto": 373.95, "observaciones": ""}, {"tipo": "LABT", "anio": "2026", "expediente": "EE-2026-00016232-APPSF-OD", "numeroProyecto": "2", "descripcion": "REEMPLAZO DE CONDUCTOR Y SISTEMATIZACIÓN SETA 32", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007033", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 126095.19, "iibbProyecto": 614.37, "observaciones": ""}, {"tipo": "LSBT", "anio": "2026", "expediente": "EE-2026-00015939-APPSF-OD", "numeroProyecto": "1", "descripcion": "NTERCONEXIÓN SUBTERRÁNEA EN MT ENTRE SET 646 Y 951 PARA ELIMINACIÓN DE SETA 22 Y OBRAS COMPLEMENTARIAS EN B", "sucursalCsv": "A.D. Santa Fe", "nroPedido": "4060007033", "contratistaCsv": "BASE INGENIERÍA S.R.L", "iibbUnitCsv": 126095.19, "iibbProyecto": 648.46, "observaciones": ""}, {"tipo": "LSBT + G4V", "anio": "2025", "expediente": "1171744", "numeroProyecto": "28", "descripcion": "Mejora CDS ctes. Bv. Rondeau y Rep. de Siria CS 025-027", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE TACUAR-MANTELECTRIC", "iibbUnitCsv": 79884.3, "iibbProyecto": 537.36, "observaciones": ""}, {"tipo": "LSBT + G4V", "anio": "2025", "expediente": "1-2023-1120760", "numeroProyecto": "29", "descripcion": "Mejora CDS ctes. Quintana 3500 - 3700 CS 23-126", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060006651", "contratistaCsv": "UTE TACUAR-MANTELECTRIC", "iibbUnitCsv": 79884.3, "iibbProyecto": 356.09, "observaciones": ""}, {"tipo": "LAMT+LABT+SETA Modif", "anio": "2025", "expediente": "1-2025-1177924", "numeroProyecto": "2", "descripcion": "Modif. Proy. por negación frentista TN 503c", "sucursalCsv": "Rosario Norte", "nroPedido": "4060006264", "contratistaCsv": "PELLEGRINI MONTAJES SRL", "iibbUnitCsv": 86535.25, "iibbProyecto": 276.36, "observaciones": ""}, {"tipo": "LABT + G4V", "anio": "2026", "expediente": "1-24-1157078", "numeroProyecto": "3", "descripcion": "Mejora CDS Reemplazo Alim. Av. Pellegrini y Laprida - CS 24-083", "sucursalCsv": "A.D.Rosario", "nroPedido": "4060007335", "contratistaCsv": "GLOBAL ACCELERATOR S.R.L", "iibbUnitCsv": 64267.05, "iibbProyecto": 277.55, "observaciones": ""}]
;

function importarProyectosUTR() {
  const dataSheet = _sheetData();
  const lastRow = dataSheet.getLastRow();
  if (lastRow < FIRST_DATA_ROW) { Logger.log('No hay trámites cargados.'); return; }
  const n = lastRow - FIRST_DATA_ROW + 1;
  const filasTramite = dataSheet.getRange(FIRST_DATA_ROW, 1, n, ID_COLUMN).getValues();

  // Índice: N° de Pedido de Compras -> lista de { id, adjudicatario, adjudicadoUnitario, fila }
  const porPC = {};
  filasTramite.forEach(row => {
    const pc = String(row[7] || '').trim(); // col 8: nroPedidoCompras
    if (!pc) return;
    if (!porPC[pc]) porPC[pc] = [];
    porPC[pc].push({
      id: row[ID_COLUMN - 1],
      pospre: row[0],
      sucursal: row[3],
      adjudicatario: row[8],
      adjudicadoUnitario: parseFloat(row[17]) || 0 // col 18: adjudicadoUnitario
    });
  });

  // Proyectos ya cargados, para no duplicar si esto se corre más de una vez.
  const proySheet = _sheetProy();
  const proyLastRow = proySheet.getLastRow();
  const existentes = new Set();
  if (proyLastRow >= PROY_FIRST_DATA_ROW) {
    const nProy = proyLastRow - PROY_FIRST_DATA_ROW + 1;
    const valoresProy = proySheet.getRange(PROY_FIRST_DATA_ROW, 1, nProy, PROY_LAST_COLUMN).getValues();
    const colExp = PROY_FIELDS.find(f => f.key === 'nroExpedienteProyecto').col;
    const colNum = PROY_FIELDS.find(f => f.key === 'numeroProyecto').col;
    valoresProy.forEach(row => {
      const idT = row[PROY_TRAMITE_ID_COLUMN - 1];
      const exp = String(row[colExp - 1] || '').trim();
      const num = String(row[colNum - 1] || '').trim();
      existentes.add(idT + '||' + exp + '||' + num);
    });
  }

  let creados = 0;
  const omitidos = []; // { motivo, detalle }
  const idsTramiteAfectados = {};

  DATOS_IMPORTAR_PROYECTOS_UTR.forEach(fila => {
    const candidatos = porPC[fila.nroPedido];
    if (!candidatos || !candidatos.length) {
      omitidos.push({ motivo: 'PC no encontrado entre los trámites cargados', detalle: fila.nroPedido + ' — ' + fila.descripcion });
      return;
    }

    let elegido = candidatos[0];
    if (candidatos.length > 1) {
      // Varios trámites comparten el mismo PC (ampliaciones/clones): desambiguar por
      // Contratista si matchea exacto; si no, por el $ Unitario más parecido al del CSV.
      const porContratista = candidatos.filter(c =>
        fila.contratistaCsv && String(c.adjudicatario || '').toUpperCase().indexOf(fila.contratistaCsv.toUpperCase()) !== -1
      );
      if (porContratista.length === 1) {
        elegido = porContratista[0];
      } else if (fila.iibbUnitCsv) {
        candidatos.sort((a, b) =>
          Math.abs(a.adjudicadoUnitario - fila.iibbUnitCsv) - Math.abs(b.adjudicadoUnitario - fila.iibbUnitCsv)
        );
        elegido = candidatos[0];
      } else {
        omitidos.push({ motivo: 'PC con más de un trámite y no se pudo desambiguar con certeza', detalle: fila.nroPedido + ' — ' + fila.descripcion });
        return;
      }
    }

    const claveExistente = elegido.id + '||' + fila.expediente + '||' + fila.numeroProyecto;
    if (existentes.has(claveExistente)) {
      omitidos.push({ motivo: 'Ya existe un proyecto igual cargado (no se duplica)', detalle: fila.nroPedido + ' — Exp. ' + fila.expediente + ' N°' + fila.numeroProyecto });
      return;
    }

    const iibb = fila.iibbProyecto || 0;
    const montoProyecto = iibb * elegido.adjudicadoUnitario;
    const nota = (fila.tipo ? '[' + fila.tipo + '] ' : '') + (fila.observaciones || '');

    const proyNewRow = proySheet.getLastRow() + 1;
    const id = Utilities.getUuid();
    const rowValues = new Array(PROY_LAST_COLUMN).fill('');
    rowValues[PROY_ID_COLUMN - 1] = id;
    rowValues[PROY_TRAMITE_ID_COLUMN - 1] = elegido.id;
    PROY_FIELDS.forEach(f => {
      if (f.key === 'pospre') rowValues[f.col - 1] = elegido.pospre;
      else if (f.key === 'sucursal') rowValues[f.col - 1] = elegido.sucursal;
      else if (f.key === 'nroPedidoCompras') rowValues[f.col - 1] = fila.nroPedido;
      else if (f.key === 'contratista') rowValues[f.col - 1] = elegido.adjudicatario;
      else if (f.key === 'nroExpedienteProyecto') rowValues[f.col - 1] = fila.expediente;
      else if (f.key === 'numeroProyecto') rowValues[f.col - 1] = fila.numeroProyecto;
      else if (f.key === 'iibbProyecto') rowValues[f.col - 1] = iibb;
      else if (f.key === 'montoProyecto') rowValues[f.col - 1] = montoProyecto;
      else if (f.key === 'descripcionProyecto') rowValues[f.col - 1] = fila.descripcion;
      else if (f.key === 'observaciones') rowValues[f.col - 1] = nota;
    });
    proySheet.getRange(proyNewRow, 1, 1, PROY_LAST_COLUMN).setValues([rowValues]);
    existentes.add(claveExistente);
    idsTramiteAfectados[elegido.id] = true;
    creados++;
  });

  Object.keys(idsTramiteAfectados).forEach(idT => _recalcularRollupProyectosTramite(idT));

  Logger.log('Proyectos importados: ' + creados);
  Logger.log('Proyectos omitidos: ' + omitidos.length);
  omitidos.forEach(o => Logger.log(' - [' + o.motivo + '] ' + o.detalle));

  return { creados: creados, omitidos: omitidos };
}

// ============================================================
// MÓDULO DE COMPRAS (Equipos, Máquinas, Instrumentos, Materiales y Bienes)
// ------------------------------------------------------------
// Independiente de "Gestiones Plan" (Contrataciones): NO comparte hoja ni
// columnas con ese módulo, para no arriesgar nada de lo que ya funciona.
// Estructura normalizada en 3 hojas, en cascada 1 a muchos, igual que la
// planilla real: Expediente -> Pedido de Compra (PC) -> Posición (línea).
// Las 3 hojas quedan agrupadas y tituladas con el prefijo "Compras - ..."
// para que sea perfectamente identificable que son de este módulo.
//
// IMPORTANTE (corrección de diseño): Matrícula, Detalle de Matrícula, Destino y
// Cantidad viven en la POSICIÓN, no en el PC — porque un mismo Pedido de Compra
// puede tener varias posiciones, cada una con su propia matrícula/cantidad/destino
// (y por lo tanto también sus propias fechas de entrega). El PC es solo el "sobre"
// que agrupa esas posiciones bajo un mismo Adjudicatario; su $ Adjudicado se
// calcula solo, sumando el monto de todas sus posiciones.
// ============================================================

const SHEET_COMPRAS_EXP = 'Compras - Expedientes';
const SHEET_COMPRAS_PC  = 'Compras - Pedidos (PC)';
const SHEET_COMPRAS_POS = 'Compras - Posiciones';

// ---- Hoja "Compras - Expedientes": 1 fila por Expediente ----
// col1: ID_Expediente (interno) | header en fila 1, datos desde fila 2
const COMPRAS_EXP_FIRST_ROW = 2;
const COMPRAS_EXP_LAST_COL = 7;
const COMPRAS_EXP_FIELDS = [
  { key: 'pospre', col: 2, label: 'Pospre' },
  { key: 'expediente', col: 3, label: 'Expediente' },
  { key: 'lp', col: 4, label: 'LP' },
  { key: 'extracto', col: 5, label: 'Extracto' },
  { key: 'presupuestoOficial', col: 6, label: '$ Presupuesto Oficial (sin IVA)' },
  { key: 'observaciones', col: 7, label: 'Observaciones' }
];
// $ Adjudicado Total (derivado, suma de los PC del expediente) va en una columna aparte,
// que se escribe SOLO desde _recalcularRollupExpedienteCompras (nunca desde el formulario).
const COMPRAS_EXP_COL_ADJUDICADO_TOTAL = 8;

// ---- Hoja "Compras - Pedidos (PC)": 1 fila por Pedido de Compra ----
// col1: ID_PC | col2: ID_Expediente (FK)
// Solo tiene 2 campos editables: N° PC y Adjudicatario. Matrícula, Destino, Cantidad y los
// montos viven en las Posiciones (ver más abajo) — el PC es apenas el agrupador.
const COMPRAS_PC_FIRST_ROW = 2;
const COMPRAS_PC_FIELDS = [
  { key: 'nroPC', col: 3, label: 'N° PC' },
  { key: 'adjudicatario', col: 4, label: 'Adjudicatario' }
];
// $ Adjudicado (derivado, suma de las Posiciones de este PC) — igual criterio que el total del
// Expediente: nunca se toca desde el formulario, solo desde _recalcularRollupPCCompras.
const COMPRAS_PC_COL_ADJUDICADO_CALC = 5;
const COMPRAS_PC_LAST_COL = 5;

// ---- Hoja "Compras - Posiciones": 1 fila por línea/posición dentro de un PC ----
// col1: ID_Posicion | col2: ID_PC (FK)
// Acá viven Matrícula, Detalle de Matrícula, Destino y Cantidad — son propios de cada posición,
// porque es lo que distingue una posición de otra dentro del mismo PC (y por eso también tienen
// sus propias fechas de entrega, cada una con su desvío).
const COMPRAS_POS_FIRST_ROW = 2;
// Las columnas 21-23 (Cantidad Planificada y los $ Unitarios) se agregaron después de las
// primeras 20: van al final del rango, no intercaladas, para no correr de lugar ninguna columna
// ya cargada en hojas viejas — ver la migración en _setupCompras().
const COMPRAS_POS_LAST_COL = 23;
const COMPRAS_POS_FIELDS = [
  { key: 'posicion', col: 3, label: 'Posición' },
  { key: 'matricula', col: 4, label: 'Matrícula N°' },
  { key: 'detalleMat', col: 5, label: 'Detalle de Matrícula' },
  { key: 'destino', col: 6, label: 'Destino' },
  { key: 'cantidadFija', col: 7, label: 'Cantidad Fija' },
  { key: 'montoPFija', col: 8, label: '$ P. Fija p/ítems (sin IVA)' },
  { key: 'fechaContratoFija', col: 9, label: 'Fecha de Entrega por Contrato P. Fija' },
  { key: 'fechaRealFija', col: 10, label: 'Fecha de Entrega Real P. Fija' },
  { key: 'partePlanificada', col: 11, label: 'Parte Planificada (Si/No)' },
  { key: 'montoPPlanificada', col: 12, label: '$ P. Planificada (sin IVA)' },
  { key: 'fechaContratoPlanificada', col: 13, label: 'Fecha de Entrega por Contrato P. Planificada' },
  { key: 'fechaRealPlanificada', col: 14, label: 'Fecha de Entrega Real P. Planificada' },
  { key: 'ampliacion', col: 15, label: 'Ampliación (Si/No)' },
  { key: 'pctAmpliacion', col: 16, label: '% de Ampliación' },
  { key: 'montoAmpliacion', col: 17, label: '$ Ampliación (sin IVA)' },
  { key: 'fechaContratoAmpliacion', col: 18, label: 'Fecha de Entrega por Contrato Ampliación' },
  { key: 'fechaRealAmpliacion', col: 19, label: 'Fecha de Entrega Real Ampliación' },
  { key: 'observaciones', col: 20, label: 'Observaciones' },
  { key: 'cantidadPlanificada', col: 21, label: 'Cantidad Planificada' },
  { key: 'montoUnitFija', col: 22, label: '$ Unitario P. Fija (sin IVA)' },
  { key: 'montoUnitPlanificada', col: 23, label: '$ Unitario P. Planificada (sin IVA)' }
];
const COMPRAS_POS_DATE_KEYS = new Set([
  'fechaContratoFija','fechaRealFija','fechaContratoPlanificada',
  'fechaRealPlanificada','fechaContratoAmpliacion','fechaRealAmpliacion'
]);

function _sheetComprasExp() { return _ss().getSheetByName(SHEET_COMPRAS_EXP); }
function _sheetComprasPC()  { return _ss().getSheetByName(SHEET_COMPRAS_PC); }
function _sheetComprasPos() { return _ss().getSheetByName(SHEET_COMPRAS_POS); }

/** Crea las 3 hojas del módulo Compras si no existen. Se llama desde setup(). No toca nada más. */
function _setupCompras() {
  const ss = _ss();

  // Columna técnica de vínculo en "Gestiones Plan" (ver _sincronizarRegistroCompra más abajo).
  const data = _sheetData();
  if (data && data.getRange(HEADER_ROW, COMPRAS_LINK_COLUMN).getValue() === '') {
    data.getRange(HEADER_ROW, COMPRAS_LINK_COLUMN).setValue('ID_Compras_Vinculada (uso interno — no editar)');
  }

  let exp = ss.getSheetByName(SHEET_COMPRAS_EXP);
  if (!exp) {
    exp = ss.insertSheet(SHEET_COMPRAS_EXP);
    const headers = ['ID_Expediente'].concat(COMPRAS_EXP_FIELDS.map(f => f.label));
    headers[COMPRAS_EXP_COL_ADJUDICADO_TOTAL - 1] = '$ Adjudicado Total (calculado)';
    exp.getRange(1, 1, 1, headers.length).setValues([headers]);
    exp.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    exp.setTabColor('#7C3AED');
  }

  let pc = ss.getSheetByName(SHEET_COMPRAS_PC);
  if (!pc) {
    pc = ss.insertSheet(SHEET_COMPRAS_PC);
    const headers = ['ID_PC', 'ID_Expediente'].concat(COMPRAS_PC_FIELDS.map(f => f.label));
    headers[COMPRAS_PC_COL_ADJUDICADO_CALC - 1] = '$ Adjudicado (calculado, suma de sus Posiciones)';
    pc.getRange(1, 1, 1, headers.length).setValues([headers]);
    pc.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    pc.setTabColor('#7C3AED');
  }

  let pos = ss.getSheetByName(SHEET_COMPRAS_POS);
  if (!pos) {
    pos = ss.insertSheet(SHEET_COMPRAS_POS);
    const headers = ['ID_Posicion', 'ID_PC'].concat(COMPRAS_POS_FIELDS.map(f => f.label));
    pos.getRange(1, 1, 1, headers.length).setValues([headers]);
    pos.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    pos.setTabColor('#7C3AED');
  } else if (pos.getLastColumn() < COMPRAS_POS_LAST_COL) {
    // La hoja ya existía de antes (sin Cantidad Planificada ni los $ Unitarios, cols 21-23): se
    // agregan los encabezados que falten al final, sin tocar ninguna columna ni fila existente.
    for (let c = pos.getLastColumn() + 1; c <= COMPRAS_POS_LAST_COL; c++) {
      const campo = COMPRAS_POS_FIELDS.find(f => f.col === c);
      if (!campo) continue;
      pos.getRange(1, c).setValue(campo.label);
      pos.getRange(1, c).setFontWeight('bold');
    }
  }
}

function _hoyStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function _diasEntreFechas(desdeStr, hastaStr) {
  if (!desdeStr || !hastaStr) return null;
  const d1 = new Date(desdeStr + 'T00:00:00');
  const d2 = new Date(hastaStr + 'T00:00:00');
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}
function _formatDateFieldCompras(key, v) {
  if (!COMPRAS_POS_DATE_KEYS.has(key)) return v;
  return _formatDateField(key, v); // reutiliza el parser/formateador flexible ya existente
}

/**
 * Calcula, para UN tramo de entrega (Fija / Planificada / Ampliación), el estado y desvío:
 *  - entregado: true si tiene Fecha de Entrega Real cargada
 *  - desvio (días): si está entregado, Real - Contrato (positivo = tarde, negativo = anticipado).
 *    Si NO está entregado y ya venció la Fecha por Contrato, días vencidos a HOY (dinámico:
 *    se recalcula solo en cada consulta, sin necesidad de guardarlo).
 *  - vencida: true si no está entregado y la Fecha por Contrato ya pasó.
 */
function _estadoTramoEntrega(fechaContrato, fechaReal) {
  if (!fechaContrato) return { entregado: false, desvio: null, vencida: false };
  const entregado = !!fechaReal;
  if (entregado) {
    return { entregado: true, desvio: _diasEntreFechas(fechaContrato, fechaReal), vencida: false };
  }
  const hoy = _hoyStr();
  const vencida = fechaContrato < hoy;
  return { entregado: false, desvio: vencida ? _diasEntreFechas(fechaContrato, hoy) : null, vencida: vencida };
}

function _comprasExpRowToRecord(rowValues, rowIndex) {
  const rec = { _row: rowIndex, _id: rowValues[0] };
  COMPRAS_EXP_FIELDS.forEach(f => { rec[f.key] = rowValues[f.col - 1]; });
  rec.adjudicadoTotal = parseFloat(rowValues[COMPRAS_EXP_COL_ADJUDICADO_TOTAL - 1]) || 0;
  return rec;
}
function _comprasPCRowToRecord(rowValues, rowIndex) {
  const rec = { _row: rowIndex, _id: rowValues[0], idExpediente: rowValues[1] };
  COMPRAS_PC_FIELDS.forEach(f => { rec[f.key] = rowValues[f.col - 1]; });
  rec.adjudicadoCalculado = parseFloat(rowValues[COMPRAS_PC_COL_ADJUDICADO_CALC - 1]) || 0;
  return rec;
}
function _comprasPosRowToRecord(rowValues, rowIndex) {
  const rec = { _row: rowIndex, _id: rowValues[0], idPC: rowValues[1] };
  COMPRAS_POS_FIELDS.forEach(f => { rec[f.key] = _formatDateFieldCompras(f.key, rowValues[f.col - 1]); });
  // Blindaje: si una celda de fecha quedó con un valor que NO es una fecha válida "yyyy-MM-dd"
  // (por ejemplo, datos viejos desalineados por un cambio de columnas anterior), se descarta en
  // vez de dejarla pasar rota — así nunca genera una entrada "fantasma" en el Calendario de
  // Vencimientos que no coincide con ningún día real y desaparece en silencio.
  COMPRAS_POS_DATE_KEYS.forEach(k => {
    if (rec[k] && !/^\d{4}-\d{2}-\d{2}$/.test(String(rec[k]))) rec[k] = '';
  });
  const fija = _estadoTramoEntrega(rec.fechaContratoFija, rec.fechaRealFija);
  const planificada = _estadoTramoEntrega(rec.fechaContratoPlanificada, rec.fechaRealPlanificada);
  const ampliacion = _estadoTramoEntrega(rec.fechaContratoAmpliacion, rec.fechaRealAmpliacion);
  rec.entregadoFija = fija.entregado; rec.desvioFija = fija.desvio; rec.vencidaFija = fija.vencida;
  rec.entregadoPlanificada = planificada.entregado; rec.desvioPlanificada = planificada.desvio; rec.vencidaPlanificada = planificada.vencida;
  rec.entregadoAmpliacion = ampliacion.entregado; rec.desvioAmpliacion = ampliacion.desvio; rec.vencidaAmpliacion = ampliacion.vencida;
  // $ de la posición: suma de los tramos que corresponda (Fija siempre; Planificada solo si
  // "Parte Planificada"=Si; Ampliación solo si "Ampliación"=Si). Es lo que alimenta el rollup del PC.
  rec.montoTotal = (parseFloat(rec.montoPFija) || 0)
    + (String(rec.partePlanificada).toLowerCase() === 'si' ? (parseFloat(rec.montoPPlanificada) || 0) : 0)
    + (String(rec.ampliacion).toLowerCase() === 'si' ? (parseFloat(rec.montoAmpliacion) || 0) : 0);
  return rec;
}

function _listarComprasExpRaw() {
  const sh = _sheetComprasExp();
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_EXP_FIRST_ROW) return [];
  const n = lastRow - COMPRAS_EXP_FIRST_ROW + 1;
  const values = sh.getRange(COMPRAS_EXP_FIRST_ROW, 1, n, COMPRAS_EXP_COL_ADJUDICADO_TOTAL).getValues();
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!values[i][0]) continue;
    out.push(_comprasExpRowToRecord(values[i], COMPRAS_EXP_FIRST_ROW + i));
  }
  return out;
}
function _listarComprasPCRaw() {
  const sh = _sheetComprasPC();
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_PC_FIRST_ROW) return [];
  const n = lastRow - COMPRAS_PC_FIRST_ROW + 1;
  const values = sh.getRange(COMPRAS_PC_FIRST_ROW, 1, n, COMPRAS_PC_LAST_COL).getValues();
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!values[i][0]) continue;
    out.push(_comprasPCRowToRecord(values[i], COMPRAS_PC_FIRST_ROW + i));
  }
  return out;
}
function _listarComprasPosRaw() {
  const sh = _sheetComprasPos();
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_POS_FIRST_ROW) return [];
  const n = lastRow - COMPRAS_POS_FIRST_ROW + 1;
  const values = sh.getRange(COMPRAS_POS_FIRST_ROW, 1, n, COMPRAS_POS_LAST_COL).getValues();
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!values[i][0]) continue;
    out.push(_comprasPosRowToRecord(values[i], COMPRAS_POS_FIRST_ROW + i));
  }
  return out;
}

/** Devuelve el árbol completo Expediente -> Pedidos -> Posiciones, listo para el frontend. */
function _listarCompras() {
  const expedientes = _listarComprasExpRaw();
  const pedidos = _listarComprasPCRaw();
  const posiciones = _listarComprasPosRaw();

  const posPorPC = {};
  posiciones.forEach(p => { (posPorPC[p.idPC] = posPorPC[p.idPC] || []).push(p); });
  pedidos.forEach(pc => { pc.posiciones = (posPorPC[pc._id] || []).sort((a, b) => (parseFloat(a.posicion) || 0) - (parseFloat(b.posicion) || 0)); });

  const pcPorExp = {};
  pedidos.forEach(pc => { (pcPorExp[pc.idExpediente] = pcPorExp[pc.idExpediente] || []).push(pc); });
  expedientes.forEach(exp => { exp.pedidos = pcPorExp[exp._id] || []; });

  return expedientes;
}

function _findComprasExpRowById(id) {
  const sh = _sheetComprasExp();
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_EXP_FIRST_ROW) return -1;
  const ids = sh.getRange(COMPRAS_EXP_FIRST_ROW, 1, lastRow - COMPRAS_EXP_FIRST_ROW + 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return COMPRAS_EXP_FIRST_ROW + i;
  return -1;
}
function _findComprasPCRowById(id) {
  const sh = _sheetComprasPC();
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_PC_FIRST_ROW) return -1;
  const ids = sh.getRange(COMPRAS_PC_FIRST_ROW, 1, lastRow - COMPRAS_PC_FIRST_ROW + 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return COMPRAS_PC_FIRST_ROW + i;
  return -1;
}
function _findComprasPosRowById(id) {
  const sh = _sheetComprasPos();
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_POS_FIRST_ROW) return -1;
  const ids = sh.getRange(COMPRAS_POS_FIRST_ROW, 1, lastRow - COMPRAS_POS_FIRST_ROW + 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return COMPRAS_POS_FIRST_ROW + i;
  return -1;
}

// ---- CRUD Expediente ----
function _crearComprasExpediente(datos) {
  const sh = _sheetComprasExp();
  const newRow = sh.getLastRow() + 1;
  const id = Utilities.getUuid();
  const rowValues = new Array(COMPRAS_EXP_COL_ADJUDICADO_TOTAL).fill('');
  rowValues[0] = id;
  COMPRAS_EXP_FIELDS.forEach(f => {
    if (datos && Object.prototype.hasOwnProperty.call(datos, f.key)) rowValues[f.col - 1] = datos[f.key];
  });
  rowValues[COMPRAS_EXP_COL_ADJUDICADO_TOTAL - 1] = 0;
  sh.getRange(newRow, 1, 1, COMPRAS_EXP_COL_ADJUDICADO_TOTAL).setValues([rowValues]);
  _sincronizarRegistroCompra(id);
  return id;
}
function _actualizarComprasExpediente(id, datos) {
  const row = _findComprasExpRowById(id);
  if (row === -1) throw new Error('Expediente de Compras no encontrado.');
  const sh = _sheetComprasExp();
  COMPRAS_EXP_FIELDS.forEach(f => {
    if (!datos || !Object.prototype.hasOwnProperty.call(datos, f.key)) return;
    sh.getRange(row, f.col).setValue(datos[f.key]);
  });
  _sincronizarRegistroCompra(id);
}
function _eliminarComprasExpediente(id) {
  const row = _findComprasExpRowById(id);
  if (row === -1) throw new Error('Expediente de Compras no encontrado.');
  // Cascada: elimina también sus Pedidos (PC) y las Posiciones de esos PC.
  _listarComprasPCRaw().filter(pc => pc.idExpediente === id).forEach(pc => _eliminarComprasPC(pc._id, true));
  _sheetComprasExp().deleteRow(row);
  _sincronizarRegistroCompra(id); // el Expediente ya no existe: esto borra su fila espejo en Gestiones Plan
}

// ---- CRUD Pedido de Compra (PC) ----
function _crearComprasPC(datos) {
  if (!datos || !datos.idExpediente) throw new Error('Falta indicar a qué Expediente pertenece este Pedido de Compra.');
  const sh = _sheetComprasPC();
  const newRow = sh.getLastRow() + 1;
  const id = Utilities.getUuid();
  const rowValues = new Array(COMPRAS_PC_LAST_COL).fill('');
  rowValues[0] = id;
  rowValues[1] = datos.idExpediente;
  COMPRAS_PC_FIELDS.forEach(f => {
    if (Object.prototype.hasOwnProperty.call(datos, f.key)) rowValues[f.col - 1] = datos[f.key];
  });
  rowValues[COMPRAS_PC_COL_ADJUDICADO_CALC - 1] = 0;
  sh.getRange(newRow, 1, 1, COMPRAS_PC_LAST_COL).setValues([rowValues]);
  _sincronizarRegistroCompra(datos.idExpediente); // el Adjudicatario de este PC puede cambiar la lista de adjudicatarios de la fila espejo
  return id;
}
function _actualizarComprasPC(id, datos) {
  const row = _findComprasPCRowById(id);
  if (row === -1) throw new Error('Pedido de Compra no encontrado.');
  const sh = _sheetComprasPC();
  const idExpediente = sh.getRange(row, 2).getValue();
  COMPRAS_PC_FIELDS.forEach(f => {
    if (!datos || !Object.prototype.hasOwnProperty.call(datos, f.key)) return;
    sh.getRange(row, f.col).setValue(datos[f.key]);
  });
  _sincronizarRegistroCompra(idExpediente);
}
function _eliminarComprasPC(id, esCascada) {
  const row = _findComprasPCRowById(id);
  if (row === -1) throw new Error('Pedido de Compra no encontrado.');
  const sh = _sheetComprasPC();
  const idExpediente = sh.getRange(row, 2).getValue();
  // Cascada: elimina las Posiciones de este PC.
  _listarComprasPosRaw().filter(p => p.idPC === id).forEach(p => _sheetComprasPos().deleteRow(_findComprasPosRowById(p._id)));
  sh.deleteRow(row);
  if (!esCascada) _recalcularRollupExpedienteCompras(idExpediente);
}

// ---- CRUD Posición ----
function _crearComprasPos(datos) {
  if (!datos || !datos.idPC) throw new Error('Falta indicar a qué Pedido de Compra pertenece esta Posición.');
  const sh = _sheetComprasPos();
  const newRow = sh.getLastRow() + 1;
  const id = Utilities.getUuid();
  const rowValues = new Array(COMPRAS_POS_LAST_COL).fill('');
  rowValues[0] = id;
  rowValues[1] = datos.idPC;
  COMPRAS_POS_FIELDS.forEach(f => {
    if (Object.prototype.hasOwnProperty.call(datos, f.key)) rowValues[f.col - 1] = datos[f.key];
  });
  sh.getRange(newRow, 1, 1, COMPRAS_POS_LAST_COL).setValues([rowValues]);
  _recalcularRollupPCCompras(datos.idPC);
  return id;
}
function _actualizarComprasPos(id, datos) {
  const row = _findComprasPosRowById(id);
  if (row === -1) throw new Error('Posición no encontrada.');
  const sh = _sheetComprasPos();
  const idPC = sh.getRange(row, 2).getValue();
  COMPRAS_POS_FIELDS.forEach(f => {
    if (!datos || !Object.prototype.hasOwnProperty.call(datos, f.key)) return;
    sh.getRange(row, f.col).setValue(datos[f.key]);
  });
  _recalcularRollupPCCompras(idPC);
}
function _eliminarComprasPos(id) {
  const row = _findComprasPosRowById(id);
  if (row === -1) throw new Error('Posición no encontrada.');
  const sh = _sheetComprasPos();
  const idPC = sh.getRange(row, 2).getValue();
  sh.deleteRow(row);
  _recalcularRollupPCCompras(idPC);
}

/** $ Adjudicado del PC = suma del $ de todas sus Posiciones (Fija + Planificada + Ampliación,
 *  según corresponda a cada una). Después empuja el recálculo hacia el Expediente. */
function _recalcularRollupPCCompras(idPC) {
  if (!idPC) return;
  const total = _listarComprasPosRaw()
    .filter(p => p.idPC === idPC)
    .reduce((acc, p) => acc + (parseFloat(p.montoTotal) || 0), 0);
  const row = _findComprasPCRowById(idPC);
  if (row === -1) return;
  const sh = _sheetComprasPC();
  sh.getRange(row, COMPRAS_PC_COL_ADJUDICADO_CALC).setValue(total);
  const idExpediente = sh.getRange(row, 2).getValue();
  _recalcularRollupExpedienteCompras(idExpediente);
}

/** $ Adjudicado Total del Expediente = suma del $ Adjudicado (ya calculado) de todos sus PC.
 *  Al final sincroniza la fila espejo en Gestiones Plan, para que Registros/Dashboard siempre
 *  reflejen el total actualizado (esto cubre también los cambios de PC y de Posiciones, porque
 *  ambos rollups terminan disparando este mismo recálculo del Expediente). */
function _recalcularRollupExpedienteCompras(idExpediente) {
  if (!idExpediente) return;
  const total = _listarComprasPCRaw()
    .filter(pc => pc.idExpediente === idExpediente)
    .reduce((acc, pc) => acc + (parseFloat(pc.adjudicadoCalculado) || 0), 0);
  const row = _findComprasExpRowById(idExpediente);
  if (row === -1) return;
  _sheetComprasExp().getRange(row, COMPRAS_EXP_COL_ADJUDICADO_TOTAL).setValue(total);
  _sincronizarRegistroCompra(idExpediente);
}

/**
 * Importación masiva desde Excel: recibe un array de "expedientes" ya reconstruidos en el
 * FRONTEND a partir de la planilla (rellenando hacia abajo las celdas repetidas del Excel
 * original), cada uno con sus `pedidos[]` y, dentro, `posiciones[]`. Hace UPSERT (no duplica
 * si se vuelve a importar el mismo archivo):
 *  - Expediente: se identifica por el texto de "Expediente".
 *  - PC: se identifica por "N° PC" dentro del Expediente.
 *  - Posición: se identifica por el número de "Posición" dentro del PC.
 */
function _comprasImportar(expedientesImport) {
  if (!Array.isArray(expedientesImport)) throw new Error('Formato de importación inválido.');
  const existentes = _listarCompras();
  const expPorNumero = {};
  existentes.forEach(e => { if (e.expediente) expPorNumero[String(e.expediente).trim()] = e; });

  let expCreados = 0, expActualizados = 0, pcCreados = 0, pcActualizados = 0, posCreados = 0, posActualizados = 0;

  expedientesImport.forEach(expImp => {
    const claveExp = String(expImp.expediente || '').trim();
    if (!claveExp) return; // sin N° de expediente no se puede identificar, se omite
    let exp = expPorNumero[claveExp];
    const datosExp = {
      pospre: expImp.pospre || '', expediente: claveExp, lp: expImp.lp || '',
      extracto: expImp.extracto || '', presupuestoOficial: expImp.presupuestoOficial || 0,
      observaciones: expImp.observaciones || ''
    };
    if (!exp) {
      const id = _crearComprasExpediente(datosExp);
      exp = { _id: id, expediente: claveExp, pedidos: [] };
      expPorNumero[claveExp] = exp;
      expCreados++;
    } else {
      _actualizarComprasExpediente(exp._id, datosExp);
      expActualizados++;
    }

    const pcPorNumero = {};
    (exp.pedidos || []).forEach(pc => { if (pc.nroPC) pcPorNumero[String(pc.nroPC).trim()] = pc; });

    (expImp.pedidos || []).forEach(pcImp => {
      const clavePC = String(pcImp.nroPC || '').trim();
      if (!clavePC) return;
      let pc = pcPorNumero[clavePC];
      const datosPC = { idExpediente: exp._id, nroPC: clavePC, adjudicatario: pcImp.adjudicatario || '' };
      if (!pc) {
        const idPC = _crearComprasPC(datosPC);
        pc = { _id: idPC, nroPC: clavePC, posiciones: [] };
        pcPorNumero[clavePC] = pc;
        pcCreados++;
      } else {
        _actualizarComprasPC(pc._id, datosPC);
        pcActualizados++;
      }

      const posPorNumero = {};
      (pc.posiciones || []).forEach(p => { if (p.posicion !== undefined && p.posicion !== '') posPorNumero[String(p.posicion).trim()] = p; });

      (pcImp.posiciones || []).forEach(posImp => {
        const clavePos = String(posImp.posicion || '').trim();
        if (!clavePos) return;
        const existente = posPorNumero[clavePos];
        const datosPos = { idPC: pc._id, posicion: clavePos };
        COMPRAS_POS_FIELDS.forEach(f => {
          if (f.key === 'posicion') return;
          if (Object.prototype.hasOwnProperty.call(posImp, f.key)) datosPos[f.key] = posImp[f.key];
        });
        if (!existente) { _crearComprasPos(datosPos); posCreados++; }
        else { _actualizarComprasPos(existente._id, datosPos); posActualizados++; }
      });
    });
  });

  return { expCreados, expActualizados, pcCreados, pcActualizados, posCreados, posActualizados };
}

/**
 * SINCRONIZACIÓN AUTOMÁTICA CON "Gestiones Plan" (Contrataciones / Registros)
 * ------------------------------------------------------------
 * Cada Expediente de Compras tiene una fila espejo en "Gestiones Plan", para que aparezca en
 * Registros y en el Dashboard exactamente como un trámite más (mismos filtros, mismos totales).
 * El vínculo entre ambas filas se guarda en una columna técnica NUEVA, más allá de todo lo que
 * usa Contrataciones (columna AL, después de ID_Interno en AK) — invisible para el flujo normal
 * de carga/edición de trámites, y no reutiliza ni pisa ninguna columna existente.
 *
 * Solo se completan los campos que tienen sentido para una Compra: Pospre, Año (tomado del N° de
 * Expediente si sigue el formato "1-AAAA-...", si no queda vacío), Rubro="Compras" (para poder
 * filtrarlas fácil), Detalle de Rubro = Extracto, Expediente, Sucursal/Área (unión de los Destino
 * de todas las Posiciones del Expediente — es el mismo dato, solo que en Compras vive a nivel
 * Posición y en Contrataciones a nivel trámite), $ Presupuesto Oficial, Adjudicatario (unión de
 * los adjudicatarios de sus PC) y $ Total Adjudicado. Las fechas de vencimiento (Fecha Fin de
 * Contrato / Ampliada) se dejan vacías a propósito: los vencimientos de Compras ya se muestran en
 * el mismo Calendario de Vencimientos a través de sus Posiciones — completarlas acá también
 * duplicaría la alerta. El resto de los campos (Estado, Certificaciones, Proyectos, etc.) no
 * aplican a Compras y quedan en blanco/0, sin afectar nada de Contrataciones.
 */
const COMPRAS_LINK_COLUMN = 38; // columna AL: ID del Expediente de Compras que generó esta fila (uso interno, no se muestra ni se edita)

function _anioDesdeExpediente(expedienteStr) {
  const m = String(expedienteStr || '').match(/-(\d{4})-/);
  return m ? m[1] : '';
}
function _findRegistroRowByComprasId(idCompra) {
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return -1;
  const n = lastRow - FIRST_DATA_ROW + 1;
  const ids = sh.getRange(FIRST_DATA_ROW, COMPRAS_LINK_COLUMN, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    if (ids[i][0] === idCompra) return FIRST_DATA_ROW + i;
  }
  return -1;
}

/** Crea o actualiza la fila espejo en "Gestiones Plan" para un Expediente de Compras. Si el
 *  Expediente ya no existe (se eliminó), borra la fila espejo. Se llama automáticamente cada vez
 *  que cambia algo que afecta el resumen (alta/edición del Expediente, o recálculo de rollup). */
function _sincronizarRegistroCompra(idExpedienteCompra) {
  if (!idExpedienteCompra) return;
  const sh = _sheetData();
  const filaVinculada = _findRegistroRowByComprasId(idExpedienteCompra);
  const exp = _listarCompras().find(e => e._id === idExpedienteCompra);

  if (!exp) {
    if (filaVinculada !== -1) sh.deleteRow(filaVinculada);
    return;
  }

  const adjudicatarios = [];
  (exp.pedidos || []).forEach(pc => {
    if (pc.adjudicatario && adjudicatarios.indexOf(pc.adjudicatario) === -1) adjudicatarios.push(pc.adjudicatario);
  });

  // Destino vive en cada Posición (no en el Expediente ni en el PC), así que la fila espejo toma
  // la unión de todos los Destino distintos que aparezcan en las Posiciones de este Expediente —
  // mismo criterio que ya se usa para juntar los Adjudicatarios de varios PC en un solo campo.
  // Nota: si un usuario tiene Sucursales Restringidas asignadas (ver _filtrarPorSucursalesRestringidas),
  // esa comparación es exacta — un Expediente con varios Destino distintos queda con un valor
  // combinado (ej. "Rosario Norte, Rosario Oeste") que no calza con ninguna sucursal individual, y
  // por lo tanto no se le mostraría a un usuario restringido a una sola de esas sucursales.
  const destinos = [];
  (exp.pedidos || []).forEach(pc => {
    (pc.posiciones || []).forEach(pos => {
      if (pos.destino && destinos.indexOf(pos.destino) === -1) destinos.push(pos.destino);
    });
  });

  const valores = {
    pospre: exp.pospre || '',
    anio: _anioDesdeExpediente(exp.expediente),
    rubro: 'Compras',
    detalleRubro: exp.extracto || '',
    expediente: exp.expediente || '',
    sucursal: destinos.join(', '),
    presupuestoOficialRubro: exp.presupuestoOficial || 0,
    adjudicatario: adjudicatarios.join(', '),
    totalAdjudicado: exp.adjudicadoTotal || 0,
    observaciones: 'Generado automáticamente desde el módulo Compras.' + (exp.observaciones ? ' ' + exp.observaciones : '')
  };

  let row = filaVinculada;
  if (row === -1) {
    row = sh.getLastRow() + 1;
    sh.getRange(row, ID_COLUMN).setValue(Utilities.getUuid());
    sh.getRange(row, COMPRAS_LINK_COLUMN).setValue(idExpedienteCompra);
  }
  FIELDS.forEach(f => {
    if (Object.prototype.hasOwnProperty.call(valores, f.key)) {
      sh.getRange(row, f.col).setValue(_numOrRaw(f.key, valores[f.key]));
    }
  });
}

// ============================================================
// MÓDULO DE COMPRAS v2 — TRÁMITES (modelo plano) + ENTREGAS
// ------------------------------------------------------------
// Reemplaza, de a poco, al árbol Expediente -> PC -> Posición de arriba: acá 1 fila = 1 trámite
// (una matrícula, o un renglón "global" si no hace falta desglosar). El N° de Expediente y el
// N° de Pedido de Compras dejan de ser contenedores que hay que crear de antemano — son datos
// más de cada trámite, y agrupar "qué trámites comparten Expediente/PC" es simplemente agrupar
// filas que repiten ese número (igual criterio que ya usa el Dashboard para agrupar por Pospre).
//
// CONVIVE EN PARALELO con las hojas viejas (Compras - Expedientes/Pedidos/Posiciones) — no se
// borra ni se deja de sincronizar nada de ahí todavía. La migración (_migrarComprasATramites) es
// aditiva: lee el árbol viejo y crea Trámites nuevos, sin tocarlo.
// ============================================================

// ---- Hoja "Compras - Trámites": 1 fila por trámite (matrícula o renglón global) ----
const SHEET_COMPRAS_TRAMITES = 'Compras - Trámites';
const COMPRAS_TRAMITES_FIRST_ROW = 2;
// Columna técnica 20 (ver más abajo, COMPRAS_MIGRACION_COL_ORIGEN) queda RESERVADA entre los
// campos de negocio (2-19) y este último (21) — no se reordena para no correr de lugar ninguna
// columna ya cargada en una hoja creada con una versión anterior de este módulo.
const COMPRAS_TRAMITES_LAST_COL = 24;
// Columna técnica 20, aparte de COMPRAS_TRAMITES_FIELDS: guarda el _id de la Posición del modelo
// viejo que originó este trámite, SOLO en los trámites que vinieron de la migración (para no
// migrar la misma Posición dos veces si se corre la migración de nuevo). En trámites cargados
// directo en el modelo nuevo queda vacía.
const COMPRAS_MIGRACION_COL_ORIGEN = 20;
const COMPRAS_TRAMITES_FIELDS = [
  { key: 'pospre', col: 2, label: 'Pospre' },
  { key: 'expediente', col: 3, label: 'Expediente' },
  // Año SE CARGA A MANO — no se deduce del N° de Expediente. Representa el año en el que el pago
  // se va a imputar (el "Plan"), que puede no coincidir con el año que figura en el Expediente
  // (ej.: expediente abierto en 2025 con pago presupuestado para 2026). Mismo criterio que ya usa
  // Registros con su campo "Año de la Gestión".
  { key: 'anio', col: 22, label: 'Año (de imputación del pago / Plan)' },
  { key: 'extracto', col: 4, label: 'Extracto' },
  { key: 'sucursal', col: 5, label: 'Sucursal / Destino' },
  { key: 'matricula', col: 6, label: 'Matrícula N°' },
  { key: 'detalleMat', col: 7, label: 'Detalle de Matrícula' },
  { key: 'cantidad', col: 8, label: 'Cantidad' },
  { key: 'montoUnitOficial', col: 9, label: '$ Unitario Oficial (sin IVA)' },
  { key: 'montoSubtotalOficial', col: 10, label: '$ Subtotal Oficial (sin IVA)' },
  { key: 'fechaApertura', col: 11, label: 'Fecha de Apertura' },
  { key: 'cantidadPlanificada', col: 12, label: 'Cantidad Planificada (tope)' },
  // Plazo de entrega "de base" del trámite: se declara ya en el Inicio (suele venir fijado en el
  // pliego, antes de saber quién gana ni cuándo va a salir la Orden de Compra). Cuando después se
  // carga una Entrega, su "Plazo (días desde Fecha de PC)" arranca autocompletado con este valor
  // — se puede ajustar por Entrega si hace falta, pero no hay que volver a escribirlo cada vez.
  { key: 'plazoEntrega', col: 21, label: 'Plazo de Entrega (días desde la Fecha de PC)' },
  { key: 'montoUnitAdjudicado', col: 13, label: '$ Unitario Adjudicado (sin IVA)' },
  { key: 'montoSubtotalAdjudicado', col: 14, label: '$ Subtotal Adjudicado (sin IVA)' },
  { key: 'contratista', col: 15, label: 'Contratista / Oferente' },
  { key: 'nroPC', col: 16, label: 'N° de Pedido de Compras' },
  { key: 'fechaPC', col: 17, label: 'Fecha de PC' },
  { key: 'estado', col: 18, label: 'Estado' },
  { key: 'observaciones', col: 19, label: 'Observaciones' },
  // Mismo par de campos, misma clave y mismo significado que en FIELDS (Contrataciones) — ver el
  // comentario grande junto a ESTADIOS_ADMINISTRATIVOS (cerca de STAGES). No se reinventa acá.
  { key: 'estadioActual', col: 23, label: 'Estadío Administrativo Actual' },
  { key: 'estadioDesde', col: 24, label: 'En este Estadío desde' }
];
const COMPRAS_TRAMITES_DATE_KEYS = new Set(['fechaApertura', 'fechaPC', 'estadioDesde']);
const COMPRAS_TRAMITES_ESTADOS = ['Adjudicado', 'Desierto', 'Relanzado', 'Finalizado'];

// ---- Hoja "Compras - Entregas": N filas por trámite, mismo patrón que "Certificaciones" ----
const SHEET_COMPRAS_ENTREGAS = 'Compras - Entregas';
const COMPRAS_ENTREGAS_ID_COLUMN = 1;
const COMPRAS_ENTREGAS_TRAMITE_ID_COLUMN = 2;
const COMPRAS_ENTREGAS_FIRST_ROW = 2;
const COMPRAS_ENTREGAS_LAST_COL = 9;
const COMPRAS_ENTREGAS_FIELDS = [
  { key: 'tipo', col: 3, label: 'Tipo (Oficial / Planificada / Ampliación)' },
  { key: 'cantidad', col: 4, label: 'Cantidad de esta entrega' },
  { key: 'monto', col: 5, label: '$ de esta entrega (sin IVA)' },
  { key: 'plazo', col: 6, label: 'Plazo (días desde Fecha de PC)' },
  { key: 'fechaContractual', col: 7, label: 'Fecha Contractual' },
  { key: 'fechaReal', col: 8, label: 'Fecha Real de Entrega' },
  { key: 'observaciones', col: 9, label: 'Observaciones' }
];
const COMPRAS_ENTREGAS_DATE_KEYS = new Set(['fechaContractual', 'fechaReal']);
const COMPRAS_ENTREGAS_TIPOS = ['Oficial', 'Planificada', 'Ampliación'];

// Tope legal de Ampliación: hasta 30% de (Fija adjudicada + Planificada ya gestionada) de TODO
// el Pedido de Compras — constante fija, no varía por contrato. Ver _listarComprasTramitesConSaldos.
const COMPRAS_AMPLIACION_PCT_MAXIMO = 0.30;

function _sheetComprasTramites() { return _ss().getSheetByName(SHEET_COMPRAS_TRAMITES); }
function _sheetComprasEntregas() { return _ss().getSheetByName(SHEET_COMPRAS_ENTREGAS); }

/** Crea las 2 hojas nuevas si no existen, y les agrega columnas si ya existían de una versión
 *  anterior de este mismo módulo nuevo (mismo criterio que la migración de columnas de Certifi-
 *  caciones). No toca absolutamente nada de las hojas del modelo viejo (Expedientes/PC/Posiciones). */
function _setupComprasTramites() {
  const ss = _ss();

  // Columna técnica de vínculo en "Gestiones Plan" para la sincronización por TRÁMITE (aparte de
  // COMPRAS_LINK_COLUMN, que es la del modelo viejo por EXPEDIENTE — conviven sin pisarse).
  const data = _sheetData();
  if (data && data.getRange(HEADER_ROW, COMPRAS_TRAMITE_LINK_COLUMN).getValue() === '') {
    data.getRange(HEADER_ROW, COMPRAS_TRAMITE_LINK_COLUMN).setValue('ID_Compras_Tramite_Vinculado (uso interno — no editar)');
  }

  let tr = ss.getSheetByName(SHEET_COMPRAS_TRAMITES);
  const comprasTramitesMaxCol = Math.max(COMPRAS_TRAMITES_LAST_COL, COMPRAS_MIGRACION_COL_ORIGEN);
  if (!tr) {
    tr = ss.insertSheet(SHEET_COMPRAS_TRAMITES);
    // Se arma por posición explícita (headers[f.col - 1] = ...), NO por concat secuencial: los
    // campos de COMPRAS_TRAMITES_FIELDS ya no caen en columnas consecutivas (col 21 quedó después
    // de la columna técnica 20), así que un concat a secas los desalinearía.
    const headers = new Array(comprasTramitesMaxCol).fill('');
    headers[0] = 'ID_Tramite';
    COMPRAS_TRAMITES_FIELDS.forEach(f => { headers[f.col - 1] = f.label; });
    headers[COMPRAS_MIGRACION_COL_ORIGEN - 1] = 'ID_Posición_Origen (migración, uso interno — no editar)';
    tr.getRange(1, 1, 1, headers.length).setValues([headers]);
    tr.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    tr.setTabColor('#0EA5E9');
  } else if (tr.getLastColumn() < comprasTramitesMaxCol) {
    // La hoja ya existía de una versión anterior de este módulo (por ejemplo, sin la columna 21 de
    // Plazo de Entrega): se agregan los encabezados que falten al final, sin tocar ninguna columna
    // ni fila existente — mismo criterio que la migración de columnas de "Compras - Posiciones".
    for (let c = tr.getLastColumn() + 1; c <= comprasTramitesMaxCol; c++) {
      let label = '';
      if (c === COMPRAS_MIGRACION_COL_ORIGEN) label = 'ID_Posición_Origen (migración, uso interno — no editar)';
      else { const campo = COMPRAS_TRAMITES_FIELDS.find(f => f.col === c); if (campo) label = campo.label; }
      if (!label) continue;
      tr.getRange(1, c).setValue(label);
      tr.getRange(1, c).setFontWeight('bold');
    }
  }

  let en = ss.getSheetByName(SHEET_COMPRAS_ENTREGAS);
  if (!en) {
    en = ss.insertSheet(SHEET_COMPRAS_ENTREGAS);
    const headers = ['ID_Entrega', 'ID_Tramite'].concat(COMPRAS_ENTREGAS_FIELDS.map(f => f.label));
    en.getRange(1, 1, 1, headers.length).setValues([headers]);
    en.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    en.setTabColor('#0EA5E9');
  }
}

// ---- Lectura: Trámites ----
function _comprasTramiteRowToRecord(rowValues, rowIndex) {
  const rec = { _row: rowIndex, _id: rowValues[0] };
  COMPRAS_TRAMITES_FIELDS.forEach(f => {
    rec[f.key] = COMPRAS_TRAMITES_DATE_KEYS.has(f.key) ? _formatDateField(f.key, rowValues[f.col - 1]) : rowValues[f.col - 1];
  });
  return rec;
}
function _listarComprasTramitesRaw() {
  const sh = _sheetComprasTramites();
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_TRAMITES_FIRST_ROW) return [];
  const n = lastRow - COMPRAS_TRAMITES_FIRST_ROW + 1;
  const values = sh.getRange(COMPRAS_TRAMITES_FIRST_ROW, 1, n, COMPRAS_TRAMITES_LAST_COL).getValues();
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!values[i][0]) continue; // fila vacía
    out.push(_comprasTramiteRowToRecord(values[i], COMPRAS_TRAMITES_FIRST_ROW + i));
  }
  return out;
}
function _findComprasTramiteRowById(id) {
  const sh = _sheetComprasTramites();
  if (!sh) return -1;
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_TRAMITES_FIRST_ROW) return -1;
  const n = lastRow - COMPRAS_TRAMITES_FIRST_ROW + 1;
  const ids = sh.getRange(COMPRAS_TRAMITES_FIRST_ROW, 1, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    if (ids[i][0] === id) return COMPRAS_TRAMITES_FIRST_ROW + i;
  }
  return -1;
}

// ---- Lectura: Entregas ----
function _comprasEntregaRowToRecord(rowValues, rowIndex) {
  const rec = { _row: rowIndex, _id: rowValues[0], idTramite: rowValues[1] };
  COMPRAS_ENTREGAS_FIELDS.forEach(f => {
    rec[f.key] = COMPRAS_ENTREGAS_DATE_KEYS.has(f.key) ? _formatDateField(f.key, rowValues[f.col - 1]) : rowValues[f.col - 1];
  });
  // Mismo cálculo de entregado/desvío/vencida que ya usaba cada tramo de Posición en el modelo
  // viejo (_estadoTramoEntrega) — acá se aplica igual a CADA Entrega, sin importar su Tipo.
  const estado = _estadoTramoEntrega(rec.fechaContractual, rec.fechaReal);
  rec.entregado = estado.entregado; rec.desvio = estado.desvio; rec.vencida = estado.vencida;
  return rec;
}
function _listarComprasEntregas(idTramiteFiltro) {
  const sh = _sheetComprasEntregas();
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_ENTREGAS_FIRST_ROW) return [];
  const n = lastRow - COMPRAS_ENTREGAS_FIRST_ROW + 1;
  const values = sh.getRange(COMPRAS_ENTREGAS_FIRST_ROW, 1, n, COMPRAS_ENTREGAS_LAST_COL).getValues();
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = values[i];
    if (!row[COMPRAS_ENTREGAS_ID_COLUMN - 1]) continue;
    if (idTramiteFiltro && row[COMPRAS_ENTREGAS_TRAMITE_ID_COLUMN - 1] !== idTramiteFiltro) continue;
    out.push(_comprasEntregaRowToRecord(row, COMPRAS_ENTREGAS_FIRST_ROW + i));
  }
  return out;
}
function _findComprasEntregaRowById(id) {
  const sh = _sheetComprasEntregas();
  if (!sh) return -1;
  const lastRow = sh.getLastRow();
  if (lastRow < COMPRAS_ENTREGAS_FIRST_ROW) return -1;
  const n = lastRow - COMPRAS_ENTREGAS_FIRST_ROW + 1;
  const ids = sh.getRange(COMPRAS_ENTREGAS_FIRST_ROW, COMPRAS_ENTREGAS_ID_COLUMN, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    if (ids[i][0] === id) return COMPRAS_ENTREGAS_FIRST_ROW + i;
  }
  return -1;
}

/**
 * Arma la lista de Trámites lista para el frontend, con sus Entregas anidadas y todos los saldos
 * ya calculados (nunca se guardan, siempre se recalculan de las Entregas reales):
 *  - Cantidad Entregada (Oficial), Cantidad Planificada Gestionada/Disponible: por trámite.
 *  - Resumen de Ampliación: agrupando TODOS los trámites que comparten el mismo N° de PC, porque
 *    el tope del 30% aplica al Pedido de Compra entero, no a una matrícula individual.
 */
function _listarComprasTramitesConSaldos() {
  const tramites = _listarComprasTramitesRaw();
  const entregas = _listarComprasEntregas();

  const entregasPorTramite = {};
  entregas.forEach(e => { (entregasPorTramite[e.idTramite] = entregasPorTramite[e.idTramite] || []).push(e); });

  const baseAmpliacionPorPC = {};
  const gestionadoAmpliacionPorPC = {};

  tramites.forEach(t => {
    const propias = entregasPorTramite[t._id] || [];
    t.entregas = propias;
    t.cantidadEntregadaOficial = propias.filter(e => e.tipo === 'Oficial').reduce((a, e) => a + (parseFloat(e.cantidad) || 0), 0);
    t.cantidadPlanificadaGestionada = propias.filter(e => e.tipo === 'Planificada').reduce((a, e) => a + (parseFloat(e.cantidad) || 0), 0);
    t.cantidadPlanificadaDisponible = (parseFloat(t.cantidadPlanificada) || 0) - t.cantidadPlanificadaGestionada;
    t._montoPlanificadaGestionada = propias.filter(e => e.tipo === 'Planificada').reduce((a, e) => a + (parseFloat(e.monto) || 0), 0);
    t._montoAmpliacionGestionadaPropia = propias.filter(e => e.tipo === 'Ampliación').reduce((a, e) => a + (parseFloat(e.monto) || 0), 0);

    if (t.nroPC) {
      const pc = String(t.nroPC).trim();
      baseAmpliacionPorPC[pc] = (baseAmpliacionPorPC[pc] || 0) + (parseFloat(t.montoSubtotalAdjudicado) || 0) + t._montoPlanificadaGestionada;
      gestionadoAmpliacionPorPC[pc] = (gestionadoAmpliacionPorPC[pc] || 0) + t._montoAmpliacionGestionadaPropia;
    }
  });

  tramites.forEach(t => {
    if (t.nroPC) {
      const pc = String(t.nroPC).trim();
      t.ampliacionBasePC = baseAmpliacionPorPC[pc] || 0;
      t.ampliacionTopePC = t.ampliacionBasePC * COMPRAS_AMPLIACION_PCT_MAXIMO;
      t.ampliacionGestionadoPC = gestionadoAmpliacionPorPC[pc] || 0;
      t.ampliacionDisponiblePC = t.ampliacionTopePC - t.ampliacionGestionadoPC;
    } else {
      t.ampliacionBasePC = 0; t.ampliacionTopePC = 0; t.ampliacionGestionadoPC = 0; t.ampliacionDisponiblePC = 0;
    }
    delete t._montoPlanificadaGestionada;
    delete t._montoAmpliacionGestionadaPropia;
  });

  return tramites;
}

// ---- CRUD Trámite ----
function _crearComprasTramite(datos) {
  const sh = _sheetComprasTramites();
  const newRow = sh.getLastRow() + 1;
  const id = Utilities.getUuid();
  // Mismo criterio que _crearRegistro: si ya viene con un Estadío elegido, se completa su fecha.
  _aplicarCambioEstadio(datos, '');
  const rowValues = new Array(Math.max(COMPRAS_TRAMITES_LAST_COL, COMPRAS_MIGRACION_COL_ORIGEN)).fill('');
  rowValues[0] = id;
  COMPRAS_TRAMITES_FIELDS.forEach(f => {
    if (datos && Object.prototype.hasOwnProperty.call(datos, f.key)) {
      rowValues[f.col - 1] = _numOrRaw(f.key, datos[f.key]);
    }
  });
  sh.getRange(newRow, 1, 1, rowValues.length).setValues([rowValues]);
  _sincronizarRegistroTramiteCompra(id);
  return id;
}
function _actualizarComprasTramite(id, datos) {
  const row = _findComprasTramiteRowById(id);
  if (row === -1) throw new Error('Trámite de Compras no encontrado.');
  const sh = _sheetComprasTramites();
  // Mismo criterio que _actualizarRegistro: si cambió el Estadío respecto del que ya estaba
  // guardado, se completa su fecha (hoy, salvo que ya haya venido una propia) — ver
  // _aplicarCambioEstadio().
  const colEstadioActual = _colDeCampo(COMPRAS_TRAMITES_FIELDS, 'estadioActual');
  const estadioActualPrevio = colEstadioActual > 0 ? sh.getRange(row, colEstadioActual).getValue() : '';
  _aplicarCambioEstadio(datos, estadioActualPrevio);
  COMPRAS_TRAMITES_FIELDS.forEach(f => {
    if (!datos || !Object.prototype.hasOwnProperty.call(datos, f.key)) return;
    sh.getRange(row, f.col).setValue(_numOrRaw(f.key, datos[f.key]));
  });
  _sincronizarRegistroTramiteCompra(id);
}
function _eliminarComprasTramite(id) {
  const row = _findComprasTramiteRowById(id);
  if (row === -1) throw new Error('Trámite de Compras no encontrado.');
  // Cascada: elimina también sus Entregas.
  _listarComprasEntregas(id).forEach(e => {
    const r = _findComprasEntregaRowById(e._id);
    if (r !== -1) _sheetComprasEntregas().deleteRow(r);
  });
  _sheetComprasTramites().deleteRow(row);
  _sincronizarRegistroTramiteCompra(id); // el trámite ya no existe: esto borra su fila espejo en Gestiones Plan
}

// ---- CRUD Entrega ----
function _crearComprasEntrega(datos) {
  if (!datos || !datos.idTramite) throw new Error('Falta indicar a qué trámite corresponde esta entrega.');
  const sh = _sheetComprasEntregas();
  const newRow = sh.getLastRow() + 1;
  const id = Utilities.getUuid();
  const rowValues = new Array(COMPRAS_ENTREGAS_LAST_COL).fill('');
  rowValues[COMPRAS_ENTREGAS_ID_COLUMN - 1] = id;
  rowValues[COMPRAS_ENTREGAS_TRAMITE_ID_COLUMN - 1] = datos.idTramite;
  COMPRAS_ENTREGAS_FIELDS.forEach(f => {
    if (Object.prototype.hasOwnProperty.call(datos, f.key)) rowValues[f.col - 1] = _numOrRaw(f.key, datos[f.key]);
  });
  sh.getRange(newRow, 1, 1, COMPRAS_ENTREGAS_LAST_COL).setValues([rowValues]);
  return id;
}
function _actualizarComprasEntrega(id, datos) {
  const row = _findComprasEntregaRowById(id);
  if (row === -1) throw new Error('Entrega no encontrada.');
  const sh = _sheetComprasEntregas();
  COMPRAS_ENTREGAS_FIELDS.forEach(f => {
    if (!datos || !Object.prototype.hasOwnProperty.call(datos, f.key)) return;
    sh.getRange(row, f.col).setValue(_numOrRaw(f.key, datos[f.key]));
  });
}
function _eliminarComprasEntrega(id) {
  const row = _findComprasEntregaRowById(id);
  if (row === -1) throw new Error('Entrega no encontrada.');
  _sheetComprasEntregas().deleteRow(row);
}

// ---- Clonar trámite (copia todos los campos; deja N° de PC / Contratista / Estado en blanco,
//      porque un trámite clonado típicamente arranca un nuevo circuito de adjudicación) ----
function _clonarComprasTramite(id) {
  const original = _listarComprasTramitesRaw().find(t => t._id === id);
  if (!original) throw new Error('Trámite de Compras no encontrado.');
  const datos = {};
  COMPRAS_TRAMITES_FIELDS.forEach(f => { datos[f.key] = original[f.key]; });
  datos.nroPC = ''; datos.contratista = ''; datos.fechaPC = ''; datos.estado = '';
  datos.montoUnitAdjudicado = ''; datos.montoSubtotalAdjudicado = '';
  return _crearComprasTramite(datos);
}

// ---- Sincronización con "Gestiones Plan" — 1 fila espejo POR TRÁMITE (no por Expediente, a
//      diferencia del modelo viejo, porque ahora Sucursal/PC/Contratista son 1 a 1 con cada
//      trámite). Usa una columna de vínculo DISTINTA de la del modelo viejo (COMPRAS_LINK_COLUMN),
//      para que ambos sistemas convivan sin pisarse mientras el modelo viejo siga en uso.
//      OJO: columna 40 (AN), NO 39 — la 39 ya está ocupada por "Seguimiento" (ver FIELDS/
//      SHEET_TOTAL_COLUMNS más arriba); escribir ahí hubiera pisado ese campo real. ----
const COMPRAS_TRAMITE_LINK_COLUMN = 40; // columna AN

function _findRegistroRowByComprasTramiteId(idTramite) {
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return -1;
  const n = lastRow - FIRST_DATA_ROW + 1;
  const ids = sh.getRange(FIRST_DATA_ROW, COMPRAS_TRAMITE_LINK_COLUMN, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    if (ids[i][0] === idTramite) return FIRST_DATA_ROW + i;
  }
  return -1;
}
function _sincronizarRegistroTramiteCompra(idTramite) {
  if (!idTramite) return;
  const sh = _sheetData();
  const filaVinculada = _findRegistroRowByComprasTramiteId(idTramite);
  const t = _listarComprasTramitesRaw().find(x => x._id === idTramite);

  if (!t) {
    if (filaVinculada !== -1) sh.deleteRow(filaVinculada);
    return;
  }

  const valores = {
    pospre: t.pospre || '',
    anio: t.anio || '',
    rubro: 'Compras',
    detalleRubro: t.extracto || '',
    expediente: t.expediente || '',
    sucursal: t.sucursal || '',
    nroPedidoCompras: t.nroPC || '',
    // "Fecha de Apertura" (fechaPedidoCompras) es el mismo campo que ya usa Contrataciones para el
    // Calendario de Aperturas — con el modelo plano, Compras por fin puede completarlo también (el
    // árbol viejo no tenía este dato a nivel Expediente).
    fechaPedidoCompras: t.fechaApertura || '',
    presupuestoOficialRubro: t.montoSubtotalOficial || 0,
    adjudicatario: t.contratista || '',
    totalAdjudicado: t.montoSubtotalAdjudicado || 0,
    estado: t.estado || '',
    observaciones: 'Generado automáticamente desde el módulo Compras.' + (t.observaciones ? ' ' + t.observaciones : '')
  };

  let row = filaVinculada;
  if (row === -1) {
    row = sh.getLastRow() + 1;
    sh.getRange(row, ID_COLUMN).setValue(Utilities.getUuid());
    sh.getRange(row, COMPRAS_TRAMITE_LINK_COLUMN).setValue(idTramite);
  }
  FIELDS.forEach(f => {
    if (Object.prototype.hasOwnProperty.call(valores, f.key)) {
      sh.getRange(row, f.col).setValue(_numOrRaw(f.key, valores[f.key]));
    }
  });
}

/**
 * REPARACIÓN MANUAL, UNA SOLA VEZ — correr desde el editor de Apps Script (menú "Ejecutar" > elegí
 * esta función), NO está conectada a ningún botón de la app a propósito. Corrige el EFECTO del bug
 * de colisión de columnas de una versión anterior: "Estadío Administrativo Actual" se guardaba en
 * la columna 40 de "Gestiones Plan" — la MISMA columna que COMPRAS_TRAMITE_LINK_COLUMN usa para
 * identificar la fila espejo de cada trámite de Compras (ver el comentario grande junto a
 * FIELDS.estadioActual, y _verificarColumnasSinColision, más arriba). Cada vez que alguien cambiaba
 * el Estadío de una fila espejo, se pisaba sin querer su ID de vínculo; la próxima sincronización ya
 * no encontraba esa fila y creaba una fila NUEVA — duplicando el trámite.
 *
 * Esta función:
 *   1) Para las filas GENUINAS de Contrataciones (no son espejos de Compras): el "Estadío Actual"
 *      que hayas cargado ahí NUNCA se corrompió — lo traslada a su nueva ubicación correcta
 *      (columnas 41/42) y libera la columna 40.
 *   2) Para las filas ESPEJO de Compras cuyo vínculo quedó roto (columna 40 ya no apunta a ningún
 *      trámite de Compras existente): las borra. No se pierde información real — el dato de origen
 *      sigue intacto en "Compras - Trámites"; estas filas son solo una copia de lectura.
 *   3) Vuelve a sincronizar TODOS los trámites de Compras contra "Gestiones Plan", para que cada
 *      uno quede con exactamente UNA fila espejo, correcta y al día.
 *
 * Corré esta función UNA SOLA VEZ, después de haber actualizado Code.gs a esta versión. Mirá el
 * registro de ejecución (Ver > Registros de ejecución, en el editor de Apps Script) al terminar
 * para ver el resumen de lo que se corrigió.
 *
 * LÍMITE A TENER EN CUENTA: si vos mismo habías cargado, a mano, un Estadío Actual directamente
 * sobre una fila ESPEJO (no sobre el trámite de Compras original), ese valor específico no se
 * puede recuperar — el vínculo que lo hubiera identificado es justo lo que se pisó. La fila
 * espejo se borra y se recrea limpia; si hace falta, ese Estadío se vuelve a cargar a mano, esta
 * vez desde el trámite de Compras correspondiente (o desde la fila con Módulo "Compras" en el
 * panel "Estadío de los Trámites").
 */
function _repararColisionColumna40() {
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) { Logger.log('No hay filas en "Gestiones Plan". Nada para reparar.'); return; }
  const n = lastRow - FIRST_DATA_ROW + 1;
  const colObservaciones = _colDeCampo(FIELDS, 'observaciones');
  const colEstadioActual = _colDeCampo(FIELDS, 'estadioActual'); // ya apunta a la posición NUEVA (41)
  const colEstadioDesde = _colDeCampo(FIELDS, 'estadioDesde');   // ya apunta a la posición NUEVA (42)
  const FINGERPRINT = 'Generado automáticamente desde el módulo Compras.';
  const idsValidosCompras = new Set(_listarComprasTramitesRaw().map(t => t._id));

  // Trae TODA la hoja de una sola vez, con un ancho igual o mayor a SHEET_TOTAL_COLUMNS, para no
  // perder nada por si algo quedó escrito en la columna 41 vieja (posición anterior de "En este
  // Estadío desde", ahora columna 42).
  const anchoLectura = Math.max(SHEET_TOTAL_COLUMNS, 43);
  const rango = sh.getRange(FIRST_DATA_ROW, 1, n, anchoLectura).getValues();

  let migradas = 0, borradas = 0;
  const filasABorrar = [];

  for (let i = 0; i < n; i++) {
    const fila = rango[i];
    const filaSheet = FIRST_DATA_ROW + i;
    const observ = String(fila[colObservaciones - 1] || '');
    const col40Valor = fila[COMPRAS_TRAMITE_LINK_COLUMN - 1]; // la columna que colisionaba
    const esFilaEspejo = observ.indexOf(FINGERPRINT) === 0;
    const linkValido = col40Valor && idsValidosCompras.has(col40Valor);

    if (esFilaEspejo && !linkValido) {
      // Fila espejo cuyo vínculo se rompió (o ya estaba huérfana porque el trámite de origen se
      // borró) — se borra. El paso de re-sincronización, más abajo, la vuelve a generar bien.
      filasABorrar.push(filaSheet);
      borradas++;
      continue;
    }
    if (esFilaEspejo && linkValido) {
      // Fila espejo que NUNCA se corrompió (la columna 40 sigue siendo un vínculo válido): no se
      // toca. No puede tener un Estadío real guardado — nunca pudo cargarse uno sin romper este
      // mismo vínculo — así que no hay nada que migrar acá.
      continue;
    }
    // Fila GENUINA de Contrataciones (no es un espejo de Compras): lo que esté en la columna 40
    // es, en realidad, el "Estadío Actual" que cargaste ahí antes de este arreglo, y lo que esté
    // en la columna 41 vieja es su fecha. Se migran a la posición nueva (41/42) y se limpia la
    // columna 40, para que vuelva a estar disponible exclusivamente para el vínculo con Compras.
    const estadioActualViejo = fila[COMPRAS_TRAMITE_LINK_COLUMN - 1]; // columna 40
    const estadioDesdeViejo = fila[40]; // columna 41 (posición vieja de "En este Estadío desde")
    if (estadioActualViejo) {
      sh.getRange(filaSheet, colEstadioActual).setValue(estadioActualViejo);
      if (estadioDesdeViejo) sh.getRange(filaSheet, colEstadioDesde).setValue(estadioDesdeViejo);
      sh.getRange(filaSheet, COMPRAS_TRAMITE_LINK_COLUMN).setValue(''); // libera la columna 40
      migradas++;
    }
  }

  // Borra de abajo hacia arriba para que los números de fila de las que quedan no se corran.
  filasABorrar.sort((a, b) => b - a).forEach(fila => sh.deleteRow(fila));

  // Reconstruye la fila espejo correcta de cada trámite de Compras — cubre tanto los que se
  // acaban de borrar como cualquier trámite que, por el bug, se haya quedado sin fila espejo.
  let resincronizados = 0;
  _listarComprasTramitesRaw().forEach(t => {
    _sincronizarRegistroTramiteCompra(t._id);
    resincronizados++;
  });

  Logger.log('Reparación terminada. Filas de Contrataciones migradas (Estadío recuperado): ' + migradas +
    '. Filas espejo duplicadas/corrompidas borradas: ' + borradas +
    '. Trámites de Compras re-sincronizados (fila espejo verificada/recreada): ' + resincronizados + '.');
}

/**
 * LIMPIEZA MANUAL, UNA SOLA VEZ — correr desde el editor de Apps Script (menú "Ejecutar" > elegí
 * esta función), NO está conectada a ningún botón de la app a propósito, porque borra filas de
 * "Gestiones Plan" y conviene correrla con la cabeza fría, no con un click accidental.
 *
 * Elimina las filas espejo VIEJAS (una por Expediente, columna de vínculo 38) de "Gestiones Plan".
 * Tiene sentido correrla recién DESPUÉS de:
 *   1) Haber corrido _migrarComprasATramites (así cada Expediente viejo ya tiene sus Trámites
 *      equivalentes, con sus propias filas espejo NUEVAS por Trámite, columna de vínculo 40).
 *   2) Haber revisado esos Trámites migrados y estar conforme con cómo quedaron.
 * Si no se corre, las filas viejas se quedan sumando presupuesto/adjudicado en el Dashboard AL LADO
 * de las nuevas — mismo dato contado dos veces. No toca absolutamente nada de las hojas
 * "Compras - Expedientes/Pedidos (PC)/Posiciones": esos datos siguen ahí intactos como respaldo.
 */
function _limpiarFilasEspejoComprasViejas() {
  const sh = _sheetData();
  const lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return { filasEliminadas: 0 };
  const n = lastRow - FIRST_DATA_ROW + 1;
  const links = sh.getRange(FIRST_DATA_ROW, COMPRAS_LINK_COLUMN, n, 1).getValues();
  // De abajo hacia arriba: al borrar una fila, las de más abajo corren su número — recorrer al
  // revés evita que eso desalinee los índices que todavía faltan procesar.
  let filasEliminadas = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (links[i][0]) {
      sh.deleteRow(FIRST_DATA_ROW + i);
      filasEliminadas++;
    }
  }
  return { filasEliminadas };
}

/**
 * Migración ÚNICA y ADITIVA desde el modelo viejo (Expediente -> PC -> Posición) al modelo plano
 * de Trámites: por cada Posición existente crea un Trámite nuevo, más sus Entregas si tenía fechas
 * de entrega cargadas. No borra ni modifica NADA del modelo viejo. Se puede correr más de una vez
 * sin duplicar — cada Trámite migrado guarda el _id de la Posición que lo originó (columna técnica
 * COMPRAS_MIGRACION_COL_ORIGEN) y, si ya existe un Trámite con ese origen, se saltea.
 *
 * OJO — cosas que se migran con un valor por default porque el modelo viejo no las tenía, y
 * conviene revisar a mano después de migrar:
 *  - $ Unitario Adjudicado: se copia el mismo valor que $ Unitario Oficial (el modelo viejo no
 *    distinguía precio estimado de precio adjudicado, tenía un solo precio por tramo).
 *  - Estado: se infiere "Adjudicado" si la Posición ya tenía N° de PC cargado, sino queda vacío.
 *  - Año: se completa con el año que figura en el N° de Expediente, pero el campo representa el
 *    año de imputación del pago (Plan) — si en algún caso no coincide con el del Expediente, hay
 *    que corregirlo a mano.
 *  - Fecha de Apertura, Fecha de PC y Plazo de Entrega: el modelo viejo no las guardaba, quedan
 *    vacías.
 */
function _migrarComprasATramites() {
  _setupComprasTramites();

  const sh = _sheetComprasTramites();
  const lastRow = sh.getLastRow();
  const origenesExistentes = new Set();
  if (lastRow >= COMPRAS_TRAMITES_FIRST_ROW) {
    const n = lastRow - COMPRAS_TRAMITES_FIRST_ROW + 1;
    sh.getRange(COMPRAS_TRAMITES_FIRST_ROW, COMPRAS_MIGRACION_COL_ORIGEN, n, 1).getValues()
      .forEach(r => { if (r[0]) origenesExistentes.add(r[0]); });
  }

  const arbol = _listarCompras();
  let tramitesCreados = 0, tramitesYaMigrados = 0, entregasCreadas = 0;

  arbol.forEach(exp => {
    (exp.pedidos || []).forEach(pc => {
      (pc.posiciones || []).forEach(pos => {
        if (origenesExistentes.has(pos._id)) { tramitesYaMigrados++; return; }

        const montoUnitOficial = pos.montoUnitFija || '';
        const datosTramite = {
          pospre: exp.pospre || '',
          expediente: exp.expediente || '',
          // Punto de partida razonable, no un dato certero: el modelo viejo no distinguía "año de
          // imputación del pago" del año del Expediente. Se completa con el año que figura en el
          // N° de Expediente y se puede corregir a mano si el pago en realidad va a otro Plan.
          anio: _anioDesdeExpediente(exp.expediente) || '',
          extracto: exp.extracto || '',
          sucursal: pos.destino || '',
          matricula: pos.matricula || '',
          detalleMat: pos.detalleMat || '',
          cantidad: pos.cantidadFija || '',
          montoUnitOficial: montoUnitOficial,
          montoSubtotalOficial: pos.montoPFija || '',
          cantidadPlanificada: pos.cantidadPlanificada || '',
          montoUnitAdjudicado: montoUnitOficial,
          montoSubtotalAdjudicado: pos.montoPFija || '',
          contratista: pc.adjudicatario || '',
          nroPC: pc.nroPC || '',
          estado: pc.nroPC ? 'Adjudicado' : '',
          observaciones: [exp.observaciones, pos.observaciones].filter(Boolean).join(' — ')
        };
        const idTramite = _crearComprasTramite(datosTramite);
        const filaNueva = _findComprasTramiteRowById(idTramite);
        sh.getRange(filaNueva, COMPRAS_MIGRACION_COL_ORIGEN).setValue(pos._id);
        tramitesCreados++;

        if (pos.fechaContratoFija) {
          _crearComprasEntrega({
            idTramite: idTramite, tipo: 'Oficial',
            cantidad: pos.cantidadFija || '', monto: pos.montoPFija || '',
            fechaContractual: pos.fechaContratoFija, fechaReal: pos.fechaRealFija || ''
          });
          entregasCreadas++;
        }
        if (String(pos.partePlanificada).toLowerCase() === 'si' && pos.fechaContratoPlanificada) {
          _crearComprasEntrega({
            idTramite: idTramite, tipo: 'Planificada',
            cantidad: pos.cantidadPlanificada || '', monto: pos.montoPPlanificada || '',
            fechaContractual: pos.fechaContratoPlanificada, fechaReal: pos.fechaRealPlanificada || ''
          });
          entregasCreadas++;
        }
        if (String(pos.ampliacion).toLowerCase() === 'si' && pos.fechaContratoAmpliacion) {
          _crearComprasEntrega({
            idTramite: idTramite, tipo: 'Ampliación',
            cantidad: '', monto: pos.montoAmpliacion || '',
            fechaContractual: pos.fechaContratoAmpliacion, fechaReal: pos.fechaRealAmpliacion || ''
          });
          entregasCreadas++;
        }
      });
    });
  });

  return { tramitesCreados, tramitesYaMigrados, entregasCreadas };
}

// ============================================================
// MÓDULO DE HISTORIAL DE KPIs (snapshots fechados de los totales generales)
// ------------------------------------------------------------
// Guarda, una vez por día, una "foto" de los totales generales (sin filtros) para poder mostrar
// después "esto cambió desde el último corte" (ej. las multas que pasaron de $102M a $302M entre
// dos relevamientos). Un snapshot por fecha: si ya existe uno para hoy, se sobrescribe (para que
// cargar la app varias veces el mismo día no genere filas duplicadas).
// ============================================================
const SHEET_HISTORIAL = 'Historial KPIs';
const HISTORIAL_FIRST_DATA_ROW = 2;
const HISTORIAL_FIELDS = [
  { key: 'fecha', col: 1, label: 'Fecha' },
  { key: 'cantTramites', col: 2, label: 'Trámites' },
  { key: 'totalPresOficial', col: 3, label: 'Presupuesto Oficial Total' },
  { key: 'totalAdjudicado', col: 4, label: 'Total Adjudicado' },
  { key: 'totalCertificado', col: 5, label: 'Certificado por AAD' },
  { key: 'totalMultas', col: 6, label: 'Multas Acumuladas' },
  { key: 'cantDesiertos', col: 7, label: 'Cant. Desiertos' },
  { key: 'cantAdjudicados', col: 8, label: 'Cant. Adjudicados' }
];
const HISTORIAL_LAST_COLUMN = 8;

function _sheetHistorial() { return _ss().getSheetByName(SHEET_HISTORIAL); }

function _setupHistorialKPIs() {
  const ss = _ss();
  let sh = ss.getSheetByName(SHEET_HISTORIAL);
  if (!sh) {
    sh = ss.insertSheet(SHEET_HISTORIAL);
    const headers = HISTORIAL_FIELDS.map(f => f.label);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
}

function _historialRowToRecord(rowValues) {
  const rec = {};
  HISTORIAL_FIELDS.forEach(f => { rec[f.key] = rowValues[f.col - 1]; });
  return rec;
}

function _listarHistorialKPIs() {
  const sh = _sheetHistorial();
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < HISTORIAL_FIRST_DATA_ROW) return [];
  const n = lastRow - HISTORIAL_FIRST_DATA_ROW + 1;
  const values = sh.getRange(HISTORIAL_FIRST_DATA_ROW, 1, n, HISTORIAL_LAST_COLUMN).getValues();
  return values.filter(row => row[0]).map(_historialRowToRecord)
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))); // más reciente primero
}

/** Guarda (o sobrescribe si ya existe uno para la misma fecha) un snapshot de los totales
 *  generales de hoy. `datos` viene ya calculado desde el frontend (mismos totales que se
 *  muestran en el Dashboard sin filtros), para no duplicar esas fórmulas en el servidor. */
function _guardarSnapshotHistorial(datos) {
  const sh = _sheetHistorial();
  if (!sh) throw new Error('No se encontró la hoja "' + SHEET_HISTORIAL + '". Ejecutá `setup` de nuevo.');
  const hoy = _hoyStr();
  const lastRow = sh.getLastRow();
  let filaExistente = -1;
  if (lastRow >= HISTORIAL_FIRST_DATA_ROW) {
    const n = lastRow - HISTORIAL_FIRST_DATA_ROW + 1;
    const fechas = sh.getRange(HISTORIAL_FIRST_DATA_ROW, 1, n, 1).getValues();
    for (let i = 0; i < n; i++) {
      if (fechas[i][0] === hoy) { filaExistente = HISTORIAL_FIRST_DATA_ROW + i; break; }
    }
  }
  const fila = filaExistente === -1 ? sh.getLastRow() + 1 : filaExistente;
  const rowValues = new Array(HISTORIAL_LAST_COLUMN).fill('');
  rowValues[0] = hoy;
  HISTORIAL_FIELDS.forEach(f => {
    if (f.key === 'fecha') return;
    rowValues[f.col - 1] = _numOrRaw(f.key, datos[f.key] || 0);
  });
  sh.getRange(fila, 1, 1, HISTORIAL_LAST_COLUMN).setValues([rowValues]);
  return hoy;
}
