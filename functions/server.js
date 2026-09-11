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

            generatedItemsText.push(`${product.name} × ${item.qty}`);
            subtotal += parseFloat(product.price) * item.qty;
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

        const shipping = pickup ? 0 : 3.00;
        const calculatedTotal = Math.max(0, subtotal - discount + shipping);
        const itemsString = generatedItemsText.join(', ');

        await client.query(
            `INSERT INTO orders (id, fname, lname, email, address, items, total, status, date, postcode, pickup)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [id, fname, lname, email, address, itemsString, calculatedTotal.toFixed(2), status, date, postcode, pickup || false]
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
        const { error: emailError } = await resend.emails.send({
            from: `Home Grown Orders <${SENDER_EMAIL}>`,
            to: [process.env.EMAIL_USER], // Still sending to your personal inbox for notification
            subject: `📦 New Order ${id} — £${calculatedTotal.toFixed(2)}`,
            html: `
                <h2>New Order from ${fname} ${lname}</h2>
                <p><strong>Order ID:</strong> ${id}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Address:</strong> ${address}</p>
                <p><strong>Fulfilment:</strong> ${pickupLabel}</p>
                <p><strong>Items:</strong> ${itemsString}</p>
                ${promoCode ? `<p><strong>Promo Used:</strong> ${promoCode}</p>` : ''}
                <p><strong>Total:</strong> £${calculatedTotal.toFixed(2)}</p>
            `
        });
        
        if (emailError) {
            console.warn('Admin email failed:', emailError);
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
                <p style="color:#999; font-size:12px;">
                    You can reply directly to this email to respond to ${name},
                    or log in to the admin panel and use the Inbox section.
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
    const { email, name, reply, date } = req.body;
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

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'No messages found for that email' });
        }

        // Send reply email to the customer via Resend
        const { error: replyEmailError } = await resend.emails.send({
            from: `Home Grown <${SENDER_EMAIL}>`,
            to: [email],
            replyTo: SENDER_EMAIL,
            subject: `Re: Your message to Home Grown 🌿`,
            html: `
                <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto; border:3px solid #164A2E; border-radius:16px; overflow:hidden;">
                    <div style="background:#164A2E; padding:24px; text-align:center;">
                        <h1 style="color:#FFD93D; margin:0; font-size:2rem; letter-spacing:0.03em;">Home Grown</h1>
                        <p style="color:#6BBF4A; margin:6px 0 0; font-size:0.8rem; letter-spacing:0.12em; text-transform:uppercase;">Food That Makes You Feel Good</p>
                    </div>
                    <div style="padding:32px; background:#FFFBE8;">
                        <p style="color:#0E3019; font-size:1rem;">Hi <strong>${name}</strong>,</p>
                        <p style="color:#2D6040;">Thanks for getting in touch! Here's our reply:</p>
                        <div style="background:white; border-left:5px solid #FFD93D; padding:16px 20px; margin:24px 0; border-radius:8px; color:#0E3019; line-height:1.7;">
                            ${reply.split('\n').join('<br>')}
                        </div>
                        <p style="color:#5A8A6A; font-size:0.9rem;">If you have any more questions, just reply to this email or message us on the website.</p>
                        <div style="text-align:center; margin-top:28px;">
                            <a href="https://homegrownfoods.online" style="background:#164A2E; color:#FFD93D; padding:12px 28px; border-radius:999px; text-decoration:none; font-weight:bold; font-size:0.95rem;">Visit Our Shop →</a>
                        </div>
                    </div>
                    <div style="background:#164A2E; padding:14px; text-align:center;">
                        <p style="color:#A8D97F; margin:0; font-size:0.78rem;">Home Grown · Handmade in Sheffield · homegrownfoods.online</p>
                    </div>
                </div>
            `
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

// ─── SERVERLESS EXPORT ────────────────────────────────────────────────────────
const serverlessHandler = serverless(app);
exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    return serverlessHandler(event, context);
};
