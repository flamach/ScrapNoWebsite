const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const nodemailer = require('nodemailer');
const db = require('./db');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function loadApiKey() {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  return loadConfig().GOOGLE_API_KEY || null;
}

// Renvoie les identifiants SMTP a utiliser pour l'envoi de mails, ou null si
// la configuration est absente/incomplete (l'envoi reste alors desactive cote
// serveur, l'UI l'indique clairement plutot que d'echouer silencieusement).
function loadSmtpConfig() {
  const config = loadConfig();
  const host = process.env.SMTP_HOST || config.SMTP_HOST;
  const user = process.env.SMTP_USER || config.SMTP_USER;
  const pass = process.env.SMTP_PASS || config.SMTP_PASS;
  const port = parseInt(process.env.SMTP_PORT || config.SMTP_PORT || '587', 10);
  const from = process.env.SMTP_FROM || config.SMTP_FROM || user;
  if (!host || !user || !pass) return null;
  return { host, port, user, pass, from };
}

const API_KEY = loadApiKey();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Nearby Search plafonne a 20 resultats par page, et la pagination
// (next_page_token) s'est averee peu fiable sur ce projet Google Cloud.
// Plutot que de compter sur la pagination, on subdivise automatiquement toute
// zone "pleine" (20 resultats, donc potentiellement saturee) en 4 sous-cercles
// qui recouvrent entierement le cercle parent. Une branche arrete de se
// subdiviser des qu'elle renvoie moins de 20 resultats (plus de nouveaux
// etablissements a trouver) : c'est ce qui fait converger la recherche sans
// reglage manuel. MAX_GRID_DEPTH n'est qu'un garde-fou de securite.
const PAGE_SIZE = 20;
const MAX_GRID_DEPTH = 5;
const MIN_CELL_RADIUS = 100; // metres
const MAX_CELLS_SEARCHED = 300; // garde-fou budget/temps
const MAX_PLACES_FOR_DETAILS = 800; // garde-fou cout API Place Details

// Point de destination a distance/cap donnes depuis un point (formule great-circle).
function offsetLatLng(lat, lng, distanceMeters, bearingDeg) {
  const R = 6371000;
  const bearing = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const angularDist = distanceMeters / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDist) + Math.cos(lat1) * Math.sin(angularDist) * Math.cos(bearing)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDist) * Math.cos(lat1),
      Math.cos(angularDist) - Math.sin(lat1) * Math.sin(lat2)
    );

  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
}

async function geocodePostalCode(postalCode) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('components', `postal_code:${postalCode}|country:FR`);
  url.searchParams.set('language', 'fr');
  url.searchParams.set('key', API_KEY);

  const r = await fetch(url);
  const data = await r.json();

  if (data.status !== 'OK' || !data.results || !data.results.length) {
    throw new Error(
      `Geocodage impossible pour le code postal ${postalCode} (${data.status}${
        data.error_message ? ': ' + data.error_message : ''
      })`
    );
  }

  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, label: data.results[0].formatted_address };
}

async function nearbySearchPage(lat, lng, radius, keyword) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
  url.searchParams.set('location', `${lat},${lng}`);
  url.searchParams.set('radius', String(radius));
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('language', 'fr');
  url.searchParams.set('key', API_KEY);

  const r = await fetch(url);
  const data = await r.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Erreur Places API (${data.status}${data.error_message ? ': ' + data.error_message : ''})`);
  }

  return data.results || [];
}

// Recherche en grille : explore le cercle demande, et subdivise
// automatiquement (par niveaux, en parallele) toute cellule qui revient
// pleine (20 resultats) ET qui a reellement revele de nouveaux
// etablissements. Une recherche par mot-cle (pas par type strict) peut
// renvoyer des correspondances approximatives qui remplissent presque
// n'importe quel cercle a 20 resultats sans que la zone soit reellement
// dense ; se baser uniquement sur "page pleine" ferait donc subdiviser
// indefiniment. On ne continue une branche que si elle apporte au moins
// NEW_RESULTS_THRESHOLD etablissements jamais vus ailleurs — des que le
// nombre total d'etablissements arrete de grimper, la branche s'arrete.
async function gridSearch(lat, lng, radius, keyword, maxDepth) {
  const NEW_RESULTS_THRESHOLD = 3;
  const placesById = new Map();
  let cellsToVisit = [{ lat, lng, radius, depth: 0 }];
  let cellsSearched = 0;
  let budgetExhausted = false;
  let depthExhausted = false;

  while (cellsToVisit.length > 0) {
    const currentLevel = cellsToVisit;
    cellsToVisit = [];

    const levelResults = await mapLimit(currentLevel, 6, async (cell) => {
      if (cellsSearched >= MAX_CELLS_SEARCHED) {
        budgetExhausted = true;
        return null;
      }
      cellsSearched++;
      const places = await nearbySearchPage(cell.lat, cell.lng, cell.radius, keyword);
      return { cell, places };
    });

    for (const entry of levelResults) {
      if (!entry) continue;
      const { cell, places } = entry;

      let newCount = 0;
      for (const p of places) {
        if (!placesById.has(p.place_id)) newCount++;
        placesById.set(p.place_id, p);
      }

      const isFull = places.length >= PAGE_SIZE;
      const stillGrowing = newCount >= NEW_RESULTS_THRESHOLD;
      const childRadius = (cell.radius / Math.SQRT2) * 1.1;
      const canSubdivide = cell.depth < maxDepth && childRadius >= MIN_CELL_RADIUS;

      if (isFull && stillGrowing && !canSubdivide) {
        depthExhausted = true;
      } else if (isFull && stillGrowing && canSubdivide) {
        const offsetDist = cell.radius / Math.SQRT2;
        for (const bearing of [45, 135, 225, 315]) {
          const c = offsetLatLng(cell.lat, cell.lng, offsetDist, bearing);
          cellsToVisit.push({ lat: c.lat, lng: c.lng, radius: childRadius, depth: cell.depth + 1 });
        }
      }
    }

    if (budgetExhausted) break;
  }

  return {
    places: Array.from(placesById.values()),
    cellsSearched,
    budgetExhausted,
    depthExhausted,
  };
}

async function getDetails(placeId) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set(
    'fields',
    'name,formatted_address,formatted_phone_number,international_phone_number,website,rating,user_ratings_total,business_status,types'
  );
  url.searchParams.set('language', 'fr');
  url.searchParams.set('key', API_KEY);

  const r = await fetch(url);
  const data = await r.json();

  if (data.status !== 'OK') {
    return null;
  }
  return data.result;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function handleSearch(req, res, query) {
  try {
    const postalCode = (query.get('postalCode') || '').trim();
    const tag = (query.get('tag') || '').trim();
    const radius = Math.min(Math.max(parseInt(query.get('radius') || '4000', 10) || 4000, 200), 50000);

    if (!/^\d{5}$/.test(postalCode)) {
      return sendJSON(res, 400, { error: 'Code postal invalide (5 chiffres attendus).' });
    }
    if (!tag) {
      return sendJSON(res, 400, { error: 'Le tag / la categorie est requis.' });
    }
    if (!API_KEY) {
      return sendJSON(res, 500, { error: "Cle API Google manquante dans config.json." });
    }

    const geo = await geocodePostalCode(postalCode);
    const grid = await gridSearch(geo.lat, geo.lng, radius, tag, MAX_GRID_DEPTH);

    let uniquePlaces = grid.places;
    let placesTruncated = false;
    if (uniquePlaces.length > MAX_PLACES_FOR_DETAILS) {
      uniquePlaces = uniquePlaces.slice(0, MAX_PLACES_FOR_DETAILS);
      placesTruncated = true;
    }

    const details = await mapLimit(uniquePlaces, 8, async (p) => {
      const d = await getDetails(p.place_id);
      return d
        ? { ...d, place_id: p.place_id }
        : { name: p.name, formatted_address: p.vicinity, place_id: p.place_id, business_status: p.business_status };
    });

    const withoutWebsite = details.filter(
      (d) => d && !d.website && d.business_status !== 'CLOSED_PERMANENTLY'
    );

    const contactedMap = db.getContactedMap(withoutWebsite.map((d) => d.place_id));

    sendJSON(res, 200, {
      location: geo.label,
      totalFound: uniquePlaces.length,
      withoutWebsiteCount: withoutWebsite.length,
      cellsSearched: grid.cellsSearched,
      incomplete: grid.budgetExhausted || grid.depthExhausted || placesTruncated,
      results: withoutWebsite.map((d) => {
        const contact = contactedMap.get(d.place_id);
        return {
          place_id: d.place_id,
          nom: d.name || '',
          adresse: d.formatted_address || '',
          telephone: d.formatted_phone_number || d.international_phone_number || '',
          note: d.rating != null ? d.rating : '',
          avis: d.user_ratings_total != null ? d.user_ratings_total : '',
          types: (d.types || []).join(', '),
          fiche_google: `https://www.google.com/maps/place/?q=place_id:${d.place_id}`,
          contacted: !!contact,
          contactedAt: contact ? contact.contacted_at : null,
        };
      }),
    });
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

// --- Recherche d'email (best-effort) ---------------------------------------
//
// Google Places ne fournit jamais d'email. On tente donc de le retrouver en
// cherchant l'etablissement sur le web (recherche DuckDuckGo HTML, qui ne
// necessite pas de cle API) puis en scannant les premieres pages de resultat
// a la recherche d'une adresse email plausible. C'est un heuristique best
// effort : ca ne trouvera pas toujours un resultat, et le champ reste
// editable manuellement cote UI.

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const DOMAIN_BLACKLIST = [
  'sentry.io', 'wixpress.com', 'wix.com', 'godaddy.com', 'schema.org',
  'example.com', 'w3.org', 'gstatic.com', 'google.com', 'googleapis.com',
  'googletagmanager.com', 'cloudflare.com', 'doubleclick.net', 'github.com',
  'npmjs.com', 'jquery.com', 'fontawesome.com', 'sentry-cdn.com',
  'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com',
  'linkedin.com', 'youtube.com', 'wikipedia.org', 'amazon.fr', 'amazon.com',
  'indeed.com', 'glassdoor.fr', 'pagesjaunes.fr', 'sentry.wixpress.com',
];

const LOCALPART_BLACKLIST = [
  'noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster', 'abuse', 'privacy',
];

// Domaines a eviter en resultat de recherche (peu de chances de contenir un
// email exploitable via un simple fetch HTML, souvent bloques ou en JS pur).
const SEARCH_RESULT_SKIP_DOMAINS = [
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'wikipedia.org', 'amazon.fr', 'amazon.com', 'indeed.com',
  'glassdoor.fr', 'tripadvisor.fr', 'tripadvisor.com',
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function webSearchUrls(query, maxResults) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);

  const r = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });
  const html = await r.text();

  const urls = [];
  const linkRegex = /class="result__a"[^>]*href="([^"]+)"/g;
  let m;
  while ((m = linkRegex.exec(html)) && urls.length < maxResults) {
    let href = m[1].replace(/&amp;/g, '&');
    if (href.includes('duckduckgo.com/l/')) {
      const uddg = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg');
      if (uddg) href = decodeURIComponent(uddg);
    }
    if (/^https?:\/\//.test(href)) urls.push(href);
  }
  return urls;
}

function extractEmails(html) {
  const matches = html.match(EMAIL_REGEX) || [];
  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    const email = raw.toLowerCase();
    const domain = email.split('@')[1] || '';
    const localPart = email.split('@')[0] || '';
    if (seen.has(email)) continue;
    if (DOMAIN_BLACKLIST.some((d) => domain.endsWith(d))) continue;
    if (LOCALPART_BLACKLIST.some((l) => localPart.includes(l))) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

async function findEmailForEstablishment(nom, adresse) {
  const query = `"${nom}" ${adresse} email contact`;

  let urls;
  try {
    urls = await webSearchUrls(query, 6);
  } catch {
    return '';
  }

  for (const url of urls) {
    const domain = hostnameOf(url);
    if (!domain || SEARCH_RESULT_SKIP_DOMAINS.some((d) => domain.endsWith(d))) continue;

    try {
      const r = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const html = await r.text();
      const emails = extractEmails(html);
      if (emails.length) return emails[0];
    } catch {
      continue;
    }
  }
  return '';
}

async function handleFindEmail(req, res, query) {
  try {
    const nom = (query.get('nom') || '').trim();
    const adresse = (query.get('adresse') || '').trim();
    if (!nom) {
      return sendJSON(res, 400, { error: 'Nom requis.' });
    }
    const email = await findEmailForEstablishment(nom, adresse);
    sendJSON(res, 200, { email });
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

// --- Envoi de mails ----------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error('Payload trop volumineux.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleSendEmail(req, res) {
  try {
    const raw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      return sendJSON(res, 400, { error: 'JSON invalide.' });
    }

    const { recipients, subject, body } = payload;
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return sendJSON(res, 400, { error: 'Aucun destinataire selectionne.' });
    }
    if (!subject || !body) {
      return sendJSON(res, 400, { error: "L'objet et le corps du message sont requis." });
    }

    const smtp = loadSmtpConfig();
    if (!smtp) {
      return sendJSON(res, 400, {
        error:
          "Configuration SMTP manquante. Ajoutez SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (et optionnellement SMTP_FROM) dans config.json pour activer l'envoi depuis flamach@quentin-machado.com.",
      });
    }

    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    const results = await mapLimit(recipients, 3, async (rcpt) => {
      const to = (rcpt.to || '').trim();
      if (!emailRegex.test(to)) {
        return { to, success: false, error: 'Adresse email invalide.' };
      }
      try {
        await transporter.sendMail({
          from: smtp.from,
          to,
          subject: String(subject).replace(/\{\{\s*nom\s*\}\}/g, rcpt.nom || ''),
          text: String(body).replace(/\{\{\s*nom\s*\}\}/g, rcpt.nom || ''),
        });
        if (rcpt.place_id) {
          db.markContacted({
            place_id: rcpt.place_id,
            nom: rcpt.nom,
            adresse: rcpt.adresse,
            email: to,
            contacted_at: new Date().toISOString(),
          });
        }
        return { to, success: true };
      } catch (err) {
        return { to, success: false, error: err.message };
      }
    });

    sendJSON(res, 200, { results });
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

function handleListContacts(req, res) {
  sendJSON(res, 200, { contacts: db.listAll() });
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);

  if (parsed.pathname === '/api/search' && req.method === 'GET') {
    handleSearch(req, res, parsed.searchParams);
    return;
  }

  if (parsed.pathname === '/api/find-email' && req.method === 'GET') {
    handleFindEmail(req, res, parsed.searchParams);
    return;
  }

  if (parsed.pathname === '/api/send-email' && req.method === 'POST') {
    handleSendEmail(req, res);
    return;
  }

  if (parsed.pathname === '/api/contacts' && req.method === 'GET') {
    handleListContacts(req, res);
    return;
  }

  serveStatic(req, res, parsed.pathname);
});

server.listen(PORT, () => {
  console.log(`Serveur demarre : http://localhost:${PORT}`);
});
