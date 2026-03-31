const https = require('https');

exports.handler = (event, context, callback) => {
  const { lat, lng, radius } = event.queryStringParameters;

  if (!lat || !lng) {
    return callback(null, {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing lat/lng' })
    });
  }

  const url = `https://api.iheartjane.com/stores?lat=${lat}&lng=${lng}&radius=${radius || 25}`;

  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      callback(null, {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: data
      });
    });
  }).on('error', (e) => {
    callback(null, { statusCode: 500, body: JSON.stringify({ error: e.message }) });
  });
};
