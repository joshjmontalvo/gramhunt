const axios = require('axios');
const cheerio = require('cheerio');

const iHeartJaneMenuScraper = async () => {
    const url = 'https://iheartjane.com/your-dispensary-url'; // Update with the actual URL
    try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);

        const products = [];
        $('.menu-item').each((index, element) => {
            const product = $(element);
            const name = product.find('.product-name').text().trim();
            const price = product.find('.product-price').text().trim();
            // Add more fields as needed

            products.push({ name, price });
        });

        return {
            store: 'iHeartJane',
            products
        };
    } catch (error) {
        console.error('Error scraping data:', error);
        return null;
    }
};

module.exports = { iHeartJaneMenuScraper };
