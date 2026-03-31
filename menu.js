// GramHunt — Live Menu Serverless Function
// Uses iHeartJane's public embed API + store search

const https = require('https');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = https.get({
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.iheartjane.com/',
        'Origin': 'https://www.iheartjane.com',
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ ok: false, status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// Clean up product names from Jane's format
function cleanName(raw) {
  return (raw || '')
    .replace(/\s+C\d{7,}/g, '')           // lot codes C0040001468
    .replace(/\s+0\d{4,}/g, '')           // batch codes 01234
    .replace(/\s+TC\s+[\d.]+%/gi, '')     // TC percentages
    .replace(/\s+\([ISDHCB]\)/g, '')      // (I) (S) (H) type tags
    .replace(/\s*\*NP\s*/g, '')           // *NP tag
    .replace(/\s+[\d.]+%\s*$/g, '')       // trailing percentages
    .replace(/\s+\d{4,}\s*$/g, '')        // trailing SKUs
    .replace(/\s+(Flower|flower)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getType(lineage = '') {
  const l = lineage.toLowerCase();
  if (l.includes('indica')) return 'indica';
  if (l.includes('sativa')) return 'sativa';
  if (l.includes('cbd')) return 'cbd';
  return 'hybrid';
}

const WEIGHT_MAP = {
  '1g': '1g', 'gram': '1g',
  '3.5g': '3.5g', 'eighth': '3.5g', '1/8': '3.5g', '3.5 grams': '3.5g',
  '7g': '7g', 'quarter': '7g', '1/4': '7g', '7 grams': '7g',
  '14g': '14g', 'half': '14g', '1/2': '14g', '14 grams': '14g',
  '28g': '28g', 'ounce': '28g', '1oz': '28g', 'oz': '28g', '28 grams': '28g',
};

function normalizeWeight(raw = '') {
  const r = raw.toLowerCase().trim();
  for (const [k, v] of Object.entries(WEIGHT_MAP)) {
    if (r.includes(k)) return v;
  }
  return null;
}

async function fetchStoreMenu(storeId) {
  const url = `https://www.iheartjane.com/api/v1/stores/${storeId}/menu_products?kind[]=flower&limit=100&offset=0&sort_by=position&available=true`;
  const res = await httpGet(url);
  if (!res.ok || !res.data) return [];

  const raw = res.data.menu_products || res.data || [];
  const products = [];
  const seen = new Set();

  for (const p of raw) {
    try {
      const name = cleanName(p.name || '');
      if (!name || name.length < 3) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const thc = parseFloat(p.percent_thc || p.max_thc || 0);
      if (thc < 0.5) continue;

      const type = getType(p.lineage || p.kind_subtype || '');

      // Build prices from variants
      const prices = {};
      const variants = p.variants || [];
      for (const v of variants) {
        const w = normalizeWeight(v.option || v.size || v.weight || '');
        if (!w) continue;
        const price = v.special_price_cents
          ? v.special_price_cents / 100
          : v.price_cents
          ? v.price_cents / 100
          : parseFloat(v.special_price || v.price || 0);
        if (price > 0) prices[w] = price;
      }
      // Skip 1g — user doesn't want it
      delete prices['1g'];
      if (Object.keys(prices).length === 0) continue;

      const onSale = variants.some(v =>
        v.special_price_cents && v.price_cents && v.special_price_cents < v.price_cents
      );

      products.push({ name, type, thc, prices, onSale, sid: String(storeId) });
    } catch(e) { continue; }
  }
  return products;
}

async function findNearbyStores(lat, lng, radius) {
  // Try Jane's store search
  const url = `https://www.iheartjane.com/api/v1/stores?lat=${lat}&lng=${lng}&radius=${radius}&rec_menu=true&med_menu=true&limit=20`;
  const res = await httpGet(url);
  if (!res.ok || !res.data) return [];

  const stores = res.data.stores || res.data || [];
  return stores.map((s, i) => ({
    id: String(s.id),
    name: s.name || 'Dispensary',
    short: (s.name || '').split(/[-–—]/)[0].trim().split(' ').slice(0,2).join(' '),
    city: `${s.city || ''}, ${s.state || ''}`.trim().replace(/^,\s*/, ''),
    state: s.state || 'CT',
    dist: Math.round((s.distance_miles || 0) * 10) / 10,
    rating: parseFloat(s.rating || 4.5).toFixed(1),
    hours: s.todays_hours_str || '',
    lat: s.lat,
    lng: s.lng,
    url: `https://www.iheartjane.com/stores/${s.id}/${s.slug || s.id}/menu/flower`,
    color: ['#39d353','#22d3ee','#a78bfa','#f97316','#fbbf24','#34d399','#f472b6','#fb923c','#60a5fa','#e879f9'][i % 10],
  }));
}

exports.handler = async (event) => {
  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const p = event.queryStringParameters || {};
  const lat = parseFloat(p.lat || '41.8408');
  const lng = parseFloat(p.lng || '-72.4509');
  const rad = parseFloat(p.radius || '25');

  try {
    // Step 1: Find nearby stores
    const stores = await findNearbyStores(lat, lng, rad);

    if (!stores.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        stores: [], products: [], count: 0, error: 'No dispensaries found in this area'
      })};
    }

    // Step 2: Fetch menus concurrently (max 8 stores to stay within timeout)
    const storeSlice = stores.slice(0, 8);
    const results = await Promise.allSettled(
      storeSlice.map(s => fetchStoreMenu(s.id))
    );

    const allProducts = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        allProducts.push(...r.value);
        storeSlice[i].productCount = r.value.length;
      } else {
        storeSlice[i].productCount = 0;
      }
    });

    // Only return stores that have products
    const activeStores = storeSlice.filter(s => s.productCount > 0);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        stores: activeStores,
        products: allProducts,
        count: allProducts.length,
        storeCount: activeStores.length,
        scrapedAt: new Date().toISOString(),
      })
    };

  } catch(err) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ stores: [], products: [], count: 0, error: err.message })
    };
  }
};
