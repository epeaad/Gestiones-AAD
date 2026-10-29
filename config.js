// ============================================================
// CONFIGURACIÓN — este es el ÚNICO archivo que tenés que tocar.
// ============================================================
// Pegá acá la URL de tu implementación de Google Apps Script
// (la que copiaste después de "Implementar > Nueva implementación").
// Tiene esta forma:
// https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXX/exec

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwDJcAW2icihVgU0nFp2MZeJIXtOqs_FPb9ENs0dpQ5kvdAYB9J8h2ejVL939OV5DEi/exec";

// ============================================================
// ÁREAS DE DISTRIBUCIÓN — agrupan Sucursales en el filtro "Área".
// Al tildar un Área se tildan solas sus Sucursales en el filtro "Sucursal",
// y al destildarla se destildan. Los nombres de sucursal se comparan sin
// distinguir mayúsculas, acentos, puntos ni espacios ("A.D.Rosario" = "A.D. Rosario").
// Una sucursal que no figure acá sigue disponible solo en el filtro "Sucursal".
// Para mover una sucursal de área, basta con editar estas listas.
// ============================================================
const AREAS_DISTRIBUCION = [
  { id: 'adsf', corto: 'A.D. Santa Fe', nombre: 'Área Distribución Santa Fe',
    sucursales: ['A.D. Santa Fe', 'AD Santa Fe', 'ADSF', 'Área Distribución Santa Fe', 'Area Distribucion Santa Fe'] },
  { id: 'adr', corto: 'A.D. Rosario', nombre: 'Área Distribución Rosario',
    sucursales: ['A.D. Rosario', 'AD Rosario', 'ADR', 'Área Distribución Rosario', 'Area Distribucion Rosario'] },
  { id: 'adtn', corto: 'A.D.T. Norte', nombre: 'Área Distribución Territorial Norte',
    sucursales: ['Reconquista', 'Noroeste', 'Santa Fe Norte', 'Rafaela', 'Centro', 'Oeste', 'Santa Fe Sur'] },
  { id: 'adts', corto: 'A.D.T. Sur', nombre: 'Área Distribución Territorial Sur',
    sucursales: ['San Lorenzo', 'Rosario Norte', 'Rosario Oeste', 'Villa Constitución', 'Sur'] }
];
