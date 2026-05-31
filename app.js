// ═══════════════════════════════════════════════
//  HOME GROWN — app.js  (v5 — fully fixed)
// ═══════════════════════════════════════════════

// --- CONFIGURATION & STATE ---
const API_BASE = window.location.origin + '/api';
let adminToken = localStorage.getItem('hg_admin_token') || null;
let STRIPE_PUBLISHABLE_KEY = 'pk_live_51PU4upEFaqxyf7ELOsith63WwqUuTzYYzEreW1DEyqn6o2KoLBkzYDLECvMznQZiG9enOc7hhu7kFdai1Cg4eFVK00ZV9S7qmV';
let cart = [];
let orders = [];
let ingredients = [];
let products = [];
let promos = [];
let stripeInstance = null;
let cardElement = null;

// Promo state
let appliedPromo = null; // { code, discount } or null

// --- DEMO FALLBACK DATA ---
const DEMO_PRODUCTS = [
    { id: 1, name: 'Honey Oat Clusters', price: 5.50, emoji: '🍯', badge: 'Best Seller', description: 'Crunchy clusters baked with local honey.', bg_color: '#FFFBE8' },
    { id: 2, name: 'Seeded Crackers',    price: 3.95, emoji: '🌾', badge: null,          description: 'Wholegrain crackers with flax & sesame.', bg_color: '#F5F5DC' },
    { id: 3, name: 'Fruit & Nut Bar',    price: 2.50, emoji: '🍫', badge: 'Vegan',        description: 'Dates, almonds and dark chocolate.',      bg_color: '#FFF0F0' },
    { id: 4, name: 'Sourdough Crisps',   price: 4.20, emoji: '🥖', badge: null,          description: 'Thin, crispy sourdough bites.',          bg_color: '#FFF8F0' }
];

// --- CACHE HELPERS ---
const CACHE_KEY     = 'hg_products_cache';
const CACHE_MAX_AGE = 1000 * 60 * 5; // 5 minutes

function getCachedProducts() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const { data, ts } = JSON.parse(raw);
        if (Date.now() - ts > CACHE_MAX_AGE) return null;
        return data;
    } catch (e) { return null; }
}

function setCachedProducts(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); }
    catch (e) { /* ignore quota errors */ }
}

function fetchWithTimeout(url, options = {}, timeout = 8000) {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ]);
}

// ─── INITIALIZE ──────────────────────────────────────────────────────────────
async function initApp() {
    // 1. Render from cache instantly if available
    const cached = getCachedProducts();
    if (cached && cached.length) {
        products = cached;
        document.getElementById('shop-loading').style.display = 'none';
        document.getElementById('products-grid').style.display = 'grid';
        renderShop();
    }

    // 2. Fetch config in background (non-blocking)
    try {
        const res = await fetchWithTimeout(`${API_BASE}/config`, {}, 5000);
        if (res.ok) {
            const data = await res.json();
            STRIPE_PUBLISHABLE_KEY = data.stripePublishableKey || STRIPE_PUBLISHABLE_KEY;
        }
    } catch (e) {
        console.warn('Config fetch failed — running in demo mode');
    }

    // 3. Fetch fresh products
    try {
        const res = await fetchWithTimeout(`${API_BASE}/products`, {}, 8000);
        if (res.ok) {
            const fresh = await res.json();
            if (fresh && fresh.length) {
                products = fresh;
                setCachedProducts(fresh);
                document.getElementById('shop-loading').style.display = 'none';
                document.getElementById('products-grid').style.display = 'grid';
                renderShop();
            }
        } else {
            throw new Error('Bad response');
        }
    } catch (error) {
        console.error('Products fetch failed:', error);
        if (!products.length) {
            products = DEMO_PRODUCTS;
            document.getElementById('shop-loading').style.display = 'none';
            document.getElementById('products-grid').style.display = 'grid';
            renderShop();
        }
    }

    updateCartUI();
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
function showView(v, e) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('view-' + v).classList.add('active');

    if (e) {
        const btn = e.target.closest('.nav-btn') || e.target;
        if (btn.classList.contains('nav-btn')) btn.classList.add('active');
    }

    if (v === 'admin') {
        if (adminToken) {
            document.getElementById('admin-login-screen').style.display = 'none';
            document.getElementById('admin-layout').style.display = 'grid';
            loadAdminData();
        } else {
            document.getElementById('admin-login-screen').style.display = 'flex';
            document.getElementById('admin-layout').style.display = 'none';
        }
    }
}

// ─── ADMIN AUTH ───────────────────────────────────────────────────────────────
async function handleAdminLogin() {
    const user = document.getElementById('admin-user').value.trim();
    const pass = document.getElementById('admin-pass').value;
    if (!user || !pass) { showToast('Please enter username and password'); return; }

    try {
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });
        if (res.ok) {
            const data = await res.json();
            adminToken = data.token;
            localStorage.setItem('hg_admin_token', adminToken);
            document.getElementById('admin-login-screen').style.display = 'none';
            document.getElementById('admin-layout').style.display = 'grid';
            loadAdminData();
            showToast('✓ Logged in successfully');
        } else {
            showToast('Invalid credentials. Please try again.');
        }
    } catch (error) {
        showToast('Login failed — check your connection');
    }
}

function handleLogout() {
    adminToken = null;
    localStorage.removeItem('hg_admin_token');
    document.getElementById('admin-login-screen').style.display = 'flex';
    document.getElementById('admin-layout').style.display = 'none';
    showToast('Logged out');
}

// ─── ADMIN DATA LOADING ───────────────────────────────────────────────────────
async function loadAdminData() {
    if (!adminToken) return;
    try {
        const headers = { 'Authorization': `Bearer ${adminToken}` };
        const [ordRes, ingRes, prodRes, promoRes] = await Promise.all([
            fetch(`${API_BASE}/admin/orders`,      { headers }),
            fetch(`${API_BASE}/admin/ingredients`, { headers }),
            fetch(`${API_BASE}/admin/products`,    { headers }),
            fetch(`${API_BASE}/admin/promos`,      { headers })
        ]);
        if (ordRes.ok)   orders      = await ordRes.json();
        if (ingRes.ok)   ingredients = await ingRes.json();
        if (prodRes.ok)  products    = await prodRes.json();
        if (promoRes.ok) promos      = await promoRes.json();

        renderAdmin();
        renderPromos();
    } catch (error) {
        console.error('Admin data sync failed:', error);
        showToast('Failed to load admin data');
    }
}

// ─── ADMIN SECTION SWITCHING ──────────────────────────────────────────────────
function showAdminSection(s, el) {
    document.querySelectorAll('.admin-section').forEach(sec => sec.classList.remove('active'));
    const section = document.getElementById('section-' + s);
    if (section) section.classList.add('active');

    document.querySelectorAll('.admin-menu-item').forEach(item => item.classList.remove('active'));
    const menuEl = el instanceof Element ? el : el?.currentTarget;
    if (menuEl && menuEl.classList.contains('admin-menu-item')) {
        menuEl.classList.add('active');
    }

    // Start real-time stock polling only on products section
    if (s === 'products') startStockPolling();
    else stopStockPolling();

    loadAdminData();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// Safely converts plain text with line breaks to HTML, preventing XSS
function formatDesc(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
}

// ─── RENDER SHOP ──────────────────────────────────────────────────────────────
function renderShop() {
    const grid = document.getElementById('products-grid');
    if (!products.length) {
        grid.innerHTML = '<p style="color:var(--text-muted); font-weight:700;">No products available.</p>';
        return;
    }
    grid.innerHTML = products.map(p => {
        const outOfStock = (p.stock !== undefined && p.stock !== null && p.stock <= 0);
        const stockClass = outOfStock ? 'out-of-stock' : '';

        return `
        <div class="product-card ${stockClass}" onclick="openProductDetail(${p.id})">
          <div class="product-img" style="background-color:${p.bg_color || '#FFFBE8'};${p.image_url ? `background-image:url('${p.image_url}');background-size:cover;background-position:center;` : ''}">
            ${!p.image_url ? `<span class="product-emoji">${p.emoji || '🍪'}</span>` : ''}
            ${p.badge ? `<span class="product-badge">${p.badge}</span>` : ''}
            ${outOfStock ? `<div class="product-sold-out-overlay">Sold Out</div>` : ''}
          </div>
          <div class="product-body">
            <div class="product-name">${p.name}</div>
            <div class="product-desc">${formatDesc(p.description)}</div>
          </div>
          <div class="product-footer">
            <span class="product-price">£${Number(p.price).toFixed(2)}</span>
            <button class="add-btn" id="add-btn-${p.id}"
              onclick="event.stopPropagation(); addToCart(${p.id})"
              ${outOfStock ? 'disabled' : ''}>
              ${outOfStock ? 'Sold Out' : '+ Add to Basket'}
            </button>
          </div>
        </div>`;
    }).join('');
}

// ─── PRODUCT DETAIL MODAL (shop) ─────────────────────────────────────────────
function openProductDetail(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;

    document.getElementById('pm-name').textContent = p.name;
    document.getElementById('pm-price').textContent = '£' + Number(p.price).toFixed(2);
    // innerHTML so line breaks render properly
    document.getElementById('pm-desc').innerHTML   = formatDesc(p.description);
    document.getElementById('pm-emoji').textContent = p.emoji || '🍪';

    const imgContainer = document.getElementById('pm-img-container');
    imgContainer.style.backgroundColor = p.bg_color || '#FFFBE8';
    if (p.image_url) {
        imgContainer.style.backgroundImage = `url('${p.image_url}')`;
        document.getElementById('pm-emoji').style.display = 'none';
    } else {
        imgContainer.style.backgroundImage = '';
        document.getElementById('pm-emoji').style.display = '';
    }

    const badgeEl = document.getElementById('pm-badge');
    if (p.badge) { badgeEl.textContent = p.badge; badgeEl.style.display = ''; }
    else { badgeEl.style.display = 'none'; }

    document.getElementById('pm-add-btn').onclick = () => { addToCart(id); closeProductDetail(); };
    document.getElementById('product-modal').classList.add('open');
}

function closeProductDetail() {
    document.getElementById('product-modal').classList.remove('open');
}

function closeProductDetailOnOverlay(e) {
    if (e.target.id === 'product-modal') closeProductDetail();
}

// ─── RENDER ADMIN ─────────────────────────────────────────────────────────────
function renderAdmin() {
    renderDashboard();
    renderOrdersTable();
    renderShipping();
    renderIngredients();
    renderPayments();
    renderProductMgmt();
}

function renderDashboard() {
    const total    = orders.reduce((s, o) => s + parseFloat(o.total || 0), 0);
    const pending  = orders.filter(o => o.status === 'pending').length;
    const lowStock = ingredients.filter(i => parseFloat(i.stock) < parseFloat(i.min_stock || i.min || 0)).length;

    document.getElementById('stat-revenue').textContent  = '£' + total.toFixed(2);
    document.getElementById('stat-orders').textContent   = orders.length;
    document.getElementById('stat-pending').textContent  = pending;
    document.getElementById('stat-lowstock').textContent = lowStock;

    const tbody = document.getElementById('dashboard-orders-body');
    if (!orders.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:2rem;">No orders yet</td></tr>';
        return;
    }
    tbody.innerHTML = orders.slice(0, 5).map(o => `
        <tr>
          <td><strong>${o.id}</strong></td>
          <td>${o.fname || ''} ${o.lname || ''}</td>
          <td style="font-size:0.82rem; color:var(--text-muted);">${(o.items || '').substring(0, 40)}${(o.items || '').length > 40 ? '…' : ''}</td>
          <td><strong>£${parseFloat(o.total).toFixed(2)}</strong></td>
          <td>
            <span class="badge badge-${o.status}">${o.status}</span>
            ${o.pickup ? '<span class="badge" style="background:#E8F5E9; color:#1B5E20; margin-left:4px;">🏠 Pickup</span>' : ''}
          </td>
          <td>${o.date || ''}</td>
        </tr>`
    ).join('');
}

function renderOrdersTable() {
    const tbody = document.getElementById('orders-body');
    if (!orders.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:2rem;">No orders yet.</td></tr>';
        return;
    }
    tbody.innerHTML = orders.map(o => `
        <tr>
          <td><strong>${o.id}</strong></td>
          <td>${o.fname || ''} ${o.lname || ''}<br><small>${o.email || ''}</small></td>
          <td style="font-size:0.8rem;">${o.address || ''}</td>
          <td style="font-size:0.82rem;">${o.items || ''}</td>
          <td><strong>£${parseFloat(o.total).toFixed(2)}</strong></td>
          <td>
            <span class="badge badge-${o.status}">${o.status}</span>
            ${o.pickup ? '<span style="font-size:0.75rem; margin-left:4px;" title="Home Pickup">🏠</span>' : ''}
          </td>
          <td>
            ${o.status === 'pending'    ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}','processing')">Process</button>` : ''}
            ${o.status === 'processing' ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}','shipped')">Ship</button>` : ''}
            ${o.status === 'shipped'    ? `<button class="action-btn" onclick="updateOrderStatus('${o.id}','delivered')">Delivered ✓</button>` : ''}
            ${!['delivered','cancelled'].includes(o.status) ? `<button class="action-btn danger" onclick="cancelOrder('${o.id}')">Cancel</button>` : ''}
          </td>
        </tr>`
    ).join('');
}

function renderShipping() {
    const el     = document.getElementById('shipping-cards');
    const active = orders.filter(o => ['processing', 'shipped'].includes(o.status));
    if (!active.length) {
        el.innerHTML = '<p style="color:var(--text-muted); font-weight:600;">No active shipments. Orders in Processing or Shipped status appear here.</p>';
        return;
    }
    const steps = ['Ordered', 'Processing', 'Dispatched', 'In Transit', 'Delivered'];
    el.innerHTML = active.map(o => {
        const stepIdx = o.status === 'processing' ? 1 : o.status === 'shipped' ? 3 : 4;
        return `
        <div class="tracking-card">
          <div class="tracking-header">
            <span class="order-id">${o.id}</span>
            <span class="badge badge-${o.status}">${o.status}</span>
            ${o.pickup ? '<span class="badge" style="background:#E8F5E9;color:#1B5E20;">🏠 Pickup</span>' : ''}
            <span style="color:var(--text-muted); font-size:0.85rem; font-weight:600; margin-left:auto;">${o.fname || ''} ${o.lname || ''} — ${o.address || ''}</span>
          </div>
          <div style="font-size:0.82rem; color:var(--text-muted); font-weight:600; margin-bottom:0.5rem;">${o.items || ''}</div>
          <div class="tracking-steps">
            ${steps.map((s, i) => `
              <div class="tracking-step ${i < stepIdx ? 'done' : ''} ${i === stepIdx ? 'current' : ''}">
                <div class="ts-dot">${i < stepIdx ? '✓' : i + 1}</div>
                <div class="ts-label">${s}</div>
              </div>`).join('')}
          </div>
          <div class="tracking-actions">
            ${o.status === 'processing' ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}','shipped')">Mark as Shipped</button>` : ''}
            ${o.status === 'shipped'    ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}','delivered')">Mark Delivered</button>` : ''}
            <input class="tracking-input" type="text" placeholder="Enter tracking number…">
          </div>
        </div>`;
    }).join('');
}

function renderIngredients() {
    const tbody = document.getElementById('ingredients-body');
    if (!ingredients.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:2rem;">No ingredients yet.</td></tr>';
        const el = document.getElementById('stat-lowstock');
        if (el) el.textContent = '0';
        return;
    }
    tbody.innerHTML = ingredients.map((ing, i) => {
        const stock  = parseFloat(ing.stock || 0);
        const min    = parseFloat(ing.min_stock || ing.min || 0);
        const max    = parseFloat(ing.max_stock || ing.max || 1);
        const pct    = Math.min(100, max > 0 ? Math.round((stock / max) * 100) : 0);
        const isCrit = stock < min * 0.5;
        const isLow  = stock < min && !isCrit;
        const status = isCrit ? 'critical' : isLow ? 'low' : 'ok';
        const barCls = isCrit ? 'prog-critical' : isLow ? 'prog-low' : 'prog-ok';

        return `
        <tr>
          <td><strong>${ing.name}</strong></td>
          <td>${stock} / ${max}</td>
          <td>${ing.unit || ''}</td>
          <td style="min-width:120px;">
            <div class="progress-bar-wrap">
              <div class="progress-bar ${barCls}" style="width:${pct}%;"></div>
            </div>
          </td>
          <td><span class="badge badge-${status}">${status}</span></td>
          <td>
            <button class="action-btn" onclick="restockIngredient(${i})">+ Restock</button>
            <button class="action-btn danger" onclick="deleteIngredient(${i})">Remove</button>
          </td>
        </tr>`;
    }).join('');
}

function renderPayments() {
    const total = orders.reduce((s, o) => s + parseFloat(o.total || 0), 0);
    const now   = new Date();
    const mTot  = orders
        .filter(o => { const d = new Date(o.timestamp || o.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
        .reduce((s, o) => s + parseFloat(o.total || 0), 0);

    const payTotal = document.getElementById('pay-total');
    const payMonth = document.getElementById('pay-month');
    const payCount = document.getElementById('pay-count');
    const payAvg   = document.getElementById('pay-avg');
    if (payTotal) payTotal.textContent = '£' + total.toFixed(2);
    if (payMonth) payMonth.textContent = '£' + mTot.toFixed(2);
    if (payCount) payCount.textContent = orders.length;
    if (payAvg)   payAvg.textContent   = orders.length ? '£' + (total / orders.length).toFixed(2) : '£0.00';

    const chartEl = document.getElementById('revenue-chart');
    if (chartEl) {
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toLocaleDateString('en-GB');
            const rev = orders.filter(o => o.date === key).reduce((s, o) => s + parseFloat(o.total || 0), 0);
            days.push({ label: d.toLocaleDateString('en-GB', { weekday: 'short' }), val: rev });
        }
        const maxR = Math.max(...days.map(d => d.val), 1);
        chartEl.innerHTML = days.map(d => `
            <div class="chart-bar-wrap">
              <div class="chart-bar-val">${d.val > 0 ? '£' + d.val.toFixed(0) : ''}</div>
              <div class="chart-bar" style="height:${Math.round((d.val / maxR) * 110)}px;"></div>
              <div class="chart-bar-label">${d.label}</div>
            </div>`
        ).join('');
    }

    const tbody = document.getElementById('payments-body');
    if (!tbody) return;
    if (!orders.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:2rem;">No transactions yet.</td></tr>';
        return;
    }
    tbody.innerHTML = orders.map(o => `
        <tr>
          <td><strong>${o.id}</strong></td>
          <td>${o.fname || ''} ${o.lname || ''}</td>
          <td><strong>£${parseFloat(o.total).toFixed(2)}</strong></td>
          <td>${o.date || ''}</td>
          <td><span class="badge badge-paid">Paid</span></td>
        </tr>`
    ).join('');
}

function renderProductMgmt() {
    const grid = document.getElementById('product-mgmt-grid');
    if (!grid) return;
    if (!products.length) {
        grid.innerHTML = `
            <div style="grid-column:1/-1; text-align:center; padding:3rem; color:var(--text-muted);">
                <div style="font-size:3rem; margin-bottom:1rem;">🍪</div>
                <p style="font-weight:700; font-size:1rem;">No products yet.</p>
                <button class="action-btn primary" onclick="openProductModal()" style="margin-top:1rem; padding:10px 24px;">+ Add Your First Product</button>
            </div>`;
        return;
    }
    grid.innerHTML = products.map(p => {
        const stock      = p.stock ?? null;
        const isLow      = stock !== null && stock > 0 && stock <= 5;
        const isOut      = stock !== null && stock <= 0;
        const stockColor = isOut ? 'var(--danger)' : isLow ? 'var(--warning)' : 'var(--success)';
        const stockLabel = isOut ? 'Out of Stock' : isLow ? `Low — ${stock} left` : `${stock !== null ? stock : '∞'} in stock`;
        const stockIcon  = isOut ? '🔴' : isLow ? '🟡' : '🟢';

        return `
        <div class="pmc-card" id="pmc-${p.id}">
          <div class="pmc-card-img" style="background:${p.bg_color || '#FFFBE8'}; ${p.image_url ? `background-image:url('${p.image_url}'); background-size:cover; background-position:center;` : ''}">
            ${p.image_url ? '' : `<span style="font-size:2.8rem;">${p.emoji || '🍪'}</span>`}
            ${p.badge ? `<span class="product-badge" style="position:absolute; top:8px; right:8px;">${p.badge}</span>` : ''}
          </div>
          <div class="pmc-card-body">
            <div class="pmc-card-name">${p.name}</div>
            <div class="pmc-card-desc">${p.description ? p.description.substring(0, 55) + (p.description.length > 55 ? '…' : '') : 'No description'}</div>
            <div class="pmc-card-price">£${Number(p.price).toFixed(2)}</div>
            <div class="pmc-stock-bar">
              <span class="pmc-stock-label" style="color:${stockColor};">${stockIcon} ${stockLabel}</span>
              ${stock !== null && stock > 0 ? `
              <div class="pmc-stock-track">
                <div class="pmc-stock-fill" style="width:${Math.min(100, (stock / Math.max(stock, 20)) * 100)}%; background:${stockColor};"></div>
              </div>` : ''}
            </div>
            <div class="pmc-card-actions">
              <button class="action-btn primary" onclick="openProductModal(${p.id})">✏️ Edit</button>
              <button class="action-btn danger" onclick="deleteProduct(${p.id})">🗑 Delete</button>
            </div>
          </div>
        </div>`;
    }).join('');
}

// ─── PRODUCT MODAL (ADD / EDIT) ───────────────────────────────────────────────
let productStockPollTimer = null;

// ── Cloudinary config — fill in your own values ──────────────────────────────
// 1. Sign up free at https://cloudinary.com
// 2. Go to Settings → Upload → Add upload preset, set to "Unsigned"
// 3. Replace the two values below with your Cloud Name and Preset Name
const CLOUDINARY_CLOUD_NAME   = 'YOUR_CLOUD_NAME';
const CLOUDINARY_UPLOAD_PRESET = 'YOUR_UPLOAD_PRESET';

function updateImagePreview(url) {
    const preview    = document.getElementById('pem-img-preview');
    const previewBox = document.getElementById('pem-img-preview-box');
    if (url) {
        preview.src              = url;
        previewBox.style.display = 'block';
    } else {
        preview.src              = '';
        previewBox.style.display = 'none';
    }
}

async function uploadToCloudinary() {
    const fileInput = document.getElementById('pem-file-input');
    const file      = fileInput.files[0];
    if (!file) return;

    if (!CLOUDINARY_CLOUD_NAME.startsWith('YOUR_')) {
        // Real upload
        const uploadBtn  = document.getElementById('pem-upload-btn');
        uploadBtn.disabled    = true;
        uploadBtn.textContent = '⏳ Uploading…';

        try {
            const formData = new FormData();
            formData.append('file',         file);
            formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

            const res  = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
                method: 'POST',
                body:   formData
            });

            if (!res.ok) throw new Error('Upload failed');
            const data = await res.json();

            document.getElementById('pem-image').value = data.secure_url;
            updateImagePreview(data.secure_url);
            showToast('✓ Image uploaded!');
        } catch (err) {
            console.error('Cloudinary upload error:', err);
            showToast('Upload failed — check your Cloudinary config');
        } finally {
            uploadBtn.disabled    = false;
            uploadBtn.textContent = '📷 Upload Photo';
            fileInput.value       = '';
        }
    } else {
        // Demo mode — just show a local preview without uploading
        const reader = new FileReader();
        reader.onload = e => {
            document.getElementById('pem-image').value = e.target.result;
            updateImagePreview(e.target.result);
            showToast('⚠️ Preview only — configure Cloudinary to save images');
        };
        reader.readAsDataURL(file);
        fileInput.value = '';
    }
}

function openProductModal(id) {
    const modal  = document.getElementById('product-edit-modal');
    const isEdit = !!id;
    document.getElementById('pem-title').textContent = isEdit ? 'Edit Product' : 'Add New Product';

    if (isEdit) {
        const p = products.find(x => x.id === id);
        if (!p) return;
        document.getElementById('pem-id').value    = p.id;
        document.getElementById('pem-name').value  = p.name        || '';
        document.getElementById('pem-price').value = p.price       || '';
        document.getElementById('pem-emoji').value = p.emoji       || '';
        document.getElementById('pem-badge').value = p.badge       || '';
        document.getElementById('pem-image').value = p.image_url   || '';
        document.getElementById('pem-desc').value  = p.description || '';
        document.getElementById('pem-bg').value    = p.bg_color    || '#FFFBE8';
        document.getElementById('pem-stock').value = p.stock       ?? '';
        updateImagePreview(p.image_url || '');
    } else {
        document.getElementById('pem-id').value    = '';
        document.getElementById('pem-name').value  = '';
        document.getElementById('pem-price').value = '';
        document.getElementById('pem-emoji').value = '';
        document.getElementById('pem-badge').value = '';
        document.getElementById('pem-image').value = '';
        document.getElementById('pem-desc').value  = '';
        document.getElementById('pem-bg').value    = '#FFFBE8';
        document.getElementById('pem-stock').value = '';
        updateImagePreview('');
    }

    modal.classList.add('open');
}

function closeProductModal() {
    document.getElementById('product-edit-modal').classList.remove('open');
}

async function saveProductFromModal() {
    const id   = document.getElementById('pem-id').value;
    const name = document.getElementById('pem-name').value.trim();
    if (!name) { showToast('Product name is required'); return; }

    const payload = {
        name,
        price:       parseFloat(document.getElementById('pem-price').value)  || 0,
        emoji:       document.getElementById('pem-emoji').value,
        badge:       document.getElementById('pem-badge').value,
        image_url:   document.getElementById('pem-image').value,
        description: document.getElementById('pem-desc').value,
        bg_color:    document.getElementById('pem-bg').value,
        stock:       parseInt(document.getElementById('pem-stock').value)     || 0
    };

    const saveBtn = document.getElementById('pem-save-btn');
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Saving…';

    try {
        const url    = id ? `${API_BASE}/admin/products/${id}` : `${API_BASE}/admin/products`;
        const method = id ? 'PUT' : 'POST';
        const res    = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify(payload)
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Server returned ${res.status}`);
        }

        localStorage.removeItem(CACHE_KEY);
        showToast(id ? '✓ Product updated!' : '✓ Product added!');
        closeProductModal();
        await loadAdminData();
    } catch (err) {
        console.error('Save Product Error:', err);
        showToast('Save failed: ' + err.message);
    } finally {
        saveBtn.disabled    = false;
        saveBtn.textContent = '💾 Save Product';
    }
}

// Poll stock levels every 20s when on products section
function startStockPolling() {
    stopStockPolling();
    productStockPollTimer = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/admin/products`, {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            if (res.ok) {
                const fresh = await res.json();
                // Update only stock counts in the UI without full re-render
                fresh.forEach(p => {
                    const existing = products.find(x => x.id === p.id);
                    if (existing && existing.stock !== p.stock) {
                        existing.stock = p.stock;
                        // Update just this card's stock display
                        const card = document.getElementById('pmc-' + p.id);
                        if (card) {
                            const isLow      = p.stock !== null && p.stock > 0 && p.stock <= 5;
                            const isOut      = p.stock !== null && p.stock <= 0;
                            const stockColor = isOut ? 'var(--danger)' : isLow ? 'var(--warning)' : 'var(--success)';
                            const stockLabel = isOut ? 'Out of Stock' : isLow ? `Low — ${p.stock} left` : `${p.stock !== null ? p.stock : '∞'} in stock`;
                            const stockIcon  = isOut ? '🔴' : isLow ? '🟡' : '🟢';
                            const stockEl    = card.querySelector('.pmc-stock-label');
                            if (stockEl) {
                                stockEl.style.color = stockColor;
                                stockEl.textContent = `${stockIcon} ${stockLabel}`;
                            }
                        }
                    }
                });
            }
        } catch (e) { /* silent fail — next poll will retry */ }
    }, 20000);
}

function stopStockPolling() {
    if (productStockPollTimer) { clearInterval(productStockPollTimer); productStockPollTimer = null; }
}

function renderPromos() {
    const tbody = document.getElementById('promos-body');
    if (!tbody) return;
    if (!promos.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:2rem;">No active promo codes.</td></tr>';
        return;
    }
    // Fixed: thead has 4 cols (Code, Discount, Used, Actions) — matches server data
    tbody.innerHTML = promos.map(p => `
        <tr>
          <td><strong>${p.code}</strong></td>
          <td>${p.discount_percent}%</td>
          <td>${p.used_count} / ${p.max_uses !== null ? p.max_uses : '∞'}</td>
          <td><button class="action-btn danger" onclick="deletePromo(${p.id})">Remove</button></td>
        </tr>`
    ).join('');
}

// ─── BASKET ───────────────────────────────────────────────────────────────────
function addToCart(id) {
    const p  = products.find(x => x.id === id);
    if (!p) return;
    const ex = cart.find(x => x.id === id);
    if (ex) ex.qty++;
    else cart.push({ ...p, qty: 1 });
    updateCartUI();

    const btn = document.getElementById('add-btn-' + id);
    if (btn) {
        btn.textContent = '✓ Added'; btn.classList.add('added');
        setTimeout(() => { btn.textContent = 'Add +'; btn.classList.remove('added'); }, 1500);
    }
    showToast(`${p.emoji || '🍪'} ${p.name} added!`);
}

function changeQty(id, d) {
    const item = cart.find(x => x.id === id);
    if (!item) return;
    item.qty += d;
    if (item.qty <= 0) cart = cart.filter(x => x.id !== id);
    updateCartUI();
}

function removeFromCart(id) {
    cart = cart.filter(x => x.id !== id);
    updateCartUI();
}

function updateCartUI() {
    const subtotal = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const count    = cart.reduce((s, x) => s + x.qty, 0);
    document.getElementById('cart-count').textContent = count;

    const itemsEl  = document.getElementById('cart-items');
    const footerEl = document.getElementById('cart-footer');

    if (cart.length === 0) {
        itemsEl.innerHTML = `<div class="empty-cart"><span class="ec-icon">🧺</span><p>Your basket is empty</p></div>`;
        footerEl.style.display = 'none';
    } else {
        itemsEl.innerHTML = cart.map(item => `
            <div class="cart-item">
              <div class="cart-item-emoji">${item.emoji || '🍪'}</div>
              <div class="cart-item-info">
                <div class="cart-item-name">${item.name}</div>
                <div class="cart-item-price">£${parseFloat(item.price).toFixed(2)} each</div>
                <div class="cart-item-qty">
                  <button class="qty-btn" onclick="changeQty(${item.id},-1)">−</button>
                  <span class="qty-num">${item.qty}</span>
                  <button class="qty-btn" onclick="changeQty(${item.id},1)">+</button>
                </div>
              </div>
              <div style="display:flex; flex-direction:column; align-items:flex-end; gap:8px;">
                <span style="font-weight:800; font-size:0.95rem; color:var(--green-dark);">£${(parseFloat(item.price) * item.qty).toFixed(2)}</span>
                <button class="remove-item" onclick="removeFromCart(${item.id})" title="Remove">🗑</button>
              </div>
            </div>`
        ).join('');
        document.getElementById('cart-total-amount').textContent = '£' + subtotal.toFixed(2);
        footerEl.style.display = 'block';
    }
}

function toggleCart() { document.getElementById('cart-overlay').classList.toggle('open'); }
function closeCartOnOverlay(e) { if (e.target.id === 'cart-overlay') toggleCart(); }

// ─── CHECKOUT ─────────────────────────────────────────────────────────────────
function isSheffieldDelivery() {
    const city     = (document.getElementById('ch-city')?.value || '').trim().toLowerCase();
    const postcode = (document.getElementById('ch-postcode')?.value || '').trim().toUpperCase();
    return city === 'sheffield' && postcode.startsWith('S');
}

function updateCheckoutTotals() {
    const subtotal = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const isPickup = document.getElementById('pickup-check')?.checked || false;
    const postcode = (document.getElementById('ch-postcode')?.value || '').trim().toUpperCase();
    const city     = (document.getElementById('ch-city')?.value || '').trim().toLowerCase();
    const btn      = document.getElementById('pay-btn');
    const msgEl    = document.getElementById('delivery-message');
    const errEl    = document.getElementById('card-errors');

    let shipping      = 0;
    let shippingLabel = '';

    if (isPickup) {
        shipping          = 0;
        shippingLabel     = '🏠 Home Pickup';
        btn.disabled      = false;
        msgEl.style.color = 'var(--green-mid)';
        msgEl.textContent = '✓ Great! We\'ll have your order ready for collection.';
        if (errEl) errEl.textContent = '';
    } else {
        const hasCity     = city.length > 0;
        const hasPostcode = postcode.length > 0;

        if (!hasCity && !hasPostcode) {
            shipping          = 0;
            shippingLabel     = 'Delivery (enter your city and postcode above)';
            btn.disabled      = false;
            msgEl.textContent = '';
        } else if (isSheffieldDelivery()) {
            shipping          = 3.00;
            shippingLabel     = '🚚 Sheffield Delivery (+£3.00)';
            btn.disabled      = false;
            msgEl.style.color = 'var(--green-mid)';
            msgEl.textContent = '✓ Great news — we deliver to your area!';
            if (errEl) errEl.textContent = '';
        } else if (postcode.startsWith('S') && hasCity && city !== 'sheffield') {
            shipping          = 0;
            shippingLabel     = '<span style="color:var(--danger);">Delivery unavailable</span>';
            btn.disabled      = true;
            msgEl.style.color = 'var(--danger)';
            msgEl.textContent = '✗ Sorry, we only deliver within Sheffield. Your city must be Sheffield to qualify.';
        } else if (city === 'sheffield' && hasPostcode && !postcode.startsWith('S')) {
            shipping          = 0;
            shippingLabel     = '<span style="color:var(--danger);">Delivery unavailable</span>';
            btn.disabled      = true;
            msgEl.style.color = 'var(--danger)';
            msgEl.textContent = '✗ That postcode doesn\'t look like a Sheffield postcode (should start with S).';
        } else {
            shipping          = 0;
            shippingLabel     = '<span style="color:var(--danger);">Delivery unavailable</span>';
            btn.disabled      = true;
            msgEl.style.color = 'var(--danger)';
            msgEl.textContent = '✗ Sorry, we only deliver to Sheffield. Please select Home Pickup instead.';
        }
    }

    // Apply promo discount to subtotal
    let discount      = 0;
    let discountLabel = '';
    if (appliedPromo) {
        discount      = subtotal * (appliedPromo.discount / 100);
        discountLabel = `🎟️ Promo ${appliedPromo.code} (−${appliedPromo.discount}%)`;
    }

    const total = Math.max(0, subtotal - discount + shipping);

    // Build summary HTML
    let html = cart.map(i => `
        <div class="os-item">
          <span>${i.emoji || ''} ${i.name} ×${i.qty}</span>
          <span>£${(parseFloat(i.price) * i.qty).toFixed(2)}</span>
        </div>`).join('');

    if (discountLabel) {
        html += `<div class="os-item" style="color:var(--success);">
          <span>${discountLabel}</span>
          <span>−£${discount.toFixed(2)}</span>
        </div>`;
    }

    html += `<div class="os-item"><span>${shippingLabel}</span><span>${shipping > 0 ? '£' + shipping.toFixed(2) : 'Free'}</span></div>`;
    html += `<div class="os-item total"><span>Total</span><span>£${total.toFixed(2)}</span></div>`;

    document.getElementById('checkout-summary').innerHTML = html;
    document.getElementById('pay-amount').textContent = '£' + total.toFixed(2);
}

function openCheckout() {
    if (cart.length === 0) return;

    // Reset promo state each time checkout opens
    appliedPromo = null;
    const promoMsgEl = document.getElementById('promo-message');
    const promoInput = document.getElementById('promo-input');
    if (promoMsgEl) promoMsgEl.textContent = '';
    if (promoInput) promoInput.value = '';

    // Reset pickup checkbox
    const pickupCheck = document.getElementById('pickup-check');
    if (pickupCheck) pickupCheck.checked = false;

    document.getElementById('checkout-content').style.display = 'block';
    document.getElementById('success-content').style.display  = 'none';
    document.getElementById('card-errors').textContent = '';

    updateCheckoutTotals();

    // Setup Stripe
    if (STRIPE_PUBLISHABLE_KEY) {
        document.getElementById('stripe-alert').style.display        = 'none';
        document.getElementById('stripe-card-section').style.display = 'block';
        if (!stripeInstance) {
            stripeInstance = Stripe(STRIPE_PUBLISHABLE_KEY);
            const elements = stripeInstance.elements();
            cardElement    = elements.create('card', {
                style: { base: { fontFamily: "'Nunito', sans-serif", fontSize: '15px', color: '#0E3019' } }
            });
            cardElement.mount('#card-element');
        }
    } else {
        document.getElementById('stripe-alert').style.display        = 'block';
        document.getElementById('stripe-card-section').style.display = 'none';
    }

    document.getElementById('checkout-modal').classList.add('open');
    toggleCart();
}

function closeCheckout() {
    document.getElementById('checkout-modal').classList.remove('open');
}

// ─── PROMO CODE ───────────────────────────────────────────────────────────────
async function applyPromo() {
    const code    = (document.getElementById('promo-input')?.value || '').trim().toUpperCase();
    const email   = (document.getElementById('ch-email')?.value || '').trim();
    const msgEl   = document.getElementById('promo-message');
    const promoBtn = document.getElementById('promo-btn');

    if (!code) {
        msgEl.style.color = 'var(--danger)';
        msgEl.textContent = 'Please enter a promo code.';
        return;
    }
    if (!email) {
        msgEl.style.color = 'var(--danger)';
        msgEl.textContent = 'Please enter your email address first.';
        return;
    }

    promoBtn.disabled   = true;
    promoBtn.textContent = 'Checking…';

    try {
        const res  = await fetch(`${API_BASE}/validate-promo`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ code, email })
        });
        const data = await res.json();

        if (data.valid) {
            appliedPromo          = { code, discount: data.discount };
            msgEl.style.color     = 'var(--success)';
            msgEl.textContent     = `✓ Code applied! ${data.discount}% off your order.`;
            promoBtn.textContent  = '✓ Applied';
            promoBtn.disabled     = true;
            updateCheckoutTotals();
        } else {
            appliedPromo          = null;
            msgEl.style.color     = 'var(--danger)';
            msgEl.textContent     = data.message || 'Invalid promo code.';
            promoBtn.disabled     = false;
            promoBtn.textContent  = 'Apply';
        }
    } catch (err) {
        console.error('Promo validation error:', err);
        msgEl.style.color    = 'var(--danger)';
        msgEl.textContent    = 'Could not validate code — please try again.';
        promoBtn.disabled    = false;
        promoBtn.textContent = 'Apply';
    }
}

// ─── PROCESS PAYMENT ──────────────────────────────────────────────────────────
async function processPayment() {
    const fields = [
        ['ch-fname',   'First name'],
        ['ch-lname',   'Last name'],
        ['ch-email',   'Email'],
        ['ch-address', 'Address'],
        ['ch-city',    'City'],
        ['ch-postcode','Postcode']
    ];
    for (const [id, label] of fields) {
        if (!document.getElementById(id).value.trim()) {
            showToast(`Please enter your ${label}`);
            return;
        }
    }

    const btn = document.getElementById('pay-btn');
    btn.disabled  = true;
    btn.innerHTML = 'Processing…';
    document.getElementById('card-errors').textContent = '';

    const customer = {
        fname:    document.getElementById('ch-fname').value.trim(),
        lname:    document.getElementById('ch-lname').value.trim(),
        email:    document.getElementById('ch-email').value.trim(),
        address:  document.getElementById('ch-address').value.trim(),
        city:     document.getElementById('ch-city').value.trim(),
        postcode: document.getElementById('ch-postcode').value.trim().toUpperCase(),
        phone:    document.getElementById('ch-phone')?.value.trim() || ''
    };
    customer.name        = `${customer.fname} ${customer.lname}`;
    const fullAddress    = `${customer.address}, ${customer.city}, ${customer.postcode}`;
    const isPickup       = document.getElementById('pickup-check')?.checked || false;

    const subtotal       = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const discount       = appliedPromo ? subtotal * (appliedPromo.discount / 100) : 0;
    const shipping       = isPickup ? 0 : (isSheffieldDelivery() ? 3.00 : 0);
    const total          = Math.max(0, subtotal - discount + shipping).toFixed(2);
    const oid            = 'HG-' + Date.now().toString().slice(-6);
    const secureCartItems = cart.map(i => ({ id: i.id, qty: i.qty }));

    try {
        let paymentIntentId = null;

        if (STRIPE_PUBLISHABLE_KEY && stripeInstance && cardElement) {
            const res = await fetch(`${API_BASE}/create-payment-intent`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    cartItems:     secureCartItems,
                    pickup:        isPickup,
                    postcode:      customer.postcode,
                    receipt_email: customer.email,
                    promoCode:     appliedPromo ? appliedPromo.code : null,
                    metadata: {
                        order_id:      oid,
                        customer_name: customer.name,
                        email:         customer.email,
                        address:       fullAddress
                    }
                })
            });

            if (!res.ok) throw new Error('Failed to initialise payment.');
            const { clientSecret } = await res.json();

            const { paymentIntent, error } = await stripeInstance.confirmCardPayment(clientSecret, {
                payment_method: {
                    card: cardElement,
                    billing_details: {
                        name:  customer.name,
                        email: customer.email,
                        phone: customer.phone || undefined,
                        address: {
                            line1:       customer.address,
                            city:        customer.city,
                            postal_code: customer.postcode,
                            country:     'GB'
                        }
                    }
                },
                receipt_email: customer.email
            });

            if (error) throw new Error(error.message);
            paymentIntentId = paymentIntent.id;
        } else {
            // Demo mode — simulate a short delay
            await new Promise(r => setTimeout(r, 700));
        }

        const orderPayload = {
            id:              oid,
            fname:           customer.fname,
            lname:           customer.lname,
            email:           customer.email,
            address:         fullAddress,
            postcode:        customer.postcode,
            cartItems:       secureCartItems,
            status:          'pending',
            date:            new Date().toLocaleDateString('en-GB'),
            timestamp:       Date.now(),
            paymentIntentId: paymentIntentId,
            pickup:          isPickup,
            promoCode:       appliedPromo ? appliedPromo.code : null
        };

        const orderRes = await fetch(`${API_BASE}/orders`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(orderPayload)
        });

        if (!orderRes.ok) {
            const errData = await orderRes.json().catch(() => ({}));
            throw new Error(errData.error || 'Order backend processing failed');
        }

        await sendConfirmationEmail(orderPayload, customer, total);

        document.getElementById('success-order-num').textContent = 'Order Reference: ' + oid;
        document.getElementById('checkout-content').style.display = 'none';
        document.getElementById('success-content').style.display  = 'block';
        cart         = [];
        appliedPromo = null;
        updateCartUI();
        showToast('🎉 Order placed! Confirmation email sent.');

    } catch (e) {
        document.getElementById('card-errors').textContent = e.message;
    } finally {
        btn.disabled  = false;
        btn.innerHTML = `🌿 Place Order — <span id="pay-amount">£${total}</span>`;
    }
}

// ─── EMAIL CONFIRMATION (EmailJS) ─────────────────────────────────────────────
const EMAILJS_SERVICE_ID  = 'YOUR_SERVICE_ID';
const EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID';
const EMAILJS_PUBLIC_KEY  = 'YOUR_PUBLIC_KEY';

function emailJsReady() {
    return typeof emailjs !== 'undefined' &&
           !EMAILJS_SERVICE_ID.startsWith('YOUR_') &&
           !EMAILJS_TEMPLATE_ID.startsWith('YOUR_') &&
           !EMAILJS_PUBLIC_KEY.startsWith('YOUR_');
}

async function sendConfirmationEmail(order, customer, total) {
    if (!emailJsReady()) {
        console.info('EmailJS not configured — skipping confirmation email.');
        return;
    }

    const itemLines = cart.length
        ? cart.map(i => `• ${i.name} × ${i.qty}   —   £${(parseFloat(i.price) * i.qty).toFixed(2)}`).join('\n')
        : (order.items || '');

    const templateParams = {
        to_name:          customer.name,
        to_email:         customer.email,
        order_id:         order.id,
        order_date:       order.date,
        items_list:       itemLines,
        order_total:      `£${total}`,
        delivery_address: order.pickup ? '🏠 Home Pickup — no delivery needed' : order.address,
        shop_name:        'Home Grown',
        reply_to:         'hello@homegrown.co.uk'
    };

    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams, EMAILJS_PUBLIC_KEY);
        console.info('✓ Confirmation email sent to', customer.email);
    } catch (err) {
        console.warn('Confirmation email failed:', err);
    }
}

// ─── ADMIN CRUD ───────────────────────────────────────────────────────────────
function resetProductForm() {
    document.getElementById('prod-id').value    = '';
    document.getElementById('prod-name').value  = '';
    document.getElementById('prod-price').value = '';
    document.getElementById('prod-emoji').value = '';
    document.getElementById('prod-badge').value = '';
    document.getElementById('prod-image').value = '';
    document.getElementById('prod-desc').value  = '';
    document.getElementById('prod-bg').value    = '#FFFBE8';
    document.getElementById('prod-stock').value = '';
    document.getElementById('product-form-title').textContent = 'Add New Snack';
}

function editProduct(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    document.getElementById('prod-id').value    = p.id;
    document.getElementById('prod-name').value  = p.name  || '';
    document.getElementById('prod-price').value = p.price || '';
    document.getElementById('prod-emoji').value = p.emoji || '';
    document.getElementById('prod-badge').value = p.badge || '';
    document.getElementById('prod-image').value = p.image_url || '';
    document.getElementById('prod-desc').value  = p.description || '';
    document.getElementById('prod-bg').value    = p.bg_color || '#FFFBE8';
    document.getElementById('prod-stock').value = p.stock ?? '';
    document.getElementById('product-form-title').textContent = 'Edit Snack';
    document.getElementById('product-form-title').scrollIntoView({ behavior: 'smooth' });
}

async function saveProduct() {
    const id   = document.getElementById('prod-id').value;
    const name = document.getElementById('prod-name').value.trim();
    if (!name) { showToast('Product name is required'); return; }

    const payload = {
        name,
        price:       parseFloat(document.getElementById('prod-price').value) || 0,
        emoji:       document.getElementById('prod-emoji').value,
        badge:       document.getElementById('prod-badge').value,
        image_url:   document.getElementById('prod-image').value,
        description: document.getElementById('prod-desc').value,
        bg_color:    document.getElementById('prod-bg').value,
        stock:       parseInt(document.getElementById('prod-stock').value) || 0
    };

    try {
        const url    = id ? `${API_BASE}/admin/products/${id}` : `${API_BASE}/admin/products`;
        const method = id ? 'PUT' : 'POST';
        const res    = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify(payload)
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Server returned ${res.status}`);
        }

        showToast(id ? '✓ Product updated!' : '✓ Product added!');
        resetProductForm();
        await loadAdminData();
    } catch (err) {
        console.error('Save Product Error:', err);
        showToast('Save failed: ' + err.message);
    }
}

async function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    try {
        const res = await fetch(`${API_BASE}/admin/products/${id}`, {
            method:  'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        showToast('Product deleted');
        await loadAdminData();
    } catch (err) {
        console.error('Delete Product Error:', err);
        showToast('Delete failed');
    }
}

async function updateOrderStatus(id, status) {
    try {
        const res = await fetch(`${API_BASE}/admin/orders/${id}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ status })
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        showToast(`Order ${id} → ${status}`);
        await loadAdminData();
    } catch (err) {
        console.error('Update Order Error:', err);
        showToast('Update failed');
    }
}

async function cancelOrder(id) {
    if (!confirm(`Cancel order ${id}?`)) return;
    await updateOrderStatus(id, 'cancelled');
}

function filterOrders(q) {
    document.querySelectorAll('#orders-body tr').forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
    });
}

function filterOrdersByStatus(s) {
    document.querySelectorAll('#orders-body tr').forEach(row => {
        row.style.display = (!s || row.textContent.toLowerCase().includes(s)) ? '' : 'none';
    });
}

async function addIngredient() {
    const name  = document.getElementById('ing-name').value.trim();
    const unit  = document.getElementById('ing-unit').value.trim();
    const stock = parseFloat(document.getElementById('ing-stock').value) || 0;
    const min   = parseFloat(document.getElementById('ing-min').value)   || 0;
    const max   = parseFloat(document.getElementById('ing-max').value)   || 10;

    if (!name || !unit) { showToast('Please enter ingredient name and unit'); return; }

    try {
        const res = await fetch(`${API_BASE}/admin/ingredients`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ name, unit, stock, min_stock: min, max_stock: max })
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        showToast('✓ ' + name + ' added');
        ['ing-name','ing-unit','ing-stock','ing-min','ing-max'].forEach(id => document.getElementById(id).value = '');
        await loadAdminData();
    } catch (err) {
        console.error('Add Ingredient Error:', err);
        showToast('Failed to add ingredient');
    }
}

async function restockIngredient(index) {
    const ing = ingredients[index];
    if (!ing) return;
    const amt = parseFloat(prompt(`Add how much ${ing.unit} to ${ing.name}?`));
    if (isNaN(amt) || amt <= 0) return;
    const newStock = Math.min(parseFloat(ing.max_stock || ing.max || 999), parseFloat(ing.stock) + amt);

    try {
        const res = await fetch(`${API_BASE}/admin/ingredients/${ing.id}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ stock: newStock })
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        showToast(`✓ Restocked ${ing.name}`);
        await loadAdminData();
    } catch (err) {
        console.error('Restock Error:', err);
        showToast('Restock failed');
    }
}

async function deleteIngredient(index) {
    const ing = ingredients[index];
    if (!ing || !confirm(`Remove ${ing.name}?`)) return;
    try {
        const res = await fetch(`${API_BASE}/admin/ingredients/${ing.id}`, {
            method:  'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        showToast(`${ing.name} removed`);
        await loadAdminData();
    } catch (err) {
        console.error('Delete Ingredient Error:', err);
        showToast('Delete failed');
    }
}

async function addPromo() {
    const code = document.getElementById('promo-new-code').value.trim().toUpperCase();
    const disc = parseInt(document.getElementById('promo-new-discount').value);
    const max  = document.getElementById('promo-new-max').value ? parseInt(document.getElementById('promo-new-max').value) : null;

    if (!code)                              { showToast('Please enter a promo code'); return; }
    if (isNaN(disc) || disc < 1 || disc > 100) { showToast('Please enter a valid discount (1-100%)'); return; }

    try {
        const res = await fetch(`${API_BASE}/admin/promos`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ code, discount_percent: disc, max_uses: max })
        });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Server error');
        }
        showToast('✓ Promo code added!');
        document.getElementById('promo-new-code').value     = '';
        document.getElementById('promo-new-discount').value = '10';
        document.getElementById('promo-new-max').value      = '';
        await loadAdminData();
    } catch (err) {
        console.error('Add Promo Error:', err);
        showToast('Failed: ' + err.message);
    }
}

async function deletePromo(id) {
    if (!confirm('Delete this promo code?')) return;
    try {
        const res = await fetch(`${API_BASE}/admin/promos/${id}`, {
            method:  'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        showToast('Promo code removed');
        await loadAdminData();
    } catch (err) { showToast('Delete failed'); }
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
initApp();
