// api/checkin.js
// Check-in del cliente vía QR — Z Motors Sistema de Citas
// El cliente NO toca Firestore directamente: este endpoint expone
// solo los datos mínimos de SU cita y permite confirmar llegada.

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { credential } = require('firebase-admin');

if (!getApps().length) {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) throw new Error('Falta GOOGLE_APPLICATION_CREDENTIALS_JSON');
  const sa = JSON.parse(raw);
  if (sa.private_key && sa.private_key.includes('\\n')) {
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  }
  initializeApp({ credential: credential.cert(sa), projectId: 'zmotors-2f8f4' });
}

const db = getFirestore();

async function buscarCita(citaId) {
  const snap = await db.collection('citas_agencia').where('citaId', '==', citaId).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0];
}

module.exports = async (req, res) => {
  try {
    // ── GET: datos públicos de la cita ──
    if (req.method === 'GET') {
      const id = String(req.query.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
      const doc = await buscarCita(id);
      if (!doc) return res.status(404).json({ ok: false, error: 'Cita no encontrada' });
      const c = doc.data();
      const fecha = c.fechaCita && c.fechaCita.toDate ? c.fechaCita.toDate() : null;
      return res.status(200).json({
        ok: true,
        cita: {
          nombre: c.nombre || '',
          fechaISO: fecha ? fecha.toISOString() : null,
          horaCita: c.horaCita || '',
          vehiculo: c.vehiculo || '',
          asesor: c.asesor || '',
          agencia: c.agencia || '',
          agenciaMarca: c.agenciaMarca || '',
          asistio: c.asistio || '',
        },
      });
    }

    // ── POST: confirmar llegada ──
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
      const doc = await buscarCita(id);
      if (!doc) return res.status(404).json({ ok: false, error: 'Cita no encontrada' });
      const c = doc.data();
      // Idempotente: si ya asistió (o ya es venta), no sobreescribir
      if (c.asistio === 'Si' || c.asistio === 'Venta') {
        return res.status(200).json({ ok: true, ya: true });
      }
      await doc.ref.update({
        asistio: 'Si',
        fechaCheckin: FieldValue.serverTimestamp(),
        checkinVia: 'qr_cliente',
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('checkin error:', e);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
};
