const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function loadApiKey() {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    return config.GOOGLE_API_KEY;
  } catch {
    return null;
  }
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

    sendJSON(res, 200, {
      location: geo.label,
      totalFound: uniquePlaces.length,
      withoutWebsiteCount: withoutWebsite.length,
      cellsSearched: grid.cellsSearched,
      incomplete: grid.budgetExhausted || grid.depthExhausted || placesTruncated,
      results: withoutWebsite.map((d) => ({
        nom: d.name || '',
        adresse: d.formatted_address || '',
        telephone: d.formatted_phone_number || d.international_phone_number || '',
        note: d.rating != null ? d.rating : '',
        avis: d.user_ratings_total != null ? d.user_ratings_total : '',
        types: (d.types || []).join(', '),
        fiche_google: `https://www.google.com/maps/place/?q=place_id:${d.place_id}`,
      })),
    });
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
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

  serveStatic(req, res, parsed.pathname);
});

server.listen(PORT, () => {
  console.log(`Serveur demarre : http://localhost:${PORT}`);
});
