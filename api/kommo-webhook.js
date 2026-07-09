// api/kommo-webhook.js
// Webhook de Kommo CRM → Firestore (colección leads_kommo)
// Versión 2: enriquece cada lead consultando la API de Kommo
// (nombre, teléfono, correo, asesor, pipeline, etapa, auto, campaña UTM)

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { credential } = require('firebase-admin');

// ─────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────
const KOMMO_BASE = 'https://bdcamozmotorscommx.kommo.com';
const KOMMO_TOKEN = process.env.KOMMO_ACCESS_TOKEN || '';

const AGENCIA_DEFAULT = 'Autoforum Puebla';
const MARCA_DEFAULT = 'seat';

// ─────────────────────────────────────────────
// Inicialización Firebase Admin
// ─────────────────────────────────────────────
if (!getApps().length) {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) {
    throw new Error('Falta la variable de entorno GOOGLE_APPLICATION_CREDENTIALS_JSON');
  }
  const serviceAccount = JSON.parse(raw);
  if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  initializeApp({
    credential: credential.cert(serviceAccount),
    projectId: 'zmotors-2f8f4',
  });
}

const db = getFirestore();

// ─────────────────────────────────────────────
// Mapeo de etapas Kommo → estatus plataforma
// ─────────────────────────────────────────────
const MAPEO_ETAPAS = {
  'leads entrante': 'Nuevo',
  'leads entrantes': 'Nuevo',
  'contacto inicial': 'Contactado',
  'negociación': 'Negociación',
  'negociacion': 'Negociación',
  'cita agendada': 'Cita agendada',
  'ganado': 'Venta',
  'logrado con éxito': 'Venta',
  'perdido': 'Descalificado',
  'venta perdida': 'Descalificado',
};

function mapearEstatus(statusName) {
  if (!statusName) return 'Nuevo';
  const key = String(statusName).trim().toLowerCase();
  return MAPEO_ETAPAS[key] || statusName;
}

// ─────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────
function normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function limpiarTelefono(tel) {
  if (!tel) return '';
  let digitos = String(tel).replace(/\D/g, '');
  if (digitos.length > 10) digitos = digitos.slice(-10);
  return digitos;
}

function tsKommo(unix) {
  const n = parseInt(unix, 10);
  if (!n || isNaN(n)) return Timestamp.now();
  return Timestamp.fromMillis(n * 1000);
}

function comoArray(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === 'object') return Object.values(x);
  return [x];
}

// Reconstruye objeto anidado desde llaves tipo leads[add][0][id]
function reconstruirObjeto(flat) {
  const resultado = {};
  for (const [clave, valor] of Object.entries(flat)) {
    const partes = clave.replace(/\]/g, '').split('[');
    let nodo = resultado;
    for (let i = 0; i < partes.length; i++) {
      const parte = partes[i];
      const esUltima = i === partes.length - 1;
      if (esUltima) {
        nodo[parte] = valor;
      } else {
        const siguienteEsIndice = /^\d+$/.test(partes[i + 1]);
        if (!(parte in nodo)) {
          nodo[parte] = siguienteEsIndice ? [] : {};
        }
        nodo = nodo[parte];
      }
    }
  }
  return resultado;
}

function normalizarPayload(body) {
  if (!body || typeof body !== 'object') return {};
  const tieneCorchetes = Object.keys(body).some((k) => k.includes('['));
  return tieneCorchetes ? reconstruirObjeto(body) : body;
}

// ─────────────────────────────────────────────
// Cliente de la API de Kommo (con caché por invocación)
// ─────────────────────────────────────────────
const cache = {
  pipelines: null, // { statusId: {statusName, pipelineName} }
  usuarios: {},    // { userId: nombre }
};

async function kommoGet(ruta) {
  if (!KOMMO_TOKEN) return null;
  try {
    const resp = await fetch(`${KOMMO_BASE}${ruta}`, {
      headers: {
        Authorization: `Bearer ${KOMMO_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      console.error(`Kommo API ${ruta} → HTTP ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error(`Kommo API ${ruta} → ${e.message}`);
    return null;
  }
}

// Carga todos los pipelines y etapas una sola vez por invocación
async function obtenerMapaEtapas() {
  if (cache.pipelines) return cache.pipelines;
  const data = await kommoGet('/api/v4/leads/pipelines');
  const mapa = {};
  const pipelines = (data && data._embedded && data._embedded.pipelines) || [];
  for (const p of pipelines) {
    const statuses = (p._embedded && p._embedded.statuses) || [];
    for (const s of statuses) {
      mapa[String(s.id)] = { statusName: s.name, pipelineName: p.name };
    }
  }
  cache.pipelines = mapa;
  return mapa;
}

async function obtenerNombreUsuario(userId) {
  if (!userId) return '';
  const key = String(userId);
  if (cache.usuarios[key] !== undefined) return cache.usuarios[key];
  const data = await kommoGet(`/api/v4/users/${key}`);
  const nombre = (data && data.name) || '';
  cache.usuarios[key] = nombre;
  return nombre;
}

// Extrae un valor de custom_fields_values por field_code o por nombre parcial
function valorCustomField(cfv, codigos, nombres) {
  const campos = comoArray(cfv);
  for (const campo of campos) {
    const code = String(campo.field_code || '').toUpperCase();
    const nombre = normalizarTexto(campo.field_name || campo.name);
    const coincideCodigo = codigos.some((c) => code === c);
    const coincideNombre = nombres.some((n) => nombre.includes(n));
    if (coincideCodigo || coincideNombre) {
      const valores = comoArray(campo.values);
      const primero = valores[0];
      if (primero && typeof primero === 'object') return primero.value || '';
      if (primero) return String(primero);
    }
  }
  return '';
}

// ─────────────────────────────────────────────
// Enriquecer lead con datos completos desde la API
// ─────────────────────────────────────────────
async function enriquecerLead(leadId) {
  const data = await kommoGet(`/api/v4/leads/${leadId}?with=contacts`);
  if (!data) return null;

  const cfv = data.custom_fields_values;
  const mapaEtapas = await obtenerMapaEtapas();
  const etapa = mapaEtapas[String(data.status_id)] || {};

  const enriquecido = {
    nombre: data.name || 'Sin nombre',
    estatusKommo: etapa.statusName || '',
    pipeline: etapa.pipelineName || '',
    asesor: await obtenerNombreUsuario(data.responsible_user_id),
    auto: valorCustomField(cfv, [], ['auto', 'vehiculo', 'modelo', 'unidad', 'version']),
    campana: valorCustomField(cfv, ['UTM_CAMPAIGN'], ['utm_campaign', 'campana', 'campaña']),
    utmSource: valorCustomField(cfv, ['UTM_SOURCE'], ['utm_source']),
    utmMedium: valorCustomField(cfv, ['UTM_MEDIUM'], ['utm_medium']),
    fuente: valorCustomField(cfv, [], ['fuente', 'source', 'origen']) || '',
    precio: data.price || 0,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    telefono: '',
    correo: '',
  };

  // Contacto principal → teléfono y correo
  const contactos = (data._embedded && data._embedded.contacts) || [];
  const principal = contactos.find((c) => c.is_main) || contactos[0];
  if (principal && principal.id) {
    const contacto = await kommoGet(`/api/v4/contacts/${principal.id}`);
    if (contacto) {
      const ccfv = contacto.custom_fields_values;
      enriquecido.telefono = limpiarTelefono(
        valorCustomField(ccfv, ['PHONE'], ['telefono', 'phone', 'celular', 'whatsapp'])
      );
      enriquecido.correo = valorCustomField(ccfv, ['EMAIL'], ['correo', 'email', 'mail']);
      enriquecido.kommoContactId = String(principal.id);
      // Si el lead no tiene nombre útil, usar el del contacto
      if ((!enriquecido.nombre || enriquecido.nombre === 'Sin nombre') && contacto.name) {
        enriquecido.nombre = contacto.name;
      }
    }
  }

  return enriquecido;
}

// ─────────────────────────────────────────────
// Procesar un lead → upsert en Firestore
// ─────────────────────────────────────────────
async function procesarLead(leadBasico, esNuevo) {
  const kommoId = String(leadBasico.id || '');
  if (!kommoId) return null;

  // 1) Datos base desde el payload del webhook (por si la API falla)
  const datos = {
    kommoId,
    nombre: leadBasico.name || 'Sin nombre',
    estatus: mapearEstatus(leadBasico.status_name),
    agencia: AGENCIA_DEFAULT,
    agenciaMarca: MARCA_DEFAULT,
    fuente: 'Kommo',
    fuente_kommo: true,
    fechaActualizacion: tsKommo(leadBasico.updated_at),
  };

  // 2) Enriquecer con la API de Kommo (datos completos)
  const extra = await enriquecerLead(kommoId);
  if (extra) {
    datos.nombre = extra.nombre || datos.nombre;
    datos.estatus = mapearEstatus(extra.estatusKommo) || datos.estatus;
    datos.pipeline = extra.pipeline;
    datos.asesor = extra.asesor;
    datos.auto = extra.auto;
    datos.campana = extra.campana;
    if (extra.utmSource) datos.utmSource = extra.utmSource;
    if (extra.utmMedium) datos.utmMedium = extra.utmMedium;
    if (extra.fuente) datos.fuente = extra.fuente;
    if (extra.telefono) datos.telefono = extra.telefono;
    if (extra.correo) datos.correo = extra.correo;
    if (extra.kommoContactId) datos.kommoContactId = extra.kommoContactId;
    if (extra.precio) datos.presupuesto = extra.precio;
    datos.fechaActualizacion = tsKommo(extra.updatedAt || leadBasico.updated_at);
    if (esNuevo || extra.createdAt) {
      datos.fechaCreacion = tsKommo(extra.createdAt || leadBasico.created_at);
    }
  } else if (esNuevo) {
    datos.fechaCreacion = tsKommo(leadBasico.created_at);
  }

  const ref = db.collection('leads_kommo').doc(`kommo_${kommoId}`);
  await ref.set(datos, { merge: true });

  // Asegurar fechaCreacion aunque el primer evento haya sido un update
  const snap = await ref.get();
  if (!snap.data().fechaCreacion) {
    await ref.set(
      { fechaCreacion: tsKommo(leadBasico.created_at || leadBasico.updated_at) },
      { merge: true }
    );
  }

  return kommoId;
}

// ─────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(200).json({
      ok: true,
      servicio: 'kommo-webhook Z Motors v2',
      apiKommoConfigurada: !!KOMMO_TOKEN,
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = normalizarPayload(req.body);

    const leadsAdd = comoArray(payload.leads && payload.leads.add);
    const leadsUpdate = comoArray(payload.leads && payload.leads.update);
    const leadsStatus = comoArray(payload.leads && payload.leads.status);
    const leadsResp = comoArray(payload.leads && payload.leads.responsible);

    const procesados = [];

    for (const lead of leadsAdd) {
      const id = await procesarLead(lead, true);
      if (id) procesados.push(id);
    }
    for (const lead of [...leadsUpdate, ...leadsStatus, ...leadsResp]) {
      const id = await procesarLead(lead, false);
      if (id) procesados.push(id);
    }

    console.log('Webhook Kommo v2 procesado:', JSON.stringify(procesados));
    return res.status(200).json({ ok: true, procesados });
  } catch (err) {
    console.error('Error en webhook Kommo:', err);
    // 200 para que Kommo no desactive el webhook; el error queda en logs
    return res.status(200).json({ ok: false, error: err.message });
  }
};
