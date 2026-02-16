const crypto = require('crypto');

function requireKeyHex() {
  const keyHex = process.env.ENCRYPTION_KEY_HEX;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY_HEX must be set to 64 hex characters (32 bytes).');
  }
  return Buffer.from(keyHex, 'hex');
}

function encryptString(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = requireKeyHex();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${ciphertext.toString('base64')}:${tag.toString('base64')}`;
}

function decryptString(payload) {
  if (!payload) return null;
  const key = requireKeyHex();
  const [ivB64, ctB64, tagB64] = String(payload).split(':');
  if (!ivB64 || !ctB64 || !tagB64) return null;
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

function maskEmail(email) {
  if (!email) return '';
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const safeUser = user.length <= 2 ? user[0] + '*' : user.slice(0, 2) + '*'.repeat(Math.min(10, user.length - 2));
  return `${safeUser}@${domain}`;
}

function maskPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  const last4 = digits.slice(-4);
  return `***${last4}`;
}

module.exports = {
  encryptString,
  decryptString,
  maskEmail,
  maskPhone,
};
