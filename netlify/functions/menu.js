const https = require('https');

exports.handler = (event, context, callback) => {
  const lat = event.queryStringParameters?.lat || '41.8408';
  const lng = event.queryStringParameters?.lng || '-72.4509';

  // Use Leafly's public API (no auth needed)
  const url = `https://www.leafly.com/api/location/near?lat=${lat}&lng=${lng}&skip=0&limit=20`;

  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const stores = (parsed.retailers || []).map((s, i) => ({
          id: String(s.id || i),
          name: s.name,
          dist: (s.distance || 0).toFixed(1),
          rating: s.rating || 4.5,
          city: s.city,
          state: s.state,
          url: s.url || '#',
          color: ['#39d353','#22d3ee','#a78bfa','#f97316'][i % 4]
        }));

        callback(null, {
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ stores, products: [], count: stores.length, scrapedAt: new Date().toISOString() })
        });
      } catch (e) {
        callback(null, { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ stores: [], products: [], count: 0, error: 'API unavailable' }) });
      }
    });
  }).on('error', () => {
    callback(null, { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ stores: [], products: [], count: 0 }) });
  });
};
