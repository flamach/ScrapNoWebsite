const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Comptes utilisateurs stockes en JSON sur disque (users.json, gitignore),
// sur le meme modele que db.js pour les contacts : suffisant a l'echelle de
// quelques utilisateurs, pas de dependance native a compiler.
//
// Les sessions sont elles aussi persistees sur disque (sessions.json) : sans
// ca, un redemarrage du serveur (deploiement, crash, redemarrage machine)
// deconnecterait tout le monde malgre un cookie encore valide cote
// navigateur. Le Map en memoire sert de cache rapide, ecrit sur disque a
// chaque creation/suppression/expiration.

const USERS_PATH = path.join(__dirname, 'users.json');
const SESSIONS_PATH = path.join(__dirname, 'sessions.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 semaine
const SESSION_COOKIE = 'session';

function loadSessionsFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessionsToDisk() {
  const plain = Object.fromEntries(sessions);
  const tmpPath = SESSIONS_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(plain, null, 2));
  fs.renameSync(tmpPath, SESSIONS_PATH);
}

const sessions = new Map();
{
  const now = Date.now();
  let pruned = false;
  for (const [token, session] of Object.entries(loadSessionsFromDisk())) {
    if (session.expiresAt < now) {
      pruned = true;
      continue;
    }
    sessions.set(token, session);
  }
  if (pruned) saveSessionsToDisk();
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  const tmpPath = USERS_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(users, null, 2));
  fs.renameSync(tmpPath, USERS_PATH);
}

function findUserByEmail(users, normalizedEmail) {
  return Object.values(users).find((u) => u.email === normalizedEmail) || null;
}

// Premier compte cree, ou email correspondant a ADMIN_EMAIL (config.json) :
// approuve et admin automatiquement. Tous les autres restent en attente
// jusqu'a approbation manuelle par un admin.
function registerUser(email, password, adminEmail) {
  const normalized = (email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Adresse email invalide.');
  }
  if (!password || password.length < 8) {
    throw new Error('Le mot de passe doit contenir au moins 8 caracteres.');
  }

  const users = loadUsers();
  if (findUserByEmail(users, normalized)) {
    throw new Error('Un compte existe deja avec cet email.');
  }

  const isFirstUser = Object.keys(users).length === 0;
  const isAdminEmail = !!adminEmail && normalized === adminEmail.trim().toLowerCase();
  const approved = isFirstUser || isAdminEmail;

  const id = crypto.randomUUID();
  const user = {
    id,
    email: normalized,
    passwordHash: bcrypt.hashSync(password, 10),
    approved,
    isAdmin: approved,
    createdAt: new Date().toISOString(),
  };
  users[id] = user;
  saveUsers(users);
  return user;
}

function verifyLogin(email, password) {
  const users = loadUsers();
  const user = findUserByEmail(users, (email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    throw new Error('Email ou mot de passe incorrect.');
  }
  if (!user.approved) {
    throw new Error("Ce compte est en attente d'approbation par un administrateur.");
  }
  return user;
}

function listPendingUsers() {
  const users = loadUsers();
  return Object.values(users)
    .filter((u) => !u.approved)
    .map(({ passwordHash, ...rest }) => rest)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function approveUser(id) {
  const users = loadUsers();
  const user = users[id];
  if (!user) throw new Error('Utilisateur introuvable.');
  user.approved = true;
  saveUsers(users);
  return user;
}

function rejectUser(id) {
  const users = loadUsers();
  if (!users[id]) throw new Error('Utilisateur introuvable.');
  delete users[id];
  saveUsers(users);
}

function getUserById(id) {
  const users = loadUsers();
  return users[id] || null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  saveSessionsToDisk();
  return token;
}

function destroySession(token) {
  if (!sessions.delete(token)) return;
  saveSessionsToDisk();
}

function getSessionUser(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    saveSessionsToDisk();
    return null;
  }
  const user = getUserById(session.userId);
  if (!user || !user.approved) return null;
  return user;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function sessionCookieHeader(token, { secure, maxAgeSeconds } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

function clearSessionCookieHeader(secure) {
  return sessionCookieHeader('', { secure, maxAgeSeconds: 0 });
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  registerUser,
  verifyLogin,
  listPendingUsers,
  approveUser,
  rejectUser,
  getUserById,
  createSession,
  destroySession,
  getSessionUser,
  parseCookies,
  sessionCookieHeader,
  clearSessionCookieHeader,
};
