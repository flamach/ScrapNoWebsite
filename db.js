const fs = require('fs');
const path = require('path');

// Petite base de suivi des etablissements contactes, stockee en JSON sur
// disque (contacts.json, gitignore). Un fichier suffit largement a l'echelle
// d'un usage mono-utilisateur, et evite une dependance native (better-sqlite3
// necessite les outils de build Visual Studio, absents de ce poste).
//
// Toutes les operations sont synchrones (fs.*Sync) et ne contiennent aucun
// `await` : comme Node.js execute le code synchrone sans interruption, deux
// appels a markContacted() declenches par des envois concurrents ne peuvent
// jamais s'entrelacer, meme sans verrou explicite.

const DB_PATH = path.join(__dirname, 'contacts.json');

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

function getContactedMap(placeIds) {
  const all = loadAll();
  const map = new Map();
  for (const id of placeIds) {
    if (all[id]) map.set(id, all[id]);
  }
  return map;
}

function markContacted({ place_id, nom, adresse, email, contacted_at }) {
  const all = loadAll();
  all[place_id] = {
    nom: nom || '',
    adresse: adresse || '',
    email: email || '',
    contacted_at,
  };
  saveAll(all);
}

function listAll() {
  const all = loadAll();
  return Object.entries(all)
    .map(([place_id, v]) => ({ place_id, ...v }))
    .sort((a, b) => (a.contacted_at < b.contacted_at ? 1 : -1));
}

module.exports = { getContactedMap, markContacted, listAll };
