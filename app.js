// ============================================================
// Gestiones AAD — lógica de la aplicación
// ============================================================

// ---- Altura real de pantalla (arregla el bug de 100vh en navegadores mobile,
//      donde la barra de direcciones aparece/desaparece y genera scroll fantasma) ----
function setRealViewportHeight() {
  document.documentElement.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
}
setRealViewportHeight();
window.addEventListener('resize', setRealViewportHeight);
window.addEventListener('orientationchange', setRealViewportHeight);

// ---- Tipos de campo para generar el formulario automáticamente ----
const DATE_FIELDS = new Set([
  'fechaInicioExpte','fechaPedidoCompras','fechaActoAdmin',
  'fechaInicioReal','fechaFinContrato','fechaFinPlazoAmpliada'
]);
const MONTH_FIELDS = new Set(['mmAAkmLAMT']); // campos tipo "mes/año" (input type="month")
const NUMBER_FIELDS = new Set([
  'anio','plazoEntrega','cantidadesIIBB','presOficialUnitario','presupuestoOficialRubro',
  'adjudicadoUnitario','totalAdjudicado','ampliacionPlazo','cantidadProyectos','kmLineaPC',
  'cantTotalIIBBProyectados','proyectadosAcumulados','pctIIBBProyectados','certificadosAAD',
  'pctAvanceCertificacion','sumatoriaMultas','cantidadCertificadosProcesados'
]);
const CURRENCY_FIELDS = new Set([
  'presOficialUnitario','presupuestoOficialRubro','adjudicadoUnitario','totalAdjudicado',
  'kmLineaPC','proyectadosAcumulados','certificadosAAD','sumatoriaMultas'
]);
const SELECT_FIELDS = {
  previstoPlan: ['Si','No'],
  movilidadInspeccion: ['Si','No'],
  estado: ['Adjudicado','Desierto','Relanzado','Finalizado']
};
// Etiqueta usada para representar, en filtros/agrupaciones, los trámites que todavía no tienen
// un Estado cargado (sin adjudicar). No es un valor real de la base: es un valor "sentinela"
// que se muestra y se filtra como una categoría más, para poder aislar esos trámites.
const ESTADO_VACIO_LABEL = 'Vacío (sin adjudicar)';
// Campos con opciones dinámicas: se cargan a partir de los valores ya existentes en la base
// (evita errores de tipeo, obliga a elegir uno de los que ya existen).
const DYNAMIC_SELECT_FIELDS = new Set(['pospre', 'sucursal']);
const LONG_FIELDS = new Set(['detalleRubro','observaciones','seguimiento']);

// ---- Campos calculados automáticamente: no se editan a mano ----
const DERIVED_FIELDS = new Set(['presupuestoOficialRubro','totalAdjudicado','fechaFinContrato','fechaFinPlazoAmpliada','pctAvanceCertificacion','pctIIBBProyectados','certificadosAAD','sumatoriaMultas','cantidadCertificadosProcesados','cantidadProyectos','cantTotalIIBBProyectados','proyectadosAcumulados']);
// Campos "fuente" que, al cambiar, disparan el recálculo
const RECALC_TRIGGER_FIELDS = new Set(['cantidadesIIBB','presOficialUnitario','adjudicadoUnitario','fechaInicioReal','plazoEntrega','ampliacionPlazo']);
// Campos "acumulador": tienen un mini sumador al lado para ir agregando valores sin calcular a mano
const SUM_HELPER_FIELDS = new Set([]);

// Un único set de claves para los 3 filtros que ahora comparten estado (Dashboard/Registros/
// Seguimiento). Se mantienen los 3 nombres históricos (FILTER_KEYS, DASH_FILTER_KEYS,
// SEGU_FILTER_KEYS) como alias del mismo array para no tener que renombrar cada referencia
// existente en el resto del archivo.
const SHARED_FILTER_KEYS = ['pospre','expediente','anio','sucursal','rubro','nroPedidoCompras','adjudicatario','estado'];
const FILTER_KEYS = SHARED_FILTER_KEYS;

// ---- Estado en memoria ----
const state = {
  session: null,      // { usuario, nombre, rol, clave }
  campos: [],
  etapas: [],
  registros: [],
  // Filtro ÚNICO compartido por Dashboard, Registros y Seguimiento de Avance: cambiarlo en
  // cualquiera de esos 3 módulos se refleja automáticamente en los otros dos (misma referencia
  // de objeto), para que navegar entre ellos sea un solo flujo de trabajo continuo. Comparativa
  // de Años queda aparte (state.comp.filtros) porque su lógica es distinta (compara Año A vs. B).
  filtrosCompartidos: { fechaPCDesde: '', fechaPCHasta: '', pctAvanceDesde: '', pctAvanceHasta: '', texto: '', textoModo: 'contiene', expediente: '' },
  riesgoPlazoActivoCompartido: false,
  editingId: null,
  activeStage: null,
  registrosSort: { key: null, dir: 1 },     // ordenamiento de la tabla de Registros
  dashSort: { key: null, dir: -1 },         // ordenamiento de la tabla de detalle del Dashboard (agrupada)
  dashDetalleSort: { key: null, dir: 1 },   // ordenamiento de la tabla de detalle del Dashboard (modo "Todos")
  comp: { anioA: '', anioB: '', groupBy: 'sucursal', filtros: {} }, // módulo Comparativa de años (filtro propio, no compartido)
  seguSort: { key: 'pctActual', dir: 1 } // orden de la tabla de Seguimiento (por defecto: peor % acumulado primero)
};

const DASH_FILTER_KEYS = SHARED_FILTER_KEYS;

// ============================================================
// ---- Debounce genérico: para inputs de texto/número que disparan un render completo (Buscar
// palabra, % de Avance desde/hasta, Expediente), evita reconstruir toda la vista —incluidos los
// gráficos del Dashboard— en cada tecla tipeada. Solo se ejecuta 300ms después de la última
// tecla, que es imperceptible para el usuario pero evita el trabajo repetido mientras escribe. ----
function debounce(fn, esperaMs) {
  let temporizador;
  return function (...args) {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn.apply(this, args), esperaMs);
  };
}

// API
// ============================================================
// ---- Indicador de carga global: una barra fina arriba del contenido que aparece mientras hay
// alguna llamada al servidor en curso (Apps Script puede tardar 1-3 seg). Al envolver apiCall en
// vez de cada botón por separado, esto cubre automáticamente TODAS las acciones de la app
// (guardar, eliminar, cambiar de módulo, etc.) sin tener que instrumentar cada una a mano. ----
let apiCallsEnCurso = 0;
function mostrarCargandoGlobal() {
  apiCallsEnCurso++;
  document.getElementById('topLoadingBar').classList.add('is-active');
}
function ocultarCargandoGlobal() {
  apiCallsEnCurso = Math.max(0, apiCallsEnCurso - 1);
  if (apiCallsEnCurso === 0) document.getElementById('topLoadingBar').classList.remove('is-active');
}

async function apiCall(action, payload) {
  const body = Object.assign({ action }, payload || {});
  if (state.session) {
    body.usuario = state.session.usuario;
    body.clave = state.session.clave;
  }
  mostrarCargandoGlobal();
  try {
    let res;
    try {
      res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS
        body: JSON.stringify(body)
      });
    } catch (networkErr) {
      throw new Error('No se pudo conectar con el servidor. Puede ser un corte de conexión momentáneo o que Google esté demorado — esperá unos segundos y volvé a intentar.');
    }
    if (!res.ok) throw new Error('Error de red (' + res.status + ')');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Error desconocido');
    return data;
  } finally {
    ocultarCargandoGlobal();
  }
}

// ============================================================
// SESIÓN
// ============================================================
function restoreSession() {
  const raw = sessionStorage.getItem('aad_session');
  if (raw) {
    try { state.session = JSON.parse(raw); } catch (e) { state.session = null; }
  }
}
function saveSession() {
  sessionStorage.setItem('aad_session', JSON.stringify(state.session));
}
function clearSession() {
  sessionStorage.removeItem('aad_session');
  sessionStorage.removeItem('aad_last_view');
  state.session = null;
}

function setLoginStatus(state_, text) {
  const box = document.getElementById('loginStatus');
  const usuarioEl = document.getElementById('loginUsuario');
  const claveEl = document.getElementById('loginClave');
  box.dataset.state = state_;
  box.querySelector('.login-status-icon').textContent = state_ === 'ok' ? '✓' : (state_ === 'err' ? '✕' : '');
  box.querySelector('.login-status-text').textContent = text || '';
  box.classList.toggle('show', state_ !== 'idle');
  usuarioEl.classList.remove('input-ok', 'input-err');
  claveEl.classList.remove('input-ok', 'input-err');
  if (state_ === 'ok') { usuarioEl.classList.add('input-ok'); claveEl.classList.add('input-ok'); }
  if (state_ === 'err') { usuarioEl.classList.add('input-err'); claveEl.classList.add('input-err'); }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const usuario = document.getElementById('loginUsuario').value.trim();
  const clave = document.getElementById('loginClave').value;
  setLoginStatus('idle', '');
  try {
    const data = await apiCallLogin(usuario, clave);
    state.session = { usuario: data.user.usuario, nombre: data.user.nombre, rol: data.user.rol, sucursalesRestringidas: data.user.sucursalesRestringidas || [], clave };
    saveSession();
    setLoginStatus('ok', 'Ingreso correcto');
    setTimeout(() => boot(), 350); // deja ver el indicador verde un instante antes de entrar
  } catch (err) {
    setLoginStatus('err', err.message);
  }
});

async function apiCallLogin(usuario, clave) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'login', usuario, clave })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
  return data;
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  clearSession();
  location.reload();
});

// ---- Mostrar la contraseña momentáneamente mientras el mouse está sobre el botón ----
(function setupPasswordToggle() {
  const btn = document.getElementById('togglePass');
  const input = document.getElementById('loginClave');
  const eyeOpen = btn.querySelector('.eye-open');
  const eyeClosed = btn.querySelector('.eye-closed');

  function reveal() {
    input.type = 'text';
    eyeOpen.hidden = true;
    eyeClosed.hidden = false;
  }
  function hide() {
    input.type = 'password';
    eyeOpen.hidden = false;
    eyeClosed.hidden = true;
  }

  btn.addEventListener('mouseenter', reveal);
  btn.addEventListener('mouseleave', hide);
  // Soporte táctil: mantener presionado para revelar
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); reveal(); });
  btn.addEventListener('touchend', hide);
  btn.addEventListener('touchcancel', hide);
  // Evita que el botón robe el foco del campo de contraseña
  btn.addEventListener('mousedown', (e) => e.preventDefault());
})();

// ============================================================
// NAVEGACIÓN
// ============================================================
document.getElementById('sidenav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn) return;
  if (btn.dataset.view === 'formulario' && !state.editingId) {
    showView('formulario');
    abrirSelectorOrigenTramite();
    return;
  }
  // Si ya estás en esa misma pestaña, no volvemos a disparar showView: evita que un clic
  // repetido (por error, o doble clic) recargue datos del servidor y corte lo que estabas
  // completando (una certificación, un proyecto o una compra a medio cargar, por ejemplo).
  if (btn.classList.contains('active')) return;
  showView(btn.dataset.view);
});

function showView(name) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.hidden = (v.id !== 'view-' + name));
  // Recordamos en qué pantalla está el usuario (igual que la sesión) para que, si el navegador
  // recarga la página sola después de un rato inactivo (algo normal en celulares), la app vuelva
  // a abrir en la misma pantalla en vez de mandarlo siempre a Dashboard.
  try { sessionStorage.setItem('aad_last_view', name); } catch (e) { /* si el navegador bloquea sessionStorage, no pasa nada grave */ }
  if (name === 'dashboard') renderDashboard();
  if (name === 'registros') renderRegistros();
  if (name === 'vencimientos') renderCalendar();
  if (name === 'aperturas') renderCalendarApertura();
  if (name === 'certificaciones') abrirVistaCertificaciones();
  if (name === 'proyectos') abrirVistaProyectos();
  if (name === 'compras') abrirVistaCompras();
  if (name === 'usuarios') renderUsuarios();
  if (name === 'seguimiento') renderSeguimiento();
  if (name === 'comparativa') renderComparativa();
}

document.getElementById('formNewBtn').addEventListener('click', () => {
  abrirSelectorOrigenTramite();
});

// ============================================================
// ORIGEN DEL TRÁMITE: nuevo desde cero vs. ampliación de contrato
// ============================================================
// Campos "cantidad/plazo" que SÍ se escalan según el % de Ampliación: si el nuevo contrato
// cubre el 30% del alcance original, se pide 0,3 veces la cantidad y 0,3 veces el plazo — NO
// se suman al 100% original (eso duplicaría todo si el % cargado fuera 100). Fórmula: factor =
// pct / 100 (100% -> factor 1, o sea "igual que el original"; 30% -> factor 0,3).
const AMPLIACION_ESCALABLE_FIELDS = ['plazoEntrega', 'cantidadesIIBB', 'ampliacionPlazo'];
// Campos de $ UNITARIO (precio por unidad / tarifa) NO se escalan: el precio unitario no cambia
// porque el contrato cubra más o menos cantidad — se copian tal cual del original. El $ Presupuesto
// Oficial y el $ Total Adjudicado, que sí dependen de la cantidad, se recalculan solos a partir
// de estos unitarios (sin escalar) y de la cantidad ya escalada — ver recalcDerivedFields().
// Campos calculados que dependen de sub-módulos (Certificaciones / Proyectos): no se copian,
// porque el trámite nuevo todavía no tiene certificaciones ni proyectos propios cargados.
// nroPedidoCompras tampoco se copia: el contrato de ampliación todavía no tiene su propio N° de
// Pedido de Compras asignado (se carga después, cuando SAP lo genere) — pero sí se mantiene el
// Adjudicatario/contratista, que normalmente es el mismo.
const AMPLIACION_BLANQUEAR_FIELDS = [
  'certificadosAAD','pctAvanceCertificacion','sumatoriaMultas','cantidadCertificadosProcesados',
  'cantidadProyectos','cantTotalIIBBProyectados','proyectadosAcumulados',
  'presupuestoOficialRubro','totalAdjudicado','fechaFinContrato','fechaFinPlazoAmpliada',
  'nroPedidoCompras','seguimiento'
];

let ampliacionSeleccion = null; // registro elegido como base de la ampliación

function abrirSelectorOrigenTramite() {
  ampliacionSeleccion = null;
  document.getElementById('ampliacionPct').value = '';
  document.getElementById('ampliacionBuscarPC').value = '';
  document.getElementById('ampliacionResultados').hidden = true;
  document.getElementById('ampliacionSeleccionado').hidden = true;
  document.getElementById('origenPaso2Msg').hidden = true;
  document.getElementById('origenContinuarBtn').disabled = true;
  document.getElementById('origenPaso1').hidden = false;
  document.getElementById('origenPaso2').hidden = true;
  document.getElementById('origenModalOverlay').hidden = false;
}
function cerrarSelectorOrigenTramite() {
  document.getElementById('origenModalOverlay').hidden = true;
}

document.getElementById('origenModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'origenModalOverlay') cerrarSelectorOrigenTramite();
});
document.addEventListener('click', (e) => {
  const resultadosBox = document.getElementById('ampliacionResultados');
  if (!resultadosBox || resultadosBox.hidden) return;
  if (!e.target.closest('#ampliacionBuscarPC') && !e.target.closest('#ampliacionResultados')) {
    resultadosBox.hidden = true;
  }
});
document.getElementById('origenCancelarBtn1').addEventListener('click', cerrarSelectorOrigenTramite);
document.getElementById('origenVolverBtn').addEventListener('click', () => {
  document.getElementById('origenPaso1').hidden = false;
  document.getElementById('origenPaso2').hidden = true;
});

document.getElementById('origenNuevoBtn').addEventListener('click', () => {
  cerrarSelectorOrigenTramite();
  state.editingId = null;
  document.getElementById('formTitle').textContent = 'Nueva Contratación';
  document.getElementById('ampliacionBanner').hidden = true;
  buildForm({});
});

document.getElementById('origenAmpliacionBtn').addEventListener('click', () => {
  document.getElementById('origenPaso1').hidden = true;
  document.getElementById('origenPaso2').hidden = false;
  document.getElementById('ampliacionBuscarPC').focus();
});

// ---- Buscador de Pedido de Compras (por número) ----
document.getElementById('ampliacionBuscarPC').addEventListener('input', (e) => {
  ampliacionSeleccion = null;
  document.getElementById('ampliacionSeleccionado').hidden = true;
  actualizarBotonContinuarAmpliacion();
  const q = e.target.value.trim().toLowerCase();
  const resultadosBox = document.getElementById('ampliacionResultados');
  if (!q) { resultadosBox.hidden = true; resultadosBox.innerHTML = ''; return; }

  // Un mismo N° de Pedido de Compras puede repetirse en varias filas (ampliaciones previas);
  // mostramos todas las coincidencias, cada una con su Pospre/Adjudicatario para diferenciarlas.
  const matches = state.registros
    .filter(r => String(r.nroPedidoCompras || '').toLowerCase().includes(q))
    .slice(0, 20);

  if (!matches.length) {
    resultadosBox.innerHTML = '<div class="autocomplete-empty">No se encontró ningún Pedido de Compras cargado con ese número.</div>';
    resultadosBox.hidden = false;
    return;
  }
  resultadosBox.innerHTML = matches.map((r, i) => `
    <div class="autocomplete-item" data-idx="${i}">
      <b>${escapeHtml(r.nroPedidoCompras || '(sin número)')}</b> — ${escapeHtml(r.pospre || '')}
      <span class="ac-sub">${escapeHtml(r.expediente || '')}${r.adjudicatario ? ' · ' + escapeHtml(r.adjudicatario) : ''}</span>
    </div>
  `).join('');
  resultadosBox.hidden = false;
  resultadosBox.querySelectorAll('.autocomplete-item').forEach((el, i) => {
    el.addEventListener('click', () => seleccionarPCAmpliacion(matches[i]));
  });
});

function seleccionarPCAmpliacion(record) {
  ampliacionSeleccion = record;
  document.getElementById('ampliacionResultados').hidden = true;
  document.getElementById('ampliacionBuscarPC').value = record.nroPedidoCompras || '';
  const box = document.getElementById('ampliacionSeleccionado');
  box.innerHTML = `<span>Seleccionado: <b>${escapeHtml(record.nroPedidoCompras || '')}</b> — ${escapeHtml(record.pospre || '')} (${escapeHtml(record.expediente || '')})</span>
    <button type="button" id="ampliacionQuitarBtn">Quitar</button>`;
  box.hidden = false;
  document.getElementById('ampliacionQuitarBtn').addEventListener('click', () => {
    ampliacionSeleccion = null;
    box.hidden = true;
    document.getElementById('ampliacionBuscarPC').value = '';
    actualizarBotonContinuarAmpliacion();
  });
  actualizarBotonContinuarAmpliacion();
}

document.getElementById('ampliacionPct').addEventListener('input', actualizarBotonContinuarAmpliacion);
function actualizarBotonContinuarAmpliacion() {
  const pct = parseFloat(document.getElementById('ampliacionPct').value);
  const ok = ampliacionSeleccion && !isNaN(pct) && pct > 0;
  document.getElementById('origenContinuarBtn').disabled = !ok;
}

document.getElementById('origenContinuarBtn').addEventListener('click', () => {
  const pct = parseFloat(document.getElementById('ampliacionPct').value);
  const msg = document.getElementById('origenPaso2Msg');
  if (!ampliacionSeleccion) {
    msg.textContent = 'Elegí un Pedido de Compras de la lista.';
    msg.hidden = false;
    return;
  }
  if (isNaN(pct) || pct <= 0) {
    msg.textContent = 'Ingresá un porcentaje de ampliación válido (mayor a 0).';
    msg.hidden = false;
    return;
  }
  msg.hidden = true;
  iniciarAmpliacionContrato(ampliacionSeleccion, pct);
  cerrarSelectorOrigenTramite();
});

// ---- Construye el registro "borrador" a partir de un Pedido de Compras existente,
//      aplicando el % de ampliación a los campos numéricos que corresponde ----
function iniciarAmpliacionContrato(base, pct) {
  // factor = pct/100 (NO 1+pct/100): al 100% el nuevo contrato pide LO MISMO que el original
  // (factor 1); al 30%, pide el 30% (factor 0,3). Con la fórmula anterior, 100% duplicaba todo.
  const factor = pct / 100;
  const draft = {};
  state.campos.forEach(f => {
    let v = base[f.key];
    if (v == null) v = '';
    if (AMPLIACION_BLANQUEAR_FIELDS.includes(f.key)) {
      draft[f.key] = '';
    } else if (AMPLIACION_ESCALABLE_FIELDS.includes(f.key)) {
      const num = parseFloat(v);
      draft[f.key] = isNaN(num) ? v : +(num * factor).toFixed(2);
    } else {
      // Se copia tal cual: incluye los $ unitarios (Oficial y Adjudicado) y el Adjudicatario —
      // el precio por unidad no cambia según el % de ampliación, y el contratista normalmente
      // sigue siendo el mismo (solo cambia el N° de Pedido de Compras, que se blanquea arriba).
      draft[f.key] = v;
    }
  });
  const nota = `Ampliación de contrato del Pedido de Compras Nº ${base.nroPedidoCompras || '(sin número)'} — se solicita un ${pct}% de las cantidades y plazos originales.`;
  draft.observaciones = draft.observaciones ? (nota + '\n' + draft.observaciones) : nota;
  // draft._id se deja sin definir a propósito: es un trámite NUEVO, no una edición del original.

  state.editingId = null;
  document.getElementById('formTitle').textContent = 'Nueva Contratación — Ampliación de contrato';
  const banner = document.getElementById('ampliacionBanner');
  banner.querySelector('p').textContent =
    `Este formulario se completó automáticamente a partir del Pedido de Compras Nº ${base.nroPedidoCompras || ''}: se copiaron los $ unitarios y el Adjudicatario tal cual, y se aplicó ${pct}% (factor ${factor}) a la Cantidad y al Plazo de Entrega. El N° de Pedido de Compras quedó vacío porque todavía no está asignado. Revisá los datos antes de guardar.`;
  banner.hidden = false;
  buildForm(draft);
  // Recalcula $ Presupuesto Oficial / $ Total Adjudicado (cantidad ya escalada × $ unitario sin
  // escalar) y las fechas de fin de contrato, ya que buildForm() solo pinta los valores del draft
  // y no dispara el recálculo por sí solo (eso pasa normalmente al tipear en esos campos).
  recalcDerivedFields();
}

// ============================================================
// ARRANQUE
// ============================================================
function showAppError(msg) {
  document.getElementById('bootLoadingOverlay').hidden = true; // si falla, no dejamos el overlay de carga tapando el error
  const box = document.getElementById('appError');
  box.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = '⚠ ' + msg;
  const btn = document.createElement('button');
  btn.textContent = 'Reintentar';
  btn.addEventListener('click', () => {
    hideAppError();
    boot().catch(err => showAppError(err.message));
  });
  box.appendChild(span);
  box.appendChild(btn);
  box.hidden = false;
  console.error('Gestiones AAD - error:', msg);
}
function hideAppError() {
  document.getElementById('appError').hidden = true;
}

async function boot() {
  document.getElementById('loginScreen').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('userName').textContent = state.session.nombre + ' (' + state.session.rol + ')' + (state.session.sucursalesRestringidas && state.session.sucursalesRestringidas.length ? ' · ' + state.session.sucursalesRestringidas.join(', ') : '');
  document.getElementById('navUsuarios').hidden = state.session.rol !== 'admin';
  const puedeEditar = state.session.rol !== 'consulta';
  const navFormulario = document.querySelector('.nav-btn[data-view="formulario"]');
  if (navFormulario) navFormulario.hidden = !puedeEditar;
  // Los usuarios "Solo consulta" tampoco ven el módulo de Compras.
  document.getElementById('navCompras').hidden = state.session.rol === 'consulta';
  // Los usuarios "Solo consulta" no pueden exportar a Excel/CSV ni imprimir a PDF, en ningún
  // módulo (Registros, Certificaciones, Proyectos, Compras y el Dashboard).
  const puedeExportar = state.session.rol !== 'consulta';
  ['exportBtn', 'certExportBtn', 'proyExportBtn', 'comprasTramitesExportBtn', 'printDashboardBtn', 'seguExportBtn', 'seguPrintBtn', 'dashDetalleExportBtn', 'histSnapshotBtn', 'compExportBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.hidden = !puedeExportar;
  });
  hideAppError();

  try {
    const data = await apiCall('listar');
    state.campos = data.campos;
    state.etapas = data.etapas;
    state.registros = data.registros;
    if (!state.registros.length) {
      showAppError('Conectado correctamente, pero la hoja "Gestiones Plan" no devolvió ninguna fila. Revisá que esa pestaña tenga tus datos y que su nombre sea exactamente "Gestiones Plan".');
    }
  } catch (err) {
    showAppError('No se pudieron cargar los datos: ' + err.message);
    return; // no seguimos si no hay datos
  }

  // Certificaciones se precargan acá (no solo al entrar a esa pestaña) porque el Dashboard necesita
  // sumar el $ Reconocimiento acumulado de todos los contratos. Si falla, el Dashboard sigue andando
  // igual, solo que esa tarjeta va a mostrar $0 hasta que se pueda cargar.
  try {
    await cargarCertificacionesDatos();
  } catch (err) {
    console.error('No se pudieron precargar las certificaciones para el Dashboard:', err);
  }

  // Compras se precarga igual que Certificaciones: el Dashboard y el Calendario de Vencimientos
  // necesitan sus fechas de entrega aunque el usuario no haya entrado a la pestaña Compras todavía.
  try {
    await cargarComprasTramites();
  } catch (err) {
    console.error('No se pudieron precargar las compras para el Dashboard:', err);
  }

  // Historial de KPIs: se precarga (para mostrar "vs. último corte" en el Dashboard) y, si todavía
  // no hay un snapshot guardado para hoy, se guarda uno automáticamente con los totales generales
  // (sin filtros) tal como están en este momento.
  try {
    await cargarHistorialKPIs();
    await guardarSnapshotHistorialSiCorresponde();
  } catch (err) {
    console.error('No se pudo precargar/guardar el historial de KPIs:', err);
  }

  populateFilterOptions();
  buildForm({});
  // Reabrimos la pantalla en la que estaba el usuario (ver showView), no siempre Dashboard. Si es
  // "usuarios" pero ya no es admin (por ejemplo cambió de usuario), o si es "formulario" pero no
  // puede editar, caemos a Dashboard como último recurso.
  let ultimaVista = null;
  try { ultimaVista = sessionStorage.getItem('aad_last_view'); } catch (e) { /* nada que hacer */ }
  const vistaValida = ultimaVista && document.getElementById('view-' + ultimaVista);
  const vistaPermitida = vistaValida
    && !(ultimaVista === 'usuarios' && state.session.rol !== 'admin')
    && !(ultimaVista === 'formulario' && !puedeEditar)
    && !(ultimaVista === 'compras' && state.session.rol === 'consulta');
  // try/finally: si showView() tira una excepción (un bug puntual en un gráfico, por ejemplo),
  // el overlay de "Cargando..." se saca IGUAL — así una falla puntual se ve como un error concreto
  // (mensaje rojo arriba, con "Reintentar") en vez de una pantalla trabada para siempre sin pista
  // de qué pasó. El error sigue subiendo después (lo atrapa el catch de quien llamó a boot()).
  try {
    showView(vistaPermitida ? ultimaVista : 'dashboard');
  } finally {
    document.getElementById('bootLoadingOverlay').hidden = true;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  restoreSession();
  if (state.session) {
    boot().catch(err => {
      alert('No se pudo restaurar la sesión: ' + err.message);
      clearSession();
      location.reload();
    });
  }
});

// ============================================================
// FORMULARIO (alta / edición por etapas)
// ============================================================
// ---- Convierte cualquier valor a formato "yyyy-MM" para inputs type="month" (por si llegó como fecha completa) ----
function toMonthValue(v) {
  if (!v) return '';
  const s = String(v);
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : s;
}

// ---- "Mes/Año" para mostrar en tablas: de "AAAA-MM" (formato del input type="month") a "MM/AA",
// que es como se lee habitualmente en Argentina. Solo cambia cómo se MUESTRA — el campo se sigue
// guardando y editando internamente en formato "AAAA-MM" para que el selector de mes del navegador
// funcione bien. ----
function formatMesAnio(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})/);
  if (!m) return String(v);
  return m[2] + '/' + m[1].slice(2);
}

function fieldByKey(key) {
  return state.campos.find(f => f.key === key);
}
function stageColorVar(idx) {
  return 'var(--stage-' + (idx + 1) + ')';
}

// ---- Un Pospre corresponde a Obra Menor si es "OBRAS MENORES" (el valor vigente y único válido),
// o si contiene la nomenclatura vieja O.D.P / O.D.S (con o sin puntos), por compatibilidad con
// trámites históricos que puedan seguir usándola. ----
function isObraMenorPospre(val) {
  const v = (val || '').toLowerCase();
  return v.includes('obras menores') || v.includes('obra menor')
    || v.includes('o.d.s') || v.includes('o.d.p') || v.includes('ods') || v.includes('odp');
}

function buildForm(record) {
  const lifeline = document.getElementById('lifeline');
  const panelsWrap = document.getElementById('stagePanels');
  lifeline.innerHTML = '';
  panelsWrap.innerHTML = '';

  const isOM = isObraMenorPospre(record.pospre);

  state.etapas.forEach((etapa, idx) => {
    const isProyectos = etapa.id === 'proyectos';
    const disabled = isProyectos && !isOM;

    // --- nodo del stepper ---
    const node = document.createElement('div');
    node.className = 'stage-node' + (disabled ? ' disabled' : '');
    node.style.setProperty('--stage-color', stageColorVar(idx));
    node.dataset.stage = etapa.id;
    node.innerHTML = `<div class="stage-line"></div><div class="stage-dot"></div><div class="stage-label">${etapa.label}</div>`;
    node.addEventListener('click', () => {
      if (disabled) return;
      setActiveStage(etapa.id);
    });
    lifeline.appendChild(node);

    // --- panel de campos ---
    const panel = document.createElement('div');
    panel.className = 'stage-panel';
    panel.id = 'panel-' + etapa.id;
    panel.hidden = idx !== 0;
    if (disabled) panel.hidden = true;

    const title = document.createElement('div');
    title.className = 'stage-panel-title';
    title.innerHTML = `<span class="dot" style="background:${stageColorVar(idx)}"></span> ${etapa.label}` +
      (isProyectos ? ' <span style="font-weight:400;color:var(--text-soft);font-size:12px;">(solo aplica a Pospre O.D.P. / O.D.S. — Obra Menor)</span>' : '');
    panel.appendChild(title);

    if (etapa.id === 'proyectos' && isOM) {
      const kmCard = document.createElement('div');
      kmCard.className = 'subsection-card';

      const kmTitle = document.createElement('div');
      kmTitle.className = 'stage-panel-title';
      kmTitle.innerHTML = `<span class="dot" style="background:var(--stage-3)"></span> Datos únicos del contrato (Obra Menor)`;
      kmCard.appendChild(kmTitle);

      const notaKm = document.createElement('div');
      notaKm.className = 'cert-nota';
      notaKm.innerHTML = `<p>El <strong>$ Km de LAMT del Contrato</strong> y su <strong>Mes/Año de cálculo</strong> se definen una sola vez, apenas se tiene el Pedido de Compras, y aplican automáticamente a todos los proyectos que se carguen después en este PC (Obra Menor) — no hace falta volver a cargarlos en cada proyecto.</p>`;
      kmCard.appendChild(notaKm);

      // Van en su propia grilla, separada de "Cantidad de Proyectos" y los totales calculados de
      // abajo: son datos independientes que se definen una sola vez, no parte del rollup de proyectos.
      const gridKm = document.createElement('div');
      gridKm.className = 'field-grid field-grid-km-lamt';
      [fieldByKey('kmLineaPC'), fieldByKey('mmAAkmLAMT')].filter(Boolean).forEach(f => {
        gridKm.appendChild(buildFieldInput(f, record));
      });
      kmCard.appendChild(gridKm);

      panel.appendChild(kmCard);
    }

    const grid = document.createElement('div');
    grid.className = 'field-grid';
    // Cada etapa puede tener uno o varios rangos de columnas (por ejemplo, "Certificación" agrupa
    // los campos de Ejecución y los de Certificación propiamente dicha, aunque no son columnas contiguas).
    let camposEtapa = (etapa.ranges || [[etapa.from, etapa.to]])
      .reduce((acc, [from, to]) => acc.concat(state.campos.filter(f => f.col >= from && f.col <= to)), []);
    // El $ Km de LAMT y su Mes/Año de cálculo ya se muestran arriba (grilla propia, ver más arriba)
    // cuando la etapa es "Proyectos" de un trámite de Obra Menor — se sacan de acá para no duplicarlos.
    if (etapa.id === 'proyectos' && isOM) {
      camposEtapa = camposEtapa.filter(f => f.key !== 'kmLineaPC' && f.key !== 'mmAAkmLAMT');
    }
    camposEtapa.forEach(f => {
      grid.appendChild(buildFieldInput(f, record));
    });
    panel.appendChild(grid);

    if (etapa.id === 'certificacion') {
      const nota = document.createElement('div');
      nota.className = 'cert-nota';
      if (record._id) {
        nota.innerHTML = `<p>Estos valores se calculan solos, sumando las certificaciones cargadas en la pestaña <strong>Certificaciones</strong>.</p>
          <button type="button" class="btn btn-secondary" id="verCertificacionesBtn">Ver / cargar certificaciones de este trámite</button>`;
      } else {
        nota.innerHTML = `<p>Estos valores se calculan solos, sumando las certificaciones que cargues en la pestaña <strong>Certificaciones</strong>. Primero guardá este trámite; después vas a poder cargarle certificaciones.</p>`;
      }
      panel.appendChild(nota);
    }
    if (etapa.id === 'proyectos') {
      const nota = document.createElement('div');
      nota.className = 'cert-nota';
      if (record._id) {
        nota.innerHTML = `<p>Estos valores se calculan solos, sumando los proyectos cargados en la pestaña <strong>Proyectos</strong>.</p>
          <button type="button" class="btn btn-secondary" id="verProyectosBtn">Ver / cargar proyectos de este trámite</button>`;
      } else {
        nota.innerHTML = `<p>Estos valores se calculan solos, sumando los proyectos que cargues en la pestaña <strong>Proyectos</strong>. Primero guardá este trámite; después vas a poder cargarle proyectos.</p>`;
      }
      panel.appendChild(nota);
    }

    panelsWrap.appendChild(panel);
  });

  const verCertBtn = document.getElementById('verCertificacionesBtn');
  if (verCertBtn) {
    verCertBtn.addEventListener('click', () => {
      certTramitePreseleccionado = record._id;
      showView('certificaciones');
    });
  }
  const verProyBtn = document.getElementById('verProyectosBtn');
  if (verProyBtn) {
    verProyBtn.addEventListener('click', () => {
      proyTramitePreseleccionado = record._id;
      showView('proyectos');
    });
  }

  // Si cambia el Pospre elegido, re-evaluar si Proyectos aplica (solo O.D.P / O.D.S = Obra Menor)
  const pospreInput = panelsWrap.querySelector('[name="pospre"]');
  if (pospreInput) {
    pospreInput.addEventListener('change', () => {
      const om = isObraMenorPospre(pospreInput.value);
      const proyNode = lifeline.querySelector('[data-stage="proyectos"]');
      const proyPanel = document.getElementById('panel-proyectos');
      proyNode.classList.toggle('disabled', !om);
      if (!om) proyPanel.hidden = true;
    });
  }

  // Desplegables dinámicos (Pospre, Sucursal): si el usuario elige "+ Otra (nueva)", mostramos
  // un campo de texto libre en su lugar para que pueda escribir un valor que todavía no existe en la base.
  panelsWrap.querySelectorAll('select.dyn-select').forEach(sel => {
    const row = sel.nextElementSibling; // .dyn-otro-row
    const otroInput = row.querySelector('.dyn-otro-input');
    const volverBtn = row.querySelector('.dyn-otro-volver');
    sel.addEventListener('change', () => {
      if (sel.value === DYNAMIC_SELECT_OTRO) {
        sel.hidden = true;
        sel.removeAttribute('name');
        row.hidden = false;
        otroInput.name = sel.dataset.dynKey;
        otroInput.value = '';
        otroInput.focus();
      }
    });
    volverBtn.addEventListener('click', () => {
      row.hidden = true;
      otroInput.removeAttribute('name');
      sel.hidden = false;
      sel.name = sel.dataset.dynKey;
      sel.value = '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Caso especial: si el campo "Otra (nueva)" es el Pospre, hay que seguir evaluando en vivo
    // si corresponde habilitar la etapa "Proyectos" (solo aplica a Obra Menor: O.D.P. / O.D.S.).
    if (sel.dataset.dynKey === 'pospre') {
      otroInput.addEventListener('input', () => {
        const om = isObraMenorPospre(otroInput.value);
        const proyNode = lifeline.querySelector('[data-stage="proyectos"]');
        const proyPanel = document.getElementById('panel-proyectos');
        proyNode.classList.toggle('disabled', !om);
        if (!om) proyPanel.hidden = true;
      });
    }
  });

  state.activeStage = state.etapas[0].id;
  setActiveStage(state.activeStage);
  document.getElementById('formMsg').hidden = true;
  recalcDerivedFields(); // completa los campos calculados con los valores ya cargados (modo edición)
}

// ---- Recalcula los campos derivados en vivo, a partir de los campos "fuente" del formulario ----
function getFormValue(name) {
  const el = document.querySelector('#stagePanels [name="' + name + '"]');
  return el ? el.value : '';
}
function setFormValue(name, value) {
  const el = document.querySelector('#stagePanels [name="' + name + '"]');
  if (el) el.value = value;
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + (parseInt(days) || 0));
  return d.toISOString().slice(0, 10);
}
function recalcDerivedFields() {
  const cantidad = parseFloat(getFormValue('cantidadesIIBB')) || 0;
  const presUnit = parseFloat(getFormValue('presOficialUnitario')) || 0;
  const adjUnit = parseFloat(getFormValue('adjudicadoUnitario')) || 0;

  // Solo se recalcula (y se pisa lo que hubiera) cuando SÍ hay con qué calcularlo. Si Cantidad o
  // Unitario están vacíos en este momento —por ejemplo, un trámite clonado/importado que ya trae
  // el $ Presupuesto Oficial cargado directamente, sin pasar por estos dos campos— NO se borra el
  // valor que ya estaba, para no perder un dato válido solo porque su "fuente" está vacía ahora.
  if (cantidad && presUnit) {
    setFormValue('presupuestoOficialRubro', (cantidad * presUnit).toFixed(2));
  }
  if (cantidad && adjUnit) {
    setFormValue('totalAdjudicado', (cantidad * adjUnit).toFixed(2));
  }

  const fInicioReal = getFormValue('fechaInicioReal');
  const plazoEntrega = parseInt(getFormValue('plazoEntrega')) || 0;
  const ampliacion = parseInt(getFormValue('ampliacionPlazo')) || 0;
  if (fInicioReal) {
    setFormValue('fechaFinContrato', addDays(fInicioReal, plazoEntrega));
    setFormValue('fechaFinPlazoAmpliada', addDays(fInicioReal, plazoEntrega + ampliacion));
  }

}
document.getElementById('stagePanels').addEventListener('input', (e) => {
  if (e.target.name && RECALC_TRIGGER_FIELDS.has(e.target.name)) {
    recalcDerivedFields();
  }
});
document.getElementById('stagePanels').addEventListener('click', (e) => {
  if (!e.target.classList.contains('btn-mini-add')) return;
  const label = e.target.closest('label');
  const mainInput = label.querySelector('input[name]');
  const addInput = label.querySelector('.sum-add-input');
  const aSumar = parseFloat(addInput.value);
  if (!aSumar) { addInput.focus(); return; }
  const actual = parseFloat(mainInput.value) || 0;
  mainInput.value = (actual + aSumar).toString();
  addInput.value = '';
  if (RECALC_TRIGGER_FIELDS.has(mainInput.name)) recalcDerivedFields();
});

// Valor sentinela para la opción "Otra (nueva)" de los campos con desplegable dinámico (Pospre, Sucursal).
const DYNAMIC_SELECT_OTRO = '__otro__';

function buildFieldInput(f, record) {
  const label = document.createElement('label');
  if (LONG_FIELDS.has(f.key)) label.classList.add('span-2');
  const value = record[f.key] != null ? record[f.key] : '';
  const isDerived = DERIVED_FIELDS.has(f.key);
  const readonlyAttr = isDerived ? 'readonly tabindex="-1"' : '';

  let inputHtml;
  if (SELECT_FIELDS[f.key]) {
    const opts = ['<option value="">—</option>'].concat(
      SELECT_FIELDS[f.key].map(o => `<option value="${o}" ${value === o ? 'selected' : ''}>${o}</option>`)
    );
    inputHtml = `<select name="${f.key}">${opts.join('')}</select>`;
  } else if (DYNAMIC_SELECT_FIELDS.has(f.key)) {
    const existentes = uniqueValues(f.key);
    // Si el registro que se está editando tiene un valor que ya no está en la lista (caso raro), lo incluimos igual para no perderlo.
    if (value && !existentes.includes(value)) existentes.unshift(value);
    const opts = ['<option value="">— Elegí un ' + escapeHtml(f.label) + ' existente —</option>'].concat(
      existentes.map(o => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`)
    ).concat(['<option value="' + DYNAMIC_SELECT_OTRO + '">+ Otra (nueva)...</option>']);
    // Dos elementos, pero solo uno tiene el atributo "name" a la vez (se alterna por JS al elegir "+ Otra (nueva)"),
    // para que el formulario nunca envíe dos valores distintos bajo la misma clave.
    inputHtml = `<select name="${f.key}" class="dyn-select" data-dyn-key="${f.key}">${opts.join('')}</select>` +
      `<div class="dyn-otro-row" hidden>` +
        `<input type="text" placeholder="Escribí ${escapeHtml(f.label)} nuevo/a..." class="dyn-otro-input" />` +
        `<button type="button" class="dyn-otro-volver" title="Volver a elegir de la lista">↩ volver a la lista</button>` +
      `</div>`;
  } else if (LONG_FIELDS.has(f.key)) {
    inputHtml = `<textarea name="${f.key}">${escapeHtml(value)}</textarea>`;
  } else if (DATE_FIELDS.has(f.key)) {
    inputHtml = `<input type="date" name="${f.key}" value="${escapeHtml(value)}" ${readonlyAttr} />`;
  } else if (MONTH_FIELDS.has(f.key)) {
    inputHtml = `<input type="month" name="${f.key}" value="${escapeHtml(toMonthValue(value))}" ${readonlyAttr} />`;
  } else if (NUMBER_FIELDS.has(f.key)) {
    // type="text" + inputmode="decimal" en vez de type="number": los inputs numéricos nativos de
    // Chrome/Edge RECHAZAN la coma decimal (habitual en Argentina, ej. "106,61") y borran lo tipeado.
    // Con texto + normalización en vivo (ver listener global "num-decimal" más abajo) se acepta
    // coma o punto indistintamente y siempre se guarda con punto.
    inputHtml = `<input type="text" inputmode="decimal" class="num-decimal" name="${f.key}" value="${escapeHtml(value)}" ${readonlyAttr} />`;
  } else {
    inputHtml = `<input type="text" name="${f.key}" value="${escapeHtml(value)}" ${readonlyAttr} />`;
  }
  const isSumHelper = SUM_HELPER_FIELDS.has(f.key);
  const sumHelperHtml = isSumHelper
    ? `<div class="sum-helper">
        <input type="text" inputmode="decimal" class="num-decimal sum-add-input" placeholder="Sumar..." />
        <button type="button" class="btn-mini-add" title="Sumar al total">+ Sumar</button>
      </div>`
    : '';
  label.innerHTML = `<span class="field-label-text">${f.label}${isDerived ? ' <span class="calc-badge">calculado</span>' : ''}${isSumHelper ? ' <span class="calc-badge sum-badge">acumulable</span>' : ''}</span>${inputHtml}${sumHelperHtml}`;
  return label;
}

// Normaliza en vivo cualquier input numérico decimal (clase "num-decimal", usada en Nuevo trámite,
// Certificaciones, Proyectos, Ampliación de contrato, etc.): si el usuario tipea una coma como
// separador decimal (habitual en Argentina), la convierte a punto al vuelo, antes de que cualquier
// otro cálculo (recalcDerivedFields, recalcMontoProyecto, etc.) llegue a leer ese valor.
// Se registra en fase de "captura" (tercer parámetro true) para garantizar que corra primero,
// sin importar en qué orden se hayan agregado los demás listeners de "input" del formulario.
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.classList && el.classList.contains('num-decimal') && typeof el.value === 'string' && el.value.indexOf(',') !== -1) {
    const pos = el.selectionStart;
    el.value = el.value.replace(/,/g, '.');
    if (pos !== null && typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(pos, pos); } catch (err) { /* algunos navegadores no lo permiten en ciertos inputs */ }
    }
  }
}, true);

function setActiveStage(stageId) {
  state.activeStage = stageId;
  document.querySelectorAll('.lifeline .stage-node').forEach(n => n.classList.toggle('active', n.dataset.stage === stageId));
  state.etapas.forEach(et => {
    const panel = document.getElementById('panel-' + et.id);
    const node = document.querySelector('.stage-node[data-stage="' + et.id + '"]');
    if (node.classList.contains('disabled')) { panel.hidden = true; return; }
    panel.hidden = et.id !== stageId;
  });
}

document.getElementById('recordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('formMsg');
  msg.hidden = true;
  // Resguardo final: se recalculan los campos derivados (Presupuesto Oficial, Total Adjudicado,
  // Fechas de Fin) justo antes de armar "datos", sin importar cómo llegó el formulario a este
  // punto (tecleado a mano, clonado, ampliación, "sumar" +N). Así lo que se guarda es siempre
  // exactamente lo que la pantalla está mostrando en ese momento — nunca hace falta reabrir el
  // trámite y volver a guardar para que "valide" un cálculo que ya debería estar hecho.
  recalcDerivedFields();
  const datos = {};
  document.querySelectorAll('#stagePanels [name]').forEach(input => {
    datos[input.name] = input.value;
  });
  try {
    if (state.editingId) {
      await apiCall('actualizar', { id: state.editingId, datos });
      msg.textContent = 'Trámite actualizado correctamente.';
    } else {
      const r = await apiCall('crear', { datos });
      state.editingId = r.id;
      msg.textContent = 'Trámite creado correctamente.';
    }
    msg.className = 'form-msg ok';
    msg.hidden = false;
    const data = await apiCall('listar');
    state.registros = data.registros;
    populateFilterOptions();
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
    msg.className = 'form-msg err';
    msg.hidden = false;
  }
});

function openRecordForEdit(record) {
  state.editingId = record._id;
  document.getElementById('formTitle').textContent = 'Editar trámite — ' + (record.expediente || record.pospre || '');
  document.getElementById('ampliacionBanner').hidden = true;
  buildForm(record);
  showView('formulario');
}

// ============================================================
// REGISTROS + FILTROS
// ============================================================
// ---- Componente de selección múltiple por tildado (checkboxes) ----
function closeAllMultiselects(except) {
  document.querySelectorAll('.multiselect.open').forEach(ms => { if (ms !== except) ms.classList.remove('open'); });
}
document.addEventListener('click', () => closeAllMultiselects());

function msLabel(selected, total) {
  if (!selected || selected.length === 0) return 'Todos';
  if (total && selected.length === total) return 'Todos (' + total + ')';
  if (selected.length === 1) return selected[0];
  return selected.length + ' seleccionados';
}

function getCheckedValues(el) {
  return Array.from(el.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value);
}

function renderMultiselect(el, options, selected, onChange) {
  const sel = new Set(selected || []);
  el._msTotalOptions = options.length; // se actualiza en cada render, para que los listeners (registrados una sola vez) sepan el total vigente
  el.innerHTML =
    '<button type="button" class="ms-toggle"><span class="ms-toggle-label">' + escapeHtml(msLabel(selected, options.length)) + '</span><span class="ms-caret">▾</span></button>' +
    '<div class="ms-panel">' +
      (options.length > 6 ? '<input type="text" class="ms-search" placeholder="Buscar..." />' : '') +
      '<div class="ms-actions">' +
        '<button type="button" class="ms-selectall">Marcar todos</button>' +
        '<button type="button" class="ms-clear">Limpiar selección</button>' +
      '</div>' +
      '<div class="ms-options">' +
      (options.length
        ? options.map(o => '<label class="ms-option"><input type="checkbox" value="' + escapeHtml(o) + '" ' + (sel.has(o) ? 'checked' : '') + '/><span>' + escapeHtml(o) + '</span></label>').join('')
        : '<div class="ms-empty">Sin opciones</div>') +
      '</div>' +
    '</div>';

  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('.ms-toggle')) {
        const willOpen = !el.classList.contains('open');
        closeAllMultiselects(el);
        el.classList.toggle('open', willOpen);
        const search = el.querySelector('.ms-search');
        if (willOpen && search) {
          search.value = '';
          filtrarOpcionesMultiselect(el, '');
          setTimeout(() => search.focus(), 0);
        }
      } else if (e.target.closest('.ms-clear')) {
        el.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
        const label = el.querySelector('.ms-toggle-label');
        if (label) label.textContent = 'Todos';
        el._msOnChange && el._msOnChange([]);
      } else if (e.target.closest('.ms-selectall')) {
        el.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true); // tilda TODAS las opciones, aunque el buscador esté filtrando la vista
        const checked = getCheckedValues(el);
        const label = el.querySelector('.ms-toggle-label');
        if (label) label.textContent = msLabel(checked, el._msTotalOptions);
        el._msOnChange && el._msOnChange(checked);
      }
    });
    el.addEventListener('input', (e) => {
      if (e.target.matches('.ms-search')) {
        filtrarOpcionesMultiselect(el, e.target.value);
      }
    });
    el.addEventListener('change', (e) => {
      if (e.target.matches('input[type=checkbox]')) {
        const checked = getCheckedValues(el);
        const label = el.querySelector('.ms-toggle-label');
        if (label) label.textContent = msLabel(checked, el._msTotalOptions);
        el._msOnChange && el._msOnChange(checked);
      }
    });
  }
  el._msOnChange = onChange; // siempre apunta al callback más reciente
}

// ---- Filtra visualmente las opciones de un multiselect según el texto buscado (sin tocar la selección) ----
function filtrarOpcionesMultiselect(el, query) {
  const q = query.trim().toLowerCase();
  el.querySelectorAll('.ms-option').forEach(opt => {
    const texto = opt.textContent.trim().toLowerCase();
    opt.style.display = (!q || texto.includes(q)) ? '' : 'none';
  });
}

function uniqueValues(key) {
  return uniqueValuesFrom(state.registros, key);
}
function uniqueValuesFrom(rows, key) {
  const set = new Set();
  rows.forEach(r => { if (r[key]) set.add(String(r[key]).trim()); });
  return Array.from(set).sort();
}

// ---- Opciones "facetadas" del filtro compartido: las opciones disponibles para cada campo se
// calculan sobre las filas que ya pasan TODOS los demás filtros activos (sin contar el propio
// campo) — así, elegir Sucursal "Centro" deja en el combo de Pedido de Compras solo los que
// existen en Centro, y en Contratista solo los que tienen algún Pedido de Compras en Centro, y
// así en cadena con el resto de los campos. ----
function opcionesFacetadas(key) {
  const otrasKeys = SHARED_FILTER_KEYS.filter(k => k !== key);
  let rows = aplicarFiltrosAvanzados(
    applyFilters(state.registros, state.filtrosCompartidos, otrasKeys),
    state.filtrosCompartidos
  );
  if (state.riesgoPlazoActivoCompartido) rows = rows.filter(esRiesgoPorPlazo);
  const opts = uniqueValuesFrom(rows, key);
  if (key === 'estado' && rows.some(r => !r.estado)) opts.push(ESTADO_VACIO_LABEL);
  return opts;
}

// ---- Repuebla los 3 combos de filtros (Dashboard/Registros/Seguimiento comparten el mismo
// estado, pero cada uno tiene su propia barra de multiselects en el DOM) con las opciones ya
// facetadas, y descarta de la selección actual cualquier valor que haya dejado de ser posible
// por culpa de otro filtro más restrictivo. Se llama al arrancar cada una de las 3 vistas y cada
// vez que cambia cualquier filtro, para que las tres queden siempre en sincro. ----
const FILTROS_COMPARTIDOS_BARRAS = [
  { selector: '#dashFiltersBar', attr: 'data-dashfilter', onChange: () => renderDashboard() },
  { selector: '#filtersBar', attr: 'data-filter', onChange: () => renderRegistros() },
  { selector: '#seguFiltersBar', attr: 'data-segufilter', onChange: () => renderSeguimiento() },
  { selector: '#certFiltersBar', attr: 'data-certfilter', onChange: () => renderCertTable() },
  { selector: '#proyFiltersBar', attr: 'data-proyfilter', onChange: () => renderProyTable() }
];
function populateFilterOptions() {
  SHARED_FILTER_KEYS.filter(k => k !== 'expediente').forEach(key => {
    const opts = opcionesFacetadas(key);
    state.filtrosCompartidos[key] = (state.filtrosCompartidos[key] || []).filter(v => opts.includes(v));
    FILTROS_COMPARTIDOS_BARRAS.forEach(bar => {
      const el = document.querySelector(bar.selector + ' [' + bar.attr + '="' + key + '"]');
      if (!el) return;
      renderMultiselect(el, opts, state.filtrosCompartidos[key], (vals) => {
        state.filtrosCompartidos[key] = vals;
        bar.onChange();
      });
    });
  });
  sincronizarFiltrosAvanzadosUI();
}

// ---- Sincroniza visualmente los inputs de "Filtros avanzados" (Fecha P.C., % de Avance, Buscar
// palabra) y el botón + badge de "Riesgo por Plazo" de las 3 barras (Dashboard/Registros/
// Seguimiento) con el estado compartido. Se llama cada vez que se repueblan los combos, para que
// al entrar a un módulo sus inputs ya reflejen lo que se cargó en cualquiera de los otros dos. ----
const FILTROS_AVANZADOS_UI = [
  { prefijo: 'dash', expedienteSelector: '#dashFiltersBar [data-dashfilter="expediente"]', riesgoBtn: 'riesgoPlazoBtn', riesgoBadge: 'riesgoPlazoBadge' },
  { prefijo: 'reg', expedienteSelector: '#filtersBar [data-filter="expediente"]', riesgoBtn: 'riesgoPlazoBtnReg', riesgoBadge: 'riesgoPlazoBadgeReg' },
  { prefijo: 'segu', expedienteSelector: '#seguFiltersBar [data-segufilter="expediente"]', riesgoBtn: 'riesgoPlazoBtnSegu', riesgoBadge: 'riesgoPlazoBadgeSegu' },
  { prefijo: 'cert', expedienteSelector: '#certFiltersBar [data-certfilter="expediente"]', riesgoBtn: 'riesgoPlazoBtnCert', riesgoBadge: 'riesgoPlazoBadgeCert' },
  { prefijo: 'proy', expedienteSelector: '#proyFiltersBar [data-proyfilter="expediente"]', riesgoBtn: 'riesgoPlazoBtnProy', riesgoBadge: 'riesgoPlazoBadgeProy' }
];
function sincronizarFiltrosAvanzadosUI() {
  const f = state.filtrosCompartidos;
  // Se calcula UNA sola vez para las 5 barras (antes se recalculaba adentro del forEach, 5 veces
  // el mismo resultado) — sobre datasets grandes esto era la parte más pesada de cada render.
  const cantidadRiesgo = filtrosCompartidosBase().filter(esRiesgoPorPlazo).length;
  FILTROS_AVANZADOS_UI.forEach(ui => {
    const setVal = (idSuffix, val) => {
      const el = document.getElementById(ui.prefijo + idSuffix);
      if (el && el !== document.activeElement) el.value = val; // no pisar lo que se está tipeando en ese momento
    };
    setVal('FechaPCDesde', f.fechaPCDesde || '');
    setVal('FechaPCHasta', f.fechaPCHasta || '');
    setVal('PctAvanceDesde', f.pctAvanceDesde || '');
    setVal('PctAvanceHasta', f.pctAvanceHasta || '');
    setVal('TextoBuscar', f.texto || '');
    setVal('TextoModo', f.textoModo || 'contiene');
    const expEl = document.querySelector(ui.expedienteSelector);
    if (expEl && expEl !== document.activeElement) expEl.value = f.expediente || '';
    const btn = document.getElementById(ui.riesgoBtn);
    if (btn) btn.classList.toggle('active', !!state.riesgoPlazoActivoCompartido);
    const badge = document.getElementById(ui.riesgoBadge);
    if (badge) badge.textContent = cantidadRiesgo;
  });
}

// ---- Filas que pasan el filtro compartido completo (categóricos + avanzados), SIN aplicar el
// toggle de "Riesgo por Plazo" — la usan tanto el badge (para contar cuántos calificarían) como
// cada módulo antes de decidir si aplica o no ese toggle. ----
function filtrosCompartidosBase() {
  return aplicarFiltrosAvanzados(applyFilters(state.registros, state.filtrosCompartidos, SHARED_FILTER_KEYS), state.filtrosCompartidos);
}

// ---- Set de _id de trámites que pasan el filtro compartido (con el toggle de riesgo aplicado si
// está activo). Lo usan Certificaciones y Proyectos para filtrar sus propias tablas por trámite,
// ya que sus registros no tienen todos los campos del filtro (Sucursal/Año/Estado, etc.) y hay
// que ir a buscarlos al trámite vinculado (idTramite). ----
function idsTramitesPermitidosPorFiltroCompartido() {
  const rows = state.riesgoPlazoActivoCompartido ? filtrosCompartidosBase().filter(esRiesgoPorPlazo) : filtrosCompartidosBase();
  return new Set(rows.map(r => r._id));
}

document.querySelector('#filtersBar [data-filter="expediente"]').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.expediente = e.target.value.trim();
  renderRegistros();
}, 300));
document.querySelector('#dashFiltersBar [data-dashfilter="expediente"]').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.expediente = e.target.value.trim();
  renderDashboard();
}, 300));
document.querySelector('#seguFiltersBar [data-segufilter="expediente"]').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.expediente = e.target.value.trim();
  renderSeguimiento();
}, 300));

// ---- Limpiar TODOS los filtros compartidos de una sola vez (categóricos + avanzados + riesgo).
// Cualquiera de los 3 botones "Limpiar filtros" (Dashboard/Registros/Seguimiento) dispara esto
// mismo, porque los 3 módulos comparten el mismo filtro — no tendría sentido limpiar "solo la
// mitad". El único parámetro es qué función de render llamar al final (la del módulo donde se
// tocó el botón; las otras dos se ponen al día solas la próxima vez que se entra a esa vista). ----
function limpiarFiltrosCompartidos(renderActual) {
  SHARED_FILTER_KEYS.forEach(k => { state.filtrosCompartidos[k] = (k === 'expediente') ? '' : []; });
  state.filtrosCompartidos.fechaPCDesde = '';
  state.filtrosCompartidos.fechaPCHasta = '';
  state.filtrosCompartidos.pctAvanceDesde = '';
  state.filtrosCompartidos.pctAvanceHasta = '';
  state.filtrosCompartidos.texto = '';
  state.filtrosCompartidos.textoModo = 'contiene';
  state.riesgoPlazoActivoCompartido = false;
  populateFilterOptions(); // repuebla combos + sincroniza inputs avanzados de las 3 barras
  renderActual();
}
document.getElementById('clearFilters').addEventListener('click', () => limpiarFiltrosCompartidos(renderRegistros));
document.getElementById('dashClearFilters').addEventListener('click', () => limpiarFiltrosCompartidos(renderDashboard));
document.getElementById('seguClearFilters').addEventListener('click', () => limpiarFiltrosCompartidos(renderSeguimiento));
document.getElementById('certClearFilters').addEventListener('click', () => limpiarFiltrosCompartidos(renderCertTable));
document.getElementById('proyClearFilters').addEventListener('click', () => limpiarFiltrosCompartidos(renderProyTable));

document.querySelector('#certFiltersBar [data-certfilter="expediente"]').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.expediente = e.target.value.trim();
  renderCertTable();
}, 300));
document.getElementById('certFechaPCDesde').addEventListener('change', (e) => { state.filtrosCompartidos.fechaPCDesde = e.target.value; renderCertTable(); });
document.getElementById('certFechaPCHasta').addEventListener('change', (e) => { state.filtrosCompartidos.fechaPCHasta = e.target.value; renderCertTable(); });
document.getElementById('certPctAvanceDesde').addEventListener('input', debounce((e) => { state.filtrosCompartidos.pctAvanceDesde = e.target.value; renderCertTable(); }, 300));
document.getElementById('certPctAvanceHasta').addEventListener('input', debounce((e) => { state.filtrosCompartidos.pctAvanceHasta = e.target.value; renderCertTable(); }, 300));
document.getElementById('certTextoBuscar').addEventListener('input', debounce((e) => { state.filtrosCompartidos.texto = e.target.value; renderCertTable(); }, 300));
document.getElementById('certTextoModo').addEventListener('change', (e) => { state.filtrosCompartidos.textoModo = e.target.value; renderCertTable(); });
document.getElementById('riesgoPlazoBtnCert').addEventListener('click', () => {
  state.riesgoPlazoActivoCompartido = !state.riesgoPlazoActivoCompartido;
  renderCertTable();
});

document.querySelector('#proyFiltersBar [data-proyfilter="expediente"]').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.expediente = e.target.value.trim();
  renderProyTable();
}, 300));
document.getElementById('proyFechaPCDesde').addEventListener('change', (e) => { state.filtrosCompartidos.fechaPCDesde = e.target.value; renderProyTable(); });
document.getElementById('proyFechaPCHasta').addEventListener('change', (e) => { state.filtrosCompartidos.fechaPCHasta = e.target.value; renderProyTable(); });
document.getElementById('proyPctAvanceDesde').addEventListener('input', debounce((e) => { state.filtrosCompartidos.pctAvanceDesde = e.target.value; renderProyTable(); }, 300));
document.getElementById('proyPctAvanceHasta').addEventListener('input', debounce((e) => { state.filtrosCompartidos.pctAvanceHasta = e.target.value; renderProyTable(); }, 300));
document.getElementById('proyTextoBuscar').addEventListener('input', debounce((e) => { state.filtrosCompartidos.texto = e.target.value; renderProyTable(); }, 300));
document.getElementById('proyTextoModo').addEventListener('change', (e) => { state.filtrosCompartidos.textoModo = e.target.value; renderProyTable(); });
document.getElementById('riesgoPlazoBtnProy').addEventListener('click', () => {
  state.riesgoPlazoActivoCompartido = !state.riesgoPlazoActivoCompartido;
  renderProyTable();
});

wireToggleFiltrosAvanzados('certFiltrosAvanzadosToggle', 'certFiltersBarAvanzados');
wireToggleFiltrosAvanzados('proyFiltrosAvanzadosToggle', 'proyFiltersBarAvanzados');
if (tieneFiltrosAvanzadosActivos(state.filtrosCompartidos, state.riesgoPlazoActivoCompartido)) {
  document.getElementById('certFiltersBarAvanzados').hidden = false;
  document.getElementById('certFiltrosAvanzadosToggle').classList.add('is-open');
  document.getElementById('proyFiltersBarAvanzados').hidden = false;
  document.getElementById('proyFiltrosAvanzadosToggle').classList.add('is-open');
}

document.getElementById('regFechaPCDesde').addEventListener('change', (e) => {
  state.filtrosCompartidos.fechaPCDesde = e.target.value;
  renderRegistros();
});
document.getElementById('regFechaPCHasta').addEventListener('change', (e) => {
  state.filtrosCompartidos.fechaPCHasta = e.target.value;
  renderRegistros();
});
document.getElementById('regPctAvanceDesde').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.pctAvanceDesde = e.target.value;
  renderRegistros();
}, 300));
document.getElementById('regPctAvanceHasta').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.pctAvanceHasta = e.target.value;
  renderRegistros();
}, 300));
document.getElementById('regTextoBuscar').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.texto = e.target.value;
  renderRegistros();
}, 300));
document.getElementById('regTextoModo').addEventListener('change', (e) => {
  state.filtrosCompartidos.textoModo = e.target.value;
  renderRegistros();
});
document.getElementById('riesgoPlazoBtnReg').addEventListener('click', () => {
  state.riesgoPlazoActivoCompartido = !state.riesgoPlazoActivoCompartido;
  document.getElementById('riesgoPlazoBtnReg').classList.toggle('active', state.riesgoPlazoActivoCompartido);
  renderRegistros();
});

// ---- Toggle de "Filtros avanzados": colapsa/expande la segunda fila de filtros más
// específicos (Fecha P.C., % de Avance, Buscar palabra, Riesgo por Plazo), tanto en Dashboard
// como en Registros. Si alguno de esos filtros ya tiene un valor cargado, se muestra expandido
// de entrada (no queremos esconder un filtro activo sin que se note). ----
function tieneFiltrosAvanzadosActivos(filtros, riesgoActivo) {
  return !!(filtros.fechaPCDesde || filtros.fechaPCHasta || filtros.pctAvanceDesde || filtros.pctAvanceHasta || filtros.texto || riesgoActivo);
}
function wireToggleFiltrosAvanzados(btnId, panelId) {
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  btn.addEventListener('click', () => {
    const abierto = panel.hidden;
    panel.hidden = !abierto;
    btn.classList.toggle('is-open', abierto);
  });
}
wireToggleFiltrosAvanzados('dashFiltrosAvanzadosToggle', 'dashFiltersBarAvanzados');
wireToggleFiltrosAvanzados('filtrosAvanzadosToggle', 'filtersBarAvanzados');
if (tieneFiltrosAvanzadosActivos(state.filtrosCompartidos, state.riesgoPlazoActivoCompartido)) {
  document.getElementById('dashFiltersBarAvanzados').hidden = false;
  document.getElementById('dashFiltrosAvanzadosToggle').classList.add('is-open');
}
if (tieneFiltrosAvanzadosActivos(state.filtrosCompartidos, state.riesgoPlazoActivoCompartido)) {
  document.getElementById('filtersBarAvanzados').hidden = false;
  document.getElementById('filtrosAvanzadosToggle').classList.add('is-open');
}

document.getElementById('dashFechaPCDesde').addEventListener('change', (e) => {
  state.filtrosCompartidos.fechaPCDesde = e.target.value;
  renderDashboard();
});
document.getElementById('dashFechaPCHasta').addEventListener('change', (e) => {
  state.filtrosCompartidos.fechaPCHasta = e.target.value;
  renderDashboard();
});
document.getElementById('dashPctAvanceDesde').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.pctAvanceDesde = e.target.value;
  renderDashboard();
}, 300));
document.getElementById('dashPctAvanceHasta').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.pctAvanceHasta = e.target.value;
  renderDashboard();
}, 300));
document.getElementById('dashTextoBuscar').addEventListener('input', debounce((e) => {
  state.filtrosCompartidos.texto = e.target.value;
  renderDashboard();
}, 300));
document.getElementById('dashTextoModo').addEventListener('change', (e) => {
  state.filtrosCompartidos.textoModo = e.target.value;
  renderDashboard();
});
document.getElementById('riesgoPlazoBtn').addEventListener('click', () => {
  state.riesgoPlazoActivoCompartido = !state.riesgoPlazoActivoCompartido;
  document.getElementById('riesgoPlazoBtn').classList.toggle('active', state.riesgoPlazoActivoCompartido);
  renderDashboard();
});

// ---- Criterio de "Riesgo por Plazo": vencido o vence en <=30 días, y no está Finalizado ----
const DIAS_RIESGO = 30;
function fechaLimiteTramite(r) {
  return r.fechaFinPlazoAmpliada || r.fechaFinContrato || '';
}
function esRiesgoPorPlazo(r) {
  if (r.estado === 'Finalizado') return false;
  const fechaLimite = fechaLimiteTramite(r);
  if (!fechaLimite) return false;
  const dLimite = new Date(fechaLimite + 'T00:00:00');
  if (isNaN(dLimite.getTime())) return false;
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const diffDias = (dLimite - hoy) / (1000 * 60 * 60 * 24);
  return diffDias <= DIAS_RIESGO;
}

// ============================================================
// CALENDARIO DE VENCIMIENTOS
// ============================================================
const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
let calMonthDate = new Date(); calMonthDate.setDate(1);
let calSelectedDay = null;

document.getElementById('calPrevBtn').addEventListener('click', () => {
  calMonthDate.setMonth(calMonthDate.getMonth() - 1);
  calSelectedDay = null;
  renderCalendar();
});
document.getElementById('calNextBtn').addEventListener('click', () => {
  calMonthDate.setMonth(calMonthDate.getMonth() + 1);
  calSelectedDay = null;
  renderCalendar();
});
document.getElementById('calTodayBtn').addEventListener('click', () => {
  calMonthDate = new Date(); calMonthDate.setDate(1);
  calSelectedDay = null;
  renderCalendar();
});

function renderCalendar() {
  const rows = filteredForDashboardBase(); // respeta filtros del dashboard, no el toggle de riesgo (queremos ver todo el mes)
  const porDia = {};
  rows.forEach(r => {
    if (r.estado === 'Finalizado') return;
    const fecha = fechaLimiteTramite(r);
    if (!fecha) return;
    if (!porDia[fecha]) porDia[fecha] = [];
    porDia[fecha].push({ _tipo: 'contratacion', rec: r });
  });
  // Compras: cada Entrega todavía pendiente (con Fecha Contractual cargada y sin Fecha Real) figura
  // en el calendario en esa fecha, esté vencida o no (igual que Contrataciones) — ver
  // comprasEntregasEventosParaCalendario más abajo, que arma esto a partir del modelo nuevo de
  // Trámites/Entregas (reemplaza a comprasEventosParaCalendario del árbol viejo, ya retirado).
  comprasEntregasEventosParaCalendario().forEach(ev => {
    if (!porDia[ev.fecha]) porDia[ev.fecha] = [];
    porDia[ev.fecha].push({ _tipo: 'compra', rec: ev });
  });

  // Si hay vencimientos de Compras cargados pero ninguno cae en el mes que se está mirando,
  // lo avisamos: así se distingue "están en otro mes" de "no se cargaron / no aparecen".
  const hintEl = document.getElementById('calComprasHint');
  if (hintEl) {
    const todasLasFechasCompras = comprasEntregasEventosParaCalendario().map(ev => ev.fecha).sort();
    const mesActual = calMonthDate.getFullYear() + '-' + String(calMonthDate.getMonth() + 1).padStart(2, '0');
    const hayEnEsteMes = todasLasFechasCompras.some(f => f.startsWith(mesActual));
    if (todasLasFechasCompras.length && !hayEnEsteMes) {
      const hoyStrHint = new Date().toISOString().slice(0, 10);
      const proxima = todasLasFechasCompras.find(f => f >= hoyStrHint) || todasLasFechasCompras[todasLasFechasCompras.length - 1];
      hintEl.hidden = false;
      hintEl.innerHTML = `Hay ${todasLasFechasCompras.length} vencimiento(s) de Compras cargado(s), pero ninguno en este mes. ` +
        `<button type="button" class="btn-link" id="calIrAComprasBtn">Ir al ${escapeHtml(proxima)}</button>`;
      const irBtn = document.getElementById('calIrAComprasBtn');
      if (irBtn) irBtn.addEventListener('click', () => {
        const [yy, mm] = proxima.split('-');
        calMonthDate = new Date(Number(yy), Number(mm) - 1, 1);
        renderCalendar();
      });
    } else {
      hintEl.hidden = true;
    }
  }

  document.getElementById('calMonthLabel').textContent = MESES_ES[calMonthDate.getMonth()] + ' ' + calMonthDate.getFullYear();

  const year = calMonthDate.getFullYear();
  const month = calMonthDate.getMonth();
  const primerDiaSemana = (new Date(year, month, 1).getDay() + 6) % 7; // 0=lunes
  const diasEnMes = new Date(year, month + 1, 0).getDate();
  const hoyStr = new Date().toISOString().slice(0, 10);

  const grid = document.getElementById('calendarGrid');
  let html = '';
  for (let i = 0; i < primerDiaSemana; i++) html += '<div class="cal-day cal-empty"></div>';

  for (let d = 1; d <= diasEnMes; d++) {
    const fechaStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const eventos = porDia[fechaStr] || [];
    const esHoy = fechaStr === hoyStr;
    let badges = '';
    if (eventos.length) {
      const vencidos = eventos.filter(r => fechaStr < hoyStr).length;
      const proximos = eventos.filter(r => fechaStr >= hoyStr && (new Date(fechaStr) - new Date(hoyStr)) / 86400000 <= DIAS_RIESGO).length;
      const lejanos = eventos.length - vencidos - proximos;
      if (vencidos) badges += `<span class="cal-badge vencido">${vencidos}</span>`;
      if (proximos) badges += `<span class="cal-badge proximo">${proximos}</span>`;
      if (lejanos) badges += `<span class="cal-badge lejano">${lejanos}</span>`;
    }
    html += `<div class="cal-day ${esHoy ? 'cal-today' : ''} ${eventos.length ? 'cal-has-events' : ''}" data-fecha="${fechaStr}">
      <div class="cal-day-num">${d}</div>
      <div class="cal-day-badges">${badges}</div>
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.cal-has-events').forEach(el => {
    el.addEventListener('click', () => {
      calSelectedDay = el.dataset.fecha;
      mostrarDetalleDia(porDia[calSelectedDay], calSelectedDay);
    });
  });

  const detailBox = document.getElementById('calendarDayDetail');
  if (calSelectedDay && porDia[calSelectedDay]) {
    mostrarDetalleDia(porDia[calSelectedDay], calSelectedDay);
  } else {
    detailBox.hidden = true;
  }
}

function mostrarDetalleDia(eventos, fechaStr) {
  const detailBox = document.getElementById('calendarDayDetail');
  const fechaLegible = new Date(fechaStr + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  detailBox.innerHTML = `<h4>Vencen el ${fechaLegible} (${eventos.length})</h4>` +
    eventos.map(ev => {
      if (ev._tipo === 'compra') {
        const c = ev.rec;
        return `<div class="cal-detail-item">
            <span><span class="cal-tag-compra">Compra</span> PC ${escapeHtml(c.nroPC || '')} Pos. ${escapeHtml(c.posicion || '')} (${escapeHtml(c.tramo)}) — Matrícula ${escapeHtml(c.matricula || 's/n')} — ${escapeHtml(c.adjudicatario || '(sin adjudicatario)')} — ${escapeHtml(c.destino || '')}</span>
            <b>${escapeHtml(c.expediente || '')}</b>
          </div>`;
      }
      const r = ev.rec;
      return `<div class="cal-detail-item">
          <span><span class="cal-tag-contratacion">Contratación</span> ${escapeHtml(r.nroPedidoCompras || '(sin PC)')} — ${escapeHtml(r.adjudicatario || '(sin contratista)')} — ${escapeHtml(r.sucursal || '')}</span>
          <b>${escapeHtml(r.expediente || '')}</b>
        </div>`;
    }).join('');
  detailBox.hidden = false;
}

// ============================================================
// CALENDARIO DE APERTURAS (el otro extremo de la vida del trámite)
// ============================================================
let calAperturaMonthDate = new Date(); calAperturaMonthDate.setDate(1);
let calAperturaSelectedDay = null;

document.getElementById('calAperturaPrevBtn').addEventListener('click', () => {
  calAperturaMonthDate.setMonth(calAperturaMonthDate.getMonth() - 1);
  calAperturaSelectedDay = null;
  renderCalendarApertura();
});
document.getElementById('calAperturaNextBtn').addEventListener('click', () => {
  calAperturaMonthDate.setMonth(calAperturaMonthDate.getMonth() + 1);
  calAperturaSelectedDay = null;
  renderCalendarApertura();
});
document.getElementById('calAperturaTodayBtn').addEventListener('click', () => {
  calAperturaMonthDate = new Date(); calAperturaMonthDate.setDate(1);
  calAperturaSelectedDay = null;
  renderCalendarApertura();
});

function renderCalendarApertura() {
  const rows = filteredForDashboardBase(); // respeta filtros del dashboard
  const porDia = {};
  rows.forEach(r => {
    const fecha = r.fechaPedidoCompras;
    if (!fecha) return;
    if (!porDia[fecha]) porDia[fecha] = [];
    porDia[fecha].push(r);
  });

  document.getElementById('calAperturaMonthLabel').textContent = MESES_ES[calAperturaMonthDate.getMonth()] + ' ' + calAperturaMonthDate.getFullYear();

  const year = calAperturaMonthDate.getFullYear();
  const month = calAperturaMonthDate.getMonth();
  const primerDiaSemana = (new Date(year, month, 1).getDay() + 6) % 7; // 0=lunes
  const diasEnMes = new Date(year, month + 1, 0).getDate();
  const hoyStr = new Date().toISOString().slice(0, 10);

  const grid = document.getElementById('calendarAperturaGrid');
  let html = '';
  for (let i = 0; i < primerDiaSemana; i++) html += '<div class="cal-day cal-empty"></div>';

  for (let d = 1; d <= diasEnMes; d++) {
    const fechaStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const eventos = porDia[fechaStr] || [];
    const esHoy = fechaStr === hoyStr;
    const badges = eventos.length ? `<span class="cal-badge cal-badge-apertura">${eventos.length}</span>` : '';
    html += `<div class="cal-day ${esHoy ? 'cal-today' : ''} ${eventos.length ? 'cal-has-events' : ''}" data-fecha="${fechaStr}">
      <div class="cal-day-num">${d}</div>
      <div class="cal-day-badges">${badges}</div>
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.cal-has-events').forEach(el => {
    el.addEventListener('click', () => {
      calAperturaSelectedDay = el.dataset.fecha;
      mostrarDetalleDiaApertura(porDia[calAperturaSelectedDay], calAperturaSelectedDay);
    });
  });

  const detailBox = document.getElementById('calendarAperturaDayDetail');
  if (calAperturaSelectedDay && porDia[calAperturaSelectedDay]) {
    mostrarDetalleDiaApertura(porDia[calAperturaSelectedDay], calAperturaSelectedDay);
  } else {
    detailBox.hidden = true;
  }
}

function mostrarDetalleDiaApertura(eventos, fechaStr) {
  const detailBox = document.getElementById('calendarAperturaDayDetail');
  const fechaLegible = new Date(fechaStr + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  detailBox.innerHTML = `<h4>Se abrieron el ${fechaLegible} (${eventos.length})</h4>` +
    eventos.map(r => `<div class="cal-detail-item">
        <span>${escapeHtml(r.pospre || '(sin pospre)')} — ${escapeHtml(r.adjudicatario || '(sin contratista)')} — ${escapeHtml(r.sucursal || '')}</span>
        <b>${escapeHtml(r.expediente || '')}</b>
      </div>`).join('');
  detailBox.hidden = false;
}

// ---- % de Avance de un trámite: Certificado / Adjudicado * 100 (misma fórmula que en toda la app) ----
function pctAvanceTramite(r) {
  const adj = num(r.totalAdjudicado);
  return adj > 0 ? (num(r.certificadosAAD) / adj) * 100 : 0;
}

// ---- % de Presupuesto Proyectado respecto del Adjudicado del contrato: $ Proyectados Acumulados
// (suma de "$ del Proyecto" de todos los proyectos del trámite) sobre el $ Total Adjudicado. No
// confundir con "% IIBB Proyectados" (que compara cantidades de IIBB, no plata). ----
function pctPresupuestoProyectado(r) {
  const adj = num(r.totalAdjudicado);
  return adj > 0 ? (num(r.proyectadosAcumulados) / adj) * 100 : 0;
}

// ---- Campos de texto sobre los que busca el filtro "Contiene / No contiene" (Dashboard y Registros) ----
const DASH_TEXTO_CAMPOS = [
  'pospre', 'expediente', 'sucursal', 'rubro', 'detalleRubro', 'nroPedidoCompras',
  'adjudicatario', 'estado', 'agenciaSector', 'observaciones'
];

// ---- Filtros avanzados compartidos por Dashboard y Registros: Fecha P.C. desde/hasta, % de
// Avance desde/hasta, y Buscar palabra (Contiene/No contiene). Recibe el objeto de filtros
// (state.filtrosCompartidos o state.filtrosCompartidos) para no duplicar esta lógica en cada módulo. ----
function aplicarFiltrosAvanzados(rows, filtros) {
  const desde = filtros.fechaPCDesde;
  const hasta = filtros.fechaPCHasta;
  if (desde || hasta) {
    rows = rows.filter(r => {
      const v = r.fechaPedidoCompras;
      if (!v) return false;
      if (desde && v < desde) return false;
      if (hasta && v > hasta) return false;
      return true;
    });
  }

  const pctDesde = filtros.pctAvanceDesde;
  const pctHasta = filtros.pctAvanceHasta;
  if ((pctDesde !== '' && pctDesde != null) || (pctHasta !== '' && pctHasta != null)) {
    rows = rows.filter(r => {
      const pct = pctAvanceTramite(r);
      if (pctDesde !== '' && pctDesde != null && pct < parseFloat(pctDesde)) return false;
      if (pctHasta !== '' && pctHasta != null && pct > parseFloat(pctHasta)) return false;
      return true;
    });
  }

  const texto = (filtros.texto || '').trim().toLowerCase();
  if (texto) {
    const modo = filtros.textoModo || 'contiene';
    rows = rows.filter(r => {
      const contiene = DASH_TEXTO_CAMPOS.some(k => String(r[k] || '').toLowerCase().includes(texto));
      return modo === 'no_contiene' ? !contiene : contiene;
    });
  }

  return rows;
}

function filteredForDashboardBase() {
  return filtrosCompartidosBase();
}

function filteredForDashboard() {
  const rows = filteredForDashboardBase();
  return state.riesgoPlazoActivoCompartido ? rows.filter(esRiesgoPorPlazo) : rows;
}

function applyFilters(rows, filtros, keys) {
  return rows.filter(r => {
    return keys.every(k => {
      const fval = filtros[k];
      if (k === 'expediente') {
        if (!fval) return true;
        return String(r.expediente || '').toLowerCase().includes(String(fval).toLowerCase());
      }
      if (!fval || !fval.length) return true; // sin selección = sin filtro
      const rval = String(r[k] || '').trim();
      // "Estado" vacío (trámite sin adjudicar) se filtra a través de la etiqueta sentinela ESTADO_VACIO_LABEL.
      const efectivo = (k === 'estado' && rval === '') ? ESTADO_VACIO_LABEL : rval;
      return fval.includes(efectivo);
    });
  });
}

function filteredRecordsBase() {
  return filtrosCompartidosBase();
}
function filteredRecords() {
  const rows = filteredRecordsBase();
  return state.riesgoPlazoActivoCompartido ? rows.filter(esRiesgoPorPlazo) : rows;
}

const REGISTROS_COLS = [
  { key: 'pospre', label: 'Pospre' },
  { key: 'expediente', label: 'Expediente' },
  { key: 'anio', label: 'Año' },
  { key: 'sucursal', label: 'Sucursal' },
  { key: 'rubro', label: 'Rubro' },
  { key: 'nroPedidoCompras', label: 'Pedido Compras' },
  { key: 'adjudicatario', label: 'Contratista' },
  { key: 'presupuestoOficialRubro', label: 'Pres. Oficial' },
  { key: 'totalAdjudicado', label: 'Total Adjudicado' },
  { key: 'certificadosAAD', label: 'Certificado' },
  { key: 'pctAvance', label: '% Avance' },
  { key: 'cantidadProyectos', label: 'Cant. Proyectos' },
  { key: 'pctPresupuestoProyectado', label: '% Presup. Proyectado' },
  { key: 'pctIIBBProyectados', label: '% IIBB Proyectados / Gestionados' },
  { key: 'seguimiento', label: 'Seguimiento' },
  { key: 'estado', label: 'Estado' }
];

// ============================================================
// ORDENAMIENTO GENÉRICO DE TABLAS (por click en el encabezado)
// ============================================================
const MONEY_COL_KEYS = new Set(['presupuestoOficialRubro', 'totalAdjudicado', 'certificadosAAD']);

// Valor "comparable" de un registro de trámite para una columna dada (usado para ordenar)
function registroSortValue(r, key) {
  if (key === 'pctAvance') return pctAvanceTramite(r);
  if (key === 'pctPresupuestoProyectado') return pctPresupuestoProyectado(r);
  if (MONEY_COL_KEYS.has(key) || key === 'anio' || key === 'cantidadProyectos' || key === 'pctIIBBProyectados') return num(r[key]);
  return String(r[key] != null ? r[key] : '').toLowerCase();
}

// Compara dos valores ya extraídos (números entre sí, o texto entre sí con localeCompare en español)
function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'es', { sensitivity: 'base', numeric: true });
}

// Genera el <thead> con encabezados clickeables y la flechita de orden activo
function sortableTheadHtml(cols, sortState, extraThHtml) {
  const ths = cols.map(c => {
    const activo = sortState.key === c.key;
    const flecha = activo ? '<span class="sort-arrow">' + (sortState.dir === 1 ? '▲' : '▼') + '</span>' : '';
    return `<th class="sortable${activo ? ' sort-active' : ''}" data-sort-key="${c.key}">${c.label}${flecha}</th>`;
  }).join('');
  return '<thead><tr>' + ths + (extraThHtml || '') + '</tr></thead>';
}

// Conecta los clicks de los <th data-sort-key> de una tabla ya renderizada a un estado de orden dado
function wireSortableHeaders(table, sortState, onChange) {
  table.querySelectorAll('th.sortable[data-sort-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (sortState.key === key) { sortState.dir = -sortState.dir; }
      else { sortState.key = key; sortState.dir = 1; }
      onChange();
    });
  });
}

// Genera las filas <td> de un registro de trámite según REGISTROS_COLS (reutilizado por Registros y Dashboard "Todos")
// ---- "AAAA-MM-DD" -> "DD/MM/AAAA", para mostrar fechas de forma legible en tablas de detalle ----
// ---- "AAAA-MM-DD" -> "DD/MM/AAAA". Si el valor no tiene ese formato (por ejemplo, texto suelto
// cargado por error en la planilla en vez de una fecha real — es lo que generaba el "#########"
// que se veía en pantalla), se muestra "-" en vez de imprimir ese texto sin sentido. ----
function formatFechaCorta(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[3] + '/' + m[2] + '/' + m[1]) : '-';
}

function registroTdsHtml(r, cols) {
  return (cols || REGISTROS_COLS).map(c => {
    if (c.key === 'estado') {
      const cls = r.estado && ['Adjudicado','Desierto','Relanzado','Finalizado'].includes(r.estado) ? 'state-' + r.estado : 'state-default';
      const texto = r.estado ? r.estado : ESTADO_VACIO_LABEL;
      return `<td><span class="state-pill ${cls}">${escapeHtml(texto)}</span></td>`;
    }
    if (DATE_FIELDS.has(c.key)) return `<td class="mono">${escapeHtml(formatFechaCorta(r[c.key]))}</td>`;
    if (MONEY_COL_KEYS.has(c.key)) return `<td class="mono">${formatMoney(r[c.key])}</td>`;
    if (c.key === 'pctAvance') return `<td class="mono">${pctAvanceTramite(r).toFixed(1)}%</td>`;
    if (c.key === 'anio') return `<td class="mono">${escapeHtml(r.anio != null ? r.anio : '')}</td>`;
    if (c.key === 'cantidadProyectos') return `<td class="mono">${num(r.cantidadProyectos) || 0}</td>`;
    if (c.key === 'pctPresupuestoProyectado') return `<td class="mono">${pctPresupuestoProyectado(r).toFixed(1)}%</td>`;
    if (c.key === 'pctIIBBProyectados') return `<td class="mono">${num(r.pctIIBBProyectados).toFixed(1)}%</td>`;
    // Textos potencialmente largos (nombre del contratista): se truncan con "..." y el texto
    // completo queda disponible al pasar el mouse, para no forzar el ancho de toda la tabla.
    if (c.key === 'adjudicatario' || c.key === 'seguimiento') {
      const texto = r[c.key] != null ? r[c.key] : '';
      return `<td class="td-truncate" title="${escapeHtml(texto)}">${escapeHtml(texto)}</td>`;
    }
    return `<td>${escapeHtml(r[c.key] != null ? r[c.key] : '')}</td>`;
  }).join('');
}

function sortRows(rows, sortState, valueFn) {
  if (!sortState.key) return rows;
  const copy = rows.slice();
  copy.sort((a, b) => compareValues(valueFn(a, sortState.key), valueFn(b, sortState.key)) * sortState.dir);
  return copy;
}

function rowClassForEstado(r) {
  if (r.estado === 'Finalizado') return ' class="row-finalizado"';
  if (r.estado === 'Desierto') return ' class="row-desierto"';
  if (r.estado === 'Relanzado') return ' class="row-relanzado"';
  return '';
}

function renderRegistros() {
  populateFilterOptions(); // repuebla combos (facetados) y sincroniza inputs avanzados de las 3 barras compartidas

  let rows = filteredRecords();
  rows = sortRows(rows, state.registrosSort, registroSortValue);
  document.getElementById('resultsCount').textContent = rows.length + ' trámite(s) encontrados de ' + state.registros.length + ' totales.';
  const table = document.getElementById('recordsTable');
  const isAdmin = state.session && state.session.rol === 'admin';
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  const thead = sortableTheadHtml(REGISTROS_COLS, state.registrosSort, '<th class="col-sticky">Acciones</th>');
  const tbody = '<tbody>' + rows.map(r => {
    const tds = registroTdsHtml(r);
    const acciones = `<td class="row-actions col-sticky">
        <button class="icon-btn" data-action="copiar" title="Copiar datos">📋</button>
        ${puedeEditar ? '<button class="icon-btn" data-action="clonar" title="Clonar trámite">🧬</button>' : ''}
        ${isAdmin ? '<button class="icon-btn danger" data-action="eliminar" title="Eliminar trámite">🗑️</button>' : ''}
      </td>`;
    return `<tr data-id="${r._id}"${rowClassForEstado(r)}>${tds}${acciones}</tr>`;
  }).join('') + '</tbody>';
  table.innerHTML = thead + tbody;
  table.classList.toggle('solo-consulta', !puedeEditar);
  setupScrollShadow(table.closest('.table-wrap'), 'recordsScrollTop', 'recordsScrollTopInner');
  wireSortableHeaders(table, state.registrosSort, renderRegistros);

  table.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.row-actions')) return; // los botones de acción no abren el formulario
      if (!puedeEditar) return; // solo consulta: no se abre el formulario de edición
      const rec = state.registros.find(r => r._id === tr.dataset.id);
      if (rec) abrirRegistroOCompras(rec);
    });
  });

  table.querySelectorAll('.row-actions [data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tr = btn.closest('tr');
      const rec = state.registros.find(r => r._id === tr.dataset.id);
      if (!rec) return;
      if (btn.dataset.action === 'copiar') copiarTramite(rec, btn);
      if (btn.dataset.action === 'clonar') clonarTramite(rec);
      if (btn.dataset.action === 'eliminar') eliminarTramite(rec);
    });
  });
}

// ---- Oculta la sombra de "hay más contenido" cuando el scroll horizontal llega al final,
//      y sincroniza la barra de scroll duplicada de arriba con la tabla de abajo (si se pasan
//      los IDs de esa barra — solo las tablas que pueden ser muy anchas la tienen). ----
function setupScrollShadow(wrap, topBarId, topInnerId) {
  if (!wrap) return;
  function update() {
    const alFinal = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2;
    wrap.classList.toggle('scrolled-end', alFinal || wrap.scrollWidth <= wrap.clientWidth);
  }
  update();
  if (!wrap.dataset.scrollWired) {
    wrap.dataset.scrollWired = '1';
    wrap.addEventListener('scroll', update);
    window.addEventListener('resize', update);
  }

  if (!topBarId) return;
  const topBar = document.getElementById(topBarId);
  const topInner = document.getElementById(topInnerId);
  if (topBar && topInner) {
    topInner.style.width = wrap.scrollWidth + 'px';
    if (!topBar.dataset.scrollWired) {
      topBar.dataset.scrollWired = '1';
      let syncing = false;
      topBar.addEventListener('scroll', () => {
        if (syncing) return; syncing = true;
        wrap.scrollLeft = topBar.scrollLeft;
        syncing = false;
      });
      wrap.addEventListener('scroll', () => {
        if (syncing) return; syncing = true;
        topBar.scrollLeft = wrap.scrollLeft;
        syncing = false;
      });
      window.addEventListener('resize', () => { topInner.style.width = wrap.scrollWidth + 'px'; });
    }
  }
}

// ---- Copiar: pasa un resumen del trámite al portapapeles ----
function copiarTramite(r, btn) {
  const resumen = [
    'Pospre: ' + (r.pospre || ''),
    'Expediente: ' + (r.expediente || ''),
    'Año: ' + (r.anio || ''),
    'Sucursal: ' + (r.sucursal || ''),
    'Rubro: ' + (r.rubro || ''),
    'N° Pedido de Compras: ' + (r.nroPedidoCompras || ''),
    'Contratista/Proveedor: ' + (r.adjudicatario || ''),
    'Estado: ' + (r.estado || ''),
    'Presupuesto Oficial: ' + formatMoney(r.presupuestoOficialRubro),
    'Total Adjudicado: ' + formatMoney(r.totalAdjudicado),
    'Total Certificado: ' + formatMoney(r.certificadosAAD),
  ].join('\n');

  navigator.clipboard.writeText(resumen).then(() => {
    const original = btn.textContent;
    btn.textContent = '✅';
    setTimeout(() => { btn.textContent = original; }, 1200);
  }).catch(() => {
    alert('No se pudo copiar. Tu navegador puede estar bloqueando el acceso al portapapeles.');
  });
}

// ---- Clonar: crea un trámite nuevo con los mismos datos ----
async function clonarTramite(r) {
  const confirmado = confirm('¿Clonar este trámite? Se va a crear un trámite nuevo con los mismos datos (podés editarlo después).');
  if (!confirmado) return;
  const datos = {};
  state.campos.forEach(f => { datos[f.key] = r[f.key]; });
  try {
    await apiCall('crear', { datos });
    const data = await apiCall('listar');
    state.registros = data.registros;
    populateFilterOptions();
    renderRegistros();
  } catch (err) {
    alert('Error al clonar: ' + err.message);
  }
}

// ---- Eliminar: borra el trámite (solo admin, lo valida también el backend) ----
async function eliminarTramite(r) {
  const confirmado = confirm('¿Eliminar definitivamente el trámite "' + (r.expediente || r.pospre || '') + '"? Esta acción no se puede deshacer.');
  if (!confirmado) return;
  try {
    await apiCall('eliminar', { id: r._id });
    const data = await apiCall('listar');
    state.registros = data.registros;
    populateFilterOptions();
    renderRegistros();
  } catch (err) {
    alert('Error al eliminar: ' + err.message);
  }
}

document.getElementById('exportBtn').addEventListener('click', () => {
  const rows = filteredRecords();
  if (!rows.length) { alert('No hay trámites para exportar con los filtros actuales.'); return; }
  const data = rows.map(r => {
    const obj = {};
    state.campos.forEach(f => { obj[f.label] = r[f.key]; });
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vida de Trámites');
  XLSX.writeFile(wb, 'gestiones_aad_export.xlsx');
});

// ============================================================
// DASHBOARD
// ============================================================
let chartAdjCertSucursal, chartCertificacionPC;

document.getElementById('dashGroupBy').addEventListener('change', renderDashboard);

// Plugin de Chart.js "casero" para dibujar el valor sobre cada punto de la curva
const pointLabelPlugin = {
  id: 'pointLabelPlugin',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    chart.data.datasets.forEach((dataset, i) => {
      if (dataset.type && dataset.type !== 'line') return; // solo dibuja sobre datasets de línea
      if (dataset.pointRadius === 0) return; // no dibujar sobre la línea de promedio (sin puntos)
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden) return;
      meta.data.forEach((point, index) => {
        // Si el dataset trae "rawData" (valor real, sin recortar para el eje), se muestra ese en la etiqueta
        const value = dataset.rawData ? dataset.rawData[index] : dataset.data[index];
        if (value == null) return;
        const sospechoso = value > 110;
        ctx.save();
        ctx.fillStyle = sospechoso ? '#7C3AED' : '#16202A';
        ctx.font = '600 11px "IBM Plex Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((sospechoso ? '⚠ ' : '') + value.toFixed(1) + '%', point.x, point.y - 12);
        ctx.restore();
      });
    });
  }
};

// ---- Dibuja el valor al final de cada barra (para gráficos de barras horizontales tipo ranking) ----
const barEndLabelPlugin = {
  id: 'barEndLabelPlugin',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    chart.data.datasets.forEach((dataset, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden) return;
      meta.data.forEach((bar, index) => {
        const value = dataset.rawData ? dataset.rawData[index] : dataset.data[index];
        if (value == null) return;
        const sospechoso = value > 110;
        ctx.save();
        ctx.fillStyle = sospechoso ? '#7C3AED' : '#16202A';
        ctx.font = '600 11px "IBM Plex Sans", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText((sospechoso ? '⚠ ' : '') + value.toFixed(1) + '%', bar.x + 6, bar.y);
        ctx.restore();
      });
    });
  }
};

function semColor(pct) {
  return pct >= 75 ? '#16A34A' : (pct >= 40 ? '#D97706' : '#DC2626');
}
function truncateLabel(text, maxLen) {
  if (!text) return text;
  return text.length > maxLen ? text.slice(0, maxLen - 1).trim() + '…' : text;
}

function renderDashboard() {
  populateFilterOptions(); // repuebla combos (facetados) y sincroniza inputs avanzados de las 3 barras compartidas; puede podar selecciones que dejaron de ser válidas

  const groupKey = document.getElementById('dashGroupBy').value;
  const rows = filteredForDashboard();

  // ---- Calendario de vencimientos ----
  renderCalendar();

  // ---- KPIs generales (montos en millones, 2 decimales) ----
  const totalPresOficial = sumField(rows, 'presupuestoOficialRubro');
  const totalAdjudicado = sumField(rows, 'totalAdjudicado');
  const totalCertificado = sumField(rows, 'certificadosAAD');
  const totalMultas = sumField(rows, 'sumatoriaMultas');
  const pctEjecucion = totalAdjudicado > 0 ? (totalCertificado / totalAdjudicado) * 100 : 0;
  const desvioPresupuestario = totalPresOficial > 0 ? ((totalAdjudicado - totalPresOficial) / totalPresOficial) * 100 : 0;
  // % de Avance por Certificación: misma fórmula que el campo calculado (Certificado / Adjudicado * 100),
  // aplicada sobre los totales del filtro actual — para que coincida con el dato individual, no un promedio aparte.
  const avanceCertificacion = totalAdjudicado > 0 ? (totalCertificado / totalAdjudicado) * 100 : 0;

  // ---- $ Reconocimiento acumulado: suma de "$ de Reconocimiento" de TODAS las certificaciones
  // cargadas cuyo trámite pasa el filtro actual del Dashboard. No es un dato del trámite en sí (no
  // se guarda ahí), se cruza en vivo con las certificaciones ya cargadas en la otra pestaña.
  const idsFiltrados = new Set(rows.map(r => r._id));
  const totalReconocimiento = (certListaCache || [])
    .filter(c => idsFiltrados.has(c.idTramite))
    .reduce((acc, c) => acc + num(c.montoReconocimiento), 0);

  // ---- Desiertos vs. Adjudicados: sobre los trámites del filtro actual que ya tienen uno de estos dos estados ----
  const cantDesiertos = rows.filter(r => r.estado === 'Desierto').length;
  const cantAdjudicados = rows.filter(r => r.estado === 'Adjudicado').length;
  const totalDesAdj = cantDesiertos + cantAdjudicados;
  const pctDesiertos = totalDesAdj > 0 ? (cantDesiertos / totalDesAdj) * 100 : 0;

  // ---- Obras Menores (Pospre O.D.P. / O.D.S.): IIBB Proyectados sobre el filtro actual ----
  const rowsObraMenor = rows.filter(r => isObraMenorPospre(r.pospre));
  const sumaIIBBProyectados = sumField(rowsObraMenor, 'cantTotalIIBBProyectados');
  const sumaIIBBGestionadosOM = sumField(rowsObraMenor, 'cantidadesIIBB');
  const pctIIBBProyectadoGeneral = sumaIIBBGestionadosOM > 0 ? (sumaIIBBProyectados / sumaIIBBGestionadosOM) * 100 : 0;

  // ---- Multas: variación vs. el último snapshot guardado del Historial de KPIs. Solo se muestra
  // sin filtros activos, porque el snapshot guardado es siempre sobre los totales generales ----
  const dashSinFiltrosActivos = DASH_FILTER_KEYS.every(k => !state.filtrosCompartidos[k] || !state.filtrosCompartidos[k].length)
    && !state.filtrosCompartidos.fechaPCDesde && !state.filtrosCompartidos.fechaPCHasta
    && !state.filtrosCompartidos.pctAvanceDesde && !state.filtrosCompartidos.pctAvanceHasta
    && !state.filtrosCompartidos.texto && !state.riesgoPlazoActivoCompartido;
  let subMultas = 'sin IVA';
  if (dashSinFiltrosActivos) {
    const previo = snapshotAnteriorAHoy();
    if (previo) {
      const deltaMultas = totalMultas - num(previo.totalMultas);
      const deltaPct = num(previo.totalMultas) > 0 ? (deltaMultas / num(previo.totalMultas)) * 100 : null;
      subMultas = (deltaMultas >= 0 ? '+' : '') + formatMillions(deltaMultas) + ' vs. ' + previo.fecha
        + (deltaPct != null ? ' (' + (deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(1) + '%)' : '');
    } else {
      subMultas = 'sin IVA · sin snapshot anterior para comparar todavía';
    }
  }

  // ---- Contratistas en semáforo rojo (mismo criterio de "Resumen por Contratista": <40% de avance) ----
  const contratistaStats = computeContratistaStats(rows);

  // ---- Semáforo de los KPIs porcentuales: mismo criterio de color que el resto de la app
  // (semColor: ≥75% verde, ≥40% amarillo, <40% rojo) para % Ejecución y % IIBB Proyectados
  // (donde más alto es mejor). El Desvío presupuestario es al revés: 0% o negativo (por debajo
  // del oficial) es lo deseable, y recién se pone rojo si el sobrecosto supera el 15%. ----
  const colorPctEjecucion = semColor(pctEjecucion);
  const colorDesvio = desvioPresupuestario <= 0 ? '#16A34A' : (desvioPresupuestario <= 15 ? '#D97706' : '#DC2626');
  const colorPctIIBB = semColor(pctIIBBProyectadoGeneral);

  const kpiRow = document.getElementById('kpiRow');
  kpiRow.innerHTML = [
    kpiCard('Trámites (filtro actual)', rows.length, 'de ' + state.registros.length + ' totales'),
    kpiCard('Presupuesto oficial total', formatMillions(totalPresOficial), 'sin IVA'),
    kpiCard('Total adjudicado', formatMillions(totalAdjudicado), 'sin IVA'),
    kpiCard('Certificado por AAD', formatMillions(totalCertificado), 'sin IVA'),
    kpiCard('% Ejecución', pctEjecucion.toFixed(1) + '%', 'certificado / adjudicado', colorPctEjecucion),
    kpiCard('Desvío presupuestario', (desvioPresupuestario >= 0 ? '+' : '') + desvioPresupuestario.toFixed(1) + '%', desvioPresupuestario >= 0 ? 'por encima del oficial' : 'por debajo del oficial', colorDesvio),
    kpiCard('Multas acumuladas', formatMillions(totalMultas), subMultas),
    kpiCard('$ Reconocimiento acumulado', formatMillions(totalReconocimiento), 'suma de certificaciones cargadas'),
    kpiCard('Desiertos / Adjudicados', cantDesiertos + ' / ' + cantAdjudicados, totalDesAdj > 0 ? pctDesiertos.toFixed(1) + '% de los procesos definidos salieron desiertos' : 'sin procesos definidos en este filtro'),
    kpiCard('Contratistas en semáforo rojo', contratistaStats.rojo + ' / ' + contratistaStats.total, contratistaStats.total ? '<40% de avance · ' + ((contratistaStats.rojo / contratistaStats.total) * 100).toFixed(1) + '% del total' : 'sin contratistas en este filtro'),
    kpiCard('IIBB Proyectados (Obra Menor)', sumaIIBBProyectados.toLocaleString('es-AR', { maximumFractionDigits: 2 }), rowsObraMenor.length + ' trámite(s) de Obra Menor en este filtro'),
    kpiCard('% IIBB Proyectados / Gestionados', pctIIBBProyectadoGeneral.toFixed(1) + '%', 'sobre ' + sumaIIBBGestionadosOM.toLocaleString('es-AR', { maximumFractionDigits: 2 }) + ' IIBB gestionados (Obra Menor)', colorPctIIBB),
  ].join('');


  // ---- Datos por Sucursal (Presupuesto Oficial / Adjudicado / Certificado) — o por Pedido de
  // Compras cuando hay una única Sucursal seleccionada en el filtro, para poder ver el detalle
  // interno de esa sucursal en vez de una sola barra plana. ----
  const sucursalUnicaSeleccionada = state.filtrosCompartidos.sucursal && state.filtrosCompartidos.sucursal.length === 1 ? state.filtrosCompartidos.sucursal[0] : null;
  const chartAgruparPor = sucursalUnicaSeleccionada ? 'nroPedidoCompras' : 'sucursal';
  const chartEtiquetaGrupo = sucursalUnicaSeleccionada ? 'Pedido de Compras' : 'Sucursal';

  const bySucursal = {};
  rows.forEach(r => {
    const key = (r[chartAgruparPor] || '(sin ' + chartEtiquetaGrupo.toLowerCase() + ')').toString().trim() || '(sin ' + chartEtiquetaGrupo.toLowerCase() + ')';
    if (!bySucursal[key]) bySucursal[key] = { presOficial:0, adjudicado:0, certificado:0, contratistas: new Set(), pospres: new Set() };
    bySucursal[key].presOficial += num(r.presupuestoOficialRubro);
    bySucursal[key].adjudicado += num(r.totalAdjudicado);
    bySucursal[key].certificado += num(r.certificadosAAD);
    if (sucursalUnicaSeleccionada) {
      if (r.adjudicatario && String(r.adjudicatario).trim()) bySucursal[key].contratistas.add(String(r.adjudicatario).trim());
      if (r.pospre && String(r.pospre).trim()) bySucursal[key].pospres.add(String(r.pospre).trim());
    }
  });
  const sucursalEntries = Object.entries(bySucursal).sort((a,b) => b[1].presOficial - a[1].presOficial);

  // ---- En modo desagregado (una sola Sucursal seleccionada), la etiqueta de cada Pedido de Compras
  // suma Contratista y Pospre, para poder identificarlo sin tener que ir a Registros a buscarlo. ----
  const etiquetaGrupoChart = (key, info) => {
    if (!sucursalUnicaSeleccionada) return key;
    const contratista = info.contratistas.size ? Array.from(info.contratistas).join(' / ') : '(sin contratista)';
    const pospre = info.pospres.size ? Array.from(info.pospres).join(' / ') : '';
    return key + ' — ' + contratista + (pospre ? ' (' + pospre + ')' : '');
  };
  const chartLabels = sucursalEntries.map(([key, info]) => etiquetaGrupoChart(key, info));

  document.getElementById('chartAdjCertTitulo').textContent = sucursalUnicaSeleccionada
    ? 'Presupuesto Oficial / Adjudicado / Certificado por Pedido de Compras — ' + sucursalUnicaSeleccionada + ' (% de Avance)'
    : 'Presupuesto Oficial / Adjudicado / Certificado por Sucursal — con % de Avance';

  // ---- Combo: Adjudicado vs Certificado por Sucursal, con % de Avance (semáforo) ----
  const pctPorSucursal = sucursalEntries.map(e => e[1].adjudicado > 0 ? (e[1].certificado / e[1].adjudicado) * 100 : 0);
  const promedioAvanceSucursal = totalAdjudicado > 0 ? (totalCertificado / totalAdjudicado) * 100 : 0;
  const UMBRAL_SOSPECHOSO = 110; // por encima de esto, casi seguro hay un dato mal cargado (Cantidad/Unitario) en algún trámite de esa sucursal
  const EJE_MAX = 130;
  // La línea se dibuja recortada al máximo del eje (para que nunca "se dispare" visualmente),
  // pero la etiqueta sobre cada punto sigue mostrando el valor real, marcado con ⚠ si es sospechoso.
  const pctParaGraficar = pctPorSucursal.map(p => Math.min(p, EJE_MAX));
  const colorPorSucursal = pctPorSucursal.map(p => p > UMBRAL_SOSPECHOSO ? '#7C3AED' : semColor(p));

  const ctxAC = document.getElementById('chartAdjCertSucursal').getContext('2d');
  if (chartAdjCertSucursal) chartAdjCertSucursal.destroy();
  chartAdjCertSucursal = new Chart(ctxAC, {
    type: 'bar',
    data: {
      labels: chartLabels,
      datasets: [
        { type:'bar', label:'Presupuesto Oficial', data: sucursalEntries.map(e => num(e[1].presOficial) / 1000000), backgroundColor:'#CBD5E1', order:2 },
        { type:'bar', label:'Adjudicado', data: sucursalEntries.map(e => e[1].adjudicado / 1000000), backgroundColor:'#93C5FD', order:2 },
        { type:'bar', label:'Certificado', data: sucursalEntries.map(e => e[1].certificado / 1000000), backgroundColor:'#6EE7B7', order:2 },
        { type:'line', label:'% Avance por Sucursal', data: pctParaGraficar, rawData: pctPorSucursal, yAxisID:'y1', borderColor:'#64748B', tension:0.3,
          pointRadius:5, pointBackgroundColor: colorPorSucursal, pointBorderColor: colorPorSucursal, order:1 },
        { type:'line', label:'Promedio General (' + promedioAvanceSucursal.toFixed(0) + '%)', data: sucursalEntries.map(() => Math.min(promedioAvanceSucursal, EJE_MAX)),
          yAxisID:'y1', borderColor:'#D97706', borderDash:[6,4], pointRadius:0, order:0 }
      ]
    },
    plugins: [pointLabelPlugin],
    options: {
      responsive:true, maintainAspectRatio:false,
      scales:{
        x:{ ticks:{ autoSkip:false, maxRotation:60, minRotation:30, callback: function(value) { return truncateLabel(this.getLabelForValue(value), 26); } } },
        y:{ beginAtZero:true, title:{ display:true, text:'Millones de $' } },
        y1:{ beginAtZero:true, max:EJE_MAX, position:'right', grid:{ drawOnChartArea:false }, title:{ display:true, text:'% Avance' } }
      },
      plugins:{ legend:{ position:'bottom' } }
    }
  });

  const notaSospechosos = document.getElementById('chartAdjCertNota');
  const sucursalesSospechosas = sucursalEntries
    .map(([key, info], i) => ({ nombre: etiquetaGrupoChart(key, info), pct: pctPorSucursal[i] }))
    .filter(s => s.pct > UMBRAL_SOSPECHOSO);
  if (sucursalesSospechosas.length) {
    notaSospechosos.innerHTML = '⚠ Valores fuera de rango (revisar Cantidad/IIBB o $ Adjudicado Unitario en los trámites de ' + (sucursalUnicaSeleccionada ? 'estos pedidos' : 'estas sucursales') + '): ' +
      sucursalesSospechosas.map(s => `<strong>${escapeHtml(s.nombre)}</strong> (${s.pct.toFixed(0)}%)`).join(', ');
    notaSospechosos.hidden = false;
  } else {
    notaSospechosos.hidden = true;
  }

  // ---- Gráfico: % de Certificación por Pedido de Compras (barras horizontales, con Sucursal/Contratista) ----
  const byPC = {};
  rows.forEach(r => {
    if (!r.nroPedidoCompras) return;
    const key = String(r.nroPedidoCompras).trim();
    if (!byPC[key]) byPC[key] = { adjudicado:0, certificado:0, sucursales:new Set(), contratistas:new Set() };
    byPC[key].adjudicado += num(r.totalAdjudicado);
    byPC[key].certificado += num(r.certificadosAAD);
    if (r.sucursal) byPC[key].sucursales.add(r.sucursal.trim());
    if (r.adjudicatario) byPC[key].contratistas.add(r.adjudicatario.trim());
  });
  const listaCortaPC = (set, max = 2) => {
    const arr = Array.from(set);
    return arr.length <= max ? arr.join(', ') : arr.slice(0, max).join(', ') + ' +' + (arr.length - max);
  };
  const pcEntries = Object.entries(byPC)
    .map(([k, v]) => ({
      pc: k,
      pct: v.adjudicado > 0 ? (v.certificado / v.adjudicado) * 100 : 0,
      detalle: listaCortaPC(v.sucursales) + ' · ' + listaCortaPC(v.contratistas)
    }))
    .sort((a,b) => a.pct - b.pct)
    .slice(0, 13);

  const EJE_MAX_PC = 130;
  const pctRealPC = pcEntries.map(e => e.pct);
  const pctGraficarPC = pctRealPC.map(p => Math.min(p, EJE_MAX_PC));
  const colorPorPC = pctRealPC.map(p => p > 110 ? '#7C3AED' : semColor(p));

  const ctx5 = document.getElementById('chartCertificacionPC').getContext('2d');
  if (chartCertificacionPC) chartCertificacionPC.destroy();
  chartCertificacionPC = new Chart(ctx5, {
    type: 'bar',
    data: {
      labels: pcEntries.map(e => ['PC ' + e.pc, e.detalle]), // array = etiqueta de 2 líneas en Chart.js
      datasets: [{
        label: '% Certificación',
        data: pctGraficarPC,
        rawData: pctRealPC,
        backgroundColor: colorPorPC,
        borderRadius: 4,
        barThickness: 16
      }]
    },
    plugins: [barEndLabelPlugin],
    options: {
      indexAxis: 'y',
      responsive:true, maintainAspectRatio:false,
      scales:{
        x:{ beginAtZero:true, max: EJE_MAX_PC, title:{ display:true, text:'% Certificación' } },
        y:{ ticks:{ font:{ size:11 } } }
      },
      plugins:{
        legend:{ display:false },
        tooltip:{ callbacks:{ label: (ctx) => (ctx.raw != null ? pctRealPC[ctx.dataIndex].toFixed(1) : '0') + '% de certificación' } }
      }
    }
  });

  // ---- Resumen por Contratista (tarjetas con semáforo) ----
  renderContratistaResumen(rows);

  // ---- Contratos vigentes por Sucursal: Adjudicados vs. Vacío (sin adjudicar) ----
  renderPivotSucursalEstado(rows);

  // ---- Tabla de detalle (según "Agrupar por") ----
  // "Todos": en vez de agrupar, se muestra el detalle completo de cada trámite que pasa los filtros actuales.
  if (groupKey === 'todos') {
    renderDashDetalleCompleto(rows);
    return;
  }

  const groups = {};
  rows.forEach(r => {
    const vacioLabel = groupKey === 'estado' ? ESTADO_VACIO_LABEL : '(sin dato)';
    const key = (r[groupKey] || vacioLabel).toString().trim() || vacioLabel;
    if (!groups[key]) groups[key] = { n:0, presOficial:0, adjudicado:0, certificado:0, certProcesados:0, proyectos:0, proyectadosAcumulados:0, pctIIBBValores:[], sucursales:new Set(), contratistas:new Set(), fechasFinContrato:new Set() };
    groups[key].n++;
    groups[key].presOficial += num(r.presupuestoOficialRubro);
    groups[key].adjudicado += num(r.totalAdjudicado);
    groups[key].certificado += num(r.certificadosAAD);
    groups[key].certProcesados += num(r.cantidadCertificadosProcesados);
    groups[key].proyectos += num(r.cantidadProyectos);
    groups[key].proyectadosAcumulados += num(r.proyectadosAcumulados);
    const pctIIBB = num(r.pctIIBBProyectados);
    if (pctIIBB > 0) groups[key].pctIIBBValores.push(pctIIBB);
    if (r.sucursal) groups[key].sucursales.add(r.sucursal.trim());
    if (r.adjudicatario) groups[key].contratistas.add(r.adjudicatario.trim());
    if (r.fechaFinContrato) groups[key].fechasFinContrato.add(formatFechaCorta(r.fechaFinContrato));
  });
  const promedioPctIIBB = (v) => v.pctIIBBValores.length ? v.pctIIBBValores.reduce((a,b) => a+b, 0) / v.pctIIBBValores.length : 0;
  const listaCorta = (set, max = 3) => {
    const arr = Array.from(set);
    return arr.length <= max ? arr.join(', ') : arr.slice(0, max).join(', ') + ' (+' + (arr.length - max) + ')';
  };

  const mostrarSucursalContratista = groupKey === 'nroPedidoCompras';

  // Filas "planas" listas para ordenar por cualquier columna (por defecto: Pres. Oficial descendente, como antes)
  let filas = Object.entries(groups).map(([k, v]) => ({
    grupo: k,
    n: v.n,
    presOficial: v.presOficial,
    adjudicado: v.adjudicado,
    certificado: v.certificado,
    avance: v.adjudicado > 0 ? (v.certificado / v.adjudicado) * 100 : 0,
    certProcesados: v.certProcesados,
    proyectos: v.proyectos,
    proyectadosAcumulados: v.proyectadosAcumulados,
    // % de Presupuesto Proyectado respecto del Adjudicado (en plata, no confundir con % IIBB Proyectados
    // que compara cantidades): $ Proyectados Acumulados del grupo / $ Total Adjudicado del grupo.
    pctPresupuestoProyectado: v.adjudicado > 0 ? (v.proyectadosAcumulados / v.adjudicado) * 100 : 0,
    pctIIBB: promedioPctIIBB(v),
    sucursales: listaCorta(v.sucursales),
    contratistas: listaCorta(v.contratistas),
    fechasFinContrato: listaCorta(v.fechasFinContrato)
  }));

  if (!state.dashSort.key) { state.dashSort.key = 'presOficial'; state.dashSort.dir = -1; }
  const dashValueFn = (f, key) => {
    if (['grupo','sucursales','contratistas','fechasFinContrato'].includes(key)) return String(f[key] || '').toLowerCase();
    return num(f[key]);
  };
  filas = sortRows(filas, state.dashSort, dashValueFn);

  const allEntries = filas;
  const entries = allEntries.slice(0, 12);
  const hayMasGrupos = allEntries.length > entries.length;

  // Totales sobre TODOS los grupos (no solo los 12 que se muestran), para que coincida con los KPIs de arriba
  const totalGeneral = allEntries.reduce((acc, f) => {
    acc.n += f.n; acc.presOficial += f.presOficial; acc.adjudicado += f.adjudicado; acc.certificado += f.certificado;
    acc.certProcesados += f.certProcesados; acc.proyectos += f.proyectos; acc.pctIIBBSuma += f.pctIIBB; acc.cant++;
    acc.proyectadosAcumulados += f.proyectadosAcumulados;
    return acc;
  }, { n:0, presOficial:0, adjudicado:0, certificado:0, certProcesados:0, proyectos:0, pctIIBBSuma:0, cant:0, proyectadosAcumulados:0 });
  const avanceGeneral = totalGeneral.adjudicado > 0 ? (totalGeneral.certificado / totalGeneral.adjudicado) * 100 : 0;
  const promedioPctIIBBGeneral = totalGeneral.cant ? totalGeneral.pctIIBBSuma / totalGeneral.cant : 0;
  const pctPresupuestoProyectadoGeneral = totalGeneral.adjudicado > 0 ? (totalGeneral.proyectadosAcumulados / totalGeneral.adjudicado) * 100 : 0;

  const dashCols = [{ key: 'grupo', label: labelForGroup(groupKey) }]
    .concat([
      { key: 'n', label: 'Trámites' },
      { key: 'presOficial', label: 'Pres. Oficial' },
      { key: 'adjudicado', label: 'Adjudicado' },
      { key: 'certificado', label: 'Certificado' },
      { key: 'avance', label: '% Avance' },
      { key: 'certProcesados', label: 'Certif. Proc.' },
      { key: 'proyectos', label: 'Proyectos' },
      { key: 'pctPresupuestoProyectado', label: '% Presup. Proy.' },
      { key: 'pctIIBB', label: '% IIBB Proy.' }
    ])
    .concat(mostrarSucursalContratista ? [{ key: 'sucursales', label: 'Sucursal' }, { key: 'contratistas', label: 'Contratista' }, { key: 'fechasFinContrato', label: 'Fin de Contrato' }] : []);

  const table = document.getElementById('dashTable');
  table.innerHTML = sortableTheadHtml(dashCols, state.dashSort) +
    '<tbody>' + entries.map(f => {
      const tdsExtra = mostrarSucursalContratista ? `<td>${escapeHtml(f.sucursales)}</td><td>${escapeHtml(f.contratistas)}</td><td class="mono">${escapeHtml(f.fechasFinContrato)}</td>` : '';
      return `<tr><td>${escapeHtml(f.grupo)}</td><td>${f.n}</td><td>${formatMillions(f.presOficial)}</td><td>${formatMillions(f.adjudicado)}</td><td>${formatMillions(f.certificado)}</td><td>${f.avance.toFixed(1)}%</td><td>${f.certProcesados}</td><td>${f.proyectos}</td><td>${f.pctPresupuestoProyectado.toFixed(1)}%</td><td>${f.pctIIBB.toFixed(1)}%</td>${tdsExtra}</tr>`;
    }).join('') +
    `<tr class="dash-table-total"><td>TOTAL${hayMasGrupos ? ' (' + allEntries.length + ' grupos)' : ''}</td><td>${totalGeneral.n}</td><td>${formatMillions(totalGeneral.presOficial)}</td><td>${formatMillions(totalGeneral.adjudicado)}</td><td>${formatMillions(totalGeneral.certificado)}</td><td>${avanceGeneral.toFixed(1)}%</td><td>${totalGeneral.certProcesados}</td><td>${totalGeneral.proyectos}</td><td>${pctPresupuestoProyectadoGeneral.toFixed(1)}%</td><td>${promedioPctIIBBGeneral.toFixed(1)}%</td>${mostrarSucursalContratista ? '<td></td><td></td><td></td>' : ''}</tr>` +
    '</tbody>';
  wireSortableHeaders(table, state.dashSort, renderDashboard);
  setupScrollShadow(table.closest('.table-wrap'));

  const nota = document.getElementById('dashTableNota');
  if (nota) {
    nota.textContent = hayMasGrupos
      ? `Se muestran los 12 grupos principales según el orden actual, de ${allEntries.length} en total. La fila TOTAL suma los ${allEntries.length}, no solo los 12 visibles. Hacé click en un encabezado para cambiar el orden.`
      : 'Hacé click en un encabezado de la tabla para ordenar por esa columna.';
    nota.hidden = false;
  }
}

// ---- Tabla de detalle completo (modo "Todos" de "Agrupar por"): un renglón por trámite, sin agrupar ----
// Usa las mismas columnas que Registros, salvo "% Presup. Proyectado": en este detalle general del
// Dashboard es redundante (ya está el $ Proyectados Acumulados y el % IIBB Proyectados) y no suma
// al análisis — se mantiene, en cambio, en la pestaña Registros.
// Columnas del detalle "Todos" del Dashboard: mismas claves que Registros, pero con etiquetas
// propias más compactas (no se tocan las de REGISTROS_COLS para no afectar esa otra tabla) y
// "Fin de Contrato" reubicada justo antes de "Seguimiento".
const DASH_DETALLE_COLS = [
  { key: 'pospre', label: 'Pospre' },
  { key: 'expediente', label: 'Expediente' },
  { key: 'anio', label: 'Año' },
  { key: 'sucursal', label: 'Sucursal' },
  { key: 'rubro', label: 'Rubro' },
  { key: 'nroPedidoCompras', label: 'Pedido Compras' },
  { key: 'adjudicatario', label: 'Contratista' },
  { key: 'presupuestoOficialRubro', label: 'Pres. Oficial' },
  { key: 'totalAdjudicado', label: 'Adjudicado' },
  { key: 'certificadosAAD', label: 'Certificado' },
  { key: 'pctAvance', label: '% Avance' },
  { key: 'cantidadProyectos', label: 'Proyectos' },
  { key: 'pctIIBBProyectados', label: '% IIBB Proy./Gest.' },
  { key: 'fechaFinContrato', label: 'Fin de Contrato' },
  { key: 'seguimiento', label: 'Seguimiento' },
  { key: 'estado', label: 'Estado' }
];
function renderDashDetalleCompleto(rows) {
  rows = sortRows(rows, state.dashDetalleSort, registroSortValue);
  const table = document.getElementById('dashTable');
  table.innerHTML = sortableTheadHtml(DASH_DETALLE_COLS, state.dashDetalleSort) +
    '<tbody>' + rows.map(r => `<tr data-id="${r._id}"${rowClassForEstado(r)}>${registroTdsHtml(r, DASH_DETALLE_COLS)}</tr>`).join('') + '</tbody>';
  wireSortableHeaders(table, state.dashDetalleSort, renderDashboard);
  setupScrollShadow(table.closest('.table-wrap'));

  const puedeEditar = state.session && state.session.rol !== 'consulta';
  if (puedeEditar) {
    table.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const rec = state.registros.find(r => r._id === tr.dataset.id);
        if (rec) abrirRegistroOCompras(rec);
      });
    });
  }

  const nota = document.getElementById('dashTableNota');
  if (nota) {
    nota.textContent = 'Detalle completo: ' + rows.length + ' trámite(s) según los filtros actuales del Dashboard. Hacé click en un encabezado para ordenar.';
    nota.hidden = false;
  }
}

let contratistaMode = 'top10';

document.getElementById('contratistaTop10Btn').addEventListener('click', () => {
  contratistaMode = 'top10';
  toggleContratistaButtons();
  renderDashboard();
});
document.getElementById('contratistaTodosBtn').addEventListener('click', () => {
  contratistaMode = 'todos';
  toggleContratistaButtons();
  renderDashboard();
});
function toggleContratistaButtons() {
  document.getElementById('contratistaTop10Btn').classList.toggle('btn-toggle-active', contratistaMode === 'top10');
  document.getElementById('contratistaTodosBtn').classList.toggle('btn-toggle-active', contratistaMode === 'todos');
}

document.getElementById('printDashboardBtn').addEventListener('click', () => {
  document.getElementById('printDate').textContent = new Date().toLocaleString('es-AR');
  window.print();
});

document.getElementById('seguPrintBtn').addEventListener('click', () => {
  document.getElementById('seguPrintDate').textContent = new Date().toLocaleString('es-AR');
  window.print();
});

// Exporta a CSV exactamente lo que se está viendo en "Detalle por agrupación" — respeta el modo
// de agrupación elegido (Sucursal, PosPre, Pedido de Compras, Contratista/Proveedor o Todos) y
// los filtros del Dashboard, porque lee directamente la tabla ya renderizada en pantalla.
document.getElementById('dashDetalleExportBtn').addEventListener('click', () => {
  exportTableToCsv(document.getElementById('dashTable'), 'detalle_por_agrupacion.csv');
});

/** Exporta cualquier <table> del DOM a un archivo .csv, tomando el texto tal como se ve (respeta
 *  el orden de columnas, el agrupamiento y los filtros ya aplicados en pantalla). Se le agrega BOM
 *  UTF-8 al archivo para que Excel muestre bien los acentos y la "ñ" al abrirlo. */
function exportTableToCsv(tableEl, filename) {
  if (!tableEl) return;
  const escapeCsv = (texto) => {
    const limpio = (texto || '').replace(/\s+/g, ' ').trim();
    return /[",;\n]/.test(limpio) ? '"' + limpio.replace(/"/g, '""') + '"' : limpio;
  };
  const filas = [];
  tableEl.querySelectorAll('thead tr').forEach(tr => {
    filas.push(Array.from(tr.querySelectorAll('th')).map(th => escapeCsv(th.textContent)).join(';'));
  });
  tableEl.querySelectorAll('tbody tr').forEach(tr => {
    filas.push(Array.from(tr.querySelectorAll('td')).map(td => escapeCsv(td.textContent)).join(';'));
  });
  if (filas.length <= 1) { alert('No hay datos para exportar con los filtros actuales.'); return; }
  const csv = '\uFEFF' + filas.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- Contratos vigentes por Sucursal: cuenta trámites con y sin Adjudicatario cargado ----
// "Vacío" = trámite sin Adjudicatario (no confundir con ESTADO_VACIO_LABEL, que es sobre el
// campo Estado): es el mismo criterio de "sin contratista adjudicado" que usa la síntesis
// contrato por contrato de un informe de estrategia (sección "Contratos Vigentes por Sucursal").
function renderPivotSucursalEstado(rows) {
  const bySucursal = {};
  rows.forEach(r => {
    const key = (r.sucursal || '(sin sucursal)').toString().trim() || '(sin sucursal)';
    if (!bySucursal[key]) bySucursal[key] = { total: 0, adjudicados: 0 };
    bySucursal[key].total++;
    if (r.adjudicatario && String(r.adjudicatario).trim()) bySucursal[key].adjudicados++;
  });

  const filas = Object.entries(bySucursal).map(([sucursal, v]) => ({
    sucursal, total: v.total, adjudicados: v.adjudicados, vacio: v.total - v.adjudicados,
    pctAdjudicados: v.total > 0 ? (v.adjudicados / v.total) * 100 : 0
  })).sort((a, b) => b.total - a.total);

  const totales = filas.reduce((acc, f) => {
    acc.total += f.total; acc.adjudicados += f.adjudicados; acc.vacio += f.vacio;
    return acc;
  }, { total: 0, adjudicados: 0, vacio: 0 });
  const pctAdjudicadosTotal = totales.total > 0 ? (totales.adjudicados / totales.total) * 100 : 0;

  const table = document.getElementById('dashPivotTable');
  table.innerHTML = '<thead><tr><th>Sucursal</th><th>Contratos vigentes</th><th>Adjudicados</th><th>Vacío (sin adjudicar)</th><th>% Adjudicados</th></tr></thead><tbody>' +
    filas.map(f => `<tr><td>${escapeHtml(f.sucursal)}</td><td>${f.total}</td><td>${f.adjudicados}</td><td>${f.vacio}</td><td>${f.pctAdjudicados.toFixed(0)}%</td></tr>`).join('') +
    `<tr class="dash-table-total"><td>TOTAL</td><td>${totales.total}</td><td>${totales.adjudicados}</td><td>${totales.vacio}</td><td>${pctAdjudicadosTotal.toFixed(0)}%</td></tr>` +
    '</tbody>';
  setupScrollShadow(table.closest('.table-wrap'));
}

// Agrupa por Adjudicatario y calcula el semáforo de cada uno (🔴 <40% · 🟡 40-74% · 🟢 ≥75% de
// avance). Función pura, sin tocar el DOM: la usan tanto el grid de tarjetas (renderContratistaResumen)
// como el KPI "Contratistas en semáforo rojo" del Dashboard, para no calcular esto dos veces con
// criterios que puedan divergir.
function computeContratistaStats(rows) {
  const byContratista = {};
  rows.forEach(r => {
    if (!r.adjudicatario) return;
    const key = r.adjudicatario.trim();
    if (!byContratista[key]) byContratista[key] = { adjudicado: 0, certificado: 0, n: 0 };
    byContratista[key].adjudicado += num(r.totalAdjudicado);
    byContratista[key].certificado += num(r.certificadosAAD);
    byContratista[key].n++;
  });

  const entries = Object.entries(byContratista).map(([nombre, v]) => ({
    nombre,
    adjudicado: v.adjudicado,
    certificado: v.certificado,
    n: v.n,
    pendiente: v.adjudicado - v.certificado,
    avance: v.adjudicado > 0 ? (v.certificado / v.adjudicado) * 100 : 0
  })).sort((a, b) => b.adjudicado - a.adjudicado);

  const rojo = entries.filter(c => c.avance < 40).length;
  const amarillo = entries.filter(c => c.avance >= 40 && c.avance < 75).length;
  const verde = entries.filter(c => c.avance >= 75).length;
  return { entries, rojo, amarillo, verde, total: entries.length };
}

function renderContratistaResumen(rows) {
  const { entries } = computeContratistaStats(rows);
  const shown = contratistaMode === 'top10' ? entries.slice(0, 10) : entries;

  const grid = document.getElementById('contratistaGrid');
  grid.innerHTML = shown.length ? shown.map((c, idx) => {
    const semaforo = c.avance >= 75 ? '🟢' : (c.avance >= 40 ? '🟡' : '🔴');
    const barColor = semColor(c.avance);
    return `<div class="contratista-card">
      <span class="semaforo">${semaforo}</span>
      <div class="rank">#${idx + 1}</div>
      <div class="name">${escapeHtml(c.nombre)}</div>
      <div class="row-line"><span>Adjudicado</span><b>${formatMillions(c.adjudicado)}</b></div>
      <div class="row-line"><span>Certificado</span><b>${formatMillions(c.certificado)}</b></div>
      <div class="avance-bar-wrap"><div class="avance-bar" style="width:${Math.min(c.avance,100)}%;background:${barColor}"></div></div>
      <div class="row-line"><span>Avance</span><b>${c.avance.toFixed(1)}%</b></div>
      <div class="row-line"><span>${c.n} contrato${c.n === 1 ? '' : 's'}</span><span>Pend: ${formatMillions(c.pendiente)}</span></div>
    </div>`;
  }).join('') : '<div class="empty-state">Sin contratistas para este filtro.</div>';
}

function labelForGroup(key) {
  return { sucursal:'Sucursal', pospre:'PosPre', nroPedidoCompras:'Pedido de Compras', adjudicatario:'Contratista/Proveedor', rubro:'Rubro', anio:'Año' }[key] || key;
}

// ============================================================
// HISTORIAL DE KPIs (snapshots fechados de los totales generales, sin filtros)
// ------------------------------------------------------------
// Un snapshot por día: al entrar a la app se guarda solo si todavía no existe uno para hoy (ver
// boot()). El botón "Guardar snapshot de hoy" del Dashboard fuerza la actualización del snapshot
// de HOY (por si los datos cambiaron durante el día), sin crear una fila nueva.
// ============================================================
let historialKPIsCache = []; // ordenado por fecha descendente (más reciente primero)

async function cargarHistorialKPIs() {
  const data = await apiCall('historial_kpis_listar');
  historialKPIsCache = data.historial || [];
}

function hoyStrFrontend() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

async function guardarSnapshotHistorialSiCorresponde(forzar) {
  if (!state.session || state.session.rol === 'consulta') return; // solo-consulta no puede escribir
  const hoy = hoyStrFrontend();
  const yaExiste = historialKPIsCache.some(h => h.fecha === hoy);
  if (yaExiste && !forzar) return;
  const rows = state.registros;
  const snapshot = {
    cantTramites: rows.length,
    totalPresOficial: sumField(rows, 'presupuestoOficialRubro'),
    totalAdjudicado: sumField(rows, 'totalAdjudicado'),
    totalCertificado: sumField(rows, 'certificadosAAD'),
    totalMultas: sumField(rows, 'sumatoriaMultas'),
    cantDesiertos: rows.filter(r => r.estado === 'Desierto').length,
    cantAdjudicados: rows.filter(r => r.estado === 'Adjudicado').length
  };
  await apiCall('historial_kpis_guardar', { datos: snapshot });
  await cargarHistorialKPIs();
}

/** Devuelve el snapshot más reciente que NO sea el de hoy (para mostrar "vs. último corte"), o
 *  null si todavía no hay ninguno anterior guardado. */
function snapshotAnteriorAHoy() {
  const hoy = hoyStrFrontend();
  return historialKPIsCache.find(h => h.fecha !== hoy) || null;
}

document.getElementById('histSnapshotBtn').addEventListener('click', async () => {
  const btn = document.getElementById('histSnapshotBtn');
  btn.disabled = true;
  try {
    await guardarSnapshotHistorialSiCorresponde(true);
    renderDashboard();
  } catch (err) {
    alert('No se pudo guardar el snapshot: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});
function kpiCard(label, value, sub, colorSemaforo) {
  const dot = colorSemaforo ? `<span class="kpi-dot" style="background:${colorSemaforo}"></span>` : '';
  return `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${dot}${value}</div><div class="kpi-sub">${sub}</div></div>`;
}
function sumField(rows, key) { return rows.reduce((acc, r) => acc + num(r[key]), 0); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function formatMoney(v) {
  const n = num(v);
  return '$ ' + n.toLocaleString('es-AR', { maximumFractionDigits: 0 });
}
function formatMillions(v) {
  const n = num(v) / 1000000;
  return '$ ' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' M';
}

// ============================================================
// COMPARATIVA DE AÑOS
// ------------------------------------------------------------
// Compara dos ejercicios (Año A vs. Año B) lado a lado, agrupados por Sucursal/Rubro/PosPre/
// Contratista, con variación en p.p. (cuando el campo ya es un %) o en % (cuando es un monto o
// una cantidad). Reusa los mismos filtros del Dashboard salvo "Año", que acá se elige aparte con
// dos selects en vez de un multiselect.
// ============================================================
const COMP_FILTER_KEYS = DASH_FILTER_KEYS.filter(k => k !== 'anio');
let chartComparativa = null;

// KPIs generales de un conjunto de filas, sin depender del DOM — usado para calcular Año A y
// Año B por separado con la misma fórmula exacta que ya usa el Dashboard.
function computeKpis(rows) {
  const totalPresOficial = sumField(rows, 'presupuestoOficialRubro');
  const totalAdjudicado = sumField(rows, 'totalAdjudicado');
  const totalCertificado = sumField(rows, 'certificadosAAD');
  const totalMultas = sumField(rows, 'sumatoriaMultas');
  const pctEjecucion = totalAdjudicado > 0 ? (totalCertificado / totalAdjudicado) * 100 : 0;
  const cantDesiertos = rows.filter(r => r.estado === 'Desierto').length;
  const cantAdjudicados = rows.filter(r => r.estado === 'Adjudicado').length;
  return { n: rows.length, totalPresOficial, totalAdjudicado, totalCertificado, totalMultas, pctEjecucion, cantDesiertos, cantAdjudicados };
}

// Totales agrupados por una clave (sucursal/rubro/pospre/adjudicatario), sin depender del DOM.
function computeGroupStats(rows, groupKey) {
  const groups = {};
  rows.forEach(r => {
    const key = (r[groupKey] || '(sin dato)').toString().trim() || '(sin dato)';
    if (!groups[key]) groups[key] = { n: 0, presOficial: 0, adjudicado: 0, certificado: 0 };
    groups[key].n++;
    groups[key].presOficial += num(r.presupuestoOficialRubro);
    groups[key].adjudicado += num(r.totalAdjudicado);
    groups[key].certificado += num(r.certificadosAAD);
  });
  return Object.entries(groups).map(([grupo, v]) => ({
    grupo, n: v.n, presOficial: v.presOficial, adjudicado: v.adjudicado, certificado: v.certificado,
    avance: v.adjudicado > 0 ? (v.certificado / v.adjudicado) * 100 : 0
  }));
}

function populateCompAnioSelects() {
  const anios = uniqueValues('anio').map(a => String(a)).filter(Boolean).sort();
  const selA = document.getElementById('compAnioA');
  const selB = document.getElementById('compAnioB');
  if (!selA || !anios.length) return;
  const opciones = anios.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
  if (selA.innerHTML !== opciones) selA.innerHTML = opciones;
  if (selB.innerHTML !== opciones) selB.innerHTML = opciones;
  if (!state.comp.anioA || !anios.includes(state.comp.anioA)) state.comp.anioA = anios[Math.max(0, anios.length - 2)];
  if (!state.comp.anioB || !anios.includes(state.comp.anioB)) state.comp.anioB = anios[anios.length - 1];
  selA.value = state.comp.anioA;
  selB.value = state.comp.anioB;
}

function populateCompFilterOptions() {
  COMP_FILTER_KEYS.forEach(key => {
    const el = document.querySelector('#compFiltersBar [data-compfilter="' + key + '"]');
    if (!el) return;
    const opts = uniqueValues(key);
    if (key === 'estado') opts.push(ESTADO_VACIO_LABEL);
    state.comp.filtros[key] = (state.comp.filtros[key] || []).filter(v => opts.includes(v));
    renderMultiselect(el, opts, state.comp.filtros[key], (vals) => {
      state.comp.filtros[key] = vals;
      renderComparativa();
    });
  });
}

function renderComparativa() {
  populateCompAnioSelects();
  populateCompFilterOptions();
  if (!state.comp.anioA || !state.comp.anioB) {
    document.getElementById('compKpiRow').innerHTML = '<div class="empty-state">No hay años cargados todavía para comparar.</div>';
    return;
  }

  const groupKey = state.comp.groupBy || 'sucursal';
  const baseFiltrada = applyFilters(state.registros, state.comp.filtros, COMP_FILTER_KEYS);
  const rowsA = baseFiltrada.filter(r => String(r.anio) === state.comp.anioA);
  const rowsB = baseFiltrada.filter(r => String(r.anio) === state.comp.anioB);

  const kA = computeKpis(rowsA);
  const kB = computeKpis(rowsB);

  const kpiCompHtml = (label, valA, valB, delta, unidad) => {
    const claseColor = delta == null ? '' : (delta > 0 ? 'text-success' : (delta < 0 ? 'text-danger' : ''));
    const deltaTxt = delta == null ? 's/d' : (delta >= 0 ? '+' : '') + delta.toFixed(1) + unidad;
    return `<div class="kpi-card">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${valA} &rarr; ${valB}</div>
      <div class="kpi-sub ${claseColor}">${deltaTxt}</div>
    </div>`;
  };
  const deltaPct = (a, b) => (a > 0 ? ((b - a) / a) * 100 : (b > 0 ? null : 0));

  document.getElementById('compKpiRow').innerHTML = [
    kpiCompHtml('Trámites', kA.n, kB.n, deltaPct(kA.n, kB.n), '%'),
    kpiCompHtml('% Ejecución', kA.pctEjecucion.toFixed(1) + '%', kB.pctEjecucion.toFixed(1) + '%', kB.pctEjecucion - kA.pctEjecucion, ' p.p.'),
    kpiCompHtml('Total Adjudicado', formatMillions(kA.totalAdjudicado), formatMillions(kB.totalAdjudicado), deltaPct(kA.totalAdjudicado, kB.totalAdjudicado), '%'),
    kpiCompHtml('Certificado AAD', formatMillions(kA.totalCertificado), formatMillions(kB.totalCertificado), deltaPct(kA.totalCertificado, kB.totalCertificado), '%'),
    kpiCompHtml('Multas', formatMillions(kA.totalMultas), formatMillions(kB.totalMultas), deltaPct(kA.totalMultas, kB.totalMultas), '%'),
    kpiCompHtml('Desiertos', kA.cantDesiertos, kB.cantDesiertos, deltaPct(kA.cantDesiertos, kB.cantDesiertos), '%')
  ].join('');

  const statsA = computeGroupStats(rowsA, groupKey);
  const statsB = computeGroupStats(rowsB, groupKey);
  const grupos = Array.from(new Set([...statsA.map(s => s.grupo), ...statsB.map(s => s.grupo)])).sort();
  const filas = grupos.map(g => {
    const a = statsA.find(s => s.grupo === g) || { n: 0, adjudicado: 0, certificado: 0, avance: 0 };
    const b = statsB.find(s => s.grupo === g) || { n: 0, adjudicado: 0, certificado: 0, avance: 0 };
    return { grupo: g, nA: a.n, nB: b.n, adjudicadoA: a.adjudicado, adjudicadoB: b.adjudicado, avanceA: a.avance, avanceB: b.avance, variacionPP: b.avance - a.avance };
  }).sort((f1, f2) => f1.variacionPP - f2.variacionPP);

  const table = document.getElementById('compTable');
  table.innerHTML = `<thead><tr>
      <th>${escapeHtml(labelForGroup(groupKey))}</th>
      <th>Trámites ${escapeHtml(state.comp.anioA)}</th><th>Trámites ${escapeHtml(state.comp.anioB)}</th>
      <th>Adjudicado ${escapeHtml(state.comp.anioA)}</th><th>Adjudicado ${escapeHtml(state.comp.anioB)}</th>
      <th>% Avance ${escapeHtml(state.comp.anioA)}</th><th>% Avance ${escapeHtml(state.comp.anioB)}</th>
      <th>Variación</th>
    </tr></thead><tbody>` +
    filas.map(f => `<tr>
      <td>${escapeHtml(f.grupo)}</td>
      <td>${f.nA}</td><td>${f.nB}</td>
      <td>${formatMillions(f.adjudicadoA)}</td><td>${formatMillions(f.adjudicadoB)}</td>
      <td>${f.avanceA.toFixed(1)}%</td><td>${f.avanceB.toFixed(1)}%</td>
      <td class="${f.variacionPP < 0 ? 'text-danger' : (f.variacionPP > 0 ? 'text-success' : '')}">${f.variacionPP >= 0 ? '+' : ''}${f.variacionPP.toFixed(1)} p.p.</td>
    </tr>`).join('') +
    '</tbody>';
  setupScrollShadow(table.closest('.table-wrap'));

  const ctx = document.getElementById('chartComparativa').getContext('2d');
  if (chartComparativa) chartComparativa.destroy();
  chartComparativa = new Chart(ctx, {
    type: 'line',
    data: {
      labels: filas.map(f => f.grupo),
      datasets: [
        { label: '% Avance ' + state.comp.anioA, data: filas.map(f => f.avanceA), borderColor: '#94A3B8', backgroundColor: '#94A3B8', pointBackgroundColor: filas.map(f => semColor(f.avanceA)), pointRadius: 5, tension: 0.3 },
        { label: '% Avance ' + state.comp.anioB, data: filas.map(f => f.avanceB), borderColor: '#0F6E56', backgroundColor: '#0F6E56', pointBackgroundColor: filas.map(f => semColor(f.avanceB)), pointRadius: 5, tension: 0.3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { ticks: { autoSkip: false, maxRotation: 60, minRotation: 30 } }, y: { beginAtZero: true, max: 130, title: { display: true, text: '% Avance' } } },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

document.getElementById('compAnioA').addEventListener('change', (e) => { state.comp.anioA = e.target.value; renderComparativa(); });
document.getElementById('compAnioB').addEventListener('change', (e) => { state.comp.anioB = e.target.value; renderComparativa(); });
document.getElementById('compGroupBy').addEventListener('change', (e) => { state.comp.groupBy = e.target.value; renderComparativa(); });
document.getElementById('compClearFilters').addEventListener('click', () => {
  COMP_FILTER_KEYS.forEach(k => { state.comp.filtros[k] = []; });
  renderComparativa();
});
document.getElementById('compExportBtn').addEventListener('click', () => {
  const table = document.getElementById('compTable');
  if (!table.querySelector('tbody tr')) { alert('No hay datos para exportar.'); return; }
  exportTableToCsv(table, 'comparativa_' + state.comp.anioA + '_vs_' + state.comp.anioB + '.csv');
});

// ============================================================
// SEGUIMIENTO DE AVANCE
// ------------------------------------------------------------
// Para cada contrato (trámite) del filtro actual, muestra el % de avance ACUMULADO de sus
// certificaciones mes a mes (no el % de cada certificado individual, sino cuánto llevaba
// certificado ese contrato a esa fecha). Usa exactamente los mismos filtros que el Dashboard,
// con la misma barra colapsable de "Filtros avanzados". Pospre / N° PC / Contratista / Sucursal
// son siempre las primeras 4 columnas de cada fila, sin excepción.
// ============================================================
const SEGU_FILTER_KEYS = SHARED_FILTER_KEYS;

// ---- "AAAA-MM" -> "Mar/25", para que las columnas de mes se lean cómodo en la tabla y el gráfico ----
const MESES_CORTOS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function formatMesCorto(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return String(v || '');
  const idx = parseInt(m[2], 10) - 1;
  return (MESES_CORTOS[idx] || m[2]) + '/' + m[1].slice(2);
}

function filteredForSeguimientoBase() {
  return filtrosCompartidosBase();
}
function filteredForSeguimiento() {
  const rows = filteredForSeguimientoBase();
  return state.riesgoPlazoActivoCompartido ? rows.filter(esRiesgoPorPlazo) : rows;
}

// ---- Tinte de fondo para el heatmap de % de avance (mismos 3 colores que las pastillas de
// Estado en el resto de la app, para no inventar una paleta nueva) ----
function semTinte(pct) {
  if (pct >= 75) return { bg: '#DCFCE7', color: '#166534' };
  if (pct >= 40) return { bg: '#FEF3C7', color: '#92400E' };
  return { bg: '#FEE2E2', color: '#991B1B' };
}

function renderSeguimiento() {
  populateFilterOptions(); // repuebla combos (facetados) y sincroniza inputs avanzados + badges de riesgo de las 3 barras

  const rows = filteredForSeguimiento();
  const idsFiltrados = new Set(rows.map(r => r._id));

  // ---- Certificaciones de estos contratos, agrupadas por trámite y ordenadas por mes/año ----
  const certsPorTramite = {};
  (certListaCache || []).forEach(c => {
    if (!idsFiltrados.has(c.idTramite) || !c.mesAnioCertificacion) return;
    if (!certsPorTramite[c.idTramite]) certsPorTramite[c.idTramite] = [];
    certsPorTramite[c.idTramite].push(c);
  });
  Object.values(certsPorTramite).forEach(list => list.sort((a, b) => String(a.mesAnioCertificacion).localeCompare(String(b.mesAnioCertificacion))));

  // ---- Columnas de mes: todos los meses con al menos 1 certificación en el filtro actual ----
  const mesesSet = new Set();
  Object.values(certsPorTramite).forEach(list => list.forEach(c => mesesSet.add(c.mesAnioCertificacion)));
  const meses = Array.from(mesesSet).sort();

  const table = document.getElementById('seguimientoTable');
  if (!meses.length) {
    table.innerHTML = '<tbody><tr><td class="empty-state">No hay certificaciones cargadas para los contratos del filtro actual.</td></tr></tbody>';
    return;
  }

  // ---- % certificado EN CADA MES (no acumulado): $ Certificados de ese mes en particular / $
  // Total Adjudicado del contrato. Si un mismo mes tiene más de una certificación, se suman. La
  // columna final "% Acumulado total" sí es acumulada, y usa pctAvanceTramite() — la misma fuente
  // de verdad que Dashboard/Registros (Certificado por AAD) — que puede diferir levemente de la
  // suma de las columnas de mes si hay certificaciones sin Mes/Año cargado. ----
  const filas = rows.map(r => {
    const certs = certsPorTramite[r._id] || [];
    const adj = num(r.totalAdjudicado);
    const montoPorMes = {};
    certs.forEach(c => {
      montoPorMes[c.mesAnioCertificacion] = (montoPorMes[c.mesAnioCertificacion] || 0) + num(c.montoCertificado);
    });
    const porMes = meses.map(m => adj > 0 ? ((montoPorMes[m] || 0) / adj) * 100 : 0);
    return {
      id: r._id, pospre: r.pospre, nroPedidoCompras: r.nroPedidoCompras, adjudicatario: r.adjudicatario,
      sucursal: r.sucursal, adj, porMes, pctActual: pctAvanceTramite(r), tieneCerts: certs.length > 0
    };
  });

  // ---- Orden: por defecto, peor % acumulado primero (para detectar rápido lo atrasado), pero
  // se puede ordenar por cualquier columna con un clic en su encabezado — incluidas las de mes. ----
  const seguSortValue = (fila, key) => {
    if (key === 'pospre') return fila.pospre || '';
    if (key === 'nroPedidoCompras') return fila.nroPedidoCompras || '';
    if (key === 'adjudicatario') return fila.adjudicatario || '';
    if (key === 'sucursal') return fila.sucursal || '';
    if (key === 'pctActual') return fila.pctActual;
    const idx = meses.indexOf(key); // key es un mes ("AAAA-MM") cuando no es ninguno de los anteriores
    return idx === -1 ? 0 : fila.porMes[idx];
  };
  const filasOrdenadas = sortRows(filas, state.seguSort, seguSortValue);

  const celdaSemaforo = (pct) => {
    const t = semTinte(pct);
    const redondeado = pct.toFixed(0);
    // "0%" confunde (¿no certificó nada, o certificó poquito y redondeó a 0?): se muestra "-" en
    // su lugar. El fondo rojo se mantiene igual, porque sigue siendo una señal de "sin avance".
    const texto = redondeado === '0' ? '-' : redondeado + '%';
    return `<td class="mono segu-celda" style="background:${t.bg}; color:${t.color};">${texto}</td>`;
  };

  // ---- Encabezados: los 4 fijos + uno por mes + el acumulado final, todos ordenables (misma
  // flechita ▲▼ que el resto de las tablas de la app cuando esa columna es la que ordena). ----
  const thSort = (key, label, claseExtra) => {
    const activo = state.seguSort.key === key;
    const flecha = activo ? (state.seguSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable${claseExtra ? ' ' + claseExtra : ''}" data-sort-key="${key}">${label}${flecha}</th>`;
  };
  const theadMeses = meses.map(m => thSort(m, escapeHtml(formatMesCorto(m)), 'mono')).join('');
  table.innerHTML = `<thead><tr>
      ${thSort('pospre', 'Pospre', 'segu-col-1')}
      ${thSort('nroPedidoCompras', 'N° PC', 'segu-col-2')}
      ${thSort('adjudicatario', 'Contratista', 'segu-col-3')}
      ${thSort('sucursal', 'Sucursal', 'segu-col-4')}
      ${theadMeses}
      ${thSort('pctActual', '% Acumulado total', 'mono')}
    </tr></thead><tbody>` +
    filasOrdenadas.map(f => `<tr${f.tieneCerts ? '' : ' class="row-sin-certificaciones"'}>
      <td class="segu-col-1" title="${escapeHtml(f.pospre || '')}">${escapeHtml(f.pospre || '')}</td>
      <td class="segu-col-2 mono">${escapeHtml(f.nroPedidoCompras || '')}</td>
      <td class="segu-col-3" title="${escapeHtml(f.adjudicatario || '')}">${escapeHtml(f.adjudicatario || '(sin contratista)')}</td>
      <td class="segu-col-4" title="${escapeHtml(f.sucursal || '')}">${escapeHtml(f.sucursal || '')}</td>
      ${f.porMes.map(celdaSemaforo).join('')}
      ${celdaSemaforo(f.pctActual)}
    </tr>`).join('') +
    '</tbody>';
  setupScrollShadow(table.closest('.table-wrap'), 'seguimientoScrollTop', 'seguimientoScrollTopInner');
  wireSortableHeaders(table, state.seguSort, renderSeguimiento);
}

document.getElementById('seguFechaPCDesde').addEventListener('change', (e) => { state.filtrosCompartidos.fechaPCDesde = e.target.value; renderSeguimiento(); });
document.getElementById('seguFechaPCHasta').addEventListener('change', (e) => { state.filtrosCompartidos.fechaPCHasta = e.target.value; renderSeguimiento(); });
document.getElementById('seguPctAvanceDesde').addEventListener('input', debounce((e) => { state.filtrosCompartidos.pctAvanceDesde = e.target.value; renderSeguimiento(); }, 300));
document.getElementById('seguPctAvanceHasta').addEventListener('input', debounce((e) => { state.filtrosCompartidos.pctAvanceHasta = e.target.value; renderSeguimiento(); }, 300));
document.getElementById('seguTextoBuscar').addEventListener('input', debounce((e) => { state.filtrosCompartidos.texto = e.target.value; renderSeguimiento(); }, 300));
document.getElementById('seguTextoModo').addEventListener('change', (e) => { state.filtrosCompartidos.textoModo = e.target.value; renderSeguimiento(); });
document.getElementById('riesgoPlazoBtnSegu').addEventListener('click', () => {
  state.riesgoPlazoActivoCompartido = !state.riesgoPlazoActivoCompartido;
  document.getElementById('riesgoPlazoBtnSegu').classList.toggle('active', state.riesgoPlazoActivoCompartido);
  renderSeguimiento();
});
document.getElementById('seguExportBtn').addEventListener('click', () => {
  const table = document.getElementById('seguimientoTable');
  if (!table.querySelector('tbody tr')) { alert('No hay datos para exportar.'); return; }
  exportTableToCsv(table, 'seguimiento_avance.csv');
});
wireToggleFiltrosAvanzados('seguFiltrosAvanzadosToggle', 'seguFiltersBarAvanzados');
if (tieneFiltrosAvanzadosActivos(state.filtrosCompartidos, state.riesgoPlazoActivoCompartido)) {
  document.getElementById('seguFiltersBarAvanzados').hidden = false;
  document.getElementById('seguFiltrosAvanzadosToggle').classList.add('is-open');
}

// ============================================================
// USUARIOS (admin)
// ============================================================
let nuevoUsuarioSucursalesSeleccionadas = [];
async function renderUsuarios() {
  if (state.session.rol !== 'admin') return;
  const data = await apiCall('usuarios_listar');
  const table = document.getElementById('usersTable');
  table.innerHTML = '<thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Sucursales Restringidas</th></tr></thead><tbody>' +
    data.usuarios.map(u => {
      const texto = (u.sucursalesRestringidas && u.sucursalesRestringidas.length) ? u.sucursalesRestringidas.join(', ') : 'Sin restricción (ve todas)';
      return `<tr><td>${escapeHtml(u.usuario)}</td><td>${escapeHtml(u.nombre)}</td><td>${escapeHtml(u.rol)}</td><td>${escapeHtml(texto)}</td></tr>`;
    }).join('') +
    '</tbody>';

  const contSucursal = document.getElementById('newSucursalRestringida');
  if (contSucursal) {
    nuevoUsuarioSucursalesSeleccionadas = nuevoUsuarioSucursalesSeleccionadas.filter(s => uniqueValues('sucursal').includes(s));
    renderMultiselect(contSucursal, uniqueValues('sucursal'), nuevoUsuarioSucursalesSeleccionadas, (vals) => {
      nuevoUsuarioSucursalesSeleccionadas = vals;
    });
  }
}

document.getElementById('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('userMsg');
  msg.hidden = true;
  try {
    await apiCall('usuarios_crear', {
      usuario_nuevo: document.getElementById('newUsuario').value.trim(),
      nombre_nuevo: document.getElementById('newNombre').value.trim(),
      clave_nueva: document.getElementById('newClave').value,
      rol_nuevo: document.getElementById('newRol').value,
      sucursales_restringidas_nuevas: nuevoUsuarioSucursalesSeleccionadas
    });
    msg.textContent = 'Usuario creado correctamente.';
    msg.className = 'form-msg ok';
    msg.hidden = false;
    document.getElementById('userForm').reset();
    nuevoUsuarioSucursalesSeleccionadas = [];
    renderUsuarios();
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
    msg.className = 'form-msg err';
    msg.hidden = false;
  }
});

// ---- Completar valores iniciales faltantes (una sola vez, base original) ----
// ---- Corrección de IVA (una sola vez, doble confirmación por ser una operación sensible) ----
// ---- Unificar valores duplicados (Pospre / Sucursal) ----
function normalizeForDupe(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDupeClusters(key) {
  const map = {};
  state.registros.forEach(r => {
    const raw = (r[key] || '').toString().trim();
    if (!raw) return;
    const norm = normalizeForDupe(raw);
    if (!map[norm]) map[norm] = {};
    map[norm][raw] = (map[norm][raw] || 0) + 1;
  });
  return Object.values(map)
    .map(variants => Object.entries(variants).sort((a, b) => b[1] - a[1])) // [[valor,count],...] desc
    .filter(variants => variants.length > 1) // solo grupos con más de una variante = posibles duplicados
    .sort((a, b) => b.reduce((s, v) => s + v[1], 0) - a.reduce((s, v) => s + v[1], 0));
}

document.getElementById('buscarDuplicadosBtn').addEventListener('click', () => {
  const campo = document.getElementById('unificarCampo').value;
  const clusters = buildDupeClusters(campo);
  const cont = document.getElementById('duplicadosResultado');

  if (!clusters.length) {
    cont.innerHTML = '<p class="form-msg ok" style="display:block;">No se encontraron variantes duplicadas para este campo. 👍</p>';
    return;
  }

  cont.innerHTML = clusters.map((variants, idx) => {
    const total = variants.reduce((s, v) => s + v[1], 0);
    const opciones = variants.map(([valor, count], i) =>
      `<label class="dupe-option">
        <input type="radio" name="dupe-${idx}" value="${escapeHtml(valor)}" ${i === 0 ? 'checked' : ''}/>
        <span>${escapeHtml(valor)}</span> <span class="dupe-count">(${count} trámite${count === 1 ? '' : 's'})</span>
      </label>`
    ).join('');
    return `<div class="dupe-cluster" data-idx="${idx}">
      <p class="dupe-cluster-title">Grupo de ${variants.length} variantes — ${total} trámites en total</p>
      ${opciones}
      <button type="button" class="btn btn-secondary dupe-unify-btn" data-idx="${idx}">Unificar este grupo</button>
      <p class="form-msg" data-msg-idx="${idx}" hidden></p>
    </div>`;
  }).join('');

  cont.querySelectorAll('.dupe-unify-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.idx;
      const cluster = clusters[idx];
      const elegido = cont.querySelector('input[name="dupe-' + idx + '"]:checked').value;
      const valoresViejos = cluster.map(v => v[0]).filter(v => v !== elegido);
      const msg = cont.querySelector('[data-msg-idx="' + idx + '"]');
      msg.hidden = true;

      const confirmado = confirm('Se van a reemplazar estas variantes:\n\n' + valoresViejos.join('\n') + '\n\npor:\n\n"' + elegido + '"\n\n¿Confirmás?');
      if (!confirmado) return;

      try {
        const r = await apiCall('unificar_valores', { campo, valoresViejos, valorNuevo: elegido });
        msg.textContent = 'Listo: se actualizaron ' + r.actualizados + ' trámites.';
        msg.className = 'form-msg ok';
        msg.hidden = false;
        btn.disabled = true;
        const data = await apiCall('listar');
        state.registros = data.registros;
        populateFilterOptions();
      } catch (err) {
        msg.textContent = 'Error: ' + err.message;
        msg.className = 'form-msg err';
        msg.hidden = false;
      }
    });
  });
});

// ============================================================
// UTILIDADES
// ============================================================
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, s => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[s]));
}

// ============================================================
// CERTIFICACIONES
// ============================================================
let certTramitePreseleccionado = null; // seteado desde el botón "Ver / cargar certificaciones" del formulario
let certTramiteActual = null;          // registro del trámite elegido en esta pestaña
let certListaCache = [];               // todas las certificaciones ya cargadas (para la tabla)
let certCamposCache = [];              // metadatos de campos (para exportar con etiquetas legibles)
let certEditingId = null;              // si no es null, el formulario está editando esa certificación
let certSort = { key: null, dir: 1 };  // ordenamiento de la tabla de Certificaciones cargadas

async function abrirVistaCertificaciones() {
  document.getElementById('certFiltroTexto').value = '';
  await cargarCertificaciones();

  const puedeEditar = state.session && state.session.rol !== 'consulta';
  document.getElementById('certFormPanel').hidden = !puedeEditar;

  if (certTramitePreseleccionado) {
    const rec = state.registros.find(r => r._id === certTramitePreseleccionado);
    certTramitePreseleccionado = null;
    if (rec && puedeEditar) seleccionarTramiteParaCertificar(rec);
  } else if (!certTramiteActual) {
    // Solo mostramos el estado "sin trámite elegido" si no había uno ya seleccionado. Si el
    // usuario estaba a mitad de cargar una certificación y solo pasó por otra pestaña (por
    // ejemplo, a mirar el Dashboard), al volver acá no le borramos lo que tenía en curso.
    document.getElementById('certTramiteSeleccionado').hidden = true;
    document.getElementById('certForm').hidden = true;
    certEditingId = null;
  }
}

async function cargarCertificacionesDatos() {
  const data = await apiCall('certificaciones_listar');
  certCamposCache = data.campos;
  certListaCache = data.certificaciones;
  // El Detalle del Rubro no se guarda en la hoja de Certificaciones: se toma en vivo del trámite
  // (PC) al que pertenece cada certificación, para saber de un vistazo qué se está certificando.
  // La Sucursal se toma de la misma forma, para poder ordenar el detalle Pospre → Sucursal → PC →
  // Contratista → N° de Certificado, aunque esa columna no se muestre en la tabla.
  certListaCache.forEach(c => {
    const rec = state.registros.find(r => r._id === c.idTramite);
    c.rubro = rec ? rec.detalleRubro : '';
    c.sucursal = rec ? rec.sucursal : '';
  });
}

async function cargarCertificaciones() {
  try {
    await cargarCertificacionesDatos();
    renderCertTable();
  } catch (err) {
    showAppError('No se pudieron cargar las certificaciones: ' + err.message);
  }
}

document.getElementById('certExportBtn').addEventListener('click', () => {
  if (!certListaCache.length) { alert('No hay certificaciones para exportar.'); return; }
  const data = certListaCache.map(c => {
    const obj = {};
    certCamposCache.forEach(f => { obj[f.label] = c[f.key]; });
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Certificaciones');
  XLSX.writeFile(wb, 'certificaciones_export.xlsx');
});

// ---- Buscador de trámite ----
const certBuscarInput = document.getElementById('certBuscarTramite');
certBuscarInput.addEventListener('input', () => {
  const q = certBuscarInput.value.trim().toLowerCase();
  const resultados = document.getElementById('certResultadosBusqueda');
  if (q.length < 2) { resultados.hidden = true; resultados.innerHTML = ''; return; }

  const matches = state.registros.filter(r =>
    String(r.pospre || '').toLowerCase().includes(q) ||
    String(r.expediente || '').toLowerCase().includes(q) ||
    String(r.nroPedidoCompras || '').toLowerCase().includes(q)
  ).slice(0, 20);

  if (!matches.length) {
    resultados.innerHTML = '<div class="cert-search-item">Sin resultados</div>';
  } else {
    resultados.innerHTML = matches.map(r => `<div class="cert-search-item" data-id="${r._id}">
        ${escapeHtml(r.pospre || '(sin pospre)')} — Exp. ${escapeHtml(r.expediente || '—')} — PC ${escapeHtml(r.nroPedidoCompras || '—')}
        <span class="small">${escapeHtml(r.sucursal || '')} · ${escapeHtml(r.adjudicatario || '(sin contratista)')}</span>
        ${r.detalleRubro ? `<span class="small">${escapeHtml(r.detalleRubro)}</span>` : ''}
      </div>`).join('');
  }
  resultados.hidden = false;

  resultados.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      const rec = state.registros.find(r => r._id === el.dataset.id);
      if (rec) seleccionarTramiteParaCertificar(rec);
      resultados.hidden = true;
      certBuscarInput.value = '';
    });
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#certFormPanel')) {
    const resultados = document.getElementById('certResultadosBusqueda');
    if (resultados) resultados.hidden = true;
  }
});

function seleccionarTramiteParaCertificar(rec) {
  certTramiteActual = rec;
  const seguirEditando = certEditingId; // si veníamos editando una certificación, "Cambiar" no debe perder eso
  document.getElementById('certFormTitle').textContent = seguirEditando ? 'Editar certificación' : 'Cargar certificación';
  document.getElementById('certSubmitBtn').textContent = seguirEditando ? 'Guardar cambios' : 'Guardar certificación';
  const chip = document.getElementById('certTramiteSeleccionado');
  chip.innerHTML = `<span><strong>${escapeHtml(rec.pospre || '')}</strong> — Exp. ${escapeHtml(rec.expediente || '—')} — PC ${escapeHtml(rec.nroPedidoCompras || '—')} — ${escapeHtml(rec.adjudicatario || '(sin contratista)')}</span>
    <button type="button" class="btn btn-ghost" id="certCambiarTramiteBtn">Cambiar</button>`;
  chip.hidden = false;
  document.getElementById('certCambiarTramiteBtn').addEventListener('click', () => {
    certTramiteActual = null;
    // Ojo: NO tocamos certEditingId acá. Si estábamos editando una certificación y el usuario
    // elige otro trámite, al guardar se reasigna esa MISMA certificación al trámite nuevo
    // (útil cuando un PC tiene varios trámites cargados y quedó vinculada al que no correspondía),
    // en vez de crear una certificación duplicada y dejar la vieja mal vinculada.
    chip.hidden = true;
    document.getElementById('certForm').hidden = true;
  });

  document.getElementById('certPospre').value = rec.pospre || '';
  document.getElementById('certExpediente').value = rec.expediente || '';
  document.getElementById('certPC').value = rec.nroPedidoCompras || '';
  document.getElementById('certContratista').value = rec.adjudicatario || '';
  document.getElementById('certFechaInicio').value = rec.fechaInicioReal || '';

  const form = document.getElementById('certForm');
  if (!seguirEditando) form.reset(); // si estamos reasignando una edición, no perder lo ya tipeado
  recalcIIBBCertificados();
  document.getElementById('certFormMsg').hidden = true;
  form.hidden = false;
}

// ---- Editar: carga una certificación ya existente en el formulario, en modo edición ----
function editarCertificacion(c) {
  const rec = state.registros.find(r => r._id === c.idTramite);
  if (!rec) { alert('No se encontró el trámite asociado a esta certificación.'); return; }
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  if (!puedeEditar) return;

  seleccionarTramiteParaCertificar(rec);
  certEditingId = c._id;
  document.getElementById('certFormTitle').textContent = 'Editar certificación';
  document.getElementById('certSubmitBtn').textContent = 'Guardar cambios';

  document.querySelectorAll('#certForm [name]').forEach(input => {
    if (c[input.name] != null) input.value = input.name === 'mesAnioCertificacion' ? toMonthValue(c[input.name]) : c[input.name];
  });
  recalcIIBBCertificados();
  document.getElementById('certFormMsg').hidden = true;
  document.getElementById('certFormPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- Clonar: crea una certificación nueva con los mismos datos ----
async function clonarCertificacion(c) {
  const confirmado = confirm('¿Clonar esta certificación? Se va a crear una nueva con los mismos datos (podés editarla después).');
  if (!confirmado) return;
  const datos = {};
  certCamposCache.forEach(f => { if (f.key !== 'pctAvance' && f.key !== 'iibbCertificados') datos[f.key] = c[f.key]; });
  try {
    await apiCall('certificaciones_crear', { datos: Object.assign({ idTramite: c.idTramite }, datos) });
    const data = await apiCall('listar');
    state.registros = data.registros;
    await cargarCertificaciones();
  } catch (err) {
    alert('Error al clonar: ' + err.message);
  }
}

document.getElementById('certCancelarBtn').addEventListener('click', () => {
  document.getElementById('certForm').hidden = true;
  document.getElementById('certTramiteSeleccionado').hidden = true;
  certTramiteActual = null;
  certEditingId = null;
});

// ---- IIBB Certificados se calcula solo: $ Certificados / $ Adjudicado Unitario del trámite ----
function recalcIIBBCertificados() {
  const iibbInput = document.querySelector('#certForm [name="iibbCertificados"]');
  if (!iibbInput) return;
  if (!certTramiteActual) { iibbInput.value = ''; return; }
  const montoInput = document.querySelector('#certForm [name="montoCertificado"]');
  const monto = montoInput ? (parseFloat(montoInput.value) || 0) : 0;
  const unitario = parseFloat(certTramiteActual.adjudicadoUnitario) || 0;
  const iibb = unitario > 0 ? monto / unitario : 0;
  iibbInput.value = iibb ? iibb.toFixed(2) : '';
}
document.getElementById('certForm').addEventListener('input', (e) => {
  if (e.target.name === 'montoCertificado') recalcIIBBCertificados();
});

document.getElementById('certForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('certFormMsg');
  msg.hidden = true;
  if (!certTramiteActual) { return; }

  const datos = {
    pospre: certTramiteActual.pospre || '',
    expediente: certTramiteActual.expediente || '',
    nroPedidoCompras: certTramiteActual.nroPedidoCompras || '',
    contratista: certTramiteActual.adjudicatario || '',
    fechaInicioContrato: certTramiteActual.fechaInicioReal || ''
  };
  document.querySelectorAll('#certForm [name]').forEach(input => { datos[input.name] = input.value; });

  try {
    if (certEditingId) {
      await apiCall('certificaciones_actualizar', { id: certEditingId, datos: Object.assign({ idTramite: certTramiteActual._id }, datos) });
      msg.textContent = 'Certificación actualizada correctamente.';
    } else {
      await apiCall('certificaciones_crear', { datos: Object.assign({ idTramite: certTramiteActual._id }, datos) });
      msg.textContent = 'Certificación guardada correctamente.';
    }
    msg.className = 'form-msg ok';
    msg.hidden = false;
    certEditingId = null;
    document.getElementById('certForm').reset();
    seleccionarTramiteParaCertificar(certTramiteActual); // limpia el form pero deja el trámite elegido para cargar otra
    const data = await apiCall('listar'); // refresca los totales del trámite (rollup)
    state.registros = data.registros;
    await cargarCertificaciones();
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
    msg.className = 'form-msg err';
    msg.hidden = false;
  }
});

document.getElementById('certFiltroTexto').addEventListener('input', renderCertTable);

// ---- "Mes/Año" en la importación: acepta "MM/AAAA", "AAAA-MM" o "MM/AA" (con 2 dígitos de año),
// y siempre lo devuelve normalizado a "AAAA-MM" (el formato que usa el campo internamente). ----
function _parseMesAnioImport(v) {
  if (!v) return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (m) return m[2] + '-' + String(m[1]).padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/\-](\d{2})$/);
  if (m) return '20' + m[2] + '-' + String(m[1]).padStart(2, '0');
  return '';
}

let certImportFilas = []; // filas ya procesadas (matcheadas o no), listas para mostrar/confirmar

document.getElementById('certImportToggleBtn').addEventListener('click', () => {
  const body = document.getElementById('certImportBody');
  body.hidden = !body.hidden;
});

document.getElementById('certImportFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const texto = await file.text();
  const filas = parseCSV(texto);

  certImportFilas = filas.map(f => {
    const nroPedido = (f['N° Pedido'] || '').trim();
    const sucursal = (f['Sucursal'] || '').trim();
    const numeroCertificado = (f['N° Certificado'] || '').trim();

    // Buscamos el trámite por N° de Pedido; si hay más de uno con el mismo PC (ampliaciones/clones),
    // desambiguamos por Sucursal, si vino en el CSV.
    let candidatos = state.registros.filter(r => String(r.nroPedidoCompras || '').trim() === nroPedido);
    let tramite = null;
    let motivo = '';
    if (!nroPedido) {
      motivo = 'Fila sin N° de Pedido';
    } else if (!candidatos.length) {
      motivo = 'No hay ningún trámite cargado con ese N° de Pedido';
    } else if (candidatos.length === 1) {
      tramite = candidatos[0];
    } else {
      const porSucursal = candidatos.filter(r => (r.sucursal || '').trim().toLowerCase() === sucursal.toLowerCase());
      if (porSucursal.length === 1) {
        tramite = porSucursal[0];
      } else {
        motivo = 'Hay ' + candidatos.length + ' trámites con ese PC y no se pudo desambiguar por Sucursal';
      }
    }

    // Evitar duplicados: si ya existe una certificación para ese trámite con el mismo N° de Certificado, se omite.
    let duplicado = false;
    if (tramite && numeroCertificado) {
      duplicado = certListaCache.some(c => c.idTramite === tramite._id && String(c.numeroCertificado || '').trim() === numeroCertificado);
    }

    let estado = 'importar';
    if (!tramite) estado = 'sin_tramite';
    else if (duplicado) estado = 'duplicado';

    return {
      csv: f,
      tramite,
      motivo,
      estado, // 'importar' | 'duplicado' | 'sin_tramite'
      datos: tramite ? {
        idTramite: tramite._id,
        numeroCertificado,
        expedienteCertificacion: (f['Expediente Certificación'] || '').trim(),
        mesAnioCertificacion: _parseMesAnioImport(f['Mes/Año']),
        montoCertificado: _parseNumeroImport(f['$ Certificado']),
        montoReconocimiento: _parseNumeroImport(f['$ Reconocimiento']),
        montoMultas: _parseNumeroImport(f['$ Multas']),
        observaciones: (f['Observaciones'] || '').trim()
      } : null
    };
  });

  renderCertImportPreview();
});

function renderCertImportPreview() {
  const wrap = document.getElementById('certImportPreviewWrap');
  wrap.hidden = false;
  const cantImportar = certImportFilas.filter(f => f.estado === 'importar').length;
  const cantDuplicado = certImportFilas.filter(f => f.estado === 'duplicado').length;
  const cantSinTramite = certImportFilas.filter(f => f.estado === 'sin_tramite').length;

  document.getElementById('certImportResumen').textContent =
    `${certImportFilas.length} fila(s) en el CSV — ${cantImportar} para importar, ${cantDuplicado} ya existen (se omiten), ${cantSinTramite} sin trámite coincidente (se omiten, revisalas manualmente).`;

  const table = document.getElementById('certImportPreviewTable');
  const badge = (estado) => estado === 'importar'
    ? '<span class="state-pill state-Adjudicado">Importar</span>'
    : estado === 'duplicado'
      ? '<span class="state-pill state-default">Ya existe</span>'
      : '<span class="state-pill state-Desierto">Sin trámite</span>';

  table.innerHTML = '<thead><tr><th>N° Pedido</th><th>Sucursal</th><th>N° Certificado</th><th>Mes/Año</th><th>$ Certificado</th><th>Estado</th><th>Detalle</th></tr></thead>' +
    '<tbody>' + certImportFilas.map(f => `<tr>
        <td>${escapeHtml(f.csv['N° Pedido'] || '')}</td>
        <td>${escapeHtml(f.csv['Sucursal'] || '')}</td>
        <td>${escapeHtml(f.csv['N° Certificado'] || '')}</td>
        <td>${escapeHtml(f.csv['Mes/Año'] || '')}</td>
        <td class="mono">${escapeHtml(f.csv['$ Certificado'] || '')}</td>
        <td>${badge(f.estado)}</td>
        <td>${escapeHtml(f.motivo || (f.estado === 'duplicado' ? 'Ya hay una certificación Nº ' + (f.csv['N° Certificado'] || '') + ' cargada para ese trámite' : ''))}</td>
      </tr>`).join('') + '</tbody>';

  document.getElementById('certImportConfirmarBtn').disabled = cantImportar === 0;
  document.getElementById('certImportConfirmarBtn').textContent = 'Importar ' + cantImportar + ' certificación(es)';
}

document.getElementById('certImportCancelarBtn').addEventListener('click', () => {
  certImportFilas = [];
  document.getElementById('certImportFile').value = '';
  document.getElementById('certImportPreviewWrap').hidden = true;
  document.getElementById('certImportMsg').hidden = true;
});

document.getElementById('certImportConfirmarBtn').addEventListener('click', async () => {
  const btn = document.getElementById('certImportConfirmarBtn');
  const msg = document.getElementById('certImportMsg');
  const aImportar = certImportFilas.filter(f => f.estado === 'importar');
  btn.disabled = true;
  let ok = 0, fallidos = 0;
  for (let i = 0; i < aImportar.length; i++) {
    btn.textContent = `Importando ${i + 1} de ${aImportar.length}...`;
    try {
      await apiCall('certificaciones_crear', { datos: aImportar[i].datos });
      ok++;
    } catch (err) {
      fallidos++;
    }
  }
  msg.textContent = `Listo: ${ok} certificación(es) importada(s)${fallidos ? ', ' + fallidos + ' fallaron' : ''}. Los trámites (Pedidos de Compras) no se modificaron.`;
  msg.className = 'form-msg ' + (fallidos ? 'err' : 'ok');
  msg.hidden = false;
  certImportFilas = [];
  document.getElementById('certImportFile').value = '';
  document.getElementById('certImportPreviewWrap').hidden = true;

  const data = await apiCall('listar'); // refresca los rollups (% de avance, etc.) de los trámites afectados
  state.registros = data.registros;
  await cargarCertificaciones();
});

const CERT_TABLE_COLS = [
  { key: 'pospre', label: 'Pospre' },
  { key: 'expediente', label: 'Expediente' },
  { key: 'rubro', label: 'Detalle Rubro' },
  { key: 'nroPedidoCompras', label: 'PC' },
  { key: 'contratista', label: 'Contratista' },
  { key: 'expedienteCertificacion', label: 'Exp. Certificación' },
  { key: 'numeroCertificado', label: 'N° Certificado' },
  { key: 'mesAnioCertificacion', label: 'Mes/Año' },
  { key: 'iibbCertificados', label: 'IIBB Certificados' },
  { key: 'montoCertificado', label: '$ Certificado' },
  { key: 'montoReconocimiento', label: '$ Reconocimiento' },
  { key: 'montoMultas', label: '$ Multas' },
  { key: 'pctAvance', label: '% del Adjudicado' },
];
const CERT_MONEY_COLS = new Set(['montoCertificado', 'montoReconocimiento', 'montoMultas']);

function certSortValue(c, key) {
  if (key === 'pctAvance' || key === 'iibbCertificados' || CERT_MONEY_COLS.has(key)) return num(c[key]);
  return String(c[key] != null ? c[key] : '').toLowerCase();
}

function renderCertTable() {
  populateFilterOptions(); // repuebla combos (facetados) y sincroniza inputs avanzados de las 5 barras compartidas

  const idsPermitidos = idsTramitesPermitidosPorFiltroCompartido();
  const q = document.getElementById('certFiltroTexto').value.trim().toLowerCase();
  let rows = certListaCache.filter(c => {
    if (!idsPermitidos.has(c.idTramite)) return false;
    if (!q) return true;
    return ['pospre','expediente','rubro','nroPedidoCompras','contratista','numeroCertificado','expedienteCertificacion'].some(k =>
      String(c[k] || '').toLowerCase().includes(q)
    );
  });
  if (certSort.key) {
    rows = sortRows(rows, certSort, certSortValue);
  } else {
    rows = rows.slice().sort((a, b) => defaultMultiKeyCompare(a, b, CERT_ORDEN_DEFECTO));
  }

  const isAdmin = state.session && state.session.rol === 'admin';
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  const table = document.getElementById('certTable');
  const thead = sortableTheadHtml(CERT_TABLE_COLS, certSort, '<th>Observaciones</th>' + ((puedeEditar || isAdmin) ? '<th>Acciones</th>' : ''));
  const tbody = '<tbody>' + rows.map(c => {
    const tds = CERT_TABLE_COLS.map(col => {
      if (CERT_MONEY_COLS.has(col.key)) return `<td class="mono">${formatMoney(c[col.key])}</td>`;
      if (col.key === 'pctAvance') return `<td class="mono">${num(c.pctAvance).toFixed(1)}%</td>`;
      if (col.key === 'iibbCertificados') return `<td class="mono">${num(c.iibbCertificados).toFixed(2)}</td>`;
      if (col.key === 'mesAnioCertificacion') return `<td class="mono">${formatMesAnio(c.mesAnioCertificacion)}</td>`;
      if (col.key === 'contratista' || col.key === 'rubro') {
        const texto = c[col.key] != null ? c[col.key] : '';
        return `<td class="td-truncate" title="${escapeHtml(texto)}">${escapeHtml(texto)}</td>`;
      }
      return `<td>${escapeHtml(c[col.key] != null ? c[col.key] : '')}</td>`;
    }).join('');
    const acciones = (puedeEditar || isAdmin) ? `<td class="row-actions">
        ${puedeEditar ? '<button class="icon-btn" data-action="editar" data-cert-id="' + c._id + '" title="Editar certificación">✏️</button>' : ''}
        ${puedeEditar ? '<button class="icon-btn" data-action="clonar" data-cert-id="' + c._id + '" title="Clonar certificación">🧬</button>' : ''}
        ${puedeEditar ? '<button class="icon-btn danger" data-action="eliminar" data-cert-id="' + c._id + '" title="Eliminar certificación">🗑️</button>' : ''}
      </td>` : '';
    return `<tr>${tds}<td class="td-truncate" title="${escapeHtml(c.observaciones || '')}">${escapeHtml(c.observaciones || '')}</td>${acciones}</tr>`;
  }).join('') + '</tbody>';
  table.innerHTML = thead + tbody;
  setupScrollShadow(table.closest('.table-wrap'));
  wireSortableHeaders(table, certSort, renderCertTable);

  table.querySelectorAll('[data-cert-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const c = certListaCache.find(x => x._id === btn.dataset.certId);
      if (!c) return;
      const accion = btn.dataset.action;
      if (accion === 'editar') { editarCertificacion(c); return; }
      if (accion === 'clonar') { await clonarCertificacion(c); return; }
      if (accion === 'eliminar') {
        const confirmado = confirm('¿Eliminar esta certificación? El total del trámite se va a recalcular.');
        if (!confirmado) return;
        try {
          await apiCall('certificaciones_eliminar', { id: c._id });
          const data = await apiCall('listar');
          state.registros = data.registros;
          await cargarCertificaciones();
        } catch (err) {
          alert('Error: ' + err.message);
        }
      }
    });
  });
}

// ============================================================
// PROYECTOS
// ============================================================
let proyTramitePreseleccionado = null; // seteado desde el botón "Ver / cargar proyectos" del formulario
let proyTramiteActual = null;          // registro del trámite elegido en esta pestaña
let proyDatosHuerfano = null;          // datos de un proyecto "huérfano" (trámite vinculado ya no existe) que se está re-vinculando
let proyListaCache = [];               // todos los proyectos ya cargados (para la tabla)
let proyCamposCache = [];              // metadatos de campos (para exportar con etiquetas legibles)
let proyEditingId = null;              // si no es null, el formulario está editando ese proyecto (en vez de crear uno nuevo)

async function abrirVistaProyectos() {
  document.getElementById('proyFiltroTexto').value = '';
  await cargarProyectos();

  const puedeEditar = state.session && state.session.rol !== 'consulta';
  document.getElementById('proyFormPanel').hidden = !puedeEditar;

  if (proyTramitePreseleccionado) {
    const rec = state.registros.find(r => r._id === proyTramitePreseleccionado);
    proyTramitePreseleccionado = null;
    proyEditingId = null;      // llegar acá (ej: "Ver / cargar proyectos" desde un trámite) siempre arranca en modo carga, nunca "edición pegada"
    proyDatosHuerfano = null;
    if (rec && puedeEditar) seleccionarTramiteParaProyecto(rec);
  } else if (!proyTramiteActual) {
    // Igual que en Certificaciones: si ya había un trámite elegido con el formulario a medio
    // completar, y el usuario solo pasó por otra pestaña, no se lo borramos al volver.
    document.getElementById('proyTramiteSeleccionado').hidden = true;
    document.getElementById('proyForm').hidden = true;
    proyEditingId = null;
    proyDatosHuerfano = null;
  }
}

async function cargarProyectos() {
  try {
    const data = await apiCall('proyectos_listar');
    proyCamposCache = data.campos;
    proyListaCache = data.proyectos;
    renderProyTable();
  } catch (err) {
    showAppError('No se pudieron cargar los proyectos: ' + err.message);
  }
}

document.getElementById('proyExportBtn').addEventListener('click', () => {
  if (!proyListaCache.length) { alert('No hay proyectos para exportar.'); return; }
  const data = proyListaCache.map(p => {
    const obj = {};
    proyCamposCache.forEach(f => { obj[f.label] = p[f.key]; });
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Proyectos');
  XLSX.writeFile(wb, 'proyectos_export.xlsx');
});

// ---- Buscador de trámite ----
const proyBuscarInput = document.getElementById('proyBuscarTramite');
proyBuscarInput.addEventListener('input', () => {
  const q = proyBuscarInput.value.trim().toLowerCase();
  const resultados = document.getElementById('proyResultadosBusqueda');
  if (q.length < 2) { resultados.hidden = true; resultados.innerHTML = ''; return; }

  const matches = state.registros.filter(r =>
    isObraMenorPospre(r.pospre) && (
      String(r.pospre || '').toLowerCase().includes(q) ||
      String(r.expediente || '').toLowerCase().includes(q) ||
      String(r.nroPedidoCompras || '').toLowerCase().includes(q)
    )
  ).slice(0, 20);

  if (!matches.length) {
    resultados.innerHTML = '<div class="cert-search-item">Sin resultados (Proyectos solo aplica a trámites con Pospre O.D.P. u O.D.S.)</div>';
  } else {
    resultados.innerHTML = matches.map(r => `<div class="cert-search-item" data-id="${r._id}">
        ${escapeHtml(r.pospre || '(sin pospre)')} — Exp. ${escapeHtml(r.expediente || '—')} — PC ${escapeHtml(r.nroPedidoCompras || '—')}
        <span class="small">${escapeHtml(r.sucursal || '')} · ${escapeHtml(r.adjudicatario || '(sin contratista)')}</span>
      </div>`).join('');
  }
  resultados.hidden = false;

  resultados.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      const rec = state.registros.find(r => r._id === el.dataset.id);
      // Elegir un trámite desde ESTE buscador siempre arranca una carga nueva (nunca "sigue"
      // editando un proyecto anterior) — la única forma de mantener el modo edición es con el
      // botón "Cambiar" del panel de arriba, que sí preserva proyEditingId a propósito.
      proyEditingId = null;
      proyDatosHuerfano = null;
      if (rec) seleccionarTramiteParaProyecto(rec);
      resultados.hidden = true;
      proyBuscarInput.value = '';
    });
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#proyFormPanel')) {
    const resultados = document.getElementById('proyResultadosBusqueda');
    if (resultados) resultados.hidden = true;
  }
});

function seleccionarTramiteParaProyecto(rec) {
  proyTramiteActual = rec;
  const seguirEditando = proyEditingId; // si veníamos editando un proyecto, "Cambiar" no debe perder eso
  document.getElementById('proyFormTitle').textContent = seguirEditando ? 'Editar proyecto' : 'Cargar proyecto';
  document.getElementById('proySubmitBtn').textContent = seguirEditando ? 'Guardar cambios' : 'Guardar proyecto';
  const chip = document.getElementById('proyTramiteSeleccionado');
  chip.innerHTML = `<span><strong>${escapeHtml(rec.pospre || '')}</strong> — Exp. ${escapeHtml(rec.expediente || '—')} — PC ${escapeHtml(rec.nroPedidoCompras || '—')} — ${escapeHtml(rec.adjudicatario || '(sin contratista)')}</span>
    <button type="button" class="btn btn-ghost" id="proyCambiarTramiteBtn">Cambiar</button>`;
  chip.hidden = false;
  document.getElementById('proyCambiarTramiteBtn').addEventListener('click', () => {
    proyTramiteActual = null;
    // Ojo: NO tocamos proyEditingId acá. Si estábamos editando un proyecto y el usuario elige otro
    // trámite, al guardar se reasigna ESE MISMO proyecto al trámite nuevo (útil cuando un proyecto
    // quedó "huérfano" — vinculado a un trámite que ya no existe, por ejemplo tras borrar y volver
    // a cargar el trámite — en vez de crear un proyecto duplicado y dejar el viejo mal vinculado).
    chip.hidden = true;
    document.getElementById('proyForm').hidden = true;
    document.getElementById('proyKmLamtInfo').hidden = true;
  });

  document.getElementById('proyPospre').value = rec.pospre || '';
  document.getElementById('proySucursal').value = rec.sucursal || '';
  document.getElementById('proyPC').value = rec.nroPedidoCompras || '';
  document.getElementById('proyContratista').value = rec.adjudicatario || '';

  // El $ Km de LAMT y su Mes/Año ya no se cargan acá: se definen una sola vez en la etapa
  // Ejecución del trámite (Registros) y valen para todos los proyectos de este Pedido de Compras.
  const info = document.getElementById('proyKmLamtInfo');
  if (num(rec.kmLineaPC) > 0) {
    info.hidden = false;
    info.innerHTML = `<strong>$ Km de LAMT de este contrato:</strong> ${formatMoney(rec.kmLineaPC)}` +
      (rec.mmAAkmLAMT ? ` (Mes/Año de cálculo: ${escapeHtml(rec.mmAAkmLAMT)})` : '') +
      `. Se definió en la etapa <strong>Ejecución</strong> del trámite y aplica a todos los proyectos de este Pedido de Compras. Para corregirlo, editá el trámite directamente desde Registros.`;
  } else {
    info.hidden = false;
    info.innerHTML = `Todavía no se cargó el <strong>$ Km de LAMT</strong> de este contrato. Cargalo desde Registros, en la etapa <strong>Ejecución</strong> del trámite — así queda disponible para todos los proyectos de este Pedido de Compras.`;
  }

  const form = document.getElementById('proyForm');
  if (proyDatosHuerfano) {
    // Re-vinculando un proyecto huérfano: precargamos sus datos propios (no los del trámite,
    // esos ya se completaron arriba) en vez de vaciar el formulario.
    const p = proyDatosHuerfano;
    document.querySelectorAll('#proyForm [name]').forEach(input => {
      if (p[input.name] != null) input.value = p[input.name];
    });
    document.getElementById('proyFormTitle').textContent = 'Editar proyecto';
    document.getElementById('proySubmitBtn').textContent = 'Guardar cambios';
    proyDatosHuerfano = null;
  } else if (!seguirEditando) {
    form.reset(); // si estamos reasignando una edición normal, no perder lo ya tipeado
  }
  recalcMontoProyecto();
  document.getElementById('proyFormMsg').hidden = true;
  form.hidden = false;
}

// ---- Editar: carga un proyecto ya existente en el formulario, en modo edición ----
function editarProyecto(p) {
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  if (!puedeEditar) return;

  const rec = state.registros.find(r => r._id === p.idTramite);
  proyEditingId = p._id;

  if (!rec) {
    // Proyecto "huérfano": su trámite vinculado ya no existe (por ejemplo, se borró y se volvió a
    // cargar). En vez de bloquear la edición, dejamos elegir a qué trámite corresponde ahora,
    // usando el mismo buscador de siempre — proyEditingId ya está seteado, así que al elegir un
    // trámite se reasigna ESTE proyecto en vez de crear uno nuevo.
    proyTramiteActual = null;
    document.getElementById('proyTramiteSeleccionado').hidden = true;
    document.getElementById('proyKmLamtInfo').hidden = true;
    document.getElementById('proyForm').hidden = true;
    document.getElementById('proyFormMsg').className = 'form-msg err';
    document.getElementById('proyFormMsg').textContent =
      `Este proyecto (N° ${p.numeroProyecto || '—'}, PC ${p.nroPedidoCompras || '—'}) está vinculado a un trámite que ya no existe. Buscá y elegí el trámite correcto abajo para volver a vincularlo — no vas a perder los datos ya cargados.`;
    document.getElementById('proyFormMsg').hidden = false;
    document.getElementById('proyBuscarTramite').focus();
    document.getElementById('proyFormPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    proyDatosHuerfano = p; // se usan para precargar el resto del formulario apenas se elija el trámite nuevo
    return;
  }

  seleccionarTramiteParaProyecto(rec);
  document.getElementById('proyFormTitle').textContent = 'Editar proyecto';
  document.getElementById('proySubmitBtn').textContent = 'Guardar cambios';

  document.querySelectorAll('#proyForm [name]').forEach(input => {
    if (p[input.name] != null) input.value = p[input.name];
  });
  recalcMontoProyecto();
  document.getElementById('proyFormMsg').hidden = true;
  document.getElementById('proyFormPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- Clonar: crea un proyecto nuevo con los mismos datos ----
async function clonarProyecto(p) {
  const confirmado = confirm('¿Clonar este proyecto? Se va a crear un proyecto nuevo con los mismos datos.');
  if (!confirmado) return;
  const datos = {};
  proyCamposCache.forEach(f => { if (f.key !== 'pctIIBBProyecto') datos[f.key] = p[f.key]; });
  try {
    await apiCall('proyectos_crear', { datos: Object.assign({ idTramite: p.idTramite }, datos) });
    await cargarProyectos();
  } catch (err) {
    alert('Error al clonar: ' + err.message);
  }
}

document.getElementById('proyCancelarBtn').addEventListener('click', () => {
  document.getElementById('proyForm').hidden = true;
  document.getElementById('proyTramiteSeleccionado').hidden = true;
  document.getElementById('proyKmLamtInfo').hidden = true;
  proyTramiteActual = null;
  proyEditingId = null;
  proyDatosHuerfano = null;
});

// ---- $ del Proyecto se calcula solo: IIBB Proyectados de ESTE proyecto × $ Adjudicado Unitario del trámite ----
function recalcMontoProyecto() {
  const montoInput = document.querySelector('#proyForm [name="montoProyecto"]');
  const iibbInput = document.querySelector('#proyForm [name="iibbProyecto"]');
  if (!montoInput) return;
  if (!proyTramiteActual) { montoInput.value = ''; return; }
  const iibbProyecto = parseFloat(iibbInput ? iibbInput.value : '') || 0;
  const unitario = parseFloat(proyTramiteActual.adjudicadoUnitario) || 0;
  const monto = iibbProyecto * unitario;
  montoInput.value = monto ? monto.toFixed(2) : '';
}
document.getElementById('proyForm').addEventListener('input', (e) => {
  if (e.target.name === 'iibbProyecto') recalcMontoProyecto();
});
document.getElementById('proyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('proyFormMsg');
  msg.hidden = true;
  if (!proyTramiteActual) { return; }

  const datos = {
    pospre: proyTramiteActual.pospre || '',
    sucursal: proyTramiteActual.sucursal || '',
    nroPedidoCompras: proyTramiteActual.nroPedidoCompras || '',
    contratista: proyTramiteActual.adjudicatario || ''
  };
  document.querySelectorAll('#proyForm [name]').forEach(input => { datos[input.name] = input.value; });

  try {
    if (proyEditingId) {
      await apiCall('proyectos_actualizar', { id: proyEditingId, datos: Object.assign({ idTramite: proyTramiteActual._id }, datos) });
      msg.textContent = 'Proyecto actualizado correctamente.';
    } else {
      await apiCall('proyectos_crear', { datos: Object.assign({ idTramite: proyTramiteActual._id }, datos) });
      msg.textContent = 'Proyecto guardado correctamente.';
    }
    msg.className = 'form-msg ok';
    msg.hidden = false;
    proyEditingId = null;
    proyDatosHuerfano = null;
    document.getElementById('proyForm').reset();
    seleccionarTramiteParaProyecto(proyTramiteActual); // limpia el form pero deja el trámite elegido para cargar otro
    const data = await apiCall('listar'); // refresca los totales del trámite (rollup)
    state.registros = data.registros;
    await cargarProyectos();
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
    msg.className = 'form-msg err';
    msg.hidden = false;
  }
});

document.getElementById('proyFiltroTexto').addEventListener('input', renderProyTable);

// ============================================================
// IMPORTAR PROYECTOS DESDE CSV (de otra herramienta)
// ============================================================
// Nunca toca el trámite/PC al que se vincula cada fila — solo CREA proyectos nuevos.
// Cada fila del CSV se busca por N° de Pedido (+ Sucursal, si hace falta desambiguar entre
// varios trámites con el mismo PC, algo que pasa seguido por ampliaciones/clones).

// Convierte "211505367,04" (coma decimal, típico de estos exports) a un número de JS normal.
function _parseNumeroImport(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Parser CSV simple pero robusto: entiende campos entre comillas (con comas y comillas escapadas "" adentro).
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, ''); // BOM
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* ignorar, el \n que sigue cierra la fila */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.some(c => c.trim() !== ''))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (r[i] != null ? r[i] : '').trim(); });
      return obj;
    });
}

let proyImportFilas = []; // filas ya procesadas (matcheadas o no), listas para mostrar/confirmar

document.getElementById('proyImportToggleBtn').addEventListener('click', () => {
  const body = document.getElementById('proyImportBody');
  body.hidden = !body.hidden;
});

document.getElementById('proyImportFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const texto = await file.text();
  const filas = parseCSV(texto);

  proyImportFilas = filas.map(f => {
    const nroPedido = (f['N° Pedido'] || '').trim();
    const sucursal = (f['Sucursal'] || '').trim();
    const numeroProyecto = (f['N° Proy.'] || '').trim();

    // Buscamos el trámite por N° de Pedido; si hay más de uno con el mismo PC (ampliaciones/clones),
    // desambiguamos por Sucursal, que también viene en el CSV.
    let candidatos = state.registros.filter(r => String(r.nroPedidoCompras || '').trim() === nroPedido);
    let tramite = null;
    let motivo = '';
    if (!nroPedido) {
      motivo = 'Fila sin N° de Pedido';
    } else if (!candidatos.length) {
      motivo = 'No hay ningún trámite cargado con ese N° de Pedido';
    } else if (candidatos.length === 1) {
      tramite = candidatos[0];
    } else {
      const porSucursal = candidatos.filter(r => (r.sucursal || '').trim().toLowerCase() === sucursal.toLowerCase());
      if (porSucursal.length === 1) {
        tramite = porSucursal[0];
      } else {
        motivo = 'Hay ' + candidatos.length + ' trámites con ese PC y no se pudo desambiguar por Sucursal';
      }
    }

    // Evitar duplicados: si ya existe un proyecto para ese trámite con el mismo N° de Proyecto, se omite.
    let duplicado = false;
    if (tramite) {
      duplicado = proyListaCache.some(p => p.idTramite === tramite._id && String(p.numeroProyecto || '').trim() === numeroProyecto && numeroProyecto !== '');
    }

    let estado = 'importar';
    if (!tramite) estado = 'sin_tramite';
    else if (duplicado) estado = 'duplicado';

    return {
      csv: f,
      tramite,
      motivo,
      estado, // 'importar' | 'duplicado' | 'sin_tramite'
      datos: tramite ? {
        idTramite: tramite._id,
        nroExpedienteProyecto: (f['Expediente'] || '').trim(),
        numeroProyecto,
        descripcionProyecto: (f['Breve Resumen'] || '').trim(),
        iibbProyecto: _parseNumeroImport(f['IIBB Proy.']),
        observaciones: (f['Observaciones'] || '').trim()
      } : null
    };
  });

  renderProyImportPreview();
});

function renderProyImportPreview() {
  const wrap = document.getElementById('proyImportPreviewWrap');
  wrap.hidden = false;
  const cantImportar = proyImportFilas.filter(f => f.estado === 'importar').length;
  const cantDuplicado = proyImportFilas.filter(f => f.estado === 'duplicado').length;
  const cantSinTramite = proyImportFilas.filter(f => f.estado === 'sin_tramite').length;

  document.getElementById('proyImportResumen').textContent =
    `${proyImportFilas.length} fila(s) en el CSV — ${cantImportar} para importar, ${cantDuplicado} ya existen (se omiten), ${cantSinTramite} sin trámite coincidente (se omiten, revisalas manualmente).`;

  const table = document.getElementById('proyImportPreviewTable');
  const badge = (estado) => estado === 'importar'
    ? '<span class="state-pill state-Adjudicado">Importar</span>'
    : estado === 'duplicado'
      ? '<span class="state-pill state-default">Ya existe</span>'
      : '<span class="state-pill state-Desierto">Sin trámite</span>';

  table.innerHTML = '<thead><tr><th>N° Pedido</th><th>Sucursal</th><th>N° Proy.</th><th>Breve Resumen</th><th>IIBB Proy.</th><th>Estado</th><th>Detalle</th></tr></thead>' +
    '<tbody>' + proyImportFilas.map(f => `<tr>
        <td>${escapeHtml(f.csv['N° Pedido'] || '')}</td>
        <td>${escapeHtml(f.csv['Sucursal'] || '')}</td>
        <td>${escapeHtml(f.csv['N° Proy.'] || '')}</td>
        <td class="td-truncate" title="${escapeHtml(f.csv['Breve Resumen'] || '')}">${escapeHtml(f.csv['Breve Resumen'] || '')}</td>
        <td class="mono">${escapeHtml(f.csv['IIBB Proy.'] || '')}</td>
        <td>${badge(f.estado)}</td>
        <td>${escapeHtml(f.motivo || (f.estado === 'duplicado' ? 'Ya hay un proyecto Nº ' + (f.csv['N° Proy.'] || '') + ' cargado para ese trámite' : ''))}</td>
      </tr>`).join('') + '</tbody>';

  document.getElementById('proyImportConfirmarBtn').disabled = cantImportar === 0;
  document.getElementById('proyImportConfirmarBtn').textContent = 'Importar ' + cantImportar + ' proyecto(s)';
}

document.getElementById('proyImportCancelarBtn').addEventListener('click', () => {
  proyImportFilas = [];
  document.getElementById('proyImportFile').value = '';
  document.getElementById('proyImportPreviewWrap').hidden = true;
  document.getElementById('proyImportMsg').hidden = true;
});

document.getElementById('proyImportConfirmarBtn').addEventListener('click', async () => {
  const btn = document.getElementById('proyImportConfirmarBtn');
  const msg = document.getElementById('proyImportMsg');
  const aImportar = proyImportFilas.filter(f => f.estado === 'importar');
  btn.disabled = true;
  let ok = 0, fallidos = 0;
  for (let i = 0; i < aImportar.length; i++) {
    btn.textContent = `Importando ${i + 1} de ${aImportar.length}...`;
    try {
      await apiCall('proyectos_crear', { datos: aImportar[i].datos });
      ok++;
    } catch (err) {
      fallidos++;
    }
  }
  msg.textContent = `Listo: ${ok} proyecto(s) importado(s)${fallidos ? ', ' + fallidos + ' fallaron' : ''}. Los trámites (Pedidos de Compras) no se modificaron.`;
  msg.className = 'form-msg ' + (fallidos ? 'err' : 'ok');
  msg.hidden = false;
  proyImportFilas = [];
  document.getElementById('proyImportFile').value = '';
  document.getElementById('proyImportPreviewWrap').hidden = true;

  const data = await apiCall('listar'); // refresca los rollups de los trámites afectados
  state.registros = data.registros;
  await cargarProyectos();
});

const PROY_TABLE_COLS = [
  { key: 'pospre', label: 'Pospre' },
  { key: 'sucursal', label: 'Sucursal' },
  { key: 'nroPedidoCompras', label: 'PC' },
  { key: 'contratista', label: 'Contratista' },
  { key: 'nroExpedienteProyecto', label: 'Exp. Proyecto' },
  { key: 'numeroProyecto', label: 'N° Proyecto' },
  { key: 'iibbProyecto', label: 'IIBB Proyecto' },
  { key: 'montoProyecto', label: '$ Proyecto' },
  { key: 'pctIIBBProyecto', label: '% IIBB' },
  { key: '_techoKmLAMT', label: '$ Km LAMT (Contrato)' },
  { key: '_pctTechoKmLAMT', label: '% del techo' },
];

// Orden por defecto (sin que el usuario haya clickeado ningún encabezado todavía): agrupa la
// lectura siguiendo el mismo recorrido de categorías, de izquierda a derecha, en ambos módulos.
function defaultMultiKeyCompare(a, b, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const va = String(a[k] != null ? a[k] : '').toLowerCase();
    const vb = String(b[k] != null ? b[k] : '').toLowerCase();
    const cmp = va.localeCompare(vb, 'es', { sensitivity: 'base', numeric: true });
    if (cmp !== 0) return cmp;
  }
  return 0;
}
const PROY_ORDEN_DEFECTO = ['pospre', 'sucursal', 'nroPedidoCompras', 'contratista', 'numeroProyecto'];
const CERT_ORDEN_DEFECTO = ['pospre', 'sucursal', 'nroPedidoCompras', 'contratista', 'numeroCertificado'];

let proySort = { key: null, dir: 1 };  // ordenamiento de la tabla de Proyectos cargados

function proySortValue(p, key) {
  if (['montoProyecto', 'pctIIBBProyecto', 'iibbProyecto', '_techoKmLAMT', '_pctTechoKmLAMT'].includes(key)) return num(p[key]);
  return String(p[key] != null ? p[key] : '').toLowerCase();
}

// ---- Semáforo por % del techo de $ Km de LAMT del contrato (al revés que semTinte(): acá más
// alto es PEOR, porque significa que el proyecto se acerca o supera el techo del contrato) ----
function semTintePorTecho(pct) {
  if (pct > 100) return { bg: '#FEE2E2', color: '#991B1B' }; // superó el techo del contrato
  if (pct >= 70) return { bg: '#FEF3C7', color: '#92400E' }; // cerca del techo
  return { bg: '#DCFCE7', color: '#166534' }; // holgado
}

function renderProyTable() {
  populateFilterOptions(); // repuebla combos (facetados) y sincroniza inputs avanzados de las 5 barras compartidas

  const idsPermitidos = idsTramitesPermitidosPorFiltroCompartido();
  const q = document.getElementById('proyFiltroTexto').value.trim().toLowerCase();
  let rows = proyListaCache.filter(p => {
    if (!idsPermitidos.has(p.idTramite)) return false;
    if (!q) return true;
    return ['pospre','nroPedidoCompras','contratista','numeroProyecto','nroExpedienteProyecto'].some(k =>
      String(p[k] || '').toLowerCase().includes(q)
    );
  });

  // ---- $ Km de LAMT del Contrato: techo cargado una sola vez en el trámite (etapa Certificación,
  // campo "kmLineaPC") que aplica a TODOS los proyectos de ese Pedido de Compras. Un proyecto
  // nunca debería superar ese techo — si lo supera, hay que revisar/corregir ese proyecto. Acá se
  // agrega esa referencia y el % que representa cada "$ del Proyecto" sobre ese techo. ----
  rows = rows.map(p => {
    const tramite = state.registros.find(r => r._id === p.idTramite);
    const techo = tramite ? num(tramite.kmLineaPC) : 0;
    const pctTecho = techo > 0 ? (num(p.montoProyecto) / techo) * 100 : null;
    return Object.assign({}, p, { _techoKmLAMT: techo, _pctTechoKmLAMT: pctTecho });
  });
  const superanTecho = rows.filter(p => p._pctTechoKmLAMT != null && p._pctTechoKmLAMT > 100);

  if (proySort.key) {
    rows = sortRows(rows, proySort, proySortValue);
  } else {
    rows = rows.slice().sort((a, b) => defaultMultiKeyCompare(a, b, PROY_ORDEN_DEFECTO));
  }

  const avisoTecho = document.getElementById('proyAvisoTechoLAMT');
  if (avisoTecho) {
    if (superanTecho.length) {
      avisoTecho.hidden = false;
      avisoTecho.innerHTML = `⚠ <strong>${superanTecho.length} proyecto(s)</strong> superan el $ Km de LAMT definido para su contrato — revisá y corregí el "IIBB del Proyecto" o el "$ Km de LAMT" del trámite: ` +
        superanTecho.slice(0, 6).map(p => escapeHtml(p.numeroProyecto || p.nroExpedienteProyecto || p._id)).join(', ') +
        (superanTecho.length > 6 ? '…' : '');
    } else {
      avisoTecho.hidden = true;
    }
  }

  const isAdmin = state.session && state.session.rol === 'admin';
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  const table = document.getElementById('proyTable');
  const thead = sortableTheadHtml(PROY_TABLE_COLS, proySort, '<th>Descripción</th><th>Observaciones</th>' + ((puedeEditar || isAdmin) ? '<th>Acciones</th>' : ''));
  const tbody = '<tbody>' + rows.map(p => {
    const tds = PROY_TABLE_COLS.map(col => {
      if (['montoProyecto', '_techoKmLAMT'].includes(col.key)) return `<td class="mono">${formatMoney(p[col.key])}</td>`;
      if (col.key === 'pctIIBBProyecto') return `<td class="mono">${num(p.pctIIBBProyecto).toFixed(1)}%</td>`;
      if (col.key === '_pctTechoKmLAMT') {
        if (p._pctTechoKmLAMT == null) return '<td class="mono" style="color:var(--text-soft)">s/d</td>';
        const t = semTintePorTecho(p._pctTechoKmLAMT);
        return `<td class="mono segu-celda" style="background:${t.bg}; color:${t.color};">${p._pctTechoKmLAMT.toFixed(0)}%</td>`;
      }
      if (col.key === 'contratista') {
        const texto = p.contratista != null ? p.contratista : '';
        return `<td class="td-truncate" title="${escapeHtml(texto)}">${escapeHtml(texto)}</td>`;
      }
      return `<td>${escapeHtml(p[col.key] != null ? p[col.key] : '')}</td>`;
    }).join('');
    const acciones = (puedeEditar || isAdmin) ? `<td class="row-actions">
        ${puedeEditar ? '<button class="icon-btn" data-action="editar" data-proy-id="' + p._id + '" title="Editar proyecto">✏️</button>' : ''}
        ${puedeEditar ? '<button class="icon-btn" data-action="clonar" data-proy-id="' + p._id + '" title="Clonar proyecto">🧬</button>' : ''}
        ${isAdmin ? '<button class="icon-btn danger" data-action="eliminar" data-proy-id="' + p._id + '" title="Eliminar proyecto">🗑️</button>' : ''}
      </td>` : '';
    return `<tr>${tds}<td class="td-truncate" title="${escapeHtml(p.descripcionProyecto || '')}">${escapeHtml(p.descripcionProyecto || '')}</td><td class="td-truncate" title="${escapeHtml(p.observaciones || '')}">${escapeHtml(p.observaciones || '')}</td>${acciones}</tr>`;
  }).join('') + '</tbody>';
  table.innerHTML = thead + tbody;
  setupScrollShadow(table.closest('.table-wrap'));
  wireSortableHeaders(table, proySort, renderProyTable);

  table.querySelectorAll('[data-proy-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const p = proyListaCache.find(x => x._id === btn.dataset.proyId);
      if (!p) return;
      const accion = btn.dataset.action;
      if (accion === 'editar') { editarProyecto(p); return; }
      if (accion === 'clonar') { await clonarProyecto(p); return; }
      if (accion === 'eliminar') {
        const confirmado = confirm('¿Eliminar este proyecto? El total del trámite se va a recalcular.');
        if (!confirmado) return;
        try {
          await apiCall('proyectos_eliminar', { id: p._id });
          const data = await apiCall('listar');
          state.registros = data.registros;
          await cargarProyectos();
        } catch (err) {
          alert('Error: ' + err.message);
        }
      }
    });
  });
}

// ============================================================
// MÓDULO DE COMPRAS (Equipos, Máquinas, Instrumentos, Materiales y Bienes)
// ------------------------------------------------------------
// Utilidades compartidas por el módulo de Compras (modelo plano de Trámites/Entregas, más abajo).
// La vista vieja en árbol (Expediente -> Pedido de Compra -> Posición) ya se retiró de acá: sus
// datos siguen intactos en las hojas "Compras - Expedientes/Pedidos (PC)/Posiciones" y en el
// backend (por si hace falta re-consultarlos), pero la pantalla y el CRUD del frontend se sacaron
// porque todo el trabajo diario ya pasa por la Vista Trámites de acá abajo.
// ============================================================
// Cada vez que Compras cambia algo que impacta su fila espejo en "Gestiones Plan" (alta/edición/
// eliminación de Expediente, PC o Posición, o una importación), refrescamos también los datos de
// Contrataciones en memoria y volvemos a pintar Registros/Dashboard si están a la vista — así el
// usuario ve la fila nueva/actualizada sin tener que recargar la página.
async function refrescarRegistrosTrasCompras() {
  try {
    const data = await apiCall('listar');
    state.registros = data.registros;
  } catch (err) {
    console.error('No se pudo refrescar Registros después del cambio en Compras:', err);
    return;
  }
  const vistaActual = document.querySelector('.nav-btn.active');
  const nombre = vistaActual && vistaActual.dataset.view;
  if (nombre === 'dashboard') renderDashboard();
  if (nombre === 'registros') renderRegistros();
}

// Genera un literal JS seguro para insertar dentro de un atributo onclick="..." (con comillas
// dobles). Usar JSON.stringify() ahí rompía el HTML porque agrega comillas dobles DENTRO de un
// atributo que ya está delimitado por comillas dobles.
function comprasJsArg(v) {
  if (v === null || v === undefined) return 'null';
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// ============================================================
// MÓDULO DE COMPRAS v2 — TRÁMITES (modelo plano) + ENTREGAS
// ------------------------------------------------------------
// Única pantalla del módulo Compras (la vista en árbol vieja ya se retiró — ver el comentario
// grande antes de refrescarRegistrosTrasCompras, más arriba).
// ============================================================
let comprasTramitesCache = [];
let comprasTramitesMeta = { estados: [], tiposEntrega: [], pctMaximoAmpliacion: 0.30 };
let comprasTramiteFormEditId = null; // id del trámite en edición, o null si es alta nueva
let comprasTramiteActiveStage = 'inicio';
let comprasEntregaFormEditId = null; // id de la entrega en edición, o null si es alta nueva
let comprasTramitesFiltros = { pospre: [], anio: [], expediente: '', nroPC: [], sucursal: [], estado: [] };
let comprasTramitesSort = { key: null, dir: 1 };

// ---- Click en una fila de Registros o del detalle "Todos" del Dashboard: si esa fila es en
//      realidad una fila espejo generada desde Compras, lleva directo a su ficha en el módulo
//      Compras en vez de abrir el editor de Contrataciones, porque esos datos se administran desde
//      ahí. Si es un trámite normal, sigue exactamente igual que siempre. ----
function abrirRegistroOCompras(rec) {
  if (rec._comprasTramiteId) { abrirComprasTramiteDesdeRegistro(rec._comprasTramiteId); return; }
  // _comprasExpedienteId: fila espejo del modelo viejo (árbol), ya sin pantalla propia a la que
  // llevar — se abre como un trámite cualquiera (de solo lectura en la práctica: nadie la va a
  // seguir editando desde acá). Se termina de limpiar cuando se corra _limpiarFilasEspejoComprasViejas.
  openRecordForEdit(rec);
}
async function abrirComprasTramiteDesdeRegistro(idTramite) {
  showView('compras');
  await cargarComprasTramites(); // nos aseguramos de tener los datos frescos antes de abrir el trámite puntual
  abrirComprasTramiteForm(idTramite);
}

async function abrirVistaCompras() {
  await cargarComprasTramites();
}

async function cargarComprasTramites() {
  try {
    const data = await apiCall('compras_tramites_listar');
    comprasTramitesCache = data.tramites || [];
    comprasTramitesMeta = {
      estados: data.estados || [],
      tiposEntrega: data.tiposEntrega || [],
      pctMaximoAmpliacion: data.pctMaximoAmpliacion || 0.30
    };
    populateComprasTramitesFilterOptions();
    renderComprasTramitesTable();
    const puedeEditar = state.session && state.session.rol !== 'consulta';
    const esAdmin = state.session && state.session.rol === 'admin';
    document.getElementById('comprasTramitesToolbar').hidden = !puedeEditar;
    document.getElementById('comprasMigrarBtn').hidden = !esAdmin;
  } catch (err) {
    showAppError('No se pudieron cargar los trámites de Compras: ' + err.message);
  }
}

// ---- Eventos para el Calendario de Vencimientos: una entrada por cada Entrega pendiente (con
//      Fecha Contractual cargada y sin Fecha Real todavía) de cualquier trámite — mismo criterio
//      y misma forma de objeto que usaba el árbol viejo, para no tener que tocar el renderizado
//      del calendario (ver renderCalendar/mostrarDetalleDia más arriba). ----
function comprasEntregasEventosParaCalendario() {
  const out = [];
  comprasTramitesCache.forEach(t => {
    (t.entregas || []).forEach(en => {
      if (en.fechaContractual && !en.entregado) {
        out.push({
          fecha: en.fechaContractual, tramo: en.tipo, expediente: t.expediente, nroPC: t.nroPC,
          posicion: '', matricula: t.matricula, adjudicatario: t.contratista, destino: t.sucursal
        });
      }
    });
  });
  return out;
}

// ---- Filtros ----
const COMPRAS_TRAMITES_FILTER_KEYS = ['pospre', 'anio', 'nroPC', 'sucursal', 'estado'];
function comprasTramitesUniqueValues(key) {
  const set = new Set();
  comprasTramitesCache.forEach(t => {
    const v = key === 'anio' ? t.anio : t[key];
    if (v) set.add(String(v).trim());
  });
  return Array.from(set).sort();
}
function populateComprasTramitesFilterOptions() {
  COMPRAS_TRAMITES_FILTER_KEYS.forEach(key => {
    const el = document.querySelector('#comprasTramitesFiltersBar [data-tfilter="' + key + '"]');
    if (!el) return;
    const opts = comprasTramitesUniqueValues(key);
    comprasTramitesFiltros[key] = (comprasTramitesFiltros[key] || []).filter(v => opts.includes(v));
    renderMultiselect(el, opts, comprasTramitesFiltros[key], (vals) => {
      comprasTramitesFiltros[key] = vals;
      renderComprasTramitesTable();
    });
  });
}
document.querySelector('#comprasTramitesFiltersBar [data-tfilter="expediente"]').addEventListener('input', debounce((e) => {
  comprasTramitesFiltros.expediente = e.target.value.trim();
  renderComprasTramitesTable();
}, 300));
document.getElementById('comprasTramitesClearFilters').addEventListener('click', () => {
  COMPRAS_TRAMITES_FILTER_KEYS.forEach(k => { comprasTramitesFiltros[k] = []; });
  comprasTramitesFiltros.expediente = '';
  const expEl = document.querySelector('#comprasTramitesFiltersBar [data-tfilter="expediente"]');
  if (expEl) expEl.value = '';
  populateComprasTramitesFilterOptions();
  renderComprasTramitesTable();
});
function comprasTramitesFiltrados() {
  const texto = (comprasTramitesFiltros.expediente || '').trim().toLowerCase();
  return comprasTramitesCache.filter(t => {
    if (comprasTramitesFiltros.pospre.length && !comprasTramitesFiltros.pospre.includes(String(t.pospre || '').trim())) return false;
    if (comprasTramitesFiltros.anio.length && !comprasTramitesFiltros.anio.includes(String(t.anio || ''))) return false;
    if (texto && !String(t.expediente || '').toLowerCase().includes(texto)) return false;
    if (comprasTramitesFiltros.nroPC.length && !comprasTramitesFiltros.nroPC.includes(String(t.nroPC || '').trim())) return false;
    if (comprasTramitesFiltros.sucursal.length && !comprasTramitesFiltros.sucursal.includes(String(t.sucursal || '').trim())) return false;
    if (comprasTramitesFiltros.estado.length && !comprasTramitesFiltros.estado.includes(String(t.estado || '').trim())) return false;
    return true;
  });
}

// ---- Tabla ----
const COMPRAS_TRAMITES_TABLE_COLS = [
  { key: 'pospre', label: 'Pospre' },
  { key: 'expediente', label: 'Expediente' },
  { key: 'anio', label: 'Año' },
  { key: 'extracto', label: 'Extracto' },
  { key: 'sucursal', label: 'Sucursal' },
  { key: 'matricula', label: 'Matrícula' },
  { key: 'cantidad', label: 'Cantidad' },
  { key: 'montoSubtotalOficial', label: '$ Subtotal Oficial' },
  { key: 'contratista', label: 'Contratista' },
  { key: 'nroPC', label: 'N° PC' },
  { key: 'montoSubtotalAdjudicado', label: '$ Subtotal Adjudicado' },
  { key: 'estado', label: 'Estado' },
  { key: 'cantidadPlanificadaDisponible', label: 'Planif. Disponible' }
];
const COMPRAS_TRAMITES_MONEY_KEYS = new Set(['montoSubtotalOficial', 'montoSubtotalAdjudicado']);
const COMPRAS_TRAMITES_NUMBER_KEYS = new Set(['anio', 'cantidad', 'cantidadPlanificadaDisponible']);
const COMPRAS_TRAMITES_ESTADO_CLASS = { 'Finalizado': 'row-finalizado', 'Desierto': 'row-desierto', 'Relanzado': 'row-relanzado' };

function comprasTramitesSortValue(t, key) { return t[key]; }

function renderComprasTramitesTable() {
  const table = document.getElementById('comprasTramitesTable');
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  const isAdmin = state.session && state.session.rol === 'admin';
  let filas = comprasTramitesFiltrados();
  const countEl = document.getElementById('comprasTramitesResultsCount');
  if (countEl) countEl.textContent = filas.length + ' trámite(s) encontrado(s), de ' + comprasTramitesCache.length + ' totales.';
  if (!comprasTramitesCache.length) {
    table.innerHTML = '<tbody><tr><td class="empty-state">Todavía no hay trámites cargados en este modelo nuevo. Usá "+ Nuevo Trámite" o "Migrar datos del Árbol".</td></tr></tbody>';
    return;
  }
  if (!filas.length) {
    table.innerHTML = '<tbody><tr><td class="empty-state">Ningún trámite coincide con los filtros aplicados.</td></tr></tbody>';
    return;
  }

  filas = sortRows(filas, comprasTramitesSort, comprasTramitesSortValue);

  const thead = sortableTheadHtml(COMPRAS_TRAMITES_TABLE_COLS, comprasTramitesSort, '<th>Acciones</th>');
  const tbody = '<tbody>' + filas.map(t => {
    const tds = COMPRAS_TRAMITES_TABLE_COLS.map(col => {
      const val = t[col.key];
      if (COMPRAS_TRAMITES_MONEY_KEYS.has(col.key)) return `<td class="mono">${formatMoney(val)}</td>`;
      if (COMPRAS_TRAMITES_NUMBER_KEYS.has(col.key)) return `<td class="mono">${val || val === 0 ? val : ''}</td>`;
      if (col.key === 'extracto') return `<td class="td-truncate" title="${escapeHtml(String(val || ''))}">${escapeHtml(String(val || ''))}</td>`;
      return `<td>${escapeHtml(String(val || ''))}</td>`;
    }).join('');
    const acciones = `<td class="row-actions">
        ${puedeEditar ? `<button class="icon-btn" title="Editar" onclick="abrirComprasTramiteForm(${comprasJsArg(t._id)})">✏️</button>` : ''}
        ${puedeEditar ? `<button class="icon-btn" title="Copiar" onclick="clonarComprasTramite(${comprasJsArg(t._id)})">📋</button>` : ''}
        ${isAdmin ? `<button class="icon-btn danger" title="Eliminar" onclick="eliminarComprasTramite(${comprasJsArg(t._id)})">🗑️</button>` : ''}
      </td>`;
    const claseFila = COMPRAS_TRAMITES_ESTADO_CLASS[t.estado] || '';
    return `<tr data-id="${t._id}" class="${claseFila}">${tds}${acciones}</tr>`;
  }).join('') + '</tbody>';

  table.innerHTML = thead + tbody;
  setupScrollShadow(table.closest('.table-wrap'), 'comprasTramitesScrollTop', 'comprasTramitesScrollTopInner');
  wireSortableHeaders(table, comprasTramitesSort, renderComprasTramitesTable);

  table.querySelectorAll('tbody tr[data-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.row-actions')) return; // los íconos de acción no vuelven a abrir el form
      if (!puedeEditar) return; // solo consulta: no se abre el formulario (aunque hoy no llegan a ver esta pestaña)
      abrirComprasTramiteForm(tr.dataset.id);
    });
  });
}

// ---- Formulario de Trámite: 2 etapas (Inicio / Adjudicación), mismo look que el "lifeline" de
//      Registros pero con su propia implementación — los campos y el ciclo de vida son distintos
//      (Obra Menor/Proyectos no aplican acá), así que no se reutiliza el mismo código, para no
//      arriesgar nada de Registros. ----
const COMPRAS_TRAMITE_ETAPAS = [
  { id: 'inicio', label: 'Inicio' },
  { id: 'adjudicacion', label: 'Adjudicación' }
];
const COMPRAS_TRAMITE_INICIO_FIELDS = [
  { key: 'pospre', label: 'Pospre', type: 'dynselect' },
  { key: 'expediente', label: 'Expediente', type: 'text', required: true },
  { key: 'anio', label: 'Año (de imputación del pago / Plan)', type: 'number' },
  { key: 'extracto', label: 'Extracto', type: 'text' },
  { key: 'sucursal', label: 'Sucursal / Destino', type: 'text' },
  { key: 'matricula', label: 'Matrícula N° (vacío = carga global)', type: 'text' },
  { key: 'detalleMat', label: 'Detalle de Matrícula', type: 'text' },
  { key: 'cantidad', label: 'Cantidad', type: 'number' },
  { key: 'montoUnitOficial', label: '$ Unitario Oficial (sin IVA)', type: 'number' },
  { key: 'montoSubtotalOficial', label: '$ Subtotal Oficial (sin IVA)', type: 'number', derived: true },
  { key: 'fechaApertura', label: 'Fecha de Apertura', type: 'date' },
  { key: 'cantidadPlanificada', label: 'Cantidad Planificada (tope)', type: 'number' },
  { key: 'plazoEntrega', label: 'Plazo de Entrega (días desde la Fecha de PC)', type: 'number' }
];
const COMPRAS_TRAMITE_ADJUDICACION_FIELDS = [
  { key: 'montoUnitAdjudicado', label: '$ Unitario Adjudicado (sin IVA)', type: 'number' },
  { key: 'montoSubtotalAdjudicado', label: '$ Subtotal Adjudicado (sin IVA)', type: 'number', derived: true },
  { key: 'contratista', label: 'Contratista / Oferente', type: 'text' },
  { key: 'nroPC', label: 'N° de Pedido de Compras', type: 'text' },
  { key: 'fechaPC', label: 'Fecha de PC', type: 'date' },
  { key: 'estado', label: 'Estado', type: 'select', options: ['', 'Adjudicado', 'Desierto', 'Relanzado', 'Finalizado'] },
  { key: 'observaciones', label: 'Observaciones', type: 'text' }
];
// ---- Pospre en "Nuevo Trámite": desplegable validado contra los Pospre ya cargados (en
//      Registros o en otros Trámites de Compras), con opción de agregar uno nuevo si hace falta
//      — mismo criterio que ya usa el resto de la app para este mismo campo. ----
function comprasTramitePospreOpciones() {
  const set = new Set(uniqueValues('pospre'));
  (comprasTramitesCache || []).forEach(t => { if (t.pospre) set.add(String(t.pospre).trim()); });
  return Array.from(set).sort();
}
function comprasTramiteCamposEtapa(etapaId) {
  return etapaId === 'inicio' ? COMPRAS_TRAMITE_INICIO_FIELDS : COMPRAS_TRAMITE_ADJUDICACION_FIELDS;
}
function comprasTramiteBuildFieldInput(f, record) {
  const value = record[f.key] != null ? record[f.key] : '';
  const readonlyAttr = f.derived ? 'readonly tabindex="-1"' : '';
  let inputHtml;
  if (f.type === 'dynselect') {
    const existentes = comprasTramitePospreOpciones();
    if (value && !existentes.includes(value)) existentes.unshift(value);
    const opts = ['<option value="">— Elegí un ' + escapeHtml(f.label) + ' existente —</option>'].concat(
      existentes.map(o => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`)
    ).concat(['<option value="' + DYNAMIC_SELECT_OTRO + '">+ Otro (nuevo)...</option>']);
    inputHtml = `<select data-key="${f.key}" class="dyn-select" data-dyn-key="${f.key}">${opts.join('')}</select>` +
      `<div class="dyn-otro-row" hidden>` +
        `<input type="text" placeholder="Escribí ${escapeHtml(f.label)} nuevo/a..." class="dyn-otro-input" />` +
        `<button type="button" class="dyn-otro-volver" title="Volver a elegir de la lista">↩ volver a la lista</button>` +
      `</div>`;
  } else if (f.type === 'select') {
    inputHtml = `<select data-key="${f.key}">${f.options.map(o => `<option value="${o}" ${value === o ? 'selected' : ''}>${o || '—'}</option>`).join('')}</select>`;
  } else if (f.type === 'date') {
    inputHtml = `<input type="date" data-key="${f.key}" value="${escapeHtml(value)}" />`;
  } else if (f.type === 'number') {
    inputHtml = `<input type="text" inputmode="decimal" class="num-decimal" data-key="${f.key}" value="${escapeHtml(value)}" ${readonlyAttr} />`;
  } else {
    inputHtml = `<input type="text" data-key="${f.key}" value="${escapeHtml(value)}" ${f.required ? 'required' : ''} />`;
  }
  const label = document.createElement('label');
  label.innerHTML = `<span class="field-label-text">${escapeHtml(f.label)}${f.derived ? ' <span class="calc-badge">calculado</span>' : ''}</span>${inputHtml}`;
  return label;
}
function comprasTramiteStageColorVar(idx) { return 'var(--stage-' + (idx + 1) + ')'; }

function buildComprasTramiteForm(record) {
  const lifeline = document.getElementById('comprasTramiteLifeline');
  const panelsWrap = document.getElementById('comprasTramiteStagePanels');
  lifeline.innerHTML = '';
  panelsWrap.innerHTML = '';

  COMPRAS_TRAMITE_ETAPAS.forEach((etapa, idx) => {
    const node = document.createElement('div');
    node.className = 'stage-node';
    node.style.setProperty('--stage-color', comprasTramiteStageColorVar(idx));
    node.dataset.stage = etapa.id;
    node.innerHTML = `<div class="stage-line"></div><div class="stage-dot"></div><div class="stage-label">${etapa.label}</div>`;
    node.addEventListener('click', () => setComprasTramiteActiveStage(etapa.id));
    lifeline.appendChild(node);

    const panel = document.createElement('div');
    panel.className = 'stage-panel';
    panel.id = 'compras-tramite-panel-' + etapa.id;
    panel.hidden = idx !== 0;

    const title = document.createElement('div');
    title.className = 'stage-panel-title';
    title.innerHTML = `<span class="dot" style="background:${comprasTramiteStageColorVar(idx)}"></span> ${etapa.label}`;
    panel.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'field-grid';
    comprasTramiteCamposEtapa(etapa.id).forEach(f => grid.appendChild(comprasTramiteBuildFieldInput(f, record)));
    panel.appendChild(grid);

    panelsWrap.appendChild(panel);
  });

  // Desplegable dinámico de Pospre: elegir "+ Otro (nuevo)" muestra el input de texto libre en
  // su lugar (mismo comportamiento que ya usa el resto de la app para este campo).
  const pospreSel = panelsWrap.querySelector('select[data-dyn-key="pospre"]');
  if (pospreSel) {
    const row = pospreSel.nextElementSibling;
    const otroInput = row.querySelector('.dyn-otro-input');
    const volverBtn = row.querySelector('.dyn-otro-volver');
    pospreSel.addEventListener('change', () => {
      if (pospreSel.value === DYNAMIC_SELECT_OTRO) {
        pospreSel.hidden = true;
        delete pospreSel.dataset.key;
        row.hidden = false;
        otroInput.dataset.key = 'pospre';
        otroInput.value = '';
        otroInput.focus();
      }
    });
    volverBtn.addEventListener('click', () => {
      row.hidden = true;
      delete otroInput.dataset.key;
      pospreSel.hidden = false;
      pospreSel.dataset.key = 'pospre';
      pospreSel.value = '';
    });
  }

  comprasTramiteActiveStage = COMPRAS_TRAMITE_ETAPAS[0].id;
  setComprasTramiteActiveStage(comprasTramiteActiveStage);
}
function setComprasTramiteActiveStage(stageId) {
  comprasTramiteActiveStage = stageId;
  document.getElementById('comprasTramiteLifeline').querySelectorAll('.stage-node').forEach(n => {
    n.classList.toggle('active', n.dataset.stage === stageId);
  });
  document.getElementById('comprasTramiteStagePanels').querySelectorAll('.stage-panel').forEach(p => {
    p.hidden = p.id !== 'compras-tramite-panel-' + stageId;
  });
}

// ---- $ Subtotal Oficial / $ Subtotal Adjudicado se calculan solos (Cantidad × $ Unitario) ----
// Mismo criterio "solo pisa si hay con qué calcular" que el resto de la app.
function getComprasTramiteFormValue(key) {
  const el = document.querySelector('#comprasTramiteStagePanels [data-key="' + key + '"]');
  return el ? el.value : '';
}
function setComprasTramiteFormValue(key, value) {
  const el = document.querySelector('#comprasTramiteStagePanels [data-key="' + key + '"]');
  if (el) el.value = value;
}
function comprasTramiteRecalcDerivedFields() {
  const cantidad = parseFloat(getComprasTramiteFormValue('cantidad')) || 0;
  const unitOficial = parseFloat(getComprasTramiteFormValue('montoUnitOficial')) || 0;
  if (cantidad && unitOficial) setComprasTramiteFormValue('montoSubtotalOficial', (cantidad * unitOficial).toFixed(2));
  const unitAdj = parseFloat(getComprasTramiteFormValue('montoUnitAdjudicado')) || 0;
  if (cantidad && unitAdj) setComprasTramiteFormValue('montoSubtotalAdjudicado', (cantidad * unitAdj).toFixed(2));
}
const COMPRAS_TRAMITE_RECALC_KEYS = new Set(['cantidad', 'montoUnitOficial', 'montoUnitAdjudicado']);
document.getElementById('comprasTramiteStagePanels').addEventListener('input', (e) => {
  const key = e.target.dataset.key;
  if (key && COMPRAS_TRAMITE_RECALC_KEYS.has(key)) comprasTramiteRecalcDerivedFields();
});

function abrirComprasTramiteForm(id) {
  comprasTramiteFormEditId = id || null;
  const record = id ? (comprasTramitesCache.find(t => t._id === id) || {}) : {};
  document.getElementById('comprasTramiteFormTitle').textContent = id ? 'Editar Trámite' : 'Nuevo Trámite';
  buildComprasTramiteForm(record);
  comprasTramiteRecalcDerivedFields();
  document.getElementById('comprasTramiteFormMsg').hidden = true;
  document.getElementById('comprasTramiteFormPanel').hidden = false;

  const entregasSection = document.getElementById('comprasEntregasSection');
  if (id) {
    entregasSection.hidden = false;
    renderComprasEntregasTable(record);
    buildComprasEntregaForm();
    renderComprasAmpliacionResumen(record);
  } else {
    entregasSection.hidden = true;
  }
  document.getElementById('comprasTramiteFormPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function cerrarComprasTramiteForm() {
  comprasTramiteFormEditId = null;
  comprasEntregaFormEditId = null;
  document.getElementById('comprasTramiteFormPanel').hidden = true;
}
document.getElementById('comprasTramiteFormCancelarBtn').addEventListener('click', cerrarComprasTramiteForm);

document.getElementById('comprasTramiteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('comprasTramiteFormMsg');
  const esNuevo = !comprasTramiteFormEditId;
  const datos = {};
  document.querySelectorAll('#comprasTramiteStagePanels [data-key]').forEach(el => { datos[el.dataset.key] = el.value; });
  try {
    if (comprasTramiteFormEditId) {
      await apiCall('compras_tramite_actualizar', { id: comprasTramiteFormEditId, datos });
    } else {
      const { id } = await apiCall('compras_tramite_crear', { datos });
      comprasTramiteFormEditId = id;
    }
    await cargarComprasTramites();
    await refrescarRegistrosTrasCompras();
    // Después de guardar por primera vez, dejamos el formulario abierto en modo edición (para
    // poder cargarle Entregas ya mismo) en vez de cerrarlo — igual criterio que Certificaciones,
    // que pide guardar el trámite primero antes de poder cargarle certificaciones. abrirComprasTramiteForm
    // reconstruye el form y oculta este mensaje, así que el aviso de éxito se muestra DESPUÉS de esa
    // llamada — si no, quedaba invisible y la pantalla parecía no haber hecho nada.
    abrirComprasTramiteForm(comprasTramiteFormEditId);
    msg.textContent = esNuevo ? 'Trámite creado correctamente.' : 'Trámite actualizado correctamente.';
    msg.className = 'form-msg ok';
    msg.hidden = false;
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-msg err';
    msg.hidden = false;
  }
});

async function clonarComprasTramite(id) {
  try {
    const { id: nuevoId } = await apiCall('compras_tramite_clonar', { id });
    await cargarComprasTramites();
    await refrescarRegistrosTrasCompras();
    abrirComprasTramiteForm(nuevoId);
  } catch (err) {
    alert('Error al copiar: ' + err.message);
  }
}
async function eliminarComprasTramite(id) {
  if (!confirm('¿Eliminar este trámite? Se van a borrar también sus Entregas, y su fila espejo en Registros.')) return;
  try {
    await apiCall('compras_tramite_eliminar', { id });
    await cargarComprasTramites();
    await refrescarRegistrosTrasCompras();
    if (comprasTramiteFormEditId === id) cerrarComprasTramiteForm();
  } catch (err) {
    alert('Error al eliminar: ' + err.message);
  }
}

// ---- Entregas (sub-lista del trámite abierto) ----
const COMPRAS_ENTREGA_FORM_FIELDS = [
  { key: 'tipo', label: 'Tipo', type: 'select', options: ['Oficial', 'Planificada', 'Ampliación'], required: true },
  { key: 'cantidad', label: 'Cantidad de esta entrega', type: 'number' },
  { key: 'monto', label: '$ de esta entrega (sin IVA)', type: 'number' },
  { key: 'plazo', label: 'Plazo (días desde Fecha de PC)', type: 'number' },
  { key: 'fechaContractual', label: 'Fecha Contractual', type: 'date' },
  { key: 'fechaReal', label: 'Fecha Real de Entrega', type: 'date' },
  { key: 'observaciones', label: 'Observaciones', type: 'text' }
];
function comprasEntregaBuildFieldInput(f, record) {
  const value = (record && record[f.key] != null) ? record[f.key] : '';
  let inputHtml;
  if (f.type === 'select') {
    inputHtml = `<select data-key="${f.key}">${f.options.map(o => `<option value="${o}" ${value === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  } else if (f.type === 'date') {
    inputHtml = `<input type="date" data-key="${f.key}" value="${escapeHtml(value)}" />`;
  } else if (f.type === 'number') {
    inputHtml = `<input type="text" inputmode="decimal" class="num-decimal" data-key="${f.key}" value="${escapeHtml(value)}" />`;
  } else {
    inputHtml = `<input type="text" data-key="${f.key}" value="${escapeHtml(value)}" ${f.required ? 'required' : ''} />`;
  }
  const label = document.createElement('label');
  label.innerHTML = `<span class="field-label-text">${escapeHtml(f.label)}</span>${inputHtml}`;
  return label;
}
function buildComprasEntregaForm(record) {
  const cont = document.getElementById('comprasEntregaFormFields');
  cont.innerHTML = '';
  COMPRAS_ENTREGA_FORM_FIELDS.forEach(f => cont.appendChild(comprasEntregaBuildFieldInput(f, record || {})));
  document.getElementById('comprasEntregaFormCancelarBtn').hidden = !record;
  document.querySelector('#comprasEntregaForm button[type="submit"]').textContent = record ? 'Guardar cambios' : '+ Agregar Entrega';
  // En una Entrega nueva (no edición), el Plazo arranca con el "Plazo de Entrega" que ya se haya
  // declarado en el Inicio del trámite — se puede pisar a mano si esta Entrega puntual necesita
  // otro plazo distinto. En una edición no se toca: se respeta lo que esa Entrega ya tenía cargado.
  if (!record) {
    const tramite = comprasTramitesCache.find(t => t._id === comprasTramiteFormEditId);
    if (tramite && tramite.plazoEntrega) setComprasEntregaFormValue('plazo', tramite.plazoEntrega);
  }
  comprasEntregaRecalcMonto();
}
function getComprasEntregaFormValue(key) {
  const el = document.querySelector('#comprasEntregaFormFields [data-key="' + key + '"]');
  return el ? el.value : '';
}
function setComprasEntregaFormValue(key, value) {
  const el = document.querySelector('#comprasEntregaFormFields [data-key="' + key + '"]');
  if (el) el.value = value;
}
// $ de esta entrega se autocompleta (Cantidad × $ Unitario Adjudicado, o el Oficial si todavía no
// hay Adjudicado cargado) y la Fecha Contractual (Fecha de PC + Plazo) — el usuario puede ajustar
// ambas a mano después, no quedan bloqueadas.
function comprasEntregaRecalcMonto() {
  if (!comprasTramiteFormEditId) return;
  const tramite = comprasTramitesCache.find(t => t._id === comprasTramiteFormEditId);
  if (!tramite) return;
  const cantidad = parseFloat(getComprasEntregaFormValue('cantidad')) || 0;
  const unitario = parseFloat(tramite.montoUnitAdjudicado) || parseFloat(tramite.montoUnitOficial) || 0;
  if (cantidad && unitario) setComprasEntregaFormValue('monto', (cantidad * unitario).toFixed(2));
  const plazo = parseInt(getComprasEntregaFormValue('plazo'));
  if (tramite.fechaPC && plazo) setComprasEntregaFormValue('fechaContractual', addDays(tramite.fechaPC, plazo));
}
document.getElementById('comprasEntregaFormFields').addEventListener('input', (e) => {
  const key = e.target.dataset.key;
  if (key === 'cantidad' || key === 'plazo') comprasEntregaRecalcMonto();
});

const COMPRAS_ENTREGAS_TABLE_COLS = [
  { key: 'tipo', label: 'Tipo' },
  { key: 'cantidad', label: 'Cantidad' },
  { key: 'monto', label: '$ Monto' },
  { key: 'fechaContractual', label: 'F. Contractual' },
  { key: 'fechaReal', label: 'F. Real' },
  { key: 'observaciones', label: 'Observaciones' }
];
function renderComprasEntregasTable(tramite) {
  const table = document.getElementById('comprasEntregasTable');
  const entregas = tramite.entregas || [];
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  if (!entregas.length) {
    table.innerHTML = '<thead><tr>' + COMPRAS_ENTREGAS_TABLE_COLS.map(c => `<th>${c.label}</th>`).join('') + '<th>Estado</th><th>Acciones</th></tr></thead>' +
      '<tbody><tr><td class="empty-state" colspan="8">Todavía no hay entregas cargadas para este trámite.</td></tr></tbody>';
    return;
  }
  const thead = '<thead><tr>' + COMPRAS_ENTREGAS_TABLE_COLS.map(c => `<th>${c.label}</th>`).join('') + '<th>Estado</th><th>Acciones</th></tr></thead>';
  const tbody = '<tbody>' + entregas.map(en => {
    const tds = COMPRAS_ENTREGAS_TABLE_COLS.map(col => {
      const val = en[col.key];
      if (col.key === 'monto') return `<td class="mono">${formatMoney(val)}</td>`;
      if (col.key === 'cantidad') return `<td class="mono">${val || ''}</td>`;
      if (col.key === 'fechaContractual' || col.key === 'fechaReal') return `<td>${val ? formatFechaCorta(val) : ''}</td>`;
      return `<td>${escapeHtml(String(val || ''))}</td>`;
    }).join('');
    let estadoTxt = '—';
    if (en.entregado) estadoTxt = '<span class="cal-badge entregado">Entregada</span>';
    else if (en.vencida) estadoTxt = `<span class="cal-badge vencido">Vencida (${en.desvio}d)</span>`;
    else if (en.fechaContractual) estadoTxt = '<span class="cal-badge lejano">Pendiente</span>';
    const acciones = puedeEditar ? `<td class="row-actions">
        <button class="icon-btn" title="Editar" onclick="editarComprasEntrega(${comprasJsArg(en._id)})">✏️</button>
        <button class="icon-btn danger" title="Eliminar" onclick="eliminarComprasEntrega(${comprasJsArg(en._id)})">🗑️</button>
      </td>` : '<td></td>';
    return `<tr>${tds}<td>${estadoTxt}</td>${acciones}</tr>`;
  }).join('') + '</tbody>';
  table.innerHTML = thead + tbody;
}
function editarComprasEntrega(id) {
  const tramite = comprasTramitesCache.find(t => t._id === comprasTramiteFormEditId);
  if (!tramite) return;
  const entrega = (tramite.entregas || []).find(e => e._id === id);
  if (!entrega) return;
  comprasEntregaFormEditId = id;
  buildComprasEntregaForm(entrega);
  document.getElementById('comprasEntregaForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
document.getElementById('comprasEntregaFormCancelarBtn').addEventListener('click', () => {
  comprasEntregaFormEditId = null;
  buildComprasEntregaForm();
});
document.getElementById('comprasEntregaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('comprasEntregaFormMsg');
  const esNuevo = !comprasEntregaFormEditId;
  const datos = {};
  document.querySelectorAll('#comprasEntregaFormFields [data-key]').forEach(el => { datos[el.dataset.key] = el.value; });
  try {
    if (comprasEntregaFormEditId) {
      await apiCall('compras_entrega_actualizar', { id: comprasEntregaFormEditId, datos });
    } else {
      datos.idTramite = comprasTramiteFormEditId;
      await apiCall('compras_entrega_crear', { datos });
    }
    comprasEntregaFormEditId = null;
    await cargarComprasTramites();
    const tramite = comprasTramitesCache.find(t => t._id === comprasTramiteFormEditId) || {};
    renderComprasEntregasTable(tramite);
    renderComprasAmpliacionResumen(tramite);
    buildComprasEntregaForm();
    msg.textContent = esNuevo ? 'Entrega guardada correctamente.' : 'Entrega actualizada correctamente.';
    msg.className = 'form-msg ok';
    msg.hidden = false;
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-msg err';
    msg.hidden = false;
  }
});
async function eliminarComprasEntrega(id) {
  if (!confirm('¿Eliminar esta entrega?')) return;
  try {
    await apiCall('compras_entrega_eliminar', { id });
    await cargarComprasTramites();
    const tramite = comprasTramitesCache.find(t => t._id === comprasTramiteFormEditId) || {};
    renderComprasEntregasTable(tramite);
    renderComprasAmpliacionResumen(tramite);
  } catch (err) {
    alert('Error al eliminar: ' + err.message);
  }
}

// ---- Resumen de saldos: Cantidad Planificada (por trámite) + Ampliación (agrupado por PC) ----
function renderComprasAmpliacionResumen(tramite) {
  const cont = document.getElementById('comprasAmpliacionResumen');
  const partes = [];
  const cantPlan = parseFloat(tramite.cantidadPlanificada) || 0;
  if (cantPlan) {
    partes.push(`<p><strong>Cantidad Planificada</strong> — Declarada: ${cantPlan} · Gestionada: ${tramite.cantidadPlanificadaGestionada || 0} · Disponible: ${tramite.cantidadPlanificadaDisponible}</p>`);
  }
  if (tramite.nroPC) {
    partes.push(`<p><strong>Ampliación de este PC (${escapeHtml(tramite.nroPC)})</strong> — Base: ${formatMoney(tramite.ampliacionBasePC)} · Tope (${(comprasTramitesMeta.pctMaximoAmpliacion * 100).toFixed(0)}%): ${formatMoney(tramite.ampliacionTopePC)} · Gestionado: ${formatMoney(tramite.ampliacionGestionadoPC)} · Disponible: ${formatMoney(tramite.ampliacionDisponiblePC)}</p>`);
  }
  if (!partes.length) { cont.hidden = true; return; }
  cont.innerHTML = partes.join('');
  cont.hidden = false;
}

// ---- Exportar / Importar CSV ----
// Usa la misma librería XLSX (SheetJS) ya cargada para el Excel del modelo viejo: escribe/lee CSV
// por extensión de archivo, sin agregar ninguna dependencia nueva.
document.getElementById('comprasTramitesExportBtn').addEventListener('click', () => {
  if (!comprasTramitesCache.length) { alert('No hay trámites para exportar.'); return; }
  const filas = comprasTramitesCache.map(t => ({
    'Pospre': t.pospre, 'Expediente': t.expediente, 'Año': t.anio, 'Extracto': t.extracto,
    'Sucursal / Destino': t.sucursal, 'Matrícula N°': t.matricula, 'Detalle de Matrícula': t.detalleMat,
    'Cantidad': t.cantidad, '$ Unitario Oficial': t.montoUnitOficial, '$ Subtotal Oficial': t.montoSubtotalOficial,
    'Fecha de Apertura': t.fechaApertura, 'Cantidad Planificada (tope)': t.cantidadPlanificada,
    'Plazo de Entrega (días desde Fecha de PC)': t.plazoEntrega,
    'Cantidad Planificada Gestionada': t.cantidadPlanificadaGestionada, 'Cantidad Planificada Disponible': t.cantidadPlanificadaDisponible,
    '$ Unitario Adjudicado': t.montoUnitAdjudicado, '$ Subtotal Adjudicado': t.montoSubtotalAdjudicado,
    'Contratista / Oferente': t.contratista, 'N° de Pedido de Compras': t.nroPC, 'Fecha de PC': t.fechaPC,
    'Estado': t.estado, 'Observaciones': t.observaciones
  }));
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Trámites');
  XLSX.writeFile(wb, 'compras_tramites_export.csv');
});

// La importación por CSV SIEMPRE crea trámites nuevos (no actualiza existentes por N° de fila ni
// por ningún otro cruce) — a diferencia del importador de Excel del modelo viejo. Es la opción más
// simple y más segura para arrancar; si hace falta actualizar en masa, se puede sumar más adelante.
document.getElementById('comprasTramitesImportFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = document.getElementById('comprasTramitesImportMsg');
  msg.hidden = false;
  msg.className = 'table-note';
  msg.textContent = 'Leyendo archivo...';
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const mapaColumnas = {
      'Pospre': 'pospre', 'Expediente': 'expediente', 'Año': 'anio', 'Extracto': 'extracto',
      'Sucursal / Destino': 'sucursal', 'Matrícula N°': 'matricula', 'Detalle de Matrícula': 'detalleMat',
      'Cantidad': 'cantidad', '$ Unitario Oficial': 'montoUnitOficial', '$ Subtotal Oficial': 'montoSubtotalOficial',
      'Fecha de Apertura': 'fechaApertura', 'Cantidad Planificada (tope)': 'cantidadPlanificada',
      'Plazo de Entrega (días desde Fecha de PC)': 'plazoEntrega',
      '$ Unitario Adjudicado': 'montoUnitAdjudicado', '$ Subtotal Adjudicado': 'montoSubtotalAdjudicado',
      'Contratista / Oferente': 'contratista', 'N° de Pedido de Compras': 'nroPC', 'Fecha de PC': 'fechaPC',
      'Estado': 'estado', 'Observaciones': 'observaciones'
    };
    let creados = 0;
    for (const fila of filas) {
      const datos = {};
      Object.keys(mapaColumnas).forEach(col => {
        if (fila[col] !== undefined && fila[col] !== '') datos[mapaColumnas[col]] = fila[col];
      });
      if (!datos.expediente) continue; // fila sin expediente: se omite
      await apiCall('compras_tramite_crear', { datos });
      creados++;
    }
    msg.className = 'table-note';
    msg.textContent = `Listo — se crearon ${creados} trámite(s) nuevo(s) a partir del CSV.`;
    await cargarComprasTramites();
    await refrescarRegistrosTrasCompras();
  } catch (err) {
    msg.className = 'table-note';
    msg.textContent = 'Error al importar: ' + err.message;
  }
  document.getElementById('comprasTramitesImportFile').value = '';
});

// ---- Migración desde el modelo viejo (Árbol) — aditiva, se puede correr más de una vez ----
document.getElementById('comprasMigrarBtn').addEventListener('click', async () => {
  if (!confirm('Esto va a leer todo lo cargado en la Vista Árbol y crear los Trámites equivalentes en este modelo nuevo. No borra ni modifica nada de la Vista Árbol, y se puede correr más de una vez sin duplicar. ¿Continuar?')) return;
  const msg = document.getElementById('comprasMigrarMsg');
  msg.hidden = false;
  msg.textContent = 'Migrando...';
  try {
    const data = await apiCall('compras_migrar_a_tramites');
    const r = data.resultado;
    msg.textContent = `Listo — ${r.tramitesCreados} trámite(s) nuevo(s) creados, ${r.tramitesYaMigrados} ya estaban migrados (se saltearon), ${r.entregasCreadas} entrega(s) generadas.`;
    await cargarComprasTramites();
    await refrescarRegistrosTrasCompras();
  } catch (err) {
    msg.textContent = 'Error al migrar: ' + err.message;
  }
});

