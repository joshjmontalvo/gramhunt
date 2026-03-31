const https = require('https');

exports.handler = (event, context, callback) => {
  const lat = event.queryStringParameters?.lat || '41.8408';
  const lng = event.queryStringParameters?.lng || '-72.4509';
  const radius = event.queryStringParameters?.radius || '25';

  // WeedMaps public API endpoint for dispensaries
  const url = `https://api.weedmaps.com/discovery/search/listings/?q=dispensaries&lat=${lat}&lng=${lng}&limit=30`;

  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const stores = (parsed.results || []).slice(0, 10).map((d, i) => ({
          id: String(d.id),
          name: d.name,
          dist: (d.distance_miles || 0).toFixed(1),
          rating: d.rating || 4.5,
          city: d.city,
          state: d.state,
          url: `https://weedmaps.com${d.url || ''}`,
          color: ['#39d353','#22d3ee','#a78bfa','#f97316','#fbbf24'][i % 5]
        }));

        // Fetch menus for each store
        const productPromises = stores.map(s => 
          new Promise((resolve) => {
            const menuUrl = `https://api.weedmaps.com/v1/listings/${s.id}/menu`;
            https.get(menuUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
              let menuData = '';
              res2.on('data', chunk => menuData += chunk);
              res2.on('end', () => {
                try {
                  const menu = JSON.parse(menuData);
                  const products = (menu.result?.categories?.[0]?.items || []).map(p => ({
                    name: p.name,
                    type: p.type?.toLowerCase() || 'hybrid',
                    thc: parseFloat(p.thc) || 15,
                    prices: { '3.5g': parseFloat(p.price) || 40 },
                    onSale: p.on_sale || false,
                    sid: s.id
                  }));
                  resolve(products);
                } catch {
                  resolve([]);
                }
              });
            }).on('error', () => resolve([]));
          })
        );

        Promise.all(productPromises).then(allProducts => {
          const products = allProducts.flat();
          callback(null, {
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({
              stores,
              products: products.slice(0, 100),
              count: products.length,
              scrapedAt: new Date().toISOString()
            })
          });
        });
      } catch (e) {
        callback(null, {
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ stores: [], products: [], count: 0, error: e.message })
        });
      }
    });
  }).on('error', (e) => {
    callback(null, {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ stores: [], products: [], count: 0, error: e.message })
    });
  });
};
