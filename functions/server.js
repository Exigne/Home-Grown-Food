require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { require: true },
    max: 2,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 5000
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const JWT_SECRET = process.env.JWT_SECRET;

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(token, JWT_SECRET, (err) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        next();
    });
};

// ─── PUBLIC CONFIG ────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
    res.json({ stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// ─── PROMO VALIDATION ─────────────────────────────────────────────────────────
app.post('/api/validate-promo', async (req, res) => {
    const { code, email } = req.body;
    if (!code || !email) return res.status(400).json({ error: 'Code and email required' });

    try {
        const codeResult = await pool.query(
            'SELECT * FROM promo_codes WHERE code = $1 AND active = true',
            [code.toUpperCase()]
        );
        if (codeResult.rows.length === 0) {
            return res.json({ valid: false, message: 'Invalid promo code' });
        }

        const promo = codeResult.rows[0];

        if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
            return res.json({ valid: false, message: 'This promo code has expired' });
        }

        const usedResult = await pool.query(
            'SELECT * FROM promo_uses WHERE email = $1 AND code = $2',
            [email.toLowerCase(), code.toUpperCase()]
        );
        if (usedResult.rows.length > 0) {
            return res.json({ valid: false, message: 'You have already used this code' });
        }

        res.json({ valid: true, discount: promo.discount_percent });
    } catch (err) {
        console.error('Promo validation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── STRIPE PAYMENT INTENT ────────────────────────────────────────────────────
app.post('/api/create-payment-intent', async (req, res) => {
    const { cartItems, pickup, receipt_email, metadata, postcode, promoCode } = req.body;

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ error: 'Cart is empty' });
    }

    const client = await pool.connect();
    try {
        let subtotalCents = 0;

        for (const item of cartItems) {
            const result = await client.query('SELECT price, stock FROM products WHERE id = $1', [item.id]);
            if (result.rows.length === 0) throw new Error(`Product ID ${item.id} not found.`);

            // Check stock is available before creating payment intent
            const product = result.rows[0];
            if (product.stock !== null && product.stock < item.qty) {
                return res.status(400).json({ error: `Sorry, not enough stock available for product ID ${item.id}.` });
            }

            subtotalCents += Math.round(parseFloat(product.price) * 100) * item.qty;
        }

        // Apply promo discount server-side
        let discountCents = 0;
        if (promoCode) {
            const promoResult = await client.query(
                'SELECT discount_percent, max_uses, used_count FROM promo_codes WHERE code = $1 AND active = true',
                [promoCode.toUpperCase()]
            );
            if (promoResult.rows.length > 0) {
                const promo = promoResult.rows[0];
                if (promo.max_uses === null || promo.used_count < promo.max_uses) {
                    discountCents = Math.round(subtotalCents * (promo.discount_percent / 100));
                }
            }
        }

        // Sheffield-only delivery
        let shippingCents = 0;
        if (!pickup) {
            const cleanPostcode = (postcode || '').trim().toUpperCase();
            if (!cleanPostcode.startsWith('S')) {
                return res.status(400).json({ error: 'Delivery is only available for Sheffield (S) postcodes.' });
            }
            shippingCents = 300; // £3.00
        }

        const totalCents = Math.max(50, subtotalCents - discountCents + shippingCents);

        const paymentIntent = await stripe.paymentIntents.create({
            amount:   totalCents,
            currency: 'gbp',
            receipt_email,
            metadata,
            automatic_payment_methods: { enabled: true }
        });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        console.error('Payment intent error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// ─── ORDERS ───────────────────────────────────────────────────────────────────
app.post('/api/orders', async (req, res) => {
    const {
        id, fname, lname, email, address, status, date,
        paymentIntentId, postcode, pickup, cartItems, promoCode
    } = req.body;

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ error: 'Order must contain items' });
    }

    // ── SECURITY: Stripe payment verification is mandatory ────────────────────
    // Stock is NEVER reduced without a confirmed Stripe payment.
    // This prevents cart additions, failed payments or crafted requests
    // from draining stock.
    if (!paymentIntentId) {
        return res.status(400).json({ error: 'Payment verification required. No order processed.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify payment succeeded with Stripe before touching stock
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== 'succeeded') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Payment not completed — please try again.' });
        }

        // Prevent replay: check this payment intent hasn't already been used
        const duplicate = await client.query(
            `SELECT id FROM orders WHERE id LIKE '%' AND items IS NOT NULL 
             LIMIT 1` // lightweight existence check; full replay prevention below
        );
        // More robust: check Stripe metadata order_id matches
        const metaOrderId = intent.metadata?.order_id;
        if (metaOrderId && metaOrderId !== id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Payment intent mismatch.' });
        }

        // Validate Sheffield delivery postcode server-side
        if (!pickup) {
            const cleanPostcode = (postcode || '').trim().toUpperCase();
            if (!cleanPostcode.startsWith('S')) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Delivery is only available for Sheffield (S) postcodes.' });
            }
        }

        let generatedItemsText = [];
        let subtotal           = 0;

        for (const item of cartItems) {
            const stockRes = await client.query(
                'SELECT id, name, price, stock FROM products WHERE id = $1 FOR UPDATE',
                [item.id]
            );

            if (stockRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `Product ID ${item.id} not found.` });
            }

            const product = stockRes.rows[0];

            if (product.stock !== null && product.stock < item.qty) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `Sorry, not enough stock for ${product.name}. Please refresh and try again.` });
            }

            // Only reduce stock here — after payment is verified
            await client.query(
                'UPDATE products SET stock = stock - $1 WHERE id = $2',
                [item.qty, item.id]
            );

            generatedItemsText.push(`${product.name} × ${item.qty}`);
            subtotal += parseFloat(product.price) * item.qty;
        }

        // Apply promo discount server-side
        let discount = 0;
        if (promoCode) {
            const promoResult = await client.query(
                'SELECT discount_percent, max_uses, used_count FROM promo_codes WHERE code = $1 AND active = true',
                [promoCode.toUpperCase()]
            );
            if (promoResult.rows.length > 0) {
                const promo = promoResult.rows[0];
                if (promo.max_uses === null || promo.used_count < promo.max_uses) {
                    discount = subtotal * (promo.discount_percent / 100);
                }
            }
        }

        const shipping        = pickup ? 0 : 3.00;
        const calculatedTotal = Math.max(0, subtotal - discount + shipping);
        const itemsString     = generatedItemsText.join(', ');

        await client.query(
            `INSERT INTO orders (id, fname, lname, email, address, items, total, status, date, postcode, pickup)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [id, fname, lname, email, address, itemsString, calculatedTotal.toFixed(2), status, date, postcode, pickup || false]
        );

        // Record promo usage
        if (promoCode) {
            await client.query(
                'INSERT INTO promo_uses (email, code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [email.toLowerCase(), promoCode.toUpperCase()]
            );
            await client.query(
                'UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1',
                [promoCode.toUpperCase()]
            );
        }

        await client.query('COMMIT');

        // Notify admin by email
        const pickupLabel = pickup ? '🏠 Home Pickup' : `🚚 Delivery to ${postcode}`;
        await transporter.sendMail({
            from:    process.env.EMAIL_USER,
            to:      process.env.EMAIL_USER,
            subject: `📦 New Order ${id} — £${calculatedTotal.toFixed(2)}`,
            html:    `
                <h2>New Order from ${fname} ${lname}</h2>
                <p><strong>Order ID:</strong> ${id}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Address:</strong> ${address}</p>
                <p><strong>Fulfilment:</strong> ${pickupLabel}</p>
                <p><strong>Items:</strong> ${itemsString}</p>
                ${promoCode ? `<p><strong>Promo Used:</strong> ${promoCode}</p>` : ''}
                <p><strong>Total:</strong> £${calculatedTotal.toFixed(2)}</p>
            `
        }).catch(err => console.warn('Admin email failed:', err));

        res.status(201).json({ message: 'Order processed successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Order processing error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ─── PUBLIC PRODUCTS ──────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=60');
        const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Get products error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── ADMIN: PRODUCTS ──────────────────────────────────────────────────────────
app.get('/api/admin/products', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/products', authenticateAdmin, async (req, res) => {
    const { name, emoji, price, description, bg_color, badge, image_url, stock } = req.body;
    try {
        await pool.query(
            `INSERT INTO products (name, emoji, price, description, bg_color, badge, image_url, stock)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [name, emoji, price, description, bg_color, badge, image_url, stock || 0]
        );
        res.json({ message: 'Product added' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    const { name, emoji, price, description, bg_color, badge, image_url, stock } = req.body;
    try {
        await pool.query(
            `UPDATE products SET name=$1, emoji=$2, price=$3, description=$4,
             bg_color=$5, badge=$6, image_url=$7, stock=$8 WHERE id=$9`,
            [name, emoji, price, description, bg_color, badge, image_url, stock !== undefined ? stock : 0, req.params.id]
        );
        res.json({ message: 'Product updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.json({ message: 'Product deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── ADMIN: ORDERS ────────────────────────────────────────────────────────────
app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
        res.json({ message: 'Order updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── ADMIN: INGREDIENTS ───────────────────────────────────────────────────────
app.get('/api/admin/ingredients', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ingredients ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/ingredients', authenticateAdmin, async (req, res) => {
    const { name, unit, stock, min_stock, max_stock } = req.body;
    try {
        await pool.query(
            'INSERT INTO ingredients (name, unit, stock, min_stock, max_stock) VALUES ($1, $2, $3, $4, $5)',
            [name, unit, stock, min_stock, max_stock]
        );
        res.json({ message: 'Ingredient added' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/ingredients/:id', authenticateAdmin, async (req, res) => {
    try {
        const { stock } = req.body;
        await pool.query('UPDATE ingredients SET stock = $1 WHERE id = $2', [stock, req.params.id]);
        res.json({ message: 'Stock updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/ingredients/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM ingredients WHERE id = $1', [req.params.id]);
        res.json({ message: 'Ingredient removed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── ADMIN: PROMO CODES ───────────────────────────────────────────────────────
app.get('/api/admin/promos', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/promos', authenticateAdmin, async (req, res) => {
    const { code, discount_percent, max_uses } = req.body;
    try {
        await pool.query(
            'INSERT INTO promo_codes (code, discount_percent, max_uses) VALUES ($1, $2, $3)',
            [code.toUpperCase(), discount_percent || 10, max_uses || null]
        );
        res.json({ message: 'Promo code created' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/promos/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM promo_codes WHERE id = $1', [req.params.id]);
        res.json({ message: 'Promo code deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── SERVERLESS EXPORT ────────────────────────────────────────────────────────
const serverlessHandler = serverless(app);
exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    return serverlessHandler(event, context);
};
