function isValidEmail(email) {
  if (!email) return false;
  const normalized = String(email).trim().toLowerCase();
  if (normalized.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizePhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';

  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');

  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

function isValidPhone(phone) {
  if (!phone) return false;
  const normalized = normalizePhone(phone);
  const digits = normalized.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function cleanTekkenTag(tag) {
  return String(tag || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

module.exports = {
  isValidEmail,
  isValidPhone,
  normalizeEmail,
  normalizePhone,
  cleanTekkenTag,
  cleanName,
};
