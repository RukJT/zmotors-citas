// api/kommo-webhook.js
// Webhook de Kommo CRM → Firestore (colección leads_kommo)
// Z Motors Intelligence Platform — Sistema de Citas
// Vercel Serverless Function

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { credential } = require('firebase-admin');

// ─────────────────────────────────────────────
// Inicialización Firebase Admin (FIX credenciales)
// Lee el JSON del service account desde la variable
// de entorno GOOGLE_APPLICATION_CREDENTIALS_JSON
// ─────────────────────────────────────────────
if (!getApps().length) {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) {
    throw new Error('Falta la variable de entorno GOOGLE_APPLICATION_CREDENTIALS_JSON');
  }
  const serviceAccount = JSON.parse(raw);
  // Por si Vercel guardó los saltos de línea escapados en la private_key
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
  'contacto inicial': 'Contactado',
  'negociación': 'Negociación',
  'negociacion': 'Negociación',
  'cita agendada': 'Cita agendada',
  'ganado': 'Venta',
  'perdido': 'Descalificado',
};

function mapearEstatus(statusName) {
  if (!statusName) return 'Nuevo';
  const key = String(statusName).trim().toLowerCase();
  return MAPEO_ETAPAS[key] || statusName;
}

// ─────────────────────────────────────────────
// Agencia piloto (única cuenta Kommo conectada:
// SEAT Autoforum Puebla). Ajustar cuando se
// agreguen más agencias al CRM.
// ─────────────────────────────────────────────
const AGENCIA_DEFAULT = 'Autoforum Puebla';
const MARCA_DEFAULT = 'seat';

// ─────────────────────────────────────────────
// Kommo envía el webhook como
// application/x-www-form-urlencoded con notación
// de corchetes: leads[add][0][id]=123
// Vercel lo deja en req.body como llaves planas.
// Esta función reconstruye el objeto anidado.
// ─────────────────────────────────────────────
function reconstruirObjeto(flat) {
  const resultado = {};
  for (const [clave, valor] of Object.entries(flat)) {
    // "leads[add][0][custom_fields][0][values][0][value]"
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

// Normaliza el body sin importar si llegó como JSON,
// urlencoded plano o ya anidado
function normalizarPayload(body) {
  if (!body || typeof body !== 'object') return {};
  // Si ya viene anidado (JSON), las llaves no traen corchetes
  const tieneCorchetes = Object.keys(body).some((k) => k.includes('['));
  return tieneCorchetes ? reconstruirObjeto(body) : body;
}

// Convierte a array de forma segura (Kommo a veces manda
// objetos con índices numéricos en lugar de arrays)
function comoArray(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === 'object') return Object.values(x);
  return [x];
}

// ─────────────────────────────────────────────
// Extraer valor de custom_fields por nombre
// (búsqueda parcial, sin acentos ni mayúsculas)
// ─────────────────────────────────────────────
function normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function buscarCustomField(customFields, nombres) {
  const campos = comoArray(customFields);
  for (const campo of campos) {
    const nombreCampo = normalizarTexto(campo.name || campo.field_name);
    for (const buscado of nombres) {
      if (nombreCampo.includes(buscado)) {
        const valores = comoArray(campo.values);
        const primero = valores[0];
        if (primero && typeof primero === 'object') return primero.value || '';
        if (primero) return primero;
      }
    }
  }
  return '';
}

// Limpia teléfono a 10 dígitos (quita +52, espacios, guiones)
function limpiarTelefono(tel) {
  if (!tel) return '';
  let digitos = String(tel).replace(/\D/g, '');
  if (digitos.length > 10) digitos = digitos.slice(-10);
  return digitos;
}

// Timestamp de Kommo (Unix segundos) → Firestore Timestamp
function tsKommo(unix) {
  const n = parseInt(unix, 10);
  if (!n || isNaN(n)) return Timestamp.now();
  return Timestamp.fromMillis(n * 1000);
}

// ─────────────────────────────────────────────
// Procesar un lead (add o update) → upsert en Firestore
// Doc ID = kommo_{id} para que update sobreescriba al mismo doc
// ─────────────────────────────────────────────
async function procesarLead(lead, esNuevo) {
  const kommoId = String(lead.id || '');
  if (!kommoId) return null;

  const customFields = lead.custom_fields || lead.custom_fields_values;

  const datos = {
    kommoId,
    kommoContactId: String(lead.contact_id || lead.main_contact_id || ''),
    nombre: lead.name || 'Sin nombre',
    auto: buscarCustomField(customFields, ['auto', 'vehiculo', 'modelo', 'unidad']),
    fuente: lead.source_name || buscarCustomField(customFields, ['fuente', 'source']) || 'Kommo',
    campana: lead.utm_campaign || buscarCustomField(customFields, ['utm', 'campana', 'campaña']) || '',
    estatus: mapearEstatus(lead.status_name),
    pipeline: lead.pipeline_name || '',
    asesor: (lead.responsible_user && lead.responsible_user.name) || lead.responsible_user_name || '',
    agencia: AGENCIA_DEFAULT,
    agenciaMarca: MARCA_DEFAULT,
    fechaActualizacion: tsKommo(lead.updated_at),
    fuente_kommo: true,
  };

  // Teléfono/correo si vienen embebidos en el lead
  const tel = buscarCustomField(customFields, ['telefono', 'phone', 'celular', 'whatsapp']);
  const correo = buscarCustomField(customFields, ['correo', 'email', 'mail']);
  if (tel) datos.telefono = limpiarTelefono(tel);
  if (correo) datos.correo = correo;

  // Solo fijar fechaCreacion en leads nuevos (no pisarla en updates)
  if (esNuevo) {
    datos.fechaCreacion = tsKommo(lead.created_at);
  }

  const ref = db.collection('leads_kommo').doc(`kommo_${kommoId}`);
  await ref.set(datos, { merge: true });

  // Asegurar fechaCreacion aunque el primer evento haya sido un update
  const snap = await ref.get();
  if (!snap.data().fechaCreacion) {
    await ref.set({ fechaCreacion: tsKommo(lead.created_at || lead.updated_at) }, { merge: true });
  }

  return kommoId;
}

// ─────────────────────────────────────────────
// Procesar un contacto (add o update) → completar
// teléfono/correo en los leads que lo referencien
// ─────────────────────────────────────────────
async function procesarContacto(contacto) {
  const contactId = String(contacto.id || '');
  if (!contactId) return null;

  const customFields = contacto.custom_fields || contacto.custom_fields_values;
  const telefono = limpiarTelefono(
    contacto.phone || buscarCustomField(customFields, ['telefono', 'phone', 'celular', 'whatsapp'])
  );
  const correo =
    contacto.email || buscarCustomField(customFields, ['correo', 'email', 'mail']) || '';

  if (!telefono && !correo) return null;

  const actualizacion = { fechaActualizacion: FieldValue.serverTimestamp() };
  if (telefono) actualizacion.telefono = telefono;
  if (correo) actualizacion.correo = correo;

  const query = await db
    .collection('leads_kommo')
    .where('kommoContactId', '==', contactId)
    .get();

  const batch = db.batch();
  query.forEach((doc) => batch.set(doc.ref, actualizacion, { merge: true }));
  if (!query.empty) await batch.commit();

  return contactId;
}

// ─────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = normalizarPayload(req.body);

    const leadsAdd = comoArray(payload.leads && payload.leads.add);
    const leadsUpdate = comoArray(payload.leads && payload.leads.update);
    const leadsStatus = comoArray(payload.leads && payload.leads.status); // cambios de etapa
    const contactsAdd = comoArray(payload.contacts && payload.contacts.add);
    const contactsUpdate = comoArray(payload.contacts && payload.contacts.update);

    const procesados = { leads: [], contactos: [] };

    for (const lead of leadsAdd) {
      const id = await procesarLead(lead, true);
      if (id) procesados.leads.push(id);
    }
    for (const lead of [...leadsUpdate, ...leadsStatus]) {
      const id = await procesarLead(lead, false);
      if (id) procesados.leads.push(id);
    }
    for (const contacto of [...contactsAdd, ...contactsUpdate]) {
      const id = await procesarContacto(contacto);
      if (id) procesados.contactos.push(id);
    }

    console.log('Webhook Kommo procesado:', JSON.stringify(procesados));
    return res.status(200).json({ ok: true, procesados });
  } catch (err) {
    console.error('Error en webhook Kommo:', err);
    // Responder 200 para que Kommo no desactive el webhook por reintentos fallidos,
    // pero dejar el error registrado en los logs de Vercel
    return res.status(200).json({ ok: false, error: err.message });
  }
};