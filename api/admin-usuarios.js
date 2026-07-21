// api/admin-usuarios.js
// Gestión de usuarios — Z Motors Sistema de Citas
// Crear / eliminar usuarios y cambiar contraseñas.
// SOLO puede llamarlo un usuario autenticado cuyo perfil tenga rol 'admin'.
// Las cuentas viven en Firebase Auth (email = username@zmotors.app);
// el perfil (rol, agencia) vive en usuarios_citas SIN campo de contraseña.

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
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
const auth = getAuth();
const DOMINIO = '@zmotors.app';

// Verifica el token del que llama y que su perfil sea admin
async function verificarAdmin(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { error: 'Sin token de autorización' };
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch (e) {
    return { error: 'Token inválido o expirado' };
  }
  const username = String(decoded.email || '').split('@')[0];
  const snap = await db.collection('usuarios_citas')
    .where('username', '==', username)
    .where('activo', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return { error: 'Perfil no encontrado' };
  const perfil = snap.docs[0].data();
  if (perfil.rol !== 'admin') return { error: 'Se requiere rol de administrador' };
  return { ok: true, username };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const admin = await verificarAdmin(req);
    if (!admin.ok) return res.status(403).json({ ok: false, error: admin.error });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const accion = body.accion;

    // ── CREAR USUARIO ──
    if (accion === 'crear') {
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const nombre = String(body.nombre || '').trim();
      const agencia = String(body.agencia || '').trim();
      const agenciaMarca = String(body.agenciaMarca || '').trim();
      const rol = String(body.rol || 'piso');
      if (!username || !nombre || !agencia) return res.status(400).json({ ok: false, error: 'Faltan campos' });
      if (!/^[a-z0-9._-]+$/.test(username)) return res.status(400).json({ ok: false, error: 'Username inválido (solo letras, números, . _ -)' });
      if (password.length < 6) return res.status(400).json({ ok: false, error: 'Contraseña mínima de 6 caracteres' });

      // ¿Ya existe el perfil?
      const existe = await db.collection('usuarios_citas').where('username', '==', username).limit(1).get();
      if (!existe.empty) return res.status(400).json({ ok: false, error: 'Ese username ya existe' });

      // Crear cuenta en Auth (o reutilizar si quedó huérfana)
      const email = username + DOMINIO;
      try {
        await auth.createUser({ email, password, displayName: nombre });
      } catch (e) {
        if (e.code === 'auth/email-already-exists') {
          const u = await auth.getUserByEmail(email);
          await auth.updateUser(u.uid, { password, displayName: nombre });
        } else {
          throw e;
        }
      }
      // Perfil SIN contraseña
      await db.collection('usuarios_citas').add({ username, nombre, agencia, agenciaMarca, rol, activo: true });
      return res.status(200).json({ ok: true });
    }

    // ── ELIMINAR USUARIO ──
    if (accion === 'eliminar') {
      const docId = String(body.docId || '');
      if (!docId) return res.status(400).json({ ok: false, error: 'Falta docId' });
      const ref = db.collection('usuarios_citas').doc(docId);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
      const username = doc.data().username;
      // Borrar cuenta de Auth (si existe)
      try {
        const u = await auth.getUserByEmail(username + DOMINIO);
        await auth.deleteUser(u.uid);
      } catch (e) { /* sin cuenta Auth: continuar */ }
      await ref.delete();
      return res.status(200).json({ ok: true });
    }

    // ── CAMBIAR CONTRASEÑA ──
    if (accion === 'password') {
      const docId = String(body.docId || '');
      const password = String(body.password || '');
      if (!docId) return res.status(400).json({ ok: false, error: 'Falta docId' });
      if (password.length < 6) return res.status(400).json({ ok: false, error: 'Contraseña mínima de 6 caracteres' });
      const doc = await db.collection('usuarios_citas').doc(docId).get();
      if (!doc.exists) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
      const username = doc.data().username;
      const email = username + DOMINIO;
      try {
        const u = await auth.getUserByEmail(email);
        await auth.updateUser(u.uid, { password });
      } catch (e) {
        // Usuario legado sin cuenta Auth: creársela con la nueva contraseña
        await auth.createUser({ email, password, displayName: doc.data().nombre || username });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Acción no reconocida' });
  } catch (e) {
    console.error('admin-usuarios error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Error interno' });
  }
};
