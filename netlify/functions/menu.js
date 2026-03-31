exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      stores: [
        { id: '1', name: 'Green Leaf', short: 'Green', dist: 2.3, rating: 4.5, city: 'Hartford, CT', state: 'CT', url: '#', color: '#39d353' },
        { id: '2', name: 'Peaceful Gardens', short: 'Peace', dist: 4.1, rating: 4.8, city: 'Manchester, CT', state: 'CT', url: '#', color: '#22d3ee' }
      ],
      products: [
        { name: 'Blue Dream', type: 'sativa', thc: 22, prices: { '3.5g': 45, '7g': 85 }, onSale: false, sid: '1' },
        { name: 'OG Kush', type: 'indica', thc: 24, prices: { '3.5g': 50, '7g': 95 }, onSale: true, sid: '2' }
      ],
      scrapedAt: new Date().toISOString()
    })
  };
};
