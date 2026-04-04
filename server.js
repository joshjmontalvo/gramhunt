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

// HTTP helper
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'GramHunt/2.0',
        'Accept':     'application/json',
      }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// Name cleaning
function cleanName(raw) {
  raw = raw || '';
  return raw
    .replace(/\s*[-\u2013\u2014|]\s*(sativa|indica|hybrid|cbd|thc|flower|pre.?roll|cart|vape|edible|concentrate|extract|wax|shatter|rosin|live\s+resin|distillate)[^$]*/gi, '')
    .replace(/\s*\(?(sativa|indica|hybrid)\)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getType(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('sativa'))  return 'sativa';
  if (s.includes('indica'))  return 'indica';
  if (s.includes('hybrid'))  return 'hybrid';
  if (s.includes('cbd'))     return 'cbd';
  return 'hybrid';
}

// Weight normalization
const WEIGHT_MAP = {
  '1g':'1g', '1 g':'1g', 'gram':'1g', '1gram':'1g',
  '3.5g':'3.5g', '3.5 g':'3.5g', 'eighth':'3.5g', '1/8':'3.5g',
  '1/8oz':'3.5g', '1/8 oz':'3.5g',
  '7g':'7g',  '7 g':'7g',  'quarter':'7g', '1/4':'7g',
  '1/4oz':'7g', '1/4 oz':'7g',
  '14g':'14g', '14 g':'14g', 'half':'14g', 'half oz':'14g',
  '1/2':'14g', '1/2oz':'14g', '1/2 oz':'14g',
  '28g':'28g', '28 g':'28g', 'ounce':'28g', 'oz':'28g',
  '1oz':'28g', '1 oz':'28g',
};

function normalizeWeight(w) {
  w = w || '';
  const wl = w.toLowerCase().trim().replace(/\s+/g, '');
  if (WEIGHT_MAP[wl]) return WEIGHT_MAP[wl];
  const pairs = [['3.5','3.5g'],['14','14g'],['28','28g'],['7','7g'],['1','1g']];
  for (const [abbr, canon] of pairs) {
    if (wl.startsWith(abbr)) return canon;
  }
  return w || '3.5g';
}

// Fetch one store's menu
async function fetchStoreMenu(store) {
  const BASE    = 'https://api.iheartjane.com/v1';
  const storeId = store.id;
  let products  = [];

  try {
    const url  = BASE + '/stores/' + storeId + '/menu_products?kind[]=flower&kind[]=pre-roll&kind[]=vaporizers&kind[]=concentrate&per_page=200';
    const data = await httpGet(url);
    const raw  = Array.isArray(data) ? data
               : (data.data || data.products || data.menu_products || []);

    for (const p of raw) {
      try {
        const name = cleanName(p.name || (p.product && p.product.name) || '');
        if (!name) continue;

        const strainType = getType(p.kind || p.strain_type || p.type || '');
        const thcPct     = parseFloat(p.thc_percentage || p.percent_thc || p.thc || 0) || null;
        const cbdPct     = parseFloat(p.cbd_percentage || p.percent_cbd || p.cbd || 0) || null;
        const brand      = p.brand || p.producer || '';
        const onSale     = !!(p.on_sale || p.special_price || p.discount_amount);
        const imgUrl     = (p.photo && p.photo.urls && p.photo.urls.original) || p.image_url || p.photo_url || '';

        let prices = {};
        const variants = p.variants || p.prices || [];
        for (const v of variants) {
          const w  = normalizeWeight(v.weight || v.option || '');
          const pr = parseFloat(v.price_with_tax || v.price || v.amount || 0);
          if (w && pr > 0) prices[w] = pr;
        }
        if (!Object.keys(prices).length && p.price) {
          const w = normalizeWeight(p.weight || p.amount || '3.5g');
          prices[w] = parseFloat(p.price);
        }
        if (!Object.keys(prices).length) continue;

        const minPrice = Math.min.apply(null, Object.values(prices));
        const GRAMS = { '1g':1, '3.5g':3.5, '7g':7, '14g':14, '28g':28 };
        const ppg = Object.entries(prices).reduce(function(best, entry) {
          const w = entry[0], pr = entry[1];
          const g = GRAMS[w]; if (!g) return best;
          const ratio = pr / g;
          return (!best || ratio < best.ratio) ? { ratio: ratio, weight: w, price: pr } : best;
        }, null);

        products.push({
          id:           storeId + '_' + name.toLowerCase().replace(/\s+/g,'_'),
          storeId:      storeId,
          storeName:    store.name,
          storeCity:    store.city,
          name:         name,
          brand:        brand,
          type:         strainType,
          category:     (p.kind || p.category || 'flower').toLowerCase(),
          thc:          thcPct,
          cbd:          cbdPct,
          prices:       prices,
          price:        minPrice,
          pricePerGram: ppg && ppg.ratio ? Math.round(ppg.ratio * 100) / 100 : null,
          bestWeight:   ppg ? ppg.weight : Object.keys(prices)[0],
          onSale:       onSale,
          imageUrl:     imgUrl,
          url:          p.custom_product_url || ('https://www.iheartjane.com/stores/' + storeId),
        });
      } catch (err) { /* skip bad product */ }
    }
  } catch (err) {
    console.error('Failed to fetch menu for ' + store.name + ': ' + err.message);
  }

  return products;
}

// Discover nearby stores
async function findNearbyStores(lat, lng, radiusMiles) {
  radiusMiles = radiusMiles || 25;
  const BASE = 'https://api.iheartjane.com/v1';
  try {
    const url  = BASE + '/stores?lat=' + lat + '&lng=' + lng + '&radius=' + radiusMiles + '&types[]=recreational&types[]=medical';
    const data = await httpGet(url);
    const raw  = Array.isArray(data) ? data : (data.stores || data.data || []);

    return raw.map(function(s) {
      return {
        id:       s.id || s.store_id,
        name:     s.name || 'Unknown Dispensary',
        city:     s.city || '',
        state:    s.state || 'CT',
        address:  [s.address, s.city, s.state].filter(Boolean).join(', '),
        phone:    s.phone || '',
        url:      s.custom_store_url || ('https://www.iheartjane.com/stores/' + s.id),
        rating:   s.rating || null,
        distance: s.distance_in_miles || null,
      };
    });
  } catch (err) {
    console.error('Store discovery failed:', err.message);
    return [];
  }
}

// GET /api/menu
app.get('/api/menu', async function(req, res) {
  const lat    = parseFloat(req.query.lat    || process.env.DEFAULT_LAT    || '41.7637');
  const lng    = parseFloat(req.query.lng    || process.env.DEFAULT_LON    || '-72.6851');
  const radius = parseFloat(req.query.radius || process.env.DEFAULT_RADIUS || '25');

  console.log('[/api/menu] lat=' + lat + ' lng=' + lng + ' radius=' + radius + 'mi');

  try {
    const stores = await findNearbyStores(lat, lng, radius);
    if (!stores.length) return res.json({ stores: [], products: [], count: 0, storeCount: 0 });

    const CONCURRENCY = 5;
    let allProducts = [];
    for (let i = 0; i < stores.length; i += CONCURRENCY) {
      const batch   = stores.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(function(s) { return fetchStoreMenu(s); }));
      results.forEach(function(r) { allProducts = allProducts.concat(r); });
    }

    allProducts.sort(function(a, b) { return (a.pricePerGram || 999) - (b.pricePerGram || 999); });

    res.json({
      stores:     stores,
      products:   allProducts,
      count:      allProducts.length,
      storeCount: stores.length,
      scrapedAt:  new Date().toISOString(),
      location:   { lat: lat, lng: lng, radiusMiles: radius },
    });
  } catch (err) {
    console.error('/api/menu error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rule-based fallback
function buildFallbackAnswer(query, products, stores) {
  const q = (query || '').toLowerCase();
  let filtered = products.slice();

  if (q.includes('sativa'))       filtered = filtered.filter(function(p) { return p.type === 'sativa'; });
  else if (q.includes('indica'))  filtered = filtered.filter(function(p) { return p.type === 'indica'; });
  else if (q.includes('hybrid'))  filtered = filtered.filter(function(p) { return p.type === 'hybrid'; });

  if (q.match(/pre.?roll|joint/))              filtered = filtered.filter(function(p) { return p.category && p.category.includes('pre'); });
  else if (q.match(/vape|cart/))               filtered = filtered.filter(function(p) { return p.category && p.category.includes('vapor'); });
  else if (q.match(/concentrate|wax|shatter/)) filtered = filtered.filter(function(p) { return p.category && p.category.includes('concentrat'); });

  if (q.match(/sale|deal|discount|cheap/)) filtered = filtered.filter(function(p) { return p.onSale; });

  const thcMatch = q.match(/(\d+)%?\s*thc/);
  if (thcMatch) {
    const minThc = parseInt(thcMatch[1]);
    filtered = filtered.filter(function(p) { return p.thc && p.thc >= minThc; });
  }

  if (q.match(/cheap|low|budget/))        filtered.sort(function(a, b) { return a.price - b.price; });
  else if (q.match(/strong|high|potent/)) filtered.sort(function(a, b) { return (b.thc || 0) - (a.thc || 0); });
  else                                     filtered.sort(function(a, b) { return (a.pricePerGram || 999) - (b.pricePerGram || 999); });

  const top = filtered.slice(0, 5);
  if (!top.length) return "I couldn't find products matching that search. Try asking about sativa, indica, hybrids, pre-rolls, or deals!";

  const lines = top.map(function(p, i) {
    const priceStr = Object.entries(p.prices).map(function(e) { return e[0] + ' @ $' + e[1]; }).join(' / ');
    const thcStr   = p.thc ? ' | ' + p.thc + '% THC' : '';
    const saleStr  = p.onSale ? ' SALE' : '';
    return (i+1) + '. ' + p.name + saleStr + ' @ ' + p.storeName + ', ' + p.storeCity + thcStr + ' — ' + priceStr;
  });

  return 'Top deals across ' + stores.length + ' dispensaries:\n\n' + lines.join('\n');
}

// POST /api/chat
app.post('/api/chat', async function(req, res) {
  const query    = req.body.query    || '';
  const products = req.body.products || [];
  const stores   = req.body.stores   || [];
  const apiKey   = process.env.OPENAI_API_KEY;

  if (!apiKey) return res.json({ answer: buildFallbackAnswer(query, products, stores) });

  const topProducts  = products.slice(0, 50);
  const productLines = topProducts.map(function(p, i) {
    return (i+1) + '. ' + p.name + (p.brand ? ' by ' + p.brand : '') + ' @ ' + p.storeName + ' (' + p.storeCity + ') | Type: ' + p.type + ' | THC: ' + (p.thc ? p.thc + '%' : 'N/A') + ' | Prices: ' + Object.entries(p.prices).map(function(e) { return e[0] + '=$' + e[1]; }).join(', ') + ' | $/g: ' + (p.pricePerGram ? '$' + p.pricePerGram : 'N/A') + (p.onSale ? ' SALE' : '');
  }).join('\n');

  const storeList = stores.map(function(s) { return s.name + ' in ' + s.city; }).join(', ');

  const systemPrompt = 'You are GramHunt, a cannabis deal expert for Connecticut dispensaries. Help users find the best deals. Be concise and recommend specific products with prices.\nDispensaries: ' + storeList + '\nInventory (best value first):\n' + productLines;

  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: query },
    ],
    temperature: 0.7,
    max_tokens: 600,
  });

  try {
    const answer = await new Promise(function(resolve, reject) {
      const req2 = https.request({
        hostname: 'api.openai.com',
        path:     '/v1/chat/completions',
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Authorization':  'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, function(resp) {
        let body = '';
        resp.on('data', function(d) { body += d; });
        resp.on('end', function() {
          try {
            const j = JSON.parse(body);
            resolve((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || buildFallbackAnswer(query, products, stores));
          } catch(e) { reject(e); }
        });
      });
      req2.on('error', reject);
      req2.write(payload);
      req2.end();
    });
    res.json({ answer: answer });
  } catch(err) {
    res.json({ answer: buildFallbackAnswer(query, products, stores) });
  }
});

// Health check
app.get('/api/health', function(req, res) {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

// Serve frontend
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('GramHunt v2.0 running on port ' + PORT);
  console.log('AI Chat: ' + (process.env.OPENAI_API_KEY ? 'enabled' : 'disabled - add OPENAI_API_KEY'));
});
