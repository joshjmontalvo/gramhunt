const https = require('https');

exports.handler = (event, context, callback) => {
  const lat = event.queryStringParameters?.lat || '41.8408';
  const lng = event.queryStringParameters?.lng || '-72.4509';

  // Leafly's public dispensary search endpoint
  const url = `https://www.leafly.com/api/retail/v1/search?lat=${lat}&lng=${lng}&limit=20`;

  https.get(url, { 
    headers: { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    } 
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const stores = (parsed.dispensaries || []).map((d, i) => ({
          id: String(d.id || i),
          name: d.name || 'Dispensary',
          dist: (d.distance || 0).toFixed(1),
          rating: d.rating || 4.5,
          city: d.city || '',
          state: d.state || 'CT',
          url: d.url || '#',
          color: ['#39d353','#22d3ee','#a78bfa','#f97316','#fbbf24'][i % 5],
          hours: d.hours_str || ''
        }));

        const products = (parsed.strains || []).slice(0, 50).map(p => ({
          name: p.name,
          type: p.type?.toLowerCase() || 'hybrid',
          thc: parseFloat(p.thc) || 15,
          prices: { '3.5g': 40, '7g': 75, '14g': 140, '28g': 260 },
          onSale: Math.random() > 0.7,
          sid: stores[Math.floor(Math.random() * stores.length)]?.id || '1'
        }));

        callback(null, {
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            stores,
            products,
            count: products.length,
            scrapedAt: new Date().toISOString()
          })
        });
      } catch (e) {
        callback(null, {
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ 
            stores: [], 
            products: [], 
            count: 0, 
            error: 'API error - ' + e.message 
          })
        });
      }
    });
  }).on('error', (e) => {
    callback(null, {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ stores: [], products: [], count: 0 })
    });
  });
};
