module.exports = async (req, res) => {
  const info = {
    node: process.version,
    variableExiste: false,
    jsonValido: false,
    firebaseAdminInstalado: false,
    error: null
  };
  try {
    const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    info.variableExiste = !!raw;
    if (raw) {
      const sa = JSON.parse(raw);
      info.jsonValido = true;
      info.projectId = sa.project_id;
      info.tieneClavePrivada = !!sa.private_key;
    }
    require('firebase-admin');
    info.firebaseAdminInstalado = true;
  } catch (e) {
    info.error = e.message;
  }
  return res.status(200).json(info);
};