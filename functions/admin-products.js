const { Pool } = require('pg');
const jwt      = require('jsonwebtoken');

const pool = new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { require: true },
    max: 2,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 5000
});

const JWT_SECRET = process.env.JWT_SECRET;

const HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type':                 'application/json'
};

function verifyToken(authHeader) {
    if (!authHeader) return false;
    const token = authHeader.replace('Bearer ', '');
    try {
        jwt.verify(token, JWT_SECRET);
        return true;
    } catch (e) {
        return false;
    }
}

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }

    if (!verifyToken(event.headers.authorization || event.headers.Authorization)) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    // Extract product ID from path if present
    const rawPath = event.path || '';
    const pathPart = rawPath
        .replace('/.netlify/functions/admin-products', '')
        .replace('/api/admin/products', '')
        .replace(/^\//, '');
    const id = pathPart || null;

    try {
        // ── GET all products ──────────────────────────────────────────────────
        if (event.httpMethod === 'GET' && !id) {
            const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
            return {
                statusCode: 200,
                headers: HEADERS,
                body: JSON.stringify(result.rows)
            };
        }

        // ── POST — create product ─────────────────────────────────────────────
        if (event.httpMethod === 'POST') {
            const {
                name, price, emoji, badge,
                image_url, description, bg_color, stock
            } = JSON.parse(event.body || '{}');

            if (!name) {
                return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Name is required' }) };
            }

            const result = await pool.query(
                `INSERT INTO products (name, price, emoji, badge, image_url, description, bg_color, stock)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [
                    name,
                    parseFloat(price) || 0,
                    emoji       || '',
                    badge       || '',
                    image_url   || '',
                    description || '',
                    bg_color    || '#FFFBE8',
                    parseInt(stock) || 0
                ]
            );

            return {
                statusCode: 201,
                headers: HEADERS,
                body: JSON.stringify(result.rows[0])
            };
        }

        // ── PUT — update product ──────────────────────────────────────────────
        if (event.httpMethod === 'PUT' && id) {
            const {
                name, price, emoji, badge,
                image_url, description, bg_color, stock
            } = JSON.parse(event.body || '{}');

            const result = await pool.query(
                `UPDATE products
                 SET name=$1, price=$2, emoji=$3, badge=$4,
                     image_url=$5, description=$6, bg_color=$7, stock=$8
                 WHERE id=$9 RETURNING *`,
                [
                    name,
                    parseFloat(price) || 0,
                    emoji       || '',
                    badge       || '',
                    image_url   || '',
                    description || '',
                    bg_color    || '#FFFBE8',
                    parseInt(stock) || 0,
                    id
                ]
            );

            if (result.rows.length === 0) {
                return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Product not found' }) };
            }

            // Bust the public product cache by returning fresh data
            return {
                statusCode: 200,
                headers: HEADERS,
                body: JSON.stringify(result.rows[0])
            };
        }

        // ── DELETE — remove product ───────────────────────────────────────────
        if (event.httpMethod === 'DELETE' && id) {
            await pool.query('DELETE FROM products WHERE id = $1', [id]);
            return {
                statusCode: 200,
                headers: HEADERS,
                body: JSON.stringify({ success: true })
            };
        }

        return {
            statusCode: 400,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Bad request' })
        };

    } catch (err) {
        console.error('admin-products error:', err.message);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: err.message })
        };
    }
};
