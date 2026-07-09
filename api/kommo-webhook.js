// api/kommo-webhook.js
// Vercel Serverless Function — recibe webhooks de Kommo y guarda en Firestore

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { credential } = require('firebase-admin');

// Initialize Firebase Admin (only once)
if (!getApps().length) {
  initializeApp({
    credential: credential.applicationDefault(),
    projectId: 'zmotors-2f8f4',
  });
}

const db = getFirestore();

// Map Kommo pipeline stages to our status names
const STAGE_MAP = {
  'leads entrante':   'Nuevo',
  'contacto inicial': 'Contactado',
  'negociación':      'Negociación',
  'cita agendada':    'Cita agendada',
  'ganado':           'Venta',
  'perdido':          'Descalificado',
};

function mapStage(stageName) {
  if (!stageName) return 'Nuevo';
  const lower = stageName.toLowerCase();
  for (const [key, val] of Object.entries(STAGE_MAP)) {
    if (lower.includes(key)) return val;
  }
  return stageName;
}

function parseFecha(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000); // Kommo sends Unix timestamps
  return d;
}

module.exports = async (req, res) => {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    console.log('Kommo webhook received:', JSON.stringify(body).substring(0, 500));

    // Kommo sends arrays of leads/contacts under different keys
    const leads = body.leads?.add || body.leads?.update || [];
    const contacts = body.contacts?.add || body.contacts?.update || [];

    // Build contact map for quick lookup
    const contactMap = {};
    contacts.forEach(c => {
      contactMap[c.id] = c;
    });

    const results = [];

    for (const lead of leads) {
      try {
        // Extract contact info
        const contactId = lead.contact_id || lead.main_contact?.id;
        const contact = contactMap[contactId] || lead.main_contact || {};

        // Extract custom fields
        const customFields = {};
        (lead.custom_fields || []).forEach(f => {
          customFields[f.name?.toLowerCase()] = f.values?.[0]?.value || f.value || '';
        });
        (contact.custom_fields || []).forEach(f => {
          customFields[f.name?.toLowerCase()] = f.values?.[0]?.value || f.value || '';
        });

        // Build lead document
        const leadDoc = {
          // Identifiers
          kommoId: String(lead.id || ''),
          kommoContactId: String(contactId || ''),

          // Contact info
          nombre: contact.name || lead.name || '',
          telefono: customFields['teléfono'] || customFields['telefono'] || customFields['phone'] || 
                    contact.phone || '',
          correo: customFields['email'] || customFields['correo'] || contact.email || '',

          // Lead info
          auto: customFields['auto de interés'] || customFields['vehiculo'] || 
                customFields['modelo'] || lead.name || '',
          fuente: lead.source_name || customFields['fuente'] || 'WhatsApp',
          campana: lead.utm_campaign || customFields['campaña'] || '',
          estatus: mapStage(lead.status_name || lead.pipeline_status_name || ''),
          pipeline: lead.pipeline_name || 'Ventas',

          // Assignment
          asesor: lead.responsible_user?.name || lead.responsible?.name || '',
          agencia: 'Autoforum SEAT Puebla', // Default for this account
          agenciaMarca: 'seat',

          // Dates
          fechaCreacion: parseFecha(lead.created_at) || new Date(),
          fechaActualizacion: parseFecha(lead.updated_at) || new Date(),
          fechaUltimaModificacion: new Date(),

          // Source
          fuente_kommo: true,
          raw_stage: lead.status_name || '',
        };

        // Remove empty fields
        Object.keys(leadDoc).forEach(k => {
          if (leadDoc[k] === '' || leadDoc[k] === null || leadDoc[k] === undefined) {
            delete leadDoc[k];
          }
        });

        // Save to Firestore — upsert by kommoId
        const docRef = db.collection('leads_kommo').doc(String(lead.id));
        await docRef.set(leadDoc, { merge: true });

        results.push({ id: lead.id, status: 'saved', nombre: leadDoc.nombre });
        console.log(`✅ Lead ${lead.id} saved: ${leadDoc.nombre}`);

      } catch (leadErr) {
        console.error(`Error processing lead ${lead.id}:`, leadErr);
        results.push({ id: lead.id, status: 'error', error: leadErr.message });
      }
    }

    return res.status(200).json({ 
      ok: true, 
      processed: results.length,
      results 
    });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};
