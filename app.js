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

const FILTER_KEYS = ['pospre','expediente','anio','nroPedidoCompras','adjudicatario','sucursal','rubro','estado'];

// ---- Estado en memoria ----
const state = {
  session: null,      // { usuario, nombre, rol, clave }
  campos: [],
  etapas: [],
  registros: [],
  filtros: {},
  dashFiltros: { fechaPCDesde: '', fechaPCHasta: '', pctAvanceDesde: '', pctAvanceHasta: '', texto: '', textoModo: 'contiene' },
  riesgoPlazoActivo: false,
  editingId: null,
  activeStage: null,
  registrosSort: { key: null, dir: 1 },     // ordenamiento de la tabla de Registros
  dashSort: { key: null, dir: -1 },         // ordenamiento de la tabla de detalle del Dashboard (agrupada)
  dashDetalleSort: { key: null, dir: 1 }    // ordenamiento de la tabla de detalle del Dashboard (modo "Todos")
};

const DASH_FILTER_KEYS = ['anio','sucursal','rubro','pospre','nroPedidoCompras','adjudicatario','estado'];

// ============================================================
// API
// ============================================================
async function apiCall(action, payload) {
  const body = Object.assign({ action }, payload || {});
  if (state.session) {
    body.usuario = state.session.usuario;
    body.clave = state.session.clave;
  }
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
  // Los usuarios "Solo consulta" no pueden exportar a Excel/CSV ni imprimir a PDF, en ningún
  // módulo (Registros, Certificaciones, Proyectos, Compras y el Dashboard).
  const puedeExportar = state.session.rol !== 'consulta';
  ['exportBtn', 'certExportBtn', 'proyExportBtn', 'comprasExportBtn', 'printDashboardBtn', 'dashDetalleExportBtn'].forEach(id => {
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
    await cargarComprasDatos();
  } catch (err) {
    console.error('No se pudieron precargar las compras para el Dashboard:', err);
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
    && !(ultimaVista === 'formulario' && !puedeEditar);
  showView(vistaPermitida ? ultimaVista : 'dashboard');
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

    const grid = document.createElement('div');
    grid.className = 'field-grid';
    // Cada etapa puede tener uno o varios rangos de columnas (por ejemplo, "Certificación" agrupa
    // los campos de Ejecución y los de Certificación propiamente dicha, aunque no son columnas contiguas).
    let camposEtapa = (etapa.ranges || [[etapa.from, etapa.to]])
      .reduce((acc, [from, to]) => acc.concat(state.campos.filter(f => f.col >= from && f.col <= to)), []);
    // El $ Km de LAMT y su Mes/Año de cálculo viven físicamente en las columnas de "Proyectos" (cols 27-28),
    // pero conceptualmente son un dato de Ejecución del contrato: se definen una sola vez y valen para
    // todos los proyectos de ese Pedido de Compras. Por eso se muestran en el panel de Certificación
    // (editables, como cualquier otro campo) y se sacan del panel de Proyectos, que solo aplica a Obra Menor.
    if (etapa.id === 'proyectos') camposEtapa = camposEtapa.filter(f => f.key !== 'kmLineaPC' && f.key !== 'mmAAkmLAMT');
    if (etapa.id === 'certificacion' && isOM) {
      const kmLineaPCField = fieldByKey('kmLineaPC');
      const mmAAkmLAMTField = fieldByKey('mmAAkmLAMT');
      if (kmLineaPCField) camposEtapa = camposEtapa.concat([kmLineaPCField]);
      if (mmAAkmLAMTField) camposEtapa = camposEtapa.concat([mmAAkmLAMTField]);
    }
    camposEtapa.forEach(f => {
      grid.appendChild(buildFieldInput(f, record));
    });
    panel.appendChild(grid);

    if (etapa.id === 'certificacion' && isOM) {
      const notaKm = document.createElement('div');
      notaKm.className = 'cert-nota';
      notaKm.innerHTML = `<p>El <strong>$ Km de LAMT</strong> y su <strong>Mes/Año de cálculo</strong> se cargan una sola vez acá y aplican automáticamente a todos los proyectos de este Pedido de Compras (Obra Menor) — no hace falta volver a cargarlos en cada proyecto.</p>`;
      panel.appendChild(notaKm);
    }

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

  const presOficial = cantidad * presUnit;
  const totalAdj = cantidad * adjUnit;
  setFormValue('presupuestoOficialRubro', presOficial ? presOficial.toFixed(2) : '');
  setFormValue('totalAdjudicado', totalAdj ? totalAdj.toFixed(2) : '');

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
  label.innerHTML = `${f.label}${isDerived ? ' <span class="calc-badge">calculado</span>' : ''}${isSumHelper ? ' <span class="calc-badge sum-badge">acumulable</span>' : ''}${inputHtml}${sumHelperHtml}`;
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
function uniqueValues(key) {
  const set = new Set();
  state.registros.forEach(r => { if (r[key]) set.add(String(r[key]).trim()); });
  return Array.from(set).sort();
}

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

function populateFilterOptions() {
  FILTER_KEYS.filter(k => k !== 'expediente').forEach(key => {
    const el = document.querySelector('#filtersBar [data-filter="' + key + '"]');
    if (!el) return;
    const opts = uniqueValues(key);
    if (key === 'estado') opts.push(ESTADO_VACIO_LABEL);
    state.filtros[key] = (state.filtros[key] || []).filter(v => opts.includes(v));
    renderMultiselect(el, opts, state.filtros[key], (vals) => {
      state.filtros[key] = vals;
      renderRegistros();
    });
  });

  DASH_FILTER_KEYS.forEach(key => {
    const el = document.querySelector('#dashFiltersBar [data-dashfilter="' + key + '"]');
    if (!el) return;
    const opts = uniqueValues(key);
    if (key === 'estado') opts.push(ESTADO_VACIO_LABEL);
    state.dashFiltros[key] = (state.dashFiltros[key] || []).filter(v => opts.includes(v));
    renderMultiselect(el, opts, state.dashFiltros[key], (vals) => {
      state.dashFiltros[key] = vals;
      renderDashboard();
    });
  });
}

document.querySelector('#filtersBar [data-filter="expediente"]').addEventListener('input', (e) => {
  state.filtros.expediente = e.target.value.trim();
  renderRegistros();
});
document.getElementById('clearFilters').addEventListener('click', () => {
  FILTER_KEYS.forEach(k => { state.filtros[k] = (k === 'expediente') ? '' : []; });
  const expEl = document.querySelector('#filtersBar [data-filter="expediente"]');
  if (expEl) expEl.value = '';
  populateFilterOptions();
  renderRegistros();
});

document.getElementById('dashClearFilters').addEventListener('click', () => {
  DASH_FILTER_KEYS.forEach(k => { state.dashFiltros[k] = []; });
  state.dashFiltros.fechaPCDesde = '';
  state.dashFiltros.fechaPCHasta = '';
  state.dashFiltros.pctAvanceDesde = '';
  state.dashFiltros.pctAvanceHasta = '';
  state.dashFiltros.texto = '';
  state.dashFiltros.textoModo = 'contiene';
  document.getElementById('dashFechaPCDesde').value = '';
  document.getElementById('dashFechaPCHasta').value = '';
  document.getElementById('dashPctAvanceDesde').value = '';
  document.getElementById('dashPctAvanceHasta').value = '';
  document.getElementById('dashTextoBuscar').value = '';
  document.getElementById('dashTextoModo').value = 'contiene';
  state.riesgoPlazoActivo = false;
  document.getElementById('riesgoPlazoBtn').classList.remove('active');
  populateFilterOptions();
  renderDashboard();
});

document.getElementById('dashFechaPCDesde').addEventListener('change', (e) => {
  state.dashFiltros.fechaPCDesde = e.target.value;
  renderDashboard();
});
document.getElementById('dashFechaPCHasta').addEventListener('change', (e) => {
  state.dashFiltros.fechaPCHasta = e.target.value;
  renderDashboard();
});
document.getElementById('dashPctAvanceDesde').addEventListener('input', (e) => {
  state.dashFiltros.pctAvanceDesde = e.target.value;
  renderDashboard();
});
document.getElementById('dashPctAvanceHasta').addEventListener('input', (e) => {
  state.dashFiltros.pctAvanceHasta = e.target.value;
  renderDashboard();
});
document.getElementById('dashTextoBuscar').addEventListener('input', (e) => {
  state.dashFiltros.texto = e.target.value;
  renderDashboard();
});
document.getElementById('dashTextoModo').addEventListener('change', (e) => {
  state.dashFiltros.textoModo = e.target.value;
  renderDashboard();
});
document.getElementById('riesgoPlazoBtn').addEventListener('click', () => {
  state.riesgoPlazoActivo = !state.riesgoPlazoActivo;
  document.getElementById('riesgoPlazoBtn').classList.toggle('active', state.riesgoPlazoActivo);
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
  // Compras: cada tramo (Fija/Planificada/Ampliación) todavía pendiente de entrega figura en el
  // calendario en su Fecha de Entrega por Contrato, esté vencida o no (igual que Contrataciones).
  comprasEventosParaCalendario().forEach(ev => {
    if (!porDia[ev.fecha]) porDia[ev.fecha] = [];
    porDia[ev.fecha].push({ _tipo: 'compra', rec: ev });
  });

  // Si hay vencimientos de Compras cargados pero ninguno cae en el mes que se está mirando,
  // lo avisamos: así se distingue "están en otro mes" de "no se cargaron / no aparecen".
  const hintEl = document.getElementById('calComprasHint');
  if (hintEl) {
    const todasLasFechasCompras = comprasEventosParaCalendario().map(ev => ev.fecha).sort();
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

// ---- Campos de texto sobre los que busca el filtro "Contiene / No contiene" del Dashboard ----
const DASH_TEXTO_CAMPOS = [
  'pospre', 'expediente', 'sucursal', 'rubro', 'detalleRubro', 'nroPedidoCompras',
  'adjudicatario', 'estado', 'agenciaSector', 'observaciones'
];

function filteredForDashboardBase() {
  let rows = applyFilters(state.registros, state.dashFiltros, DASH_FILTER_KEYS);
  const desde = state.dashFiltros.fechaPCDesde;
  const hasta = state.dashFiltros.fechaPCHasta;
  if (desde || hasta) {
    rows = rows.filter(r => {
      const v = r.fechaPedidoCompras;
      if (!v) return false;
      if (desde && v < desde) return false;
      if (hasta && v > hasta) return false;
      return true;
    });
  }

  const pctDesde = state.dashFiltros.pctAvanceDesde;
  const pctHasta = state.dashFiltros.pctAvanceHasta;
  if ((pctDesde !== '' && pctDesde != null) || (pctHasta !== '' && pctHasta != null)) {
    rows = rows.filter(r => {
      const pct = pctAvanceTramite(r);
      if (pctDesde !== '' && pctDesde != null && pct < parseFloat(pctDesde)) return false;
      if (pctHasta !== '' && pctHasta != null && pct > parseFloat(pctHasta)) return false;
      return true;
    });
  }

  const texto = (state.dashFiltros.texto || '').trim().toLowerCase();
  if (texto) {
    const modo = state.dashFiltros.textoModo || 'contiene';
    rows = rows.filter(r => {
      const contiene = DASH_TEXTO_CAMPOS.some(k => String(r[k] || '').toLowerCase().includes(texto));
      return modo === 'no_contiene' ? !contiene : contiene;
    });
  }

  return rows;
}

function filteredForDashboard() {
  const rows = filteredForDashboardBase();
  return state.riesgoPlazoActivo ? rows.filter(esRiesgoPorPlazo) : rows;
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

function filteredRecords() {
  return applyFilters(state.registros, state.filtros, FILTER_KEYS);
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
function registroTdsHtml(r, cols) {
  return (cols || REGISTROS_COLS).map(c => {
    if (c.key === 'estado') {
      const cls = r.estado && ['Adjudicado','Desierto','Relanzado','Finalizado'].includes(r.estado) ? 'state-' + r.estado : 'state-default';
      const texto = r.estado ? r.estado : ESTADO_VACIO_LABEL;
      return `<td><span class="state-pill ${cls}">${escapeHtml(texto)}</span></td>`;
    }
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
  return '';
}

function renderRegistros() {
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
  setupScrollShadow(table.closest('.table-wrap'));
  wireSortableHeaders(table, state.registrosSort, renderRegistros);

  table.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.row-actions')) return; // los botones de acción no abren el formulario
      if (!puedeEditar) return; // solo consulta: no se abre el formulario de edición
      const rec = state.registros.find(r => r._id === tr.dataset.id);
      if (rec) openRecordForEdit(rec);
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
//      y sincroniza la barra de scroll duplicada de arriba con la tabla de abajo ----
function setupScrollShadow(wrap) {
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

  // Barra superior duplicada (solo aplica a la tabla de Registros, que es la que puede ser muy ancha)
  const topBar = document.getElementById('recordsScrollTop');
  const topInner = document.getElementById('recordsScrollTopInner');
  if (topBar && topInner && wrap.querySelector('#recordsTable')) {
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
  const groupKey = document.getElementById('dashGroupBy').value;
  const rows = filteredForDashboard();

  // ---- Badge de "Riesgo por Plazo": cuenta sobre el resto de los filtros, sin aplicar el toggle de riesgo ----
  const riesgoCount = filteredForDashboardBase().filter(esRiesgoPorPlazo).length;
  document.getElementById('riesgoPlazoBadge').textContent = riesgoCount;

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
  // se guarda ahí), se cruza en vivo con las certificaciones ya cargadas en la otra pestaña. La
  // "Erogación total real" suma esto al Certificado por AAD, para reflejar todo lo efectivamente
  // reconocido/pagado (certificado + reconocimientos), no solo el monto certificado base.
  const idsFiltrados = new Set(rows.map(r => r._id));
  const totalReconocimiento = (certListaCache || [])
    .filter(c => idsFiltrados.has(c.idTramite))
    .reduce((acc, c) => acc + num(c.montoReconocimiento), 0);
  const erogacionTotalReal = totalCertificado + totalReconocimiento;

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

  const kpiRow = document.getElementById('kpiRow');
  kpiRow.innerHTML = [
    kpiCard('Trámites (filtro actual)', rows.length, 'de ' + state.registros.length + ' totales'),
    kpiCard('Presupuesto oficial total', formatMillions(totalPresOficial), 'sin IVA'),
    kpiCard('Total adjudicado', formatMillions(totalAdjudicado), 'sin IVA'),
    kpiCard('Certificado por AAD', formatMillions(totalCertificado), 'sin IVA'),
    kpiCard('% Ejecución', pctEjecucion.toFixed(1) + '%', 'certificado / adjudicado'),
    kpiCard('Desvío presupuestario', (desvioPresupuestario >= 0 ? '+' : '') + desvioPresupuestario.toFixed(1) + '%', desvioPresupuestario >= 0 ? 'por encima del oficial' : 'por debajo del oficial'),
    kpiCard('Multas acumuladas', formatMillions(totalMultas), 'sin IVA'),
    kpiCard('$ Reconocimiento acumulado', formatMillions(totalReconocimiento), 'suma de certificaciones cargadas'),
    kpiCard('Erogación total real', formatMillions(erogacionTotalReal), 'Certificado por AAD + Reconocimiento'),
    kpiCard('Desiertos / Adjudicados', cantDesiertos + ' / ' + cantAdjudicados, totalDesAdj > 0 ? pctDesiertos.toFixed(1) + '% de los procesos definidos salieron desiertos' : 'sin procesos definidos en este filtro'),
    kpiCard('IIBB Proyectados (Obra Menor)', sumaIIBBProyectados.toLocaleString('es-AR', { maximumFractionDigits: 2 }), rowsObraMenor.length + ' trámite(s) de Obra Menor en este filtro'),
    kpiCard('% IIBB Proyectados / Gestionados', pctIIBBProyectadoGeneral.toFixed(1) + '%', 'sobre ' + sumaIIBBGestionadosOM.toLocaleString('es-AR', { maximumFractionDigits: 2 }) + ' IIBB gestionados (Obra Menor)'),
  ].join('');


  // ---- Datos por Sucursal (Presupuesto Oficial / Adjudicado / Certificado) ----
  // Se sigue calculando acá porque lo usa el gráfico de abajo ("Adjudicado vs. Certificado por
  // Sucursal — con % de Avance"), aunque el gráfico de barras de las 3 series juntas ya no se muestra.
  const bySucursal = {};
  rows.forEach(r => {
    const key = (r.sucursal || '(sin sucursal)').toString().trim() || '(sin sucursal)';
    if (!bySucursal[key]) bySucursal[key] = { presOficial:0, adjudicado:0, certificado:0 };
    bySucursal[key].presOficial += num(r.presupuestoOficialRubro);
    bySucursal[key].adjudicado += num(r.totalAdjudicado);
    bySucursal[key].certificado += num(r.certificadosAAD);
  });
  const sucursalEntries = Object.entries(bySucursal).sort((a,b) => b[1].presOficial - a[1].presOficial);

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
      labels: sucursalEntries.map(e => e[0]),
      datasets: [
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
        x:{ ticks:{ autoSkip:false, maxRotation:60, minRotation:30 } },
        y:{ beginAtZero:true, title:{ display:true, text:'Millones de $' } },
        y1:{ beginAtZero:true, max:EJE_MAX, position:'right', grid:{ drawOnChartArea:false }, title:{ display:true, text:'% Avance' } }
      },
      plugins:{ legend:{ position:'bottom' } }
    }
  });

  const notaSospechosos = document.getElementById('chartAdjCertNota');
  const sucursalesSospechosas = sucursalEntries
    .map((e, i) => ({ nombre: e[0], pct: pctPorSucursal[i] }))
    .filter(s => s.pct > UMBRAL_SOSPECHOSO);
  if (sucursalesSospechosas.length) {
    notaSospechosos.innerHTML = '⚠ Valores fuera de rango (revisar Cantidad/IIBB o $ Adjudicado Unitario en los trámites de estas sucursales): ' +
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
    if (!groups[key]) groups[key] = { n:0, presOficial:0, adjudicado:0, certificado:0, certProcesados:0, proyectos:0, proyectadosAcumulados:0, pctIIBBValores:[], sucursales:new Set(), contratistas:new Set() };
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
    contratistas: listaCorta(v.contratistas)
  }));

  if (!state.dashSort.key) { state.dashSort.key = 'presOficial'; state.dashSort.dir = -1; }
  const dashValueFn = (f, key) => {
    if (['grupo','sucursales','contratistas'].includes(key)) return String(f[key] || '').toLowerCase();
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
      { key: 'adjudicado', label: 'Total Adjudicado' },
      { key: 'certificado', label: 'Certificado AAD' },
      { key: 'avance', label: '% de Avance' },
      { key: 'certProcesados', label: 'Cant. Certificados Proc.' },
      { key: 'proyectos', label: 'Cant. Proyectos' },
      { key: 'pctPresupuestoProyectado', label: '% Presup. Proyectado' },
      { key: 'pctIIBB', label: '% IIBB Proyectados' }
    ])
    .concat(mostrarSucursalContratista ? [{ key: 'sucursales', label: 'Sucursal' }, { key: 'contratistas', label: 'Contratista' }] : []);

  const table = document.getElementById('dashTable');
  table.innerHTML = sortableTheadHtml(dashCols, state.dashSort) +
    '<tbody>' + entries.map(f => {
      const tdsExtra = mostrarSucursalContratista ? `<td>${escapeHtml(f.sucursales)}</td><td>${escapeHtml(f.contratistas)}</td>` : '';
      return `<tr><td>${escapeHtml(f.grupo)}</td><td>${f.n}</td><td>${formatMillions(f.presOficial)}</td><td>${formatMillions(f.adjudicado)}</td><td>${formatMillions(f.certificado)}</td><td>${f.avance.toFixed(1)}%</td><td>${f.certProcesados}</td><td>${f.proyectos}</td><td>${f.pctPresupuestoProyectado.toFixed(1)}%</td><td>${f.pctIIBB.toFixed(1)}%</td>${tdsExtra}</tr>`;
    }).join('') +
    `<tr class="dash-table-total"><td>TOTAL${hayMasGrupos ? ' (' + allEntries.length + ' grupos)' : ''}</td><td>${totalGeneral.n}</td><td>${formatMillions(totalGeneral.presOficial)}</td><td>${formatMillions(totalGeneral.adjudicado)}</td><td>${formatMillions(totalGeneral.certificado)}</td><td>${avanceGeneral.toFixed(1)}%</td><td>${totalGeneral.certProcesados}</td><td>${totalGeneral.proyectos}</td><td>${pctPresupuestoProyectadoGeneral.toFixed(1)}%</td><td>${promedioPctIIBBGeneral.toFixed(1)}%</td>${mostrarSucursalContratista ? '<td></td><td></td>' : ''}</tr>` +
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
const DASH_DETALLE_COLS = REGISTROS_COLS.filter(c => c.key !== 'pctPresupuestoProyectado');
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
        if (rec) openRecordForEdit(rec);
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

function renderContratistaResumen(rows) {
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
  return { sucursal:'Sucursal', pospre:'PosPre', nroPedidoCompras:'Pedido de Compras', adjudicatario:'Contratista/Proveedor' }[key] || key;
}
function kpiCard(label, value, sub) {
  return `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
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
  } else {
    document.getElementById('certTramiteSeleccionado').hidden = true;
    document.getElementById('certForm').hidden = true;
    certTramiteActual = null;
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
  const q = document.getElementById('certFiltroTexto').value.trim().toLowerCase();
  let rows = certListaCache.filter(c => {
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
  } else {
    document.getElementById('proyTramiteSeleccionado').hidden = true;
    document.getElementById('proyForm').hidden = true;
    proyTramiteActual = null;
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
  if (key === 'montoProyecto' || key === 'pctIIBBProyecto' || key === 'iibbProyecto') return num(p[key]);
  return String(p[key] != null ? p[key] : '').toLowerCase();
}

function renderProyTable() {
  const q = document.getElementById('proyFiltroTexto').value.trim().toLowerCase();
  let rows = proyListaCache.filter(p => {
    if (!q) return true;
    return ['pospre','nroPedidoCompras','contratista','numeroProyecto','nroExpedienteProyecto'].some(k =>
      String(p[k] || '').toLowerCase().includes(q)
    );
  });
  if (proySort.key) {
    rows = sortRows(rows, proySort, proySortValue);
  } else {
    rows = rows.slice().sort((a, b) => defaultMultiKeyCompare(a, b, PROY_ORDEN_DEFECTO));
  }

  const isAdmin = state.session && state.session.rol === 'admin';
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  const table = document.getElementById('proyTable');
  const thead = sortableTheadHtml(PROY_TABLE_COLS, proySort, '<th>Descripción</th><th>Observaciones</th>' + ((puedeEditar || isAdmin) ? '<th>Acciones</th>' : ''));
  const tbody = '<tbody>' + rows.map(p => {
    const tds = PROY_TABLE_COLS.map(col => {
      if (['montoProyecto'].includes(col.key)) return `<td class="mono">${formatMoney(p[col.key])}</td>`;
      if (col.key === 'pctIIBBProyecto') return `<td class="mono">${num(p.pctIIBBProyecto).toFixed(1)}%</td>`;
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
// Independiente del módulo de Contrataciones (Registros): no toca `state.registros`
// ni ningún dato de ese módulo. Estructura en árbol: Expediente -> Pedidos (PC) -> Posiciones.
// Matrícula, Detalle de Matrícula, Destino y Cantidad viven en la POSICIÓN (no en el PC): es lo
// que distingue una posición de otra dentro del mismo PC, y por eso cada una tiene sus propias
// fechas de entrega y su propio desvío.
// ============================================================
let comprasCache = [];              // árbol completo: expedientes -> pedidos -> posiciones
let comprasFormNivel = null;        // 'exp' | 'pc' | 'pos' — qué se está creando/editando
let comprasFormEditId = null;       // id del registro en edición, o null si es alta nueva
let comprasFormParentId = null;     // idExpediente (para pc) o idPC (para pos)
let comprasImportFilas = [];        // preview de la importación desde Excel, antes de confirmar

const COMPRAS_EXP_FORM_FIELDS = [
  { key: 'pospre', label: 'Pospre', type: 'text' },
  { key: 'expediente', label: 'Expediente', type: 'text', required: true },
  { key: 'lp', label: 'LP', type: 'text' },
  { key: 'extracto', label: 'Extracto', type: 'text' },
  { key: 'presupuestoOficial', label: '$ Presupuesto Oficial (sin IVA)', type: 'number' },
  { key: 'observaciones', label: 'Observaciones', type: 'text' }
];
const COMPRAS_PC_FORM_FIELDS = [
  { key: 'nroPC', label: 'N° PC', type: 'text', required: true },
  { key: 'adjudicatario', label: 'Adjudicatario', type: 'text' }
];
const COMPRAS_POS_FORM_FIELDS = [
  { key: 'posicion', label: 'Posición', type: 'number', required: true },
  { key: 'matricula', label: 'Matrícula N°', type: 'text' },
  { key: 'detalleMat', label: 'Detalle de Matrícula', type: 'text' },
  { key: 'destino', label: 'Destino', type: 'text' },
  { key: 'cantidad', label: 'Cantidad', type: 'number' },
  { key: 'montoPFija', label: '$ P. Fija p/ítems (sin IVA)', type: 'number' },
  { key: 'fechaContratoFija', label: 'Fecha Entrega x Contrato — P. Fija', type: 'date' },
  { key: 'fechaRealFija', label: 'Fecha Entrega Real — P. Fija', type: 'date' },
  { key: 'partePlanificada', label: 'Parte Planificada', type: 'select', options: ['No', 'Si'] },
  { key: 'montoPPlanificada', label: '$ P. Planificada (sin IVA)', type: 'number' },
  { key: 'fechaContratoPlanificada', label: 'Fecha Entrega x Contrato — Planificada', type: 'date' },
  { key: 'fechaRealPlanificada', label: 'Fecha Entrega Real — Planificada', type: 'date' },
  { key: 'ampliacion', label: 'Ampliación', type: 'select', options: ['No', 'Si'] },
  { key: 'pctAmpliacion', label: '% de Ampliación', type: 'number' },
  { key: 'montoAmpliacion', label: '$ Ampliación (sin IVA)', type: 'number' },
  { key: 'fechaContratoAmpliacion', label: 'Fecha Entrega x Contrato — Ampliación', type: 'date' },
  { key: 'fechaRealAmpliacion', label: 'Fecha Entrega Real — Ampliación', type: 'date' },
  { key: 'observaciones', label: 'Observaciones', type: 'text' }
];

// ---- Filtros de Compras: Pospre, Año, Trámite (Expediente), PC y Destino ----
// Igual criterio que Registros: filtran a nivel Expediente (qué trámites se muestran), y una vez
// que un trámite entra por el filtro se ve completo (todos sus PC y todas sus Posiciones) —
// así siempre se puede ver el detalle entero de lo que se encontró, como en Certificaciones/Proyectos.
const COMPRAS_FILTER_KEYS = ['pospre', 'anio', 'nroPC', 'destino'];
let comprasFiltros = { pospre: [], anio: [], expediente: '', nroPC: [], destino: [] };

function comprasAnioDeExpediente(expedienteStr) {
  const m = String(expedienteStr || '').match(/-(\d{4})-/);
  return m ? m[1] : '';
}
function comprasUniqueValues(key) {
  const set = new Set();
  comprasCache.forEach(exp => {
    if (key === 'pospre') { if (exp.pospre) set.add(String(exp.pospre).trim()); }
    if (key === 'anio') { const a = comprasAnioDeExpediente(exp.expediente); if (a) set.add(a); }
    (exp.pedidos || []).forEach(pc => {
      if (key === 'nroPC' && pc.nroPC) set.add(String(pc.nroPC).trim());
      (pc.posiciones || []).forEach(pos => {
        if (key === 'destino' && pos.destino) set.add(String(pos.destino).trim());
      });
    });
  });
  return Array.from(set).sort();
}
function populateComprasFilterOptions() {
  COMPRAS_FILTER_KEYS.forEach(key => {
    const el = document.querySelector('#comprasFiltersBar [data-cfilter="' + key + '"]');
    if (!el) return;
    const opts = comprasUniqueValues(key);
    comprasFiltros[key] = (comprasFiltros[key] || []).filter(v => opts.includes(v));
    renderMultiselect(el, opts, comprasFiltros[key], (vals) => {
      comprasFiltros[key] = vals;
      renderComprasTable();
    });
  });
}
function comprasFiltered() {
  const texto = (comprasFiltros.expediente || '').trim().toLowerCase();
  return comprasCache.filter(exp => {
    if (comprasFiltros.pospre.length && !comprasFiltros.pospre.includes(String(exp.pospre || '').trim())) return false;
    if (comprasFiltros.anio.length && !comprasFiltros.anio.includes(comprasAnioDeExpediente(exp.expediente))) return false;
    if (texto && !String(exp.expediente || '').toLowerCase().includes(texto)) return false;
    if (comprasFiltros.nroPC.length) {
      const tienePC = (exp.pedidos || []).some(pc => comprasFiltros.nroPC.includes(String(pc.nroPC || '').trim()));
      if (!tienePC) return false;
    }
    if (comprasFiltros.destino.length) {
      const tieneDestino = (exp.pedidos || []).some(pc => (pc.posiciones || []).some(pos => comprasFiltros.destino.includes(String(pos.destino || '').trim())));
      if (!tieneDestino) return false;
    }
    return true;
  });
}
document.querySelector('#comprasFiltersBar [data-cfilter="expediente"]').addEventListener('input', (e) => {
  comprasFiltros.expediente = e.target.value.trim();
  renderComprasTable();
});
document.getElementById('comprasClearFilters').addEventListener('click', () => {
  COMPRAS_FILTER_KEYS.forEach(k => { comprasFiltros[k] = []; });
  comprasFiltros.expediente = '';
  const expEl = document.querySelector('#comprasFiltersBar [data-cfilter="expediente"]');
  if (expEl) expEl.value = '';
  populateComprasFilterOptions();
  renderComprasTable();
});

async function abrirVistaCompras() {
  await cargarCompras();
  cerrarComprasForm();
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  document.getElementById('comprasToolbar').hidden = !puedeEditar;
}

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

async function cargarComprasDatos() {
  const data = await apiCall('compras_listar');
  comprasCache = data.expedientes || [];
}
async function cargarCompras() {
  try {
    await cargarComprasDatos();
    populateComprasFilterOptions();
    renderComprasTable();
  } catch (err) {
    showAppError('No se pudieron cargar las compras: ' + err.message);
  }
}

// ---- Riesgo por plazo (mismo criterio que Contrataciones: DIAS_RIESGO, definido más arriba) ----
function comprasTramosPendientes() {
  const out = [];
  comprasCache.forEach(exp => (exp.pedidos || []).forEach(pc => (pc.posiciones || []).forEach(pos => {
    [
      { tramo: 'P. Fija', fecha: pos.fechaContratoFija, entregado: pos.entregadoFija },
      { tramo: 'P. Planificada', fecha: pos.fechaContratoPlanificada, entregado: pos.entregadoPlanificada },
      { tramo: 'Ampliación', fecha: pos.fechaContratoAmpliacion, entregado: pos.entregadoAmpliacion }
    ].forEach(t => {
      if (t.fecha && !t.entregado) out.push({ exp, pc, pos, tramo: t.tramo, fecha: t.fecha });
    });
  })));
  return out;
}
function comprasRiesgoCount() {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  return comprasTramosPendientes().filter(t => {
    const d = new Date(t.fecha + 'T00:00:00');
    if (isNaN(d.getTime())) return false;
    return ((d - hoy) / 86400000) <= DIAS_RIESGO;
  }).length;
}
function comprasEventosParaCalendario() {
  return comprasTramosPendientes().map(t => ({
    fecha: t.fecha, tramo: t.tramo, expediente: t.exp.expediente, nroPC: t.pc.nroPC,
    posicion: t.pos.posicion, matricula: t.pos.matricula, adjudicatario: t.pc.adjudicatario, destino: t.pos.destino
  }));
}

// ---- Render de la tabla / árbol ----
function comprasBadgeTramo(label, pos, fechaKey, entregadoKey, desvioKey, vencidaKey) {
  const fecha = pos[fechaKey];
  if (!fecha) return '';
  const entregado = pos[entregadoKey];
  const desvio = pos[desvioKey];
  const vencida = pos[vencidaKey];
  let cls = 'cal-badge lejano', texto = fecha;
  if (entregado) {
    cls = desvio > 0 ? 'cal-badge proximo' : 'cal-badge lejano';
    texto = fecha + (desvio !== null ? ' · entregado (' + (desvio > 0 ? '+' : '') + desvio + ' d)' : ' · entregado');
  } else if (vencida) {
    cls = 'cal-badge vencido';
    texto = fecha + ' · vencido hace ' + Math.abs(desvio) + ' d';
  } else {
    texto = fecha + ' · pendiente';
  }
  return `<div class="compras-tramo"><b>${escapeHtml(label)}:</b> <span class="${cls}" style="position:static;display:inline-block;">${escapeHtml(texto)}</span></div>`;
}

function renderComprasTable() {
  const wrap = document.getElementById('comprasTree');
  const puedeEditar = state.session && state.session.rol !== 'consulta';
  const filtradas = comprasFiltered();
  const countEl = document.getElementById('comprasResultsCount');
  if (countEl) countEl.textContent = filtradas.length + ' expediente(s) encontrado(s) de ' + comprasCache.length + ' totales.';
  if (!comprasCache.length) {
    wrap.innerHTML = '<p class="empty-hint">Todavía no hay expedientes de Compras cargados.</p>';
    return;
  }
  if (!filtradas.length) {
    wrap.innerHTML = '<p class="empty-hint">Ningún expediente coincide con los filtros aplicados.</p>';
    return;
  }
  wrap.innerHTML = filtradas.map(exp => {
    const pedidosHtml = (exp.pedidos || []).map(pc => {
      const posHtml = (pc.posiciones || []).map(pos => `
        <div class="compras-pos-card">
          <div class="compras-pos-head">
            <b>Posición ${escapeHtml(pos.posicion || '')}</b>
            <span class="mono">$ ${num(pos.montoTotal).toLocaleString('es-AR', { maximumFractionDigits: 2 })}</span>
            ${puedeEditar ? `<span class="compras-pos-actions">
              <button class="btn-link" onclick="abrirComprasForm('pos', ${comprasJsArg(pos._id)}, ${comprasJsArg(pc._id)})">Editar</button>
              <button class="btn-link danger" onclick="eliminarComprasRegistro('pos', ${comprasJsArg(pos._id)})">Eliminar</button>
            </span>` : ''}
          </div>
          <div class="compras-tramo"><b>Matrícula:</b> ${escapeHtml(pos.matricula || '(sin matrícula)')} ${pos.detalleMat ? '— ' + escapeHtml(pos.detalleMat) : ''}</div>
          <div class="compras-tramo"><b>Destino:</b> ${escapeHtml(pos.destino || '—')} &nbsp; <b>Cantidad:</b> ${escapeHtml(String(pos.cantidad || '—'))}</div>
          ${comprasBadgeTramo('P. Fija', pos, 'fechaContratoFija', 'entregadoFija', 'desvioFija', 'vencidaFija')}
          ${comprasBadgeTramo('P. Planificada', pos, 'fechaContratoPlanificada', 'entregadoPlanificada', 'desvioPlanificada', 'vencidaPlanificada')}
          ${comprasBadgeTramo('Ampliación', pos, 'fechaContratoAmpliacion', 'entregadoAmpliacion', 'desvioAmpliacion', 'vencidaAmpliacion')}
          ${pos.observaciones ? `<div class="compras-tramo"><b>Obs.:</b> ${escapeHtml(pos.observaciones)}</div>` : ''}
        </div>`).join('') || '<p class="empty-hint">Sin posiciones cargadas.</p>';

      return `<details class="compras-pc">
          <summary>
            PC ${escapeHtml(pc.nroPC || '(sin número)')} — ${escapeHtml(pc.adjudicatario || 'sin adjudicatario')}
            <span class="mono">$ ${num(pc.adjudicadoCalculado).toLocaleString('es-AR', { maximumFractionDigits: 2 })}</span>
            ${puedeEditar ? `<span class="compras-pos-actions">
              <button class="btn-link" onclick="event.stopPropagation(); abrirComprasForm('pc', ${comprasJsArg(pc._id)}, ${comprasJsArg(exp._id)})">Editar PC</button>
              <button class="btn-link" onclick="event.stopPropagation(); abrirComprasForm('pos', null, ${comprasJsArg(pc._id)})">+ Posición</button>
              <button class="btn-link danger" onclick="event.stopPropagation(); eliminarComprasRegistro('pc', ${comprasJsArg(pc._id)})">Eliminar PC</button>
            </span>` : ''}
          </summary>
          <div class="compras-pos-list">${posHtml}</div>
        </details>`;
    }).join('') || '<p class="empty-hint">Sin pedidos de compra cargados.</p>';

    return `<details class="compras-exp" open>
        <summary>
          <b>${escapeHtml(exp.expediente || '(sin número)')}</b> — ${escapeHtml(exp.extracto || '')}
          <span class="mono">Ofic.: $ ${num(exp.presupuestoOficial).toLocaleString('es-AR', { maximumFractionDigits: 2 })} · Adj.: $ ${num(exp.adjudicadoTotal).toLocaleString('es-AR', { maximumFractionDigits: 2 })}</span>
          ${puedeEditar ? `<span class="compras-pos-actions">
            <button class="btn-link" onclick="event.stopPropagation(); abrirComprasForm('exp', ${comprasJsArg(exp._id)}, null)">Editar</button>
            <button class="btn-link" onclick="event.stopPropagation(); abrirComprasForm('pc', null, ${comprasJsArg(exp._id)})">+ Pedido (PC)</button>
            <button class="btn-link danger" onclick="event.stopPropagation(); eliminarComprasRegistro('exp', ${comprasJsArg(exp._id)})">Eliminar Expediente</button>
          </span>` : ''}
        </summary>
        <div class="compras-pc-list">${pedidosHtml}</div>
      </details>`;
  }).join('');
}

// Genera un literal JS seguro para insertar dentro de un atributo onclick="..." (con comillas
// dobles). Usar JSON.stringify() ahí rompía el HTML porque agrega comillas dobles DENTRO de un
// atributo que ya está delimitado por comillas dobles.
function comprasJsArg(v) {
  if (v === null || v === undefined) return 'null';
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// ---- Formulario genérico (sirve para los 3 niveles) ----
function comprasCampos(nivel) {
  return nivel === 'exp' ? COMPRAS_EXP_FORM_FIELDS : (nivel === 'pc' ? COMPRAS_PC_FORM_FIELDS : COMPRAS_POS_FORM_FIELDS);
}
function comprasPospreOpciones() {
  // Combina los Pospre ya usados en Contrataciones (state.registros) y los ya cargados en
  // Compras (comprasCache), para que la lista desplegable sea la más completa posible.
  const set = new Set();
  (state.registros || []).forEach(r => { if (r.pospre) set.add(String(r.pospre).trim()); });
  (comprasCache || []).forEach(e => { if (e.pospre) set.add(String(e.pospre).trim()); });
  return Array.from(set).sort();
}

function abrirComprasForm(nivel, editId, parentId) {
  comprasFormNivel = nivel;
  comprasFormEditId = editId || null;
  comprasFormParentId = parentId || null;

  let registro = {};
  if (editId) {
    if (nivel === 'exp') registro = comprasCache.find(e => e._id === editId) || {};
    if (nivel === 'pc') comprasCache.forEach(e => (e.pedidos || []).forEach(pc => { if (pc._id === editId) registro = pc; }));
    if (nivel === 'pos') comprasCache.forEach(e => (e.pedidos || []).forEach(pc => (pc.posiciones || []).forEach(pos => { if (pos._id === editId) registro = pos; })));
  }

  const titulos = { exp: 'Expediente de Compras', pc: 'Pedido de Compra (PC)', pos: 'Posición' };
  document.getElementById('comprasFormTitle').textContent = (editId ? 'Editar ' : 'Nuevo/a ') + titulos[nivel];

  const cont = document.getElementById('comprasFormFields');
  cont.innerHTML = comprasCampos(nivel).map(f => {
    const val = registro[f.key] !== undefined && registro[f.key] !== null ? registro[f.key] : '';
    // Pospre: desplegable dinámico (no texto libre), igual criterio que en Contrataciones —
    // valida contra los Pospre ya existentes, con opción de agregar uno nuevo si hace falta.
    if (f.key === 'pospre') {
      const existentes = comprasPospreOpciones();
      if (val && !existentes.includes(val)) existentes.unshift(val);
      const opts = ['<option value="">— Elegí un Pospre existente —</option>'].concat(
        existentes.map(o => `<option value="${escapeHtml(o)}" ${val === o ? 'selected' : ''}>${escapeHtml(o)}</option>`)
      ).concat(['<option value="' + DYNAMIC_SELECT_OTRO + '">+ Otro (nuevo)...</option>']);
      return `<label>${escapeHtml(f.label)}
        <select class="dyn-select" data-dyn-key="pospre">${opts.join('')}</select>
        <div class="dyn-otro-row" hidden>
          <input type="text" placeholder="Escribí el Pospre nuevo..." class="dyn-otro-input" />
          <button type="button" class="dyn-otro-volver" title="Volver a elegir de la lista">↩ volver a la lista</button>
        </div>
      </label>`;
    }
    if (f.type === 'select') {
      return `<label>${escapeHtml(f.label)}
        <select data-key="${f.key}">${f.options.map(o => `<option value="${o}" ${val === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
      </label>`;
    }
    return `<label>${escapeHtml(f.label)}
      <input type="${f.type}" data-key="${f.key}" value="${escapeHtml(String(val))}" ${f.required ? 'required' : ''} />
    </label>`;
  }).join('');

  // Cablea el comportamiento del desplegable de Pospre (elegir "+ Otro (nuevo)" muestra el input de texto).
  const pospreSel = cont.querySelector('select[data-dyn-key="pospre"]');
  if (pospreSel) {
    const row = pospreSel.nextElementSibling;
    const otroInput = row.querySelector('.dyn-otro-input');
    const volverBtn = row.querySelector('.dyn-otro-volver');
    pospreSel.dataset.key = 'pospre';
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

  document.getElementById('comprasFormMsg').hidden = true;
  document.getElementById('comprasFormPanel').hidden = false;
  document.getElementById('comprasFormPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function cerrarComprasForm() {
  comprasFormNivel = null; comprasFormEditId = null; comprasFormParentId = null;
  const panel = document.getElementById('comprasFormPanel');
  if (panel) panel.hidden = true;
}
document.getElementById('comprasFormCancelarBtn').addEventListener('click', cerrarComprasForm);

document.getElementById('comprasForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('comprasFormMsg');
  const datos = {};
  document.querySelectorAll('#comprasFormFields [data-key]').forEach(el => { datos[el.dataset.key] = el.value; });

  try {
    if (comprasFormNivel === 'exp') {
      if (comprasFormEditId) await apiCall('compras_exp_actualizar', { id: comprasFormEditId, datos });
      else await apiCall('compras_exp_crear', { datos });
    } else if (comprasFormNivel === 'pc') {
      if (comprasFormEditId) await apiCall('compras_pc_actualizar', { id: comprasFormEditId, datos });
      else await apiCall('compras_pc_crear', { datos: Object.assign({ idExpediente: comprasFormParentId }, datos) });
    } else if (comprasFormNivel === 'pos') {
      if (comprasFormEditId) await apiCall('compras_pos_actualizar', { id: comprasFormEditId, datos });
      else await apiCall('compras_pos_crear', { datos: Object.assign({ idPC: comprasFormParentId }, datos) });
    }
    await cargarCompras();
    await refrescarRegistrosTrasCompras();
    cerrarComprasForm();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-msg err';
    msg.hidden = false;
  }
});

async function eliminarComprasRegistro(nivel, id) {
  const avisos = {
    exp: '¿Eliminar este Expediente? Se van a borrar también todos sus Pedidos (PC) y Posiciones, y su fila espejo en Registros.',
    pc: '¿Eliminar este Pedido de Compra? Se van a borrar también todas sus Posiciones.',
    pos: '¿Eliminar esta Posición?'
  };
  if (!confirm(avisos[nivel])) return;
  const acciones = { exp: 'compras_exp_eliminar', pc: 'compras_pc_eliminar', pos: 'compras_pos_eliminar' };
  try {
    await apiCall(acciones[nivel], { id });
    await cargarCompras();
    await refrescarRegistrosTrasCompras();
  } catch (err) {
    showAppError('No se pudo eliminar: ' + err.message);
  }
}

// ---- Exportar a Excel (mismo formato de la planilla original, para backup / informes) ----
document.getElementById('comprasExportBtn').addEventListener('click', () => {
  if (!comprasCache.length) { alert('No hay compras para exportar.'); return; }
  const filas = [];
  comprasCache.forEach(exp => (exp.pedidos || []).forEach(pc => (pc.posiciones || []).forEach(pos => {
    filas.push({
      'PosPre': exp.pospre, 'Expte': exp.expediente, 'LP': exp.lp, 'Extracto': exp.extracto,
      '$ Presupuesto Oficial (sin IVA)': exp.presupuestoOficial,
      'PC': pc.nroPC, 'Adjudicatario': pc.adjudicatario, '$ Adjudicado PC (calculado)': pc.adjudicadoCalculado,
      'Posición': pos.posicion, 'Matrícula N°': pos.matricula, 'Detalle de Matrícula': pos.detalleMat,
      'Destino': pos.destino, 'Cantidad': pos.cantidad,
      'Fecha de Entrega por Contrato P.Fija': pos.fechaContratoFija, 'Fecha de Entrega Real P.Fija': pos.fechaRealFija,
      'Desvío de Fecha Entrega P. Fija (días)': pos.desvioFija,
      '$ P. Fija p/ítems S/IVA': pos.montoPFija,
      'Parte Planificada': pos.partePlanificada, '$ P. Planificada (s/IVA)': pos.montoPPlanificada,
      'Fecha de Entrega por Contrato P.Planificada': pos.fechaContratoPlanificada, 'Fecha de Entrega Real P.Planificada': pos.fechaRealPlanificada,
      'Desvío de Fecha Entrega P. Planificada (días)': pos.desvioPlanificada,
      'Ampliación (si / no)': pos.ampliacion, '% de Ampliación': pos.pctAmpliacion, '$ Ampliación (sin IVA)': pos.montoAmpliacion,
      'Fecha de Entrega por Contrato Ampliación': pos.fechaContratoAmpliacion, 'Fecha de Entrega Real Ampliación': pos.fechaRealAmpliacion,
      'Desvío de Fecha Entrega Ampliación (días)': pos.desvioAmpliacion,
      '$ Total Posición (calculado)': pos.montoTotal,
      'Observaciones': pos.observaciones
    });
  })));
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Compras');
  XLSX.writeFile(wb, 'compras_export.xlsx');
});

// ---- Importar desde Excel (formato "Gestiones de Compra de Mat-EE y Bienes.xlsx") ----
// Reconstruye el árbol Expediente -> PC -> Posición rellenando hacia abajo las celdas que en
// el Excel original vienen en blanco (porque pertenecen al mismo grupo que la fila de arriba).
// IMPORTANTE: Matrícula, Detalle, Destino y Cantidad se leen de CADA fila de Posición (no se
// heredan del PC), porque son propias de cada posición.
function parseComprasExcelRows(rows) {
  const expedientes = [];
  let curExp = null, curPC = null;
  for (let i = 1; i < rows.length; i++) { // fila 0 = encabezados
    const r = rows[i] || [];
    const val = (idx) => (r[idx] !== undefined && r[idx] !== null) ? r[idx] : '';
    const expte = String(val(1)).trim();
    const pc = String(val(5)).trim();
    const posicion = String(val(11)).trim();
    if (!expte && !pc && !posicion) continue; // fila totalmente vacía

    if (expte) {
      curExp = {
        pospre: val(0), expediente: expte, lp: val(2), extracto: val(3),
        presupuestoOficial: _parseNumeroImport(val(4)), observaciones: '', pedidos: []
      };
      expedientes.push(curExp);
      curPC = null;
    }
    if (!curExp) continue; // fila de PC/Posición sin ningún Expediente todavía abierto: se omite

    if (pc) {
      curPC = { nroPC: pc, adjudicatario: val(8), posiciones: [] };
      curExp.pedidos.push(curPC);
    }
    if (!curPC) continue;

    if (posicion) {
      curPC.posiciones.push({
        posicion: posicion,
        matricula: val(6), detalleMat: val(7), destino: val(9), cantidad: '',
        fechaContratoFija: _excelFechaImport(val(12)),
        montoPFija: _parseNumeroImport(val(15)),
        partePlanificada: val(16) ? 'Si' : 'No',
        montoPPlanificada: _parseNumeroImport(val(17)),
        fechaContratoPlanificada: _excelFechaImport(val(18)),
        ampliacion: val(21) ? 'Si' : 'No',
        pctAmpliacion: _parseNumeroImport(val(22)),
        montoAmpliacion: _parseNumeroImport(val(23)),
        fechaContratoAmpliacion: _excelFechaImport(val(24)),
        observaciones: val(27)
      });
    }
  }
  return expedientes;
}
// Excel puede traer la fecha como texto dd/mm/aaaa, como número de serie de Excel, o como Date
// (SheetJS con cellDates:true entrega Date directamente).
function _excelFechaImport(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0].slice(0, 10);
  return '';
}

document.getElementById('comprasImportFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  comprasImportFilas = parseComprasExcelRows(rows);
  renderComprasImportPreview();
});

function renderComprasImportPreview() {
  const wrap = document.getElementById('comprasImportPreviewWrap');
  wrap.hidden = false;
  const cantPC = comprasImportFilas.reduce((acc, e) => acc + e.pedidos.length, 0);
  const cantPos = comprasImportFilas.reduce((acc, e) => acc + e.pedidos.reduce((a, pc) => a + pc.posiciones.length, 0), 0);
  document.getElementById('comprasImportResumen').textContent =
    `${comprasImportFilas.length} expediente(s), ${cantPC} pedido(s) de compra y ${cantPos} posición(es) detectados en el archivo. ` +
    `Si un Expediente / PC / Posición ya existe (mismo número), se actualiza; si no existe, se crea. No se duplica nada. ` +
    `La columna "Cantidad" no existe en este formato de Excel: se importa en blanco, completala manualmente si la necesitás.`;

  const table = document.getElementById('comprasImportPreviewTable');
  table.innerHTML = '<thead><tr><th>Expediente</th><th>Extracto</th><th>PC</th><th>Adjudicatario</th><th>Posiciones</th><th>Matrículas</th></tr></thead><tbody>' +
    comprasImportFilas.map(e => e.pedidos.map((pc, idx) => `<tr>
        <td>${idx === 0 ? escapeHtml(e.expediente) : ''}</td>
        <td>${idx === 0 ? escapeHtml(e.extracto) : ''}</td>
        <td>${escapeHtml(pc.nroPC)}</td>
        <td>${escapeHtml(pc.adjudicatario)}</td>
        <td>${pc.posiciones.length}</td>
        <td>${pc.posiciones.map(p => escapeHtml(p.matricula)).filter(Boolean).join(', ')}</td>
      </tr>`).join('')).join('') + '</tbody>';

  document.getElementById('comprasImportConfirmarBtn').disabled = !comprasImportFilas.length;
}
document.getElementById('comprasImportCancelarBtn').addEventListener('click', () => {
  comprasImportFilas = [];
  document.getElementById('comprasImportFile').value = '';
  document.getElementById('comprasImportPreviewWrap').hidden = true;
  document.getElementById('comprasImportMsg').hidden = true;
});
document.getElementById('comprasImportConfirmarBtn').addEventListener('click', async () => {
  const btn = document.getElementById('comprasImportConfirmarBtn');
  const msg = document.getElementById('comprasImportMsg');
  btn.disabled = true;
  btn.textContent = 'Importando...';
  try {
    const data = await apiCall('compras_importar', { expedientes: comprasImportFilas });
    const r = data.resultado;
    msg.textContent = `Listo — Expedientes: ${r.expCreados} nuevos / ${r.expActualizados} actualizados · ` +
      `PC: ${r.pcCreados} nuevos / ${r.pcActualizados} actualizados · Posiciones: ${r.posCreados} nuevas / ${r.posActualizados} actualizadas.`;
    msg.className = 'form-msg ok';
  } catch (err) {
    msg.textContent = 'Error al importar: ' + err.message;
    msg.className = 'form-msg err';
  }
  msg.hidden = false;
  btn.textContent = 'Confirmar importación';
  comprasImportFilas = [];
  document.getElementById('comprasImportFile').value = '';
  document.getElementById('comprasImportPreviewWrap').hidden = true;
  await cargarCompras();
  await refrescarRegistrosTrasCompras();
});

