function isValidEmail(email) {
  if (!email) return false;
  // Basic email validation (good enough for a league bot)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidPhone(phone) {
  if (!phone) return false;
  // Accept +country... or local digits; require at least 7 digits
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7;
}

function cleanTekkenTag(tag) {
  return String(tag || '').trim();
}

function cleanName(name) {
  return String(name || '').trim();
}

module.exports = {
  isValidEmail,
  isValidPhone,
  cleanTekkenTag,
  cleanName,
};
