module.exports = async (req, res) => {
  const todas = Object.keys(process.env);
  const relacionadas = todas.filter(n => {
    const m = n.toUpperCase();
    return m.includes('GOOGLE') || m.includes('CREDENT') || m.includes('FIREBASE');
  });
  return res.status(200).json({
    totalVariables: todas.length,
    variablesRelacionadas: relacionadas,
    valorExiste: !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  });
};