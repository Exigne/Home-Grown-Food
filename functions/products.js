const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { require: true },
  max: 2,
  idleTimeoutMillis: 0,
  connectionTimeoutMillis: 5000
});

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    // No CDN caching — always fetch fresh from DB so admin price/stock
    // changes appear in the shop immediately without needing a hard refresh.
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma':        'no-cache'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id');
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(result.rows)
    };
  } catch (err) {
    console.error('Products query failed:', err.message);
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
