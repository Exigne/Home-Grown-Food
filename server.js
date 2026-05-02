require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// Secure connection to Neon PostgreSQL
const pool = new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { require: true }
});

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware to protect admin routes
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        next();
    });
};

// --- AUTHENTICATION ---
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
        const { amount, currency } = req.body;
        // Create a PaymentIntent with the order amount and currency
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: currency || 'gbp',
            automatic_payment_methods: { enabled: true },
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- PUBLIC ROUTES (Orders) ---
app.post('/api/orders', async (req, res) => {
    const { id, fname, lname, email, address, items, total, status, date } = req.body;
    try {
        await pool.query(
            `INSERT INTO orders (id, fname, lname, email, address, items, total, status, date) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, fname, lname, email, address, items, total, status, date]
        );
        res.status(201).json({ message: 'Order placed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save order' });
    }
});

// --- PROTECTED ADMIN ROUTES ---
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

app.get('/api/admin/ingredients', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ingredients ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/ingredients', authenticateAdmin, async (req, res) => {
    try {
        const { name, unit, stock, min_stock, max_stock } = req.body;
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

// Export as a Netlify Serverless Function
const serverless = require('serverless-http');
module.exports.handler = serverless(app);
