'use strict';

const axios = require('axios');

exports.handler = async (event, context) => {
    try {
        const response = await axios.get('https://api.iheartjane.com/v1/dispensaries');
        const menus = response.data;
        return {
            statusCode: 200,
            body: JSON.stringify(menus),
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Failed to fetch dispensary menus', error: error.message }),
        };
    }
};
