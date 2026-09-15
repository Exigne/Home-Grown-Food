require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
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

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Important: Resend requires a verified domain to send emails. 
// You cannot send "from" a Hotmail/Gmail address. 
// We are using 'hello@homegrownfoods.online' below as your sender address.
const SENDER_EMAIL = 'hello@homegrownfoods.online'; 

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

            const product = result.rows[0];
            if (product.stock !== null && product.stock < item.qty) {
                return res.status(400).json({ error: `Sorry, not enough stock available for product ID ${item.id}.` });
            }

            subtotalCents += Math.round(parseFloat(product.price) * 100) * item.qty;
        }

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

        let shippingCents = 0;
        if (!pickup) {
            const cleanPostcode = (postcode || '').trim().toUpperCase();
            if (!cleanPostcode.startsWith('S')) {
                return res.status(400).json({ error: 'Delivery is only available for Sheffield (S) postcodes.' });
            }
            shippingCents = 300;
        }

        const totalCents = Math.max(50, subtotalCents - discountCents + shippingCents);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalCents,
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

    if (!paymentIntentId) {
        return res.status(400).json({ error: 'Payment verification required. No order processed.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== 'succeeded') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Payment not completed — please try again.' });
        }

        const metaOrderId = intent.metadata?.order_id;
        if (metaOrderId && metaOrderId !== id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Payment intent mismatch.' });
        }

        if (!pickup) {
            const cleanPostcode = (postcode || '').trim().toUpperCase();
            if (!cleanPostcode.startsWith('S')) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Delivery is only available for Sheffield (S) postcodes.' });
            }
        }

        let generatedItemsText = [];
        let receiptItems = [];  // detailed line items for the confirmation receipt
        let subtotal = 0;

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

            await client.query(
                'UPDATE products SET stock = stock - $1 WHERE id = $2',
                [item.qty, item.id]
            );

            const lineTotal = parseFloat(product.price) * item.qty;
            generatedItemsText.push(`${product.name} × ${item.qty}`);
            receiptItems.push({
                name: product.name,
                qty: item.qty,
                unitPrice: parseFloat(product.price),
                lineTotal: lineTotal
            });
            subtotal += lineTotal;
        }

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

        const shipping = pickup ? 0 : 3.99;
        const calculatedTotal = Math.max(0, subtotal - discount + shipping);
        const itemsString = generatedItemsText.join(', ');

        const marketingConsent = req.body.marketingConsent === true;

        await client.query(
            `INSERT INTO orders (id, fname, lname, email, address, items, total, status, date, postcode, pickup, marketing_consent)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [id, fname, lname, email, address, itemsString, calculatedTotal.toFixed(2),
             status, date, postcode, pickup || false, marketingConsent]
        );

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

        // ─── EMAIL NOTIFICATION (RESEND) ──────────────────────────────────────
        const pickupLabel = pickup ? '🏠 Home Pickup' : `🚚 Delivery to ${postcode}`;
        const adminItemRows = receiptItems.map(function(it) {
            return '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;">' + it.name +
                '</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center;">×' + it.qty +
                '</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;">£' + it.lineTotal.toFixed(2) +
                '</td></tr>';
        }).join('');
        const { error: emailError } = await resend.emails.send({
            from: `Home Grown Orders <${SENDER_EMAIL}>`,
            to: [process.env.EMAIL_USER],
            subject: `📦 New Order ${id} — £${calculatedTotal.toFixed(2)} (${pickup ? 'Pickup' : 'Delivery'})`,
            html: `
                <div style="font-family:Arial,sans-serif;max-width:560px;">
                    <h2 style="color:#164A2E;">New Order — ${id}</h2>
                    <p style="margin:4px 0;"><strong>Customer:</strong> ${fname} ${lname}</p>
                    <p style="margin:4px 0;"><strong>Email:</strong> ${email}</p>
                    <p style="margin:4px 0;"><strong>Fulfilment:</strong> ${pickupLabel}</p>
                    ${!pickup ? '<p style="margin:4px 0;"><strong>Address:</strong> ' + address + '</p>' : ''}
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:0.9rem;">
                        <thead><tr style="background:#164A2E;color:#FFD93D;">
                            <th style="padding:6px 8px;text-align:left;">Item</th>
                            <th style="padding:6px 8px;text-align:center;">Qty</th>
                            <th style="padding:6px 8px;text-align:right;">Total</th>
                        </tr></thead>
                        <tbody>${adminItemRows}</tbody>
                    </table>
                    ${promoCode ? '<p style="margin:4px 0;"><strong>Promo Used:</strong> ' + promoCode + ' (−£' + discount.toFixed(2) + ')</p>' : ''}
                    ${!pickup ? '<p style="margin:4px 0;color:#5A8A6A;">Delivery: £' + shipping.toFixed(2) + '</p>' : ''}
                    <p style="font-size:1.2rem;font-weight:bold;color:#164A2E;">Total: £${calculatedTotal.toFixed(2)}</p>
                </div>
            `
        });
        
        if (emailError) {
            console.warn('Admin email failed:', emailError);
        }

        // ─── CUSTOMER ORDER CONFIRMATION (RESEND) ─────────────────────────────
        // Transactional — always sent regardless of marketing subscription status
        try {
            // Build a proper itemised receipt table
            const itemRows = receiptItems.map(function(it) {
                return '<tr>' +
                    '<td style="padding:10px 0;border-bottom:1px solid #eee;color:#0E3019;">' +
                        it.name + ' <span style="color:#5A8A6A;">× ' + it.qty + '</span></td>' +
                    '<td style="padding:10px 0;border-bottom:1px solid #eee;color:#0E3019;text-align:right;white-space:nowrap;">£' +
                        it.lineTotal.toFixed(2) + '</td>' +
                '</tr>';
            }).join('');

            // Totals rows (subtotal, discount, delivery/collection, total)
            var totalsRows = '<tr><td style="padding:8px 0;color:#5A8A6A;">Subtotal</td>' +
                '<td style="padding:8px 0;color:#5A8A6A;text-align:right;">£' + subtotal.toFixed(2) + '</td></tr>';
            if (discount > 0) {
                totalsRows += '<tr><td style="padding:4px 0;color:#2E7D32;">Discount' +
                    (promoCode ? ' (' + promoCode + ')' : '') + '</td>' +
                    '<td style="padding:4px 0;color:#2E7D32;text-align:right;">−£' + discount.toFixed(2) + '</td></tr>';
            }
            totalsRows += '<tr><td style="padding:4px 0;color:#5A8A6A;">' +
                (pickup ? 'Collection' : 'UK Postage') + '</td>' +
                '<td style="padding:4px 0;color:#5A8A6A;text-align:right;">' +
                (shipping > 0 ? '£' + shipping.toFixed(2) : 'FREE') + '</td></tr>';
            totalsRows += '<tr><td style="padding:12px 0 0;font-weight:bold;color:#164A2E;font-size:1.15rem;border-top:2px solid #164A2E;">Total</td>' +
                '<td style="padding:12px 0 0;font-weight:bold;color:#164A2E;font-size:1.15rem;text-align:right;border-top:2px solid #164A2E;">£' +
                calculatedTotal.toFixed(2) + '</td></tr>';

            const fulfilMsg = pickup
                ? 'We\'ll have your order ready for collection on <strong>Friday or Saturday, 10am–1pm</strong>. We\'ll email you when it\'s ready.'
                : 'Your order will be posted to:<br><strong>' + address + '</strong>';

            await resend.emails.send({
                from:    `Home Grown <${SENDER_EMAIL}>`,
                to:      [email],
                subject: `Your Home Grown order ${id} is confirmed! 🌿`,
                html: `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:3px solid #164A2E;border-radius:16px;overflow:hidden;">
                    <div style="background:#164A2E;padding:24px;text-align:center;">
                        <h1 style="color:#FFD93D;margin:0;font-size:2rem;">Home Grown</h1>
                        <p style="color:#6BBF4A;margin:6px 0 0;font-size:0.8rem;letter-spacing:0.12em;text-transform:uppercase;">Food That Makes You Feel Good</p>
                    </div>
                    <div style="padding:32px;background:#FFFBE8;">
                        <p style="color:#0E3019;font-size:1.15rem;margin:0 0 4px;">Hi <strong>${fname}</strong>, thanks for your order! 🎉</p>
                        <p style="color:#2D6040;margin:0 0 20px;">We're getting it ready with love. Here's your receipt:</p>

                        <div style="background:white;border-radius:12px;padding:20px 24px;border:1px solid #e5e5d8;">
                            <div style="font-size:0.72rem;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:#5A8A6A;margin-bottom:4px;">Order ${id}</div>
                            <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
                                ${itemRows}
                            </table>
                            <table style="width:100%;border-collapse:collapse;">
                                ${totalsRows}
                            </table>
                        </div>

                        <div style="background:#E8F5E9;border-left:5px solid #6BBF4A;padding:16px 20px;border-radius:8px;color:#0E3019;line-height:1.6;margin-top:20px;">
                            <strong>${pickup ? '🏠 Collection' : '🚚 Postage'}</strong><br>
                            ${fulfilMsg}
                        </div>

                        <p style="color:#5A8A6A;font-size:0.9rem;margin-top:24px;">Any questions? Just use the chat on our website — we'd love to hear from you!</p>
                        <div style="text-align:center;margin-top:24px;">
                            <a href="https://homegrownfoods.online" style="background:#164A2E;color:#FFD93D;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:bold;">Visit Our Shop &rarr;</a>
                        </div>
                    </div>
                    <div style="background:#164A2E;padding:14px;text-align:center;">
                        <p style="color:#A8D97F;margin:0;font-size:0.78rem;">Home Grown &middot; Handmade in Sheffield &middot; homegrownfoods.online</p>
                    </div>
                </div>`
            });
        } catch (custEmailErr) {
            console.warn('Customer confirmation email failed:', custEmailErr);
        }

        // ─── NTFY PUSH NOTIFICATION ───────────────────────────────────────────
        try {
            const NTFY_TOPIC = 'homegrownfoods-orders';
            const typeLabel = pickup ? '🏠 PICKUP' : '🚚 DELIVERY';
            await fetch('https://ntfy.sh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    topic: NTFY_TOPIC,
                    title: `🌿 £${calculatedTotal.toFixed(2)} — New Order (${typeLabel})`,
                    message: `Customer: ${fname} ${lname}\n\nItems:\n${itemsString.replace(/, /g, '\n')}`,
                    tags: ['tada', 'package'],
                    priority: 3
                })
            });
        } catch (ntfyErr) {
            console.warn('Ntfy push failed:', ntfyErr);
        }

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
    const { name, emoji, price, description, bg_color, badge, image_url, stock, stripe_recurring_price_id, subscription_enabled, delivery_enabled } = req.body;
    try {
        // Check current stock before updating so we know if it just came back in stock
        const currentRes = await pool.query('SELECT stock FROM products WHERE id = $1', [req.params.id]);
        const currentStock = currentRes.rows[0]?.stock ?? null;

        await pool.query(
            `UPDATE products SET name=$1, emoji=$2, price=$3, description=$4,
            bg_color=$5, badge=$6, image_url=$7, stock=$8, stripe_recurring_price_id=$9,
            subscription_enabled=$10, delivery_enabled=$11 WHERE id=$12`,
            [name, emoji, price, description, bg_color, badge, image_url,
             stock !== undefined ? stock : 0,
             stripe_recurring_price_id || null,
             subscription_enabled === true || subscription_enabled === 'true',
             delivery_enabled === true || delivery_enabled === 'true',
             req.params.id]
        );

        // If product just came back in stock, notify everyone on the wishlist
        const wasOutOfStock = currentStock !== null && currentStock <= 0;
        const isNowInStock  = stock !== null && stock > 0;

        if (wasOutOfStock && isNowInStock) {
            await sendWishlistNotifications(req.params.id, name);
        }

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

// ─── WISHLIST ─────────────────────────────────────────────────────────────────
// Public: customer signs up to be notified when a product is back in stock
app.post('/api/wishlist', async (req, res) => {
    const { productId, email } = req.body;
    if (!productId || !email) {
        return res.status(400).json({ error: 'productId and email are required' });
    }
    try {
        await pool.query(
            `INSERT INTO wishlist (product_id, email)
            VALUES ($1, $2)
            ON CONFLICT (product_id, email) DO NOTHING`,
            [productId, email.toLowerCase().trim()]
        );
        res.status(201).json({ message: 'Added to wishlist' });
    } catch (err) {
        console.error('Wishlist save error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin: get all wishlist entries, enriched with product name
// ─── WISHLIST NOTIFICATIONS ──────────────────────────────────────────────────
// Shared helper — sends back-in-stock emails and clears the wishlist for a product
async function sendWishlistNotifications(productId, productName) {
    try {
        const wishlistRes = await pool.query(
            'SELECT id, email FROM wishlist WHERE product_id = $1',
            [productId]
        );

        if (!wishlistRes.rows.length) return 0;

        let sent = 0;
        for (const entry of wishlistRes.rows) {
            const { error } = await resend.emails.send({
                from:    `Home Grown <${SENDER_EMAIL}>`,
                to:      [entry.email],
                subject: `🌿 ${productName} is back in stock!`,
                html: `
                    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto; border:3px solid #164A2E; border-radius:16px; overflow:hidden;">
                        <div style="background:#164A2E; padding:24px; text-align:center;">
                            <h1 style="color:#FFD93D; margin:0; font-size:2rem;">Home Grown</h1>
                            <p style="color:#6BBF4A; margin:6px 0 0; font-size:0.8rem; letter-spacing:0.12em; text-transform:uppercase;">Food That Makes You Feel Good</p>
                        </div>
                        <div style="padding:32px; background:#FFFBE8; text-align:center;">
                            <p style="font-size:2rem; margin:0 0 16px;">🎉</p>
                            <h2 style="color:#164A2E; font-size:1.5rem; margin:0 0 12px;">Good news — it's back!</h2>
                            <p style="color:#2D6040; font-size:1rem; margin:0 0 24px;">
                                <strong>${productName}</strong> is back in stock and ready to order.
                            </p>
                            <a href="https://homegrownfoods.online" style="display:inline-block; background:#164A2E; color:#FFD93D; padding:14px 32px; border-radius:999px; text-decoration:none; font-weight:bold; font-size:1rem;">
                                Shop Now →
                            </a>
                            <p style="color:#999; font-size:0.78rem; margin-top:24px;">
                                You signed up to be notified when this item was available.<br>
                                ⚠️ Please do not reply to this email.
                            </p>
                        </div>
                        <div style="background:#164A2E; padding:14px; text-align:center;">
                            <p style="color:#A8D97F; margin:0; font-size:0.78rem;">Home Grown · Handmade in Sheffield · homegrownfoods.online</p>
                        </div>
                    </div>
                `
            });
            if (!error) sent++;
            else console.warn(`Wishlist email failed for ${entry.email}:`, error);
        }

        // Clear wishlist entries now that everyone has been notified
        await pool.query('DELETE FROM wishlist WHERE product_id = $1', [productId]);
        console.log(`Wishlist: notified ${sent} customer(s) about ${productName}`);
        return sent;
    } catch (err) {
        console.error('sendWishlistNotifications error:', err);
        return 0;
    }
}

// Admin: manually trigger wishlist notifications for a product
app.post('/api/admin/wishlist/notify/:productId', authenticateAdmin, async (req, res) => {
    const { productId } = req.params;
    try {
        const productRes = await pool.query('SELECT name FROM products WHERE id = $1', [productId]);
        if (!productRes.rows.length) return res.status(404).json({ error: 'Product not found' });
        const productName = productRes.rows[0].name;
        const sent = await sendWishlistNotifications(productId, productName);
        res.json({ message: `Notified ${sent} customer(s) about ${productName}`, sent });
    } catch (err) {
        console.error('Manual wishlist notify error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/wishlist', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
            w.id,
            w.product_id,
            w.email,
            w.created_at,
            TO_CHAR(w.created_at AT TIME ZONE 'Europe/London', 'DD Mon YYYY HH24:MI') AS date,
            p.name AS product_name
            FROM wishlist w
            LEFT JOIN products p ON p.id = w.product_id
            ORDER BY w.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Admin wishlist fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin: clear all wishlist entries for a specific product (after notifying)
app.delete('/api/admin/wishlist/:productId', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM wishlist WHERE product_id = $1', [req.params.productId]);
        res.json({ message: 'Wishlist cleared for product' });
    } catch (err) {
        console.error('Wishlist clear error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin: remove a single wishlist entry
app.delete('/api/admin/wishlist/entry/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM wishlist WHERE id = $1', [req.params.id]);
        res.json({ message: 'Wishlist entry removed' });
    } catch (err) {
        console.error('Wishlist entry delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────
// Public: customer sends a chat message
app.post('/api/chat', async (req, res) => {
    const { name, email, message, ts } = req.body;
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'name, email and message are required' });
    }
    try {
        await pool.query(
            `INSERT INTO chat_messages (name, email, message, ts)
            VALUES ($1, $2, $3, $4)`,
            [name.trim(), email.toLowerCase().trim(), message.trim(), ts || Date.now()]
        );

        // Email notification to business owner (RESEND)
        const { error: chatEmailError } = await resend.emails.send({
            from: `Home Grown Chat <${SENDER_EMAIL}>`,
            to: [process.env.EMAIL_USER], 
            subject: `💬 New Chat Message from ${name}`,
            html: `
                <h2>New chat message on Home Grown</h2>
                <p><strong>From:</strong> ${name} &lt;${email}&gt;</p>
                <p><strong>Message:</strong></p>
                <blockquote style="border-left:4px solid #164A2E; padding:8px 16px; margin:0; color:#333;">
                    ${message}
                </blockquote>
                <br>
                <p>
                    <a href="https://homegrownfoods.online/#admin" style="background:#164A2E; color:#FFD93D; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:bold;">
                        Reply in Admin Panel →
                    </a>
                </p>
                <p style="color:#999; font-size:12px; border-top:1px solid #eee; padding-top:12px; margin-top:12px;">
                    ⚠️ Do not reply to this email — replies will not be delivered.<br>
                    Use the Admin Panel link above to respond to ${name}.
                </p>
            `
        });

        if (chatEmailError) {
            console.warn('Chat notification email failed:', chatEmailError);
        }

        // Ntfy push notification for new chat
        try {
            await fetch('https://ntfy.sh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    topic: 'homegrownfoods-orders',
                    title: `💬 New message from ${name}`,
                    message: message.substring(0, 200),
                    tags: ['speech_balloon'],
                    priority: 2
                })
            });
        } catch (ntfyErr) {
            console.warn('Chat ntfy push failed:', ntfyErr);
        }

        res.status(201).json({ message: 'Message sent' });
    } catch (err) {
        console.error('Chat save error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin: get all chat messages ordered by most recent
app.get('/api/admin/chats', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
            id,
            name,
            email,
            message,
            ts,
            read,
            replies,
            TO_CHAR(created_at AT TIME ZONE 'Europe/London', 'DD Mon YYYY HH24:MI') AS date,
            created_at
            FROM chat_messages
            ORDER BY created_at ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Admin chats fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin: reply to a customer — appends reply to the most recent message from that email
app.post('/api/admin/chat/reply', authenticateAdmin, async (req, res) => {
    const { email, name, reply, date, direct, htmlContent, subject } = req.body;
    if (!email || !reply) {
        return res.status(400).json({ error: 'email and reply are required' });
    }
    try {
        const newReply = JSON.stringify({ text: reply, date: date || new Date().toLocaleString('en-GB') });

        // Append to the replies JSONB array on the most recent message from this email
        const result = await pool.query(`
            UPDATE chat_messages
            SET replies = replies || $1::jsonb,
            read = true
            WHERE id = (
                SELECT id FROM chat_messages
                WHERE email = $2
                ORDER BY created_at DESC
                LIMIT 1
            )
            RETURNING id
        `, [`[${newReply}]`, email.toLowerCase().trim()]);

        // If no existing chat message (customer only ordered, never chatted),
        // create a new outbound message record so the reply is tracked
        if (result.rowCount === 0) {
            await pool.query(
                `INSERT INTO chat_messages (name, email, message, ts, read, replies)
                 VALUES ($1, $2, $3, $4, true, $5::jsonb)`,
                [
                    name || email,
                    email.toLowerCase().trim(),
                    '[Direct message initiated from admin CRM]',
                    Date.now(),
                    '[' + newReply + ']'
                ]
            );
        }

        // Use pre-built HTML from frontend template if provided, otherwise use default
        const emailSubject = subject || (direct ? 'A message from Home Grown' : 'Re: Your message to Home Grown');
        const emailHtml    = htmlContent || (
            '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:3px solid #164A2E;border-radius:16px;overflow:hidden;">'
          + '<div style="background:#164A2E;padding:24px;text-align:center;">'
          + '<h1 style="color:#FFD93D;margin:0;font-size:2rem;">Home Grown</h1>'
          + '<p style="color:#6BBF4A;margin:6px 0 0;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.12em;">Food That Makes You Feel Good</p>'
          + '</div>'
          + '<div style="padding:32px;background:#FFFBE8;">'
          + '<p style="color:#0E3019;">Hi <strong>' + name + '</strong>,</p>'
          + (direct ? '<p style="color:#2D6040;">A message from the Home Grown team:</p>' : '<p style="color:#2D6040;">Thanks for getting in touch!</p>')
          + '<div style="background:white;border-left:5px solid #FFD93D;padding:16px 20px;margin:20px 0;border-radius:8px;color:#0E3019;line-height:1.7;">'
          + reply.split('\\n').join('<br>')
          + '</div>'
          + '<p style="color:#5A8A6A;font-size:0.9rem;">If you have any questions, please use the chat widget on our website.</p>'
          + '<p style="color:#999;font-size:0.8rem;margin-top:8px;">Please do not reply directly to this email.</p>'
          + '<div style="text-align:center;margin-top:28px;">'
          + '<a href="https://homegrownfoods.online" style="background:#164A2E;color:#FFD93D;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:bold;">Visit Our Shop &rarr;</a>'
          + '</div></div>'
          + '<div style="background:#164A2E;padding:14px;text-align:center;">'
          + '<p style="color:#A8D97F;margin:0;font-size:0.78rem;">Home Grown &middot; Handmade in Sheffield &middot; homegrownfoods.online</p>'
          + '</div></div>'
        );

        // Send reply email to the customer via Resend
        const { error: replyEmailError } = await resend.emails.send({
            from:    `Home Grown <${SENDER_EMAIL}>`,
            to:      [email],
            subject: emailSubject,
            html:    emailHtml
        });

        if (replyEmailError) {
            console.error('Failed to send reply via Resend:', replyEmailError);
            return res.status(500).json({ error: 'Reply saved, but failed to send email.' });
        }

        res.json({ message: 'Reply sent and saved' });
    } catch (err) {
        console.error('Chat reply error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin: delete all messages in a conversation thread
app.delete('/api/admin/chats/thread', authenticateAdmin, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    try {
        const result = await pool.query(
            'DELETE FROM chat_messages WHERE email = $1',
            [email.toLowerCase().trim()]
        );
        res.json({ message: `Deleted ${result.rowCount} message(s)` });
    } catch (err) {
        console.error('Delete chat thread error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin: mark all messages from an email as read
app.put('/api/admin/chats/read', authenticateAdmin, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    try {
        await pool.query(
            'UPDATE chat_messages SET read = true WHERE email = $1',
            [email.toLowerCase().trim()]
        );
        res.json({ message: 'Marked as read' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  CRM
// ═══════════════════════════════════════════════════════════════════════════════

// CRM list — consolidated by customer name so multiple emails merge into one row
app.get('/api/admin/crm', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            WITH email_names AS (
                SELECT LOWER(TRIM(email)) AS email,
                       NULLIF(TRIM(fname || ' ' || lname), '') AS name
                FROM orders WHERE email IS NOT NULL AND email <> ''
                UNION ALL
                SELECT LOWER(TRIM(email)),
                       NULLIF(TRIM(COALESCE(name, '')), '')
                FROM chat_messages WHERE email IS NOT NULL AND email <> ''
            ),
            email_primary AS (
                SELECT email, MAX(name) AS primary_name
                FROM email_names
                GROUP BY email
            ),
            grouped AS (
                SELECT
                    COALESCE(primary_name, email)            AS group_key,
                    MAX(primary_name)                        AS display_name,
                    ARRAY_AGG(DISTINCT email ORDER BY email) AS emails
                FROM email_primary
                GROUP BY COALESCE(primary_name, email)
            ),
            all_activity AS (
                SELECT LOWER(TRIM(email)) AS email,
                       total::numeric AS ltv, 1 AS order_count, created_at AS last_seen
                FROM orders WHERE email IS NOT NULL
                UNION ALL
                SELECT LOWER(TRIM(email)), 0, 0, created_at FROM chat_messages WHERE email IS NOT NULL
                UNION ALL
                SELECT LOWER(TRIM(email)), 0, 0, created_at FROM wishlist WHERE email IS NOT NULL
            )
            SELECT
                g.group_key,
                g.display_name,
                g.emails,
                COALESCE(SUM(a.order_count), 0) AS order_count,
                COALESCE(SUM(a.ltv), 0)         AS ltv,
                TO_CHAR(MAX(a.last_seen) AT TIME ZONE 'Europe/London', 'DD Mon YYYY') AS last_contact,
                MAX(a.last_seen) AS last_seen_raw,
                -- Message stats for badge
                (SELECT COUNT(*) FROM chat_messages cm
                 WHERE LOWER(cm.email) = ANY(g.emails))::int AS message_count,
                (SELECT COUNT(*) FROM chat_messages cm
                 WHERE LOWER(cm.email) = ANY(g.emails) AND cm.read = false)::int AS unread_count
            FROM grouped g
            LEFT JOIN all_activity a ON a.email = ANY(g.emails)
            GROUP BY g.group_key, g.display_name, g.emails
            ORDER BY MAX(a.last_seen) DESC NULLS LAST
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('CRM list error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Full profile — accepts comma-separated emails to query across all of a customer's addresses
app.get('/api/admin/crm/customer', authenticateAdmin, async (req, res) => {
    const emailsParam = (req.query.emails || req.query.email || '').toLowerCase().trim();
    if (!emailsParam) return res.status(400).json({ error: 'emails required' });
    const emails = emailsParam.split(',').map(e => e.trim()).filter(Boolean);

    try {
        const [ordersRes, chatsRes, notesRes, wishlistRes] = await Promise.all([
            pool.query(
                'SELECT * FROM orders WHERE LOWER(email) = ANY($1) ORDER BY created_at DESC',
                [emails]
            ),
            pool.query(
                'SELECT * FROM chat_messages WHERE LOWER(email) = ANY($1) ORDER BY created_at ASC',
                [emails]
            ),
            pool.query(
                'SELECT * FROM customer_notes WHERE LOWER(email) = ANY($1) ORDER BY created_at DESC',
                [emails]
            ),
            pool.query(
                `SELECT w.*, p.name AS product_name, p.emoji
                 FROM   wishlist w
                 LEFT JOIN products p ON p.id = w.product_id
                 WHERE  LOWER(w.email) = ANY($1)`,
                [emails]
            )
        ]);
        res.json({
            emails:   emails,
            orders:   ordersRes.rows,
            messages: chatsRes.rows,
            notes:    notesRes.rows,
            wishlist: wishlistRes.rows
        });
    } catch (err) {
        console.error('CRM profile error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add a note — stored against the primary (first) email of the group
app.post('/api/admin/crm/notes', authenticateAdmin, async (req, res) => {
    const { email, note } = req.body;
    if (!email || !note) return res.status(400).json({ error: 'email and note required' });
    try {
        const result = await pool.query(
            'INSERT INTO customer_notes (email, note) VALUES ($1, $2) RETURNING *',
            [email.toLowerCase().trim(), note.trim()]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a note
app.delete('/api/admin/crm/notes/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM customer_notes WHERE id = $1', [req.params.id]);
        res.json({ message: 'Note deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─── BROADCAST EMAIL ──────────────────────────────────────────────────────────
// Send a composed email to ALL unique customer email addresses
app.post('/api/admin/crm/broadcast', authenticateAdmin, async (req, res) => {
    const { subject, message } = req.body;
    if (!subject || !message) {
        return res.status(400).json({ error: 'subject and message are required' });
    }
    try {
        // Collect every unique email across orders, chat_messages and wishlist
        const emailRes = await pool.query(`
            SELECT DISTINCT LOWER(TRIM(email)) AS email
            FROM (
                SELECT email FROM orders        WHERE email IS NOT NULL AND email <> ''
                UNION
                SELECT email FROM chat_messages WHERE email IS NOT NULL AND email <> ''
                UNION
                SELECT email FROM wishlist      WHERE email IS NOT NULL AND email <> ''
            ) all_emails
            ORDER BY email
        `);

        const allEmails = emailRes.rows.map(r => r.email);
        if (!allEmails.length) {
            return res.status(400).json({ error: 'No customer emails found' });
        }

        let sent = 0;
        let failed = 0;

        for (const toEmail of allEmails) {
            const { error } = await resend.emails.send({
                from:    `Home Grown <${SENDER_EMAIL}>`,
                to:      [toEmail],
                subject: subject,
                html: `
                    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto; border:3px solid #164A2E; border-radius:16px; overflow:hidden;">
                        <div style="background:#164A2E; padding:24px; text-align:center;">
                            <h1 style="color:#FFD93D; margin:0; font-size:2rem; letter-spacing:0.03em;">Home Grown</h1>
                            <p style="color:#6BBF4A; margin:6px 0 0; font-size:0.8rem; letter-spacing:0.12em; text-transform:uppercase;">Food That Makes You Feel Good</p>
                        </div>
                        <div style="padding:32px; background:#FFFBE8;">
                            <div style="color:#0E3019; font-size:1rem; line-height:1.8;">
                            ${message.split('\\n').join('<br>')}

                            </div>
                            <div style="text-align:center; margin-top:32px;">
                                <a href="https://homegrownfoods.online" style="background:#164A2E; color:#FFD93D; padding:14px 32px; border-radius:999px; text-decoration:none; font-weight:bold; font-size:1rem;">Visit Our Shop →</a>
                            </div>
                        </div>
                        <div style="background:#164A2E; padding:14px; text-align:center;">
                            <p style="color:#A8D97F; margin:0; font-size:0.78rem;">Home Grown · Handmade in Sheffield · homegrownfoods.online</p>
                            <p style="color:#6BBF4A; margin:4px 0 0; font-size:0.72rem;">⚠️ Please do not reply to this email directly.</p>
                        </div>
                    </div>
                `
            });
            if (error) { console.warn('Broadcast failed for', toEmail, error); failed++; }
            else sent++;
        }

        res.json({
            message: 'Broadcast complete',
            sent,
            failed,
            total: allEmails.length
        });
    } catch (err) {
        console.error('Broadcast error:', err);
        res.status(500).json({ error: err.message });
    }
});


// ─── STRIPE SUBSCRIPTION CHECKOUT ────────────────────────────────────────────
// Creates a Stripe Checkout Session in subscription mode.
// Requires: product must have stripe_recurring_price_id set in admin panel.
app.post('/api/create-subscription-session', async (req, res) => {
    const { priceId, productName, customerEmail } = req.body;
    if (!priceId) {
        return res.status(400).json({ error: 'No Stripe recurring price ID configured for this product. Set it in Admin → Products → Edit.' });
    }
    try {
        // Line items: the product recurring price + a delivery fee line
        const lineItems = [{ price: priceId, quantity: 1 }];

        // If no separate price ID for delivery, add delivery as a one-off in metadata
        // (delivery is baked into the Stripe recurring price set by admin)
        const session = await stripe.checkout.sessions.create({
            mode:                 'subscription',
            payment_method_types: ['card'],
            billing_address_collection: 'required',
            shipping_address_collection: { allowed_countries: ['GB'] },
            line_items:        lineItems,
            customer_email:    customerEmail || undefined,
            success_url:       'https://homegrownfoods.online?subscribed=1&product=' + encodeURIComponent(productName || ''),
            cancel_url:        'https://homegrownfoods.online',
            metadata:          { product_name: productName || '', delivery_fee: '3.99' }
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe subscription session error:', err);
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  CAMPAIGNS / AUDIENCE / TAGS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Ensure a contact row exists + return its unsub token ──
async function ensureContact(email, firstName) {
    const e = email.toLowerCase().trim();
    const crypto = require('crypto');
    const token  = crypto.randomBytes(16).toString('hex');
    const r = await pool.query(
        `INSERT INTO contacts (email, first_name, unsub_token)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET first_name = COALESCE(contacts.first_name, EXCLUDED.first_name)
         RETURNING *`,
        [e, firstName || null, token]
    );
    return r.rows[0];
}

// ─── TAGS ──
app.get('/api/admin/tags/:email', authenticateAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT tag FROM customer_tags WHERE email = $1 ORDER BY tag',
            [req.params.email.toLowerCase().trim()]);
        res.json(r.rows.map(x => x.tag));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/tags', authenticateAdmin, async (req, res) => {
    const { email, tag } = req.body;
    if (!email || !tag) return res.status(400).json({ error: 'email and tag required' });
    try {
        await pool.query(
            'INSERT INTO customer_tags (email, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [email.toLowerCase().trim(), tag.trim()]
        );
        res.json({ message: 'Tag added' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/tags', authenticateAdmin, async (req, res) => {
    const { email, tag } = req.body;
    try {
        await pool.query('DELETE FROM customer_tags WHERE email = $1 AND tag = $2',
            [email.toLowerCase().trim(), tag.trim()]);
        res.json({ message: 'Tag removed' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// All distinct tags in use (for segment dropdown)
app.get('/api/admin/tags', authenticateAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT DISTINCT tag FROM customer_tags ORDER BY tag');
        res.json(r.rows.map(x => x.tag));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SEGMENT RESOLVER — returns array of {email, first_name} matching a segment ──
async function resolveSegment(segment) {
    segment = segment || {};
    // Base: all subscribed contacts
    let sql = `
        SELECT c.email, c.first_name
        FROM contacts c
        WHERE c.is_subscribed = TRUE
    `;
    const params = [];
    let n = 0;

    if (segment.tag) {
        n++;
        sql += ` AND c.email IN (SELECT email FROM customer_tags WHERE tag = $${n})`;
        params.push(segment.tag);
    }

    if (segment.neverOrdered) {
        sql += ` AND c.email NOT IN (SELECT DISTINCT LOWER(email) FROM orders)`;
    }

    if (segment.orderedWithinDays) {
        n++;
        sql += ` AND c.email IN (
            SELECT DISTINCT LOWER(email) FROM orders
            WHERE created_at > NOW() - ($${n} || ' days')::interval
        )`;
        params.push(String(parseInt(segment.orderedWithinDays)));
    }

    if (segment.ltvMin) {
        n++;
        sql += ` AND c.email IN (
            SELECT LOWER(email) FROM orders
            GROUP BY LOWER(email)
            HAVING SUM(total::numeric) >= $${n}
        )`;
        params.push(parseFloat(segment.ltvMin));
    }

    const r = await pool.query(sql, params);
    return r.rows;
}

// Preview how many people a segment matches
app.post('/api/admin/segment/preview', authenticateAdmin, async (req, res) => {
    try {
        const rows = await resolveSegment(req.body.segment);
        res.json({ count: rows.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CAMPAIGNS CRUD ──
app.get('/api/admin/campaigns', authenticateAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/campaigns', authenticateAdmin, async (req, res) => {
    const { name, subject, body_html, segment, status, scheduled_at } = req.body;
    try {
        const r = await pool.query(
            `INSERT INTO campaigns (name, subject, body_html, segment, status, scheduled_at)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [name || 'Untitled Campaign', subject || '', body_html || '',
             JSON.stringify(segment || {}), status || 'draft', scheduled_at || null]
        );
        res.status(201).json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/campaigns/:id', authenticateAdmin, async (req, res) => {
    const { name, subject, body_html, segment, status, scheduled_at } = req.body;
    try {
        const r = await pool.query(
            `UPDATE campaigns SET name=$1, subject=$2, body_html=$3, segment=$4,
             status=$5, scheduled_at=$6 WHERE id=$7 RETURNING *`,
            [name, subject, body_html, JSON.stringify(segment || {}),
             status, scheduled_at || null, req.params.id]
        );
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/campaigns/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
        res.json({ message: 'Campaign deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SEND A CAMPAIGN (immediate) ──
async function sendCampaign(campaignId) {
    const cRes = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    const campaign = cRes.rows[0];
    if (!campaign) throw new Error('Campaign not found');

    await pool.query('UPDATE campaigns SET status = $1 WHERE id = $2', ['sending', campaignId]);

    const recipients = await resolveSegment(campaign.segment || {});
    let sent = 0;

    for (const person of recipients) {
        const contact = await ensureContact(person.email, person.first_name);
        const firstName = person.first_name || 'there';
        const unsubUrl = `https://homegrownfoods.online/api/unsubscribe/${contact.unsub_token}`;

        // Personalisation merge tags + real unsubscribe link
        let html = (campaign.body_html || '')
            .split('{{first_name}}').join(firstName)
            .split('{{email}}').join(person.email)
            .split('{{unsubscribe_url}}').join(unsubUrl);

        // Tracking pixel
        const trackId  = campaignId + '_' + Buffer.from(person.email).toString('base64');
        const pixel    = `<img src="https://homegrownfoods.online/api/track/open/${trackId}" width="1" height="1" style="display:none;" alt="">`;

        // Safety net: if the template has no unsubscribe link at all, append a minimal one (legal requirement)
        const unsubFooter = html.indexOf(unsubUrl) === -1
            ? `<div style="text-align:center;padding:16px;font-size:0.72rem;color:#999;">If you don't want to receive these emails, please <a href="${unsubUrl}" style="color:#999;">unsubscribe here</a>.</div>`
            : '';

        try {
            await resend.emails.send({
                from:    `Home Grown <${SENDER_EMAIL}>`,
                to:      [person.email],
                subject: campaign.subject || 'A message from Home Grown',
                html:    html + unsubFooter + pixel
            });
            await pool.query(
                `INSERT INTO campaign_events (campaign_id, email, event_type) VALUES ($1,$2,'delivered')`,
                [campaignId, person.email]
            );
            sent++;
        } catch (e) { console.warn('Campaign send failed for', person.email, e.message); }
    }

    await pool.query(
        'UPDATE campaigns SET status=$1, sent_at=NOW(), sent_count=$2 WHERE id=$3',
        ['sent', sent, campaignId]
    );
    return sent;
}

app.post('/api/admin/campaigns/:id/send', authenticateAdmin, async (req, res) => {
    try {
        const sent = await sendCampaign(req.params.id);
        res.json({ message: `Campaign sent to ${sent} recipients`, sent });
    } catch (err) {
        console.error('Send campaign error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── OPEN TRACKING (1x1 pixel) ──
app.get('/api/track/open/:trackId', async (req, res) => {
    try {
        const [cid, emailB64] = req.params.trackId.split('_');
        const email = Buffer.from(emailB64, 'base64').toString('utf8');
        // Only count first open per recipient
        const existing = await pool.query(
            `SELECT 1 FROM campaign_events WHERE campaign_id=$1 AND email=$2 AND event_type='opened'`,
            [cid, email]
        );
        if (existing.rowCount === 0) {
            await pool.query(
                `INSERT INTO campaign_events (campaign_id, email, event_type) VALUES ($1,$2,'opened')`,
                [cid, email]
            );
            await pool.query('UPDATE campaigns SET open_count = open_count + 1 WHERE id = $1', [cid]);
        }
    } catch (e) { /* swallow — never break the pixel */ }
    // Return a 1x1 transparent gif
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store');
    res.end(gif);
});

// ─── CLICK TRACKING (redirect) ──
app.get('/api/track/click/:trackId', async (req, res) => {
    const dest = req.query.url || 'https://homegrownfoods.online';
    try {
        const [cid, emailB64] = req.params.trackId.split('_');
        const email = Buffer.from(emailB64, 'base64').toString('utf8');
        await pool.query(
            `INSERT INTO campaign_events (campaign_id, email, event_type) VALUES ($1,$2,'clicked')`,
            [cid, email]
        );
        await pool.query('UPDATE campaigns SET click_count = click_count + 1 WHERE id = $1', [cid]);
    } catch (e) {}
    res.redirect(dest);
});

// ─── UNSUBSCRIBE ──
app.get('/api/unsubscribe/:token', async (req, res) => {
    try {
        const r = await pool.query(
            'UPDATE contacts SET is_subscribed = FALSE WHERE unsub_token = $1 RETURNING email',
            [req.params.token]
        );
        const email = r.rows[0]?.email || 'your email';
        res.setHeader('Content-Type', 'text/html');
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Unsubscribed — Home Grown</title></head>
            <body style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;text-align:center;padding:0 20px;">
            <div style="border:3px solid #164A2E;border-radius:16px;overflow:hidden;">
              <div style="background:#164A2E;padding:28px;">
                <h1 style="color:#FFD93D;margin:0;">Home Grown</h1></div>
              <div style="padding:32px;background:#FFFBE8;">
                <h2 style="color:#164A2E;">You've been unsubscribed</h2>
                <p style="color:#2D6040;line-height:1.6;">${email} will no longer receive marketing emails from us.
                You'll still get order confirmations for any purchases.</p>
                <p style="color:#5A8A6A;font-size:0.9rem;">Changed your mind? Just contact us and we'll add you back.</p>
                <a href="https://homegrownfoods.online" style="display:inline-block;margin-top:16px;background:#164A2E;color:#FFD93D;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:bold;">Back to Shop</a>
              </div></div></body></html>`);
    } catch (err) { res.status(500).send('Error processing unsubscribe'); }
});

// ─── EMAIL WEBHOOK (Resend/SendGrid events) ──
app.post('/api/webhooks/email', async (req, res) => {
    try {
        const evt = req.body;
        // Resend format: { type: 'email.opened'|'email.clicked', data: { email_id, to, ... } }
        const type = evt.type || evt.event;
        const email = (evt.data && (evt.data.to || evt.data.email)) || evt.email;
        const campaignId = evt.data?.tags?.campaign_id || req.query.cid;
        if (campaignId && email) {
            if (type && type.indexOf('open') !== -1) {
                await pool.query('UPDATE campaigns SET open_count = open_count + 1 WHERE id = $1', [campaignId]);
                await pool.query(`INSERT INTO campaign_events (campaign_id, email, event_type) VALUES ($1,$2,'opened')`, [campaignId, email]);
            } else if (type && type.indexOf('click') !== -1) {
                await pool.query('UPDATE campaigns SET click_count = click_count + 1 WHERE id = $1', [campaignId]);
                await pool.query(`INSERT INTO campaign_events (campaign_id, email, event_type) VALUES ($1,$2,'clicked')`, [campaignId, email]);
            }
        }
        res.json({ received: true });
    } catch (err) { res.status(200).json({ received: true }); } // always 200 so provider doesn't retry-storm
});

// ─── SCHEDULED CAMPAIGN POLLER ──
// Netlify scheduled function or external cron should hit this endpoint every few minutes.
app.post('/api/admin/campaigns/run-scheduled', async (req, res) => {
    // simple shared-secret guard
    if (req.query.key !== process.env.CRON_SECRET) {
        return res.status(403).json({ error: 'forbidden' });
    }
    try {
        const due = await pool.query(
            `SELECT id FROM campaigns WHERE status='scheduled' AND scheduled_at <= NOW()`
        );
        let ran = 0;
        for (const row of due.rows) {
            await sendCampaign(row.id);
            ran++;
        }
        res.json({ message: `Ran ${ran} scheduled campaign(s)`, ran });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  STOCKIST PROSPECTING
// ═══════════════════════════════════════════════════════════════════════════════

// Search Google Places for local businesses of a given type near a location
app.post('/api/admin/prospects/search', authenticateAdmin, async (req, res) => {
    const { query, location } = req.body; // e.g. query="cafe", location="Sheffield, UK"
    if (!query) return res.status(400).json({ error: 'query required' });
    const apiKey = process.env.GOOGLE_PLACES_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GOOGLE_PLACES_KEY not set in environment' });

    try {
        const searchText = query + ' in ' + (location || 'Sheffield, UK');
        const url = 'https://places.googleapis.com/v1/places:searchText';
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryTypeDisplayName'
            },
            body: JSON.stringify({ textQuery: searchText, maxResultCount: 20, regionCode: 'GB' })
        });
        const data = await r.json();
        if (data.error) return res.status(500).json({ error: data.error.message || 'Places API error' });

        const results = (data.places || []).map(function(p) {
            return {
                place_id: p.id,
                name:     p.displayName ? p.displayName.text : '',
                address:  p.formattedAddress || '',
                phone:    p.nationalPhoneNumber || '',
                website:  p.websiteUri || '',
                category: p.primaryTypeDisplayName ? p.primaryTypeDisplayName.text : query
            };
        });
        res.json({ results: results });
    } catch (err) {
        console.error('Prospect search error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Save selected prospects to the database (dedupe by place_id)
app.post('/api/admin/prospects', authenticateAdmin, async (req, res) => {
    const { prospects } = req.body; // array
    if (!prospects || !prospects.length) return res.status(400).json({ error: 'no prospects provided' });
    try {
        let saved = 0;
        for (const p of prospects) {
            const r = await pool.query(
                `INSERT INTO prospects (name, category, address, phone, website, place_id, status)
                 VALUES ($1,$2,$3,$4,$5,$6,'new')
                 ON CONFLICT (place_id) DO NOTHING`,
                [p.name, p.category || null, p.address || null, p.phone || null, p.website || null, p.place_id || null]
            );
            if (r.rowCount > 0) saved++;
        }
        res.json({ message: 'Saved ' + saved + ' new prospects', saved: saved });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// List saved prospects
app.get('/api/admin/prospects', authenticateAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM prospects ORDER BY created_at DESC');
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update a prospect (status, email, notes, draft)
app.put('/api/admin/prospects/:id', authenticateAdmin, async (req, res) => {
    const { status, email, notes, draft_email } = req.body;
    try {
        const r = await pool.query(
            `UPDATE prospects SET
                status      = COALESCE($1, status),
                email       = COALESCE($2, email),
                notes       = COALESCE($3, notes),
                draft_email = COALESCE($4, draft_email)
             WHERE id = $5 RETURNING *`,
            [status || null, email || null, notes || null, draft_email || null, req.params.id]
        );
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/prospects/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM prospects WHERE id = $1', [req.params.id]);
        res.json({ message: 'Prospect deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send the outreach email to a prospect (individual, B2B)
app.post('/api/admin/prospects/:id/send', authenticateAdmin, async (req, res) => {
    const { email, body } = req.body;
    if (!email || !body) return res.status(400).json({ error: 'email and body required' });
    try {
        const pRes = await pool.query('SELECT * FROM prospects WHERE id = $1', [req.params.id]);
        const p = pRes.rows[0];
        if (!p) return res.status(404).json({ error: 'Prospect not found' });

        await resend.emails.send({
            from:    `Home Grown <${SENDER_EMAIL}>`,
            to:      [email],
            replyTo: process.env.REPLY_TO_EMAIL,
            subject: `Home Grown — a Sheffield snack maker saying hello 🌿`,
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;line-height:1.7;color:#0E3019;">`
                + body.split('\n').join('<br>')
                + `<br><br><div style="border-top:1px solid #ddd;padding-top:12px;margin-top:20px;font-size:0.8rem;color:#999;">`
                + `Home Grown &middot; Handmade in Sheffield &middot; homegrownfoods.online<br>`
                + `This is a one-off B2B enquiry. If you'd rather not hear from us, just reply and let us know.</div></div>`
        });

        await pool.query('UPDATE prospects SET status = $1, email = $2 WHERE id = $3', ['contacted', email, req.params.id]);
        res.json({ message: 'Outreach sent' });
    } catch (err) {
        console.error('Prospect send error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── SERVERLESS EXPORT ────────────────────────────────────────────────────────
const serverlessHandler = serverless(app);
exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    return serverlessHandler(event, context);
};
