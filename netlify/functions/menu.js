const fetch = require('node-fetch');

const API_URL = 'https://api.iheartjane.com/v1/stores';

async function getStoresByLocation(lat, lng) {
    const response = await fetch(`${API_URL}?lat=${lat}&lng=${lng}&limit=10}`);
    if (!response.ok) {
        throw new Error('Network response was not ok');
    }
    return await response.json();
}

async function getLiveMenu(storeId) {
    const response = await fetch(`${API_URL}/${storeId}/live-menu`);
    if (!response.ok) {
        throw new Error('Unable to fetch live menu');
    }
    return await response.json();
}

exports.handler = async (event) => {
    const { lat, lng } = JSON.parse(event.body);
    try {
        const stores = await getStoresByLocation(lat, lng);
        const menus = await Promise.all(stores.map(store => getLiveMenu(store.id)));
        return {
            statusCode: 200,
            body: JSON.stringify(menus),
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};