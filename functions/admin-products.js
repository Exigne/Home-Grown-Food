const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

function verifyToken(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  // Simple verification - replace with proper JWT verify in production
  return token.length > 10 ? token : null;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const token = verifyToken(event.headers.authorization);
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const path = event.path.replace('/.netlify/functions/admin-products', '').replace('/api/admin/products', '');
  const id = path.replace('/', '');

  try {
    // GET all products
    if (event.httpMethod === 'GET' && !id) {
      const result = await pool.query('SELECT * FROM products ORDER BY id');
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(result.rows) };
    }

    // POST create
    if (event.httpMethod === 'POST') {
      const { name, price, emoji, badge, image, desc, bg } = JSON.parse(event.body);
      const result = await pool.query(
        `INSERT INTO products (name, price, emoji, badge, image, desc, bg) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [name, price, emoji || '', badge || '', image || '', desc || '', bg || '#FFFBE8']
      );
      return { statusCode: 201, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(result.rows[0]) };
    }

    // PUT update
    if (event.httpMethod === 'PUT' && id) {
      const { name, price, emoji, badge, image, desc, bg } = JSON.parse(event.body);
      const result = await pool.query(
        `UPDATE products SET name=$1, price=$2, emoji=$3, badge=$4, image=$5, desc=$6, bg=$7 
         WHERE id=$8 RETURNING *`,
        [name, price, emoji || '', badge || '', image || '', desc || '', bg || '#FFFBE8', id]
      );
      if (result.rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(result.rows[0]) };
    }

    // DELETE
    if (event.httpMethod === 'DELETE' && id) {
      await pool.query('DELETE FROM products WHERE id = $1', [id]);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request' }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
