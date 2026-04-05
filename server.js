/**
 * GramHunt — Express Server
 * Scrapes nearby CT dispensaries via iHeartJane & serves an AI deal assistant.
 *
 *   npm install
 *   OPENAI_API_KEY=sk-... node server.js
 */
const express = require('express');
const https   = require('https');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpGet(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: {
            'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept':          'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer':         'https://www.iheartjane.com/',
            'Origin':          'https://www.iheartjane.com',
          }
        }, res => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => {
            if (body.trim().startsWith('Throttled') || body.trim() === 'Too Many Requests') {
              reject(new Error('Throttled'));
            } else {
              try { resolve(JSON.parse(body)); }
              catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timed out')); });
      });
      return result;
    } catch (err) {
      if (err.message === 'Throttled' && attempt < retries) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

// ─── Name cleaning ────────────────────────────────────────────────────────────
function cleanName(raw = '') {
  return raw
    .replace(/\s*[-–—|]\s*(sativa|indica|hybrid|cbd|thc|flower|pre.?roll|cart|vape|edible|concentrate|extract|wax|shatter|rosin|live\s+resin|distillate)[^$]*/gi, '')
    .replace(/\s*\(?(sativa|indica|hybrid)\)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getType(raw = '') {
  const s = (raw || '').toLowerCase();
  if (s.includes('sativa'))  return 'sativa';
  if (s.includes('indica'))  return 'indica';
  if (s.includes('hybrid'))  return 'hybrid';
  if (s.includes('cbd'))     return 'cbd';
  return 'hybrid';
}

// ─── Weight normalization ─────────────────────────────────────────────────────
const WEIGHT_MAP = {
  '1g':'1g', '1 g':'1g', 'gram':'1g', '1gram':'1g',
  '3.5g':'3.5g', '3.5 g':'3.5g', 'eighth':'3.5g', '1/8':'3.5g',
  '1.8oz':'3.5g', '1/8 oz':'3.5g',
  '7g':'7g',  '7 g':'7g',  'quarter':'7g', '1/4':'7g',
  '1/4oz':'7g', '1/4 oz':'7g',
  '14g':'14g', '14 g':'14g', 'half':'14g', 'half oz':'14g',
  '1/2':'14g', '1/2oz':'14g', '1/2 oz':'14g',
  '28g':'28g', '28 g':'28g', 'ounce':'28g', 'oz':'28g',
  '1oz':'28g', '1 oz':'28g',
};

function normalizeWeight(w = '') {
  const wl = w.toLowerCase().trim().replace(/\s+/g, '');
  if (WEIGHT_MAP[wl]) return WEIGHT_MAP[wl];
  for (const [abbr, canon] of [['3.5','3.5g'],['14','14g'],['28','28g'],['7','7g'],['1','1g']]) {
    if (wl.startsWith(abbr)) return canon;
  }
  return w || '3.5g';
}

// ─── Fetch one store's menu ───────────────────────────────────────────────────
async function fetchStoreMenu(store) {
  const BASE    = 'https://api.iheartjane.com/v1';
  const storeId = store.id;
  let products  = [];

  try {
    const url  = `${BASE}/stores/${storeId}/menu_products?kind[]=flower&kind[]=pre-roll&kind[]=vaporizers&kind[]=concentrate&per_page=200`;
    const data = await httpGet(url);
    const raw  = Array.isArray(data) ? data
               : (data.data || data.products || data.menu_products || []);

    for (const p of raw) {
      try {
        const name      = cleanName(p.name || p.product?.name || '');
        if (!name) continue;

        const strainType = getType(p.kind || p.strain_type || p.type || '');
        const thcPct     = parseFloat(p.thc_percentage || p.percent_thc || p.thc || 0) || null;
        const cbdPct     = parseFloat(p.cbd_percentage || p.percent_cbd || p.cbd || 0) || null;
        const brand      = p.brand || p.producer || '';
        const onSale     = !!(p.on_sale || p.special_price || p.discount_amount);
        const imgUrl     = p.photo?.urls?.original || p.image_url || p.photo_url || '';

        // Build prices object from variants
        let prices = {};
        const variants = p.variants || p.prices || [];
        for (const v of variants) {
          const w  = normalizeWeight(v.weight || v.option || '');
          const pr = parseFloat(v.price_with_tax || v.price || v.amount || 0);
          if (w && pr > 0) prices[w] = pr;
        }
        // Fallback: single price
        if (!Object.keys(prices).length && p.price) {
          const w = normalizeWeight(p.weight || p.amount || '3.5g');
          prices[w] = parseFloat(p.price);
        }
        if (!Object.keys(prices).length) continue;

        // Best/cheapest price for sorting
        const minPrice = Math.min(...Object.values(prices));
        // Price-per-gram calculation (best value)
        const GRAMS = { '1g':1, '3.5g':3.5, '7g':7, '14g':14, '28g':28 };
        const ppg = Object.entries(prices).reduce((best, [w, pr]) => {
          const g = GRAMS[w]; if (!g) return best;
          const ratio = pr / g;
          return (!best || ratio < best.ratio) ? { ratio, weight: w, price: pr } : best;
        }, null);

        products.push({
          id:         `${storeId}_${name.toLowerCase().replace(/\s+/g,'_')}`,
          storeId:    storeId,
          storeName:  store.name,
          storeCity:  store.city,
          name,
          brand,
          type:       strainType,
          category:   (p.kind || p.category || 'flower').toLowerCase(),
          thc:        thcPct,
          cbd:        cbdPct,
          prices,
          price:      minPrice,
          pricePerGram: ppg?.ratio ? Math.round(ppg.ratio * 100) / 100 : null,
          bestWeight: ppg?.weight || Object.keys(prices)[0],
          onSale,
          imageUrl:   imgUrl,
          url:        p.custom_product_url || `https://www.iheartjane.com/stores/${storeId}`,
        });
      } catch (err) {
        // skip bad products
      }
    }
  } catch (err) {
    console.error(`  ✗ Failed to fetch menu for ${store.name}: ${err.message}`);
  }

  return products;
}

// ─── Discover nearby stores ───────────────────────────────────────────────────
async function findNearbyStores(lat, lng, radiusMiles = 25) {
  const BASE = 'https://api.iheartjane.com/v1';
  try {
    const url  = `${BASE}/stores?lat=${lat}&lng=${lng}&radius=${radiusMiles}&types[]=recreational&types[]=medical`;
    const data = await httpGet(url);
    const raw  = Array.isArray(data) ? data : (data.stores || data.data || []);

    if (raw.length > 0) console.log('[stores] first store keys:', Object.keys(raw[0]).join(', '));
    return raw.slice(0, 20).map(s => ({
      id:      s.id || s.store_id || s.store?.id,
      name:    s.name || s.store_name || s.dispensary_name || s.store?.name || 'Unknown Dispensary',
      city:    s.city || '',
      state:   s.state || 'CT',
      address: [s.address, s.city, s.state].filter(Boolean).join(', '),
      phone:   s.phone || '',
      url:     s.custom_store_url || `https://www.iheartjane.com/stores/${s.id}`,
      rating:  s.rating || null,
      distance: s.distance_in_miles || null,
    }));
  } catch (err) {
    console.error('Store discovery failed:', err.message);
    return [];
  }
}

// ─── CT Cannabis Tax Calculator ───────────────────────────────────────────────
// CT excise: $0.00625/mg THC (if THC% known), plus 6.35% sales + 3% municipal
// We display post-tax prices already from iHeartJane, so this is informational.
function estimateTax(price) {
  const salesTax = price * 0.0635;
  const muniTax  = price * 0.03;
  return {
    base:  +(price / 1.0935).toFixed(2),
    sales: +salesTax.toFixed(2),
    muni:  +muniTax.toFixed(2),
    total: +price.toFixed(2),
  };
}

// ─── GET /api/menu ─────────────────────────────────────────────────────────────
app.get('/api/menu', async (req, res) => {
  const lat    = parseFloat(req.query.lat    || process.env.DEFAULT_LAT    || '41.7637');
  const lng    = parseFloat(req.query.lng    || process.env.DEFAULT_LON    || '-72.6851');
  const radius = parseFloat(req.query.radius || process.env.DEFAULT_RADIUS || '25');

  console.log(`[/api/menu] lat=${lat} lng=${lng} radius=${radius}mi`);

  try {
    const stores = await findNearbyStores(lat, lng, radius);
    if (!stores.length) return res.json({ stores: [], products: [], count: 0, storeCount: 0 });

    // Scrape stores sequentially to avoid throttling (free tier is single-threaded anyway)
    const CONCURRENCY = 2;
    let allProducts = [];
    for (let i = 0; i < stores.length; i += CONCURRENCY) {
      const batch   = stores.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(s => fetchStoreMenu(s)));
      allProducts   = allProducts.concat(results.flat());
      if (i + CONCURRENCY < stores.length) await sleep(400); // respect rate limits
    }

    // Sort by best value (price per gram)
    allProducts.sort((a, b) => (a.pricePerGram || 999) - (b.pricePerGram || 999));

    res.json({
      stores,
      products:   allProducts,
      count:      allProducts.length,
      storeCount: stores.length,
      scrapedAt:  new Date().toISOString(),
      location:   { lat, lng, radiusMiles: radius },
    });
  } catch (err) {
    console.error('/api/menu error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/chat ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { query = '', products = [], stores = [] } = req.body;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.json({ answer: buildFallbackAnswer(query, products, stores) });
  }

  // Build context from top 50 products
  const topProducts = products.slice(0, 50);
  const productLines = topProducts.map((p, i) =>
    `${i+1}. ${p.name}${p.brand ? ` by ${p.brand}` : ''} @ ${p.storeName} (${p.storeCity}) ` +
    `| Type: ${p.type} | THC: ${p.thc ? p.thc+'%' : 'N/A'} ` +
    `| Prices: ${Object.entries(p.prices).map(([w,pr]) => `${w}=$${pr}`).join(', ')} ` +
    `| $/g: ${p.pricePerGram ? '$'+p.pricePerGram : 'N/A'}${p.onSale ? ' 🔥SALE' : ''}`
  ).join('\n');

  const storeList = stores.map(s => `${s.name} in ${s.city}`).join(', ');

  const systemPrompt = `You are GramHunt, a cannabis deal expert for Connecticut dispensaries.
You help users find the best deals on flower, pre-rolls, vapes, and concentrates.
Answer concisely and helpfully. Recommend specific products with prices.
Available dispensaries: ${storeList}
Current inventory (sorted best value first):
${productLines}`;

  try {
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: query },
      ],
      temperature: 0.7,
      max_tokens: 600,
    });

    const answer = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'api.openai.com',
        path:     '/v1/chat/completions',
        method:   'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, resp => {
        let body = '';
        resp.on('data', d => body += d);
        resp.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(j.choices?.[0]?.message?.content || buildFallbackAnswer(query, products, stores));
          } catch (e) { reject(e); }
        });
      });
      req2.on('error', reject);
      req2.write(payload);
      req2.end();
    });

    res.json({ answer });
  } catch (err) {
    console.error('/api/chat OpenAI error:', err.message);
    res.json({ answer: buildFallbackAnswer(query, products, stores) });
  }
});

// ─── Rule-based fallback (no API key needed) ──────────────────────────────────
function buildFallbackAnswer(query, products, stores) {
  const q = query.toLowerCase();

  let filtered = [...products];

  // Type filters
  if (q.includes('sativa'))  filtered = filtered.filter(p => p.type === 'sativa');
  else if (q.includes('indica'))  filtered = filtered.filter(p => p.type === 'indica');
  else if (q.includes('hybrid'))  filtered = filtered.filter(p => p.type === 'hybrid');

  // Category filters
  if (q.match(/pre-?roll|joint/))   filtered = filtered.filter(p => p.category?.includes('pre'));
  else if (q.match(/vape|cart/))    filtered = filtered.filter(p => p.category?.includes('vapor'));
  else if (q.match(/concentrate|wax|shatter|rosin/)) filtered = filtered.filter(p => p.category?.includes('concentrat'));

  // Sale filter
  if (q.match(/sale|deal|discount|cheap/)) filtered = filtered.filter(p => p.onSale);

  // THC filter
  const thcMatch = q.match(/(\d+)%?\s*thc/);
  if (thcMatch) {
    const minThc = parseInt(thcMatch[1]);
    filtered = filtered.filter(p => p.thc && p.thc >= minThc);
  }

  // Sort
  if (q.match(/cheap|low|budget|afford/)) filtered.sort((a, b) => a.price - b.price);
  else if (q.match(/strong|high|potent|thc/)) filtered.sort((a, b) => (b.thc || 0) - (a.thc || 0));
  else filtered.sort((a, b) => (a.pricePerGram || 999) - (b.pricePerGram || 999));

  const top = filtered.slice(0, 5);
  if (!top.length) return "I couldn't find products matching that search. Try asking about sativa, indica, hybrids, pre-rolls, or deals!";

  const storeCount = stores.length;
  const lines = top.map((p, i) => {
    const priceStr = Object.entries(p.prices).map(([w,pr]) => `${w} @ $${pr}`).join(' · ');
    const thcStr   = p.thc ? ` | ${p.thc}% THC` : '';
    const saleStr  = p.onSale ? ' 🔥 ON SALE' : '';
    return `**${i+1}. ${p.name}**${saleStr}\n   📍 ${p.storeName} · ${p.storeCity}${thcStr}\n   💰 ${priceStr}`;
  });

  return `Here are the top deals across ${storeCount} dispensaries:\n\n${lines.join('\n\n')}`;
}

// ─── GET /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  🌿 GramHunt v2.0 — http://localhost:${PORT}`);
  console.log(`  🤖 AI Chat: ${process.env.OPENAI_API_KEY ? 'enabled (GPT-4o-mini)' : 'disabled (no OPENAI_API_KEY)'}`);
  console.log(`${'='.repeat(50)}\n`);
});
