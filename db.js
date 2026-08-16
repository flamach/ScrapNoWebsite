const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Suivi commercial des etablissements (contactes par email ou ajoutes a la
// main), stocke en JSON sur disque (contacts.json, gitignore). Un fichier
// suffit largement a l'echelle d'un usage a quelques utilisateurs, et evite
// une dependance native (better-sqlite3 necessite les outils de build Visual
// Studio, absents de ce poste).
//
// Toutes les operations sont synchrones (fs.*Sync) et ne contiennent aucun
// `await` : comme Node.js execute le code synchrone sans interruption, deux
// appels concurrents ne peuvent jamais s'entrelacer, meme sans verrou
// explicite.

const DB_PATH = path.join(__dirname, 'contacts.json');

const STATUSES = ['a_contacter', 'contacte', 'relance', 'interesse', 'rdv', 'signe', 'refuse', 'sans_reponse'];
const DEFAULT_STATUS = 'a_contacter';

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveAll(data) {
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

// Ne renvoie que les etablissements reellement contactes par email (pas les
// entrees ajoutees a la main et pas encore contactees), pour l'avertissement
// de doublon lors d'une recherche.
function getContactedMap(placeIds) {
  const all = loadAll();
  const map = new Map();
  for (const id of placeIds) {
    if (all[id] && all[id].contacted_at) map.set(id, all[id]);
  }
  return map;
}

function markContacted({ place_id, nom, adresse, telephone, email, contacted_at }) {
  const all = loadAll();
  const existing = all[place_id] || {};
  all[place_id] = {
    nom: nom || existing.nom || '',
    adresse: adresse || existing.adresse || '',
    telephone: telephone || existing.telephone || '',
    email: email || existing.email || '',
    status: 'contacte',
    notes: existing.notes || '',
    created_at: existing.created_at || contacted_at,
    contacted_at,
    updated_at: contacted_at,
  };
  saveAll(all);
}

function addManual({ nom, adresse, telephone, email, status, notes }) {
  const all = loadAll();
  const id = 'manual_' + crypto.randomUUID();
  const now = new Date().toISOString();
  all[id] = {
    nom: nom || '',
    adresse: adresse || '',
    telephone: telephone || '',
    email: email || '',
    status: STATUSES.includes(status) ? status : DEFAULT_STATUS,
    notes: notes || '',
    created_at: now,
    contacted_at: null,
    updated_at: now,
  };
  saveAll(all);
  return { place_id: id, ...all[id] };
}

function updateEntry(place_id, { status, notes, nom, adresse, telephone, email }) {
  const all = loadAll();
  const entry = all[place_id];
  if (!entry) throw new Error('Etablissement introuvable.');

  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new Error('Statut invalide.');
    entry.status = status;
  }
  if (notes !== undefined) entry.notes = notes;
  if (nom !== undefined) entry.nom = nom;
  if (adresse !== undefined) entry.adresse = adresse;
  if (telephone !== undefined) entry.telephone = telephone;
  if (email !== undefined) entry.email = email;
  entry.updated_at = new Date().toISOString();

  all[place_id] = entry;
  saveAll(all);
  return { place_id, ...entry };
}

function removeEntry(place_id) {
  const all = loadAll();
  if (!all[place_id]) throw new Error('Etablissement introuvable.');
  delete all[place_id];
  saveAll(all);
}

function listAll() {
  const all = loadAll();
  return Object.entries(all)
    .map(([place_id, v]) => ({ status: DEFAULT_STATUS, notes: '', ...v, place_id }))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

module.exports = {
  STATUSES,
  DEFAULT_STATUS,
  getContactedMap,
  markContacted,
  addManual,
  updateEntry,
  removeEntry,
  listAll,
};
