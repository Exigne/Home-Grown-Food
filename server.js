require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json());

// --- DATABASE CONNECTION ---
const pool = new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { require: true }
});

// --- EMAIL CONFIGURATION ---
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

// --- AUTH MIDDLEWARE ---
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    jwt.verify(token, JWT_SECRET, (err) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        next();
    });
};

// --- PUBLIC CONFIG ROUTE ---
// This allows the frontend to get the Stripe Publishable Key from the cloud
app.get('/api/config', (req, res) => {
    res.json({
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY 
    });
});

// --- AUTHENTICATION ROUTE ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// --- STRIPE PAYMENT INTENT ---
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount } = req.body;
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: 'gbp',
            automatic_payment_methods: { enabled: true },
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SECURE ORDER PLACEMENT (With Email Verification) ---
app.post('/api/orders', async (req, res) => {
    const { id, fname, lname, email, address, items, total, status, date, paymentIntentId } = req.body;
    try {
        // 1. Double check payment status with Stripe directly
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== 'succeeded') return res.status(400).json({ error: 'Payment not verified' });

        // 2. Save to Neon Database
        await pool.query(
            `INSERT INTO orders (id, fname, lname, email, address, items, total, status, date) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, fname, lname, email, address, items, total, status, date]
        );

        // 3. Send Notification Email to you
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER,
            subject: `📦 Order ${id} Confirmed`,
            html: `<h3>New Order from ${fname} ${lname}</h3><p>Total: £${total}</p><p>Items: ${items}</p>`
        });

        res.status(201).json({ message: 'Order processed successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- PUBLIC PRODUCT ROUTE ---
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ADMIN: PRODUCT MANAGEMENT ---
app.post('/api/admin/products', authenticateAdmin, async (req, res) => {
    const { name, emoji, price, description, bg_color, badge, image_url } = req.body;
    try {
        await pool.query(
            `INSERT INTO products (name, emoji, price, description, bg_color, badge, image_url) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`, 
            [name, emoji, price, description, bg_color, badge, image_url]
        );
        res.json({ message: 'Product added' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    const { name, emoji, price, description, bg_color, badge, image_url } = req.body;
    try {
        await pool.query(
            `UPDATE products SET name=$1, emoji=$2, price=$3, description=$4, bg_color=$5, badge=$6, image_url=$7 
             WHERE id=$8`,
            [name, emoji, price, description, bg_color, badge, image_url, req.params.id]
        );
        res.json({ message: 'Product updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.json({ message: 'Product deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ADMIN: ORDER MANAGEMENT ---
app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
        res.json({ message: 'Order updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ADMIN: INGREDIENT MANAGEMENT ---
app.get('/api/admin/ingredients', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ingredients ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ingredients', authenticateAdmin, async (req, res) => {
    const { name, unit, stock, min_stock, max_stock } = req.body;
    try {
        await pool.query(
            'INSERT INTO ingredients (name, unit, stock, min_stock, max_stock) VALUES ($1, $2, $3, $4, $5)',
            [name, unit, stock, min_stock, max_stock]
        );
        res.json({ message: 'Ingredient added' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/ingredients/:id', authenticateAdmin, async (req, res) => {
    try {
        const { stock } = req.body;
        await pool.query('UPDATE ingredients SET stock = $1 WHERE id = $2', [stock, req.params.id]);
        res.json({ message: 'Stock updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/ingredients/:id', authenticateAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM ingredients WHERE id = $1', [req.params.id]);
        res.json({ message: 'Ingredient removed' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export for Netlify Functions
module.exports.handler = serverless(app);
