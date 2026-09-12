// ═══════════════════════════════════════════════
//  HOME GROWN — app.js
// ═══════════════════════════════════════════════

// ─── CONFIGURATION & STATE ───────────────────────────────────────────────────
const API_BASE = window.location.origin + '/api';
let adminToken  = localStorage.getItem('hg_admin_token') || null;
let STRIPE_PUBLISHABLE_KEY = 'pk_live_51PU4upEFaqxyf7ELOsith63WwqUuTzYYzEreW1DEyqn6o2KoLBkzYDLECvMznQZiG9enOc7hhu7kFdai1Cg4eFVK00ZV9S7qmV';
let cart             = [];
let orders           = [];
let ingredients      = [];
let products         = [];
let promos           = [];
let wishlistEntries  = [];
let chatMessages     = [];
let stripeInstance   = null;
let cardElement      = null;
let appliedPromo     = null;

// ─── SECRET ADMIN ACCESS ──────────────────────────────────────────────────────
// Click the Home Grown logo 7 times quickly, or visit /#admin
let _logoClicks = 0;
let _logoTimer  = null;

function handleLogoClick(e) {
    e.preventDefault();
    _logoClicks++;
    clearTimeout(_logoTimer);
    _logoTimer = setTimeout(() => { _logoClicks = 0; }, 2000);
    if (_logoClicks >= 7) {
        _logoClicks = 0;
        window.location.hash = 'admin';
        showView('admin', e);
    } else {
        showView('shop', e);
        if (window.location.hash === '#admin') window.location.hash = '';
    }
}

// ─── CHAT STATE ───────────────────────────────────────────────────────────────
let localChatHistory = JSON.parse(localStorage.getItem('hg_chat_history') || '[]');
let chatUser         = JSON.parse(localStorage.getItem('hg_chat_user')    || 'null');
let chatWindowOpen   = false;

// ─── FALLBACK PRODUCTS ────────────────────────────────────────────────────────
const DEMO_PRODUCTS = [
    { id: 1, name: 'Honey Oat Clusters', price: 5.50, emoji: '🍯', badge: 'Best Seller', description: 'Crunchy clusters baked with local honey.', bg_color: '#FFFBE8' },
    { id: 2, name: 'Seeded Crackers',    price: 3.95, emoji: '🌾', badge: null,          description: 'Wholegrain crackers with flax & sesame.',  bg_color: '#F5F5DC' },
    { id: 3, name: 'Fruit & Nut Bar',    price: 2.50, emoji: '🍫', badge: 'Vegan',       description: 'Dates, almonds and dark chocolate.',       bg_color: '#FFF0F0' },
    { id: 4, name: 'Sourdough Crisps',   price: 4.20, emoji: '🥖', badge: null,          description: 'Thin, crispy sourdough bites.',            bg_color: '#FFF8F0' }
];

// ─── CACHE HELPERS ────────────────────────────────────────────────────────────
const CACHE_KEY     = 'hg_products_cache';
const CACHE_MAX_AGE = 1000 * 60 * 5;

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
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch (e) {}
}
function fetchWithTimeout(url, options = {}, timeout = 8000) {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ]);
}

// ─── INITIALIZE ──────────────────────────────────────────────────────────────
async function initApp() {
    const cached = getCachedProducts();
    if (cached && cached.length) {
        products = cached;
        document.getElementById('shop-loading').style.display = 'none';
        document.getElementById('products-grid').style.display = 'grid';
        renderShop();
    }

    try {
        const res = await fetchWithTimeout(`${API_BASE}/config`, {}, 5000);
        if (res.ok) {
            const data = await res.json();
            STRIPE_PUBLISHABLE_KEY = data.stripePublishableKey || STRIPE_PUBLISHABLE_KEY;
        }
    } catch (e) { console.warn('Config fetch failed — running with defaults'); }

    try {
        const res = await fetchWithTimeout(`${API_BASE}/products`, {}, 8000);
        if (!res.ok) throw new Error('Bad response');
        const fresh = await res.json();
        if (fresh && fresh.length) {
            products = fresh;
            setCachedProducts(fresh);
            document.getElementById('shop-loading').style.display = 'none';
            document.getElementById('products-grid').style.display = 'grid';
            renderShop();
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

    // Secret admin access via URL hash
    if (window.location.hash === '#admin') {
        showView('admin');
    }
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
function showView(v, e) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('view-' + v).classList.add('active');
    if (e) {
        const btn = e.target?.closest?.('.nav-btn') || e.target;
        if (btn && btn.classList && btn.classList.contains('nav-btn')) btn.classList.add('active');
    }
    if (v === 'shop' && products.length) renderShop();
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
    } catch (error) { showToast('Login failed — check your connection'); }
}

function handleLogout() {
    adminToken = null;
    localStorage.removeItem('hg_admin_token');
    document.getElementById('admin-login-screen').style.display = 'flex';
    document.getElementById('admin-layout').style.display = 'none';
    window.location.hash = '';
    showToast('Logged out');
}

// ─── ADMIN DATA LOADING ───────────────────────────────────────────────────────
// Uses Promise.allSettled so one failing endpoint never breaks the others.
async function loadAdminData() {
    if (!adminToken) return;
    try {
        const headers = { 'Authorization': `Bearer ${adminToken}` };

        const [ordRes, ingRes, prodRes, promoRes, wishRes, chatRes] = await Promise.allSettled([
            fetch(`${API_BASE}/admin/orders`,      { headers }),
            fetch(`${API_BASE}/admin/ingredients`, { headers }),
            fetch(`${API_BASE}/admin/products`,    { headers }),
            fetch(`${API_BASE}/admin/promos`,      { headers }),
            fetch(`${API_BASE}/admin/wishlist`,    { headers }),
            fetch(`${API_BASE}/admin/chats`,       { headers })
        ]);

        if (ordRes.status   === 'fulfilled' && ordRes.value.ok)   orders          = await ordRes.value.json();
        if (ingRes.status   === 'fulfilled' && ingRes.value.ok)   ingredients     = await ingRes.value.json();
        if (prodRes.status  === 'fulfilled' && prodRes.value.ok)  products        = await prodRes.value.json();
        if (promoRes.status === 'fulfilled' && promoRes.value.ok) promos          = await promoRes.value.json();
        if (wishRes.status  === 'fulfilled' && wishRes.value.ok)  wishlistEntries = await wishRes.value.json();
        if (chatRes.status  === 'fulfilled' && chatRes.value.ok)  chatMessages    = await chatRes.value.json();

        renderAdmin();
        try { renderPromos();     } catch (e) { console.warn('renderPromos failed:', e); }
        try { renderWishlist();   } catch (e) { console.warn('renderWishlist failed:', e); }
        try { renderAdminChats(); } catch (e) { console.warn('renderAdminChats failed:', e); }

    } catch (error) {
        console.error('Admin data sync failed:', error);
        showToast('Failed to load admin data — check your connection');
    }
}

// ─── ADMIN SECTION SWITCHING ──────────────────────────────────────────────────
function showAdminSection(s, el) {
    document.querySelectorAll('.admin-section').forEach(sec => sec.classList.remove('active'));
    const section = document.getElementById('section-' + s);
    if (section) section.classList.add('active');
    document.querySelectorAll('.admin-menu-item').forEach(item => item.classList.remove('active'));
    const menuEl = el instanceof Element ? el : el?.currentTarget;
    if (menuEl && menuEl.classList.contains('admin-menu-item')) menuEl.classList.add('active');
    if (s === 'products') startStockPolling(); else stopStockPolling();
    if (s === 'crm') loadCRM(); else loadAdminData();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatDesc(text) {
    if (!text) return '';
    if (/<[a-z][\s\S]*>/i.test(text)) return text;
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ─── RENDER SHOP ──────────────────────────────────────────────────────────────
function renderShop() {
    const grid = document.getElementById('products-grid');
    if (!products.length) {
        grid.innerHTML = '<p style="color:var(--text-muted); font-weight:700;">No products available.</p>';
        return;
    }
    const sorted = [...products].sort((a, b) => {
        const aOut = a.stock !== undefined && a.stock !== null && a.stock <= 0;
        const bOut = b.stock !== undefined && b.stock !== null && b.stock <= 0;
        if (aOut && !bOut) return 1;
        if (!aOut && bOut) return -1;
        return 0;
    });
    grid.innerHTML = sorted.map(p => {
        const outOfStock = (p.stock !== undefined && p.stock !== null && p.stock <= 0);
        return `
        <div class="product-card ${outOfStock ? 'out-of-stock' : ''}" onclick="openProductDetail(${p.id})">
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
            ${outOfStock
              ? `<button class="notify-btn" onclick="event.stopPropagation(); openWishlistModal(${p.id})">🔔 Notify Me</button>`
              : `<button class="add-btn" id="add-btn-${p.id}" onclick="event.stopPropagation(); addToCart(${p.id})">+ Add to Basket</button>`
            }
          </div>
        </div>`;
    }).join('');
}

// ─── PRODUCT DETAIL MODAL ─────────────────────────────────────────────────────
function openProductDetail(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    document.getElementById('pm-name').textContent  = p.name;
    document.getElementById('pm-price').textContent = '£' + Number(p.price).toFixed(2);
    document.getElementById('pm-desc').innerHTML    = formatDesc(p.description);
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
    else          { badgeEl.style.display = 'none'; }
    const outOfStock = (p.stock !== undefined && p.stock !== null && p.stock <= 0);
    const addBtn = document.getElementById('pm-add-btn');
    if (outOfStock) {
        addBtn.textContent = '🔔 Notify Me When Back In Stock';
        addBtn.onclick = () => { closeProductDetail(); openWishlistModal(id); };
    } else {
        addBtn.textContent = '+ Add to Basket';
        addBtn.onclick = () => { addToCart(id); closeProductDetail(); };
    }
    document.getElementById('product-modal').classList.add('open');
}
function closeProductDetail() { document.getElementById('product-modal').classList.remove('open'); }
function closeProductDetailOnOverlay(e) { if (e.target.id === 'product-modal') closeProductDetail(); }

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
            ${o.pickup ? '<span class="badge" style="background:#E8F5E9;color:#1B5E20;margin-left:4px;">🏠 Pickup</span>' : ''}
          </td>
          <td>${o.date || ''}</td>
        </tr>`).join('');
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
            ${o.pickup ? '<span style="font-size:0.75rem;margin-left:4px;" title="Home Pickup">🏠</span>' : ''}
          </td>
          <td>
            ${o.status === 'pending'    ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}','processing')">Process</button>` : ''}
            ${o.status === 'processing' ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}','shipped')">Ship</button>` : ''}
            ${o.status === 'shipped'    ? `<button class="action-btn" onclick="updateOrderStatus('${o.id}','delivered')">Delivered ✓</button>` : ''}
            ${!['delivered','cancelled'].includes(o.status) ? `<button class="action-btn danger" onclick="cancelOrder('${o.id}')">Cancel</button>` : ''}
          </td>
        </tr>`).join('');
}

function renderShipping() {
    const el = document.getElementById('shipping-cards');
    const deliveryOrders = orders.filter(o => !o.pickup && o.status !== 'cancelled');
    if (!deliveryOrders.length) {
        el.innerHTML = '<p style="color:var(--text-muted); font-weight:600;">No delivery orders yet.</p>';
        return;
    }
    const active    = deliveryOrders.filter(o => o.status !== 'delivered');
    const delivered = deliveryOrders.filter(o => o.status === 'delivered');
    let html = '';
    if (active.length) {
        html += active.map(o => `
            <div class="shipping-row" id="ship-${o.id}">
              <div class="shipping-row-main">
                <div class="shipping-row-info">
                  <div class="shipping-row-id">${o.id}</div>
                  <div class="shipping-row-name">${o.fname || ''} ${o.lname || ''}</div>
                  <div class="shipping-row-address">📍 ${o.address || 'No address'}</div>
                  <div class="shipping-row-items">${o.items || ''}</div>
                </div>
                <div class="shipping-row-meta">
                  <span class="badge badge-${o.status}" style="margin-bottom:8px;">${o.status}</span>
                  <div style="font-weight:800;font-size:1rem;color:var(--green-dark);">£${parseFloat(o.total).toFixed(2)}</div>
                  <div style="font-size:0.78rem;color:var(--text-muted);font-weight:600;margin-top:4px;">${o.date || ''}</div>
                  ${o.status === 'pending'    ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}','processing')" style="margin-top:8px;width:100%;">Process</button>` : ''}
                  ${o.status === 'processing' ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}','shipped')" style="margin-top:8px;width:100%;">Mark Shipped</button>` : ''}
                </div>
              </div>
              <label class="shipping-delivered-check">
                <input type="checkbox" onchange="markDelivered('${o.id}', this)">
                <span>Mark as Delivered</span>
              </label>
            </div>`).join('');
    }
    if (delivered.length) {
        html += `<div style="margin-top:2rem;margin-bottom:1rem;font-size:0.8rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);display:flex;align-items:center;gap:12px;"><span>✓ Delivered</span><div style="flex:1;height:2px;background:var(--border);"></div></div>`;
        html += delivered.map(o => `
            <div class="shipping-row shipping-row-done" id="ship-${o.id}">
              <div class="shipping-row-main">
                <div class="shipping-row-info">
                  <div class="shipping-row-id">${o.id}</div>
                  <div class="shipping-row-name">${o.fname || ''} ${o.lname || ''}</div>
                  <div class="shipping-row-address">📍 ${o.address || 'No address'}</div>
                  <div class="shipping-row-items">${o.items || ''}</div>
                </div>
                <div class="shipping-row-meta">
                  <span class="badge badge-delivered" style="margin-bottom:8px;">Delivered</span>
                  <div style="font-weight:800;font-size:1rem;color:var(--green-dark);">£${parseFloat(o.total).toFixed(2)}</div>
                  <div style="font-size:0.78rem;color:var(--text-muted);font-weight:600;margin-top:4px;">${o.date || ''}</div>
                </div>
              </div>
              <label class="shipping-delivered-check shipping-delivered-check-done">
                <input type="checkbox" checked disabled><span>Delivered ✓</span>
              </label>
            </div>`).join('');
    }
    el.innerHTML = html;
}

async function markDelivered(id, checkbox) {
    checkbox.disabled = true;
    try { await updateOrderStatus(id, 'delivered'); }
    catch (e) { checkbox.checked = false; checkbox.disabled = false; showToast('Could not mark as delivered'); }
}

function exportShippingCSV() {
    const deliveryOrders = orders.filter(o => !o.pickup && o.status !== 'cancelled');
    if (!deliveryOrders.length) { showToast('No delivery orders to export'); return; }
    const headers = ['Order ID','First Name','Last Name','Email','Address','Items','Total','Status','Date'];
    const rows    = deliveryOrders.map(o =>
        [o.id||'',o.fname||'',o.lname||'',o.email||'',o.address||'',o.items||'',
         '£'+parseFloat(o.total||0).toFixed(2),o.status||'',o.date||'']
        .map(c => `"${String(c).replace(/"/g,'""')}"`).join(','));
    const csv      = [headers.map(h=>`"${h}"`).join(','), ...rows].join('\n');
    const filename = `homegrown-deliveries-${new Date().toLocaleDateString('en-GB').replace(/\//g,'-')}.csv`;
    const link     = document.createElement('a');
    link.setAttribute('href', 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv));
    link.setAttribute('download', filename);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    showToast(`✓ Exported ${deliveryOrders.length} order${deliveryOrders.length !== 1 ? 's' : ''}`);
}

function renderIngredients() {
    const tbody = document.getElementById('ingredients-body');
    if (!ingredients.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem;">No ingredients yet.</td></tr>';
        const el = document.getElementById('stat-lowstock'); if (el) el.textContent = '0';
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
          <td style="min-width:120px;"><div class="progress-bar-wrap"><div class="progress-bar ${barCls}" style="width:${pct}%;"></div></div></td>
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
            const d = new Date(); d.setDate(d.getDate() - i);
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
            </div>`).join('');
    }
    const tbody = document.getElementById('payments-body');
    if (!tbody) return;
    if (!orders.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem;">No transactions yet.</td></tr>'; return; }
    tbody.innerHTML = orders.map(o => `
        <tr>
          <td><strong>${o.id}</strong></td>
          <td>${o.fname || ''} ${o.lname || ''}</td>
          <td><strong>£${parseFloat(o.total).toFixed(2)}</strong></td>
          <td>${o.date || ''}</td>
          <td><span class="badge badge-paid">Paid</span></td>
        </tr>`).join('');
}

function renderProductMgmt() {
    const grid = document.getElementById('product-mgmt-grid');
    if (!grid) return;
    if (!products.length) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-muted);"><div style="font-size:3rem;margin-bottom:1rem;">🍪</div><p style="font-weight:700;font-size:1rem;">No products yet.</p><button class="action-btn primary" onclick="openProductModal()" style="margin-top:1rem;padding:10px 24px;">+ Add Your First Product</button></div>`;
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
          <div class="pmc-card-img" style="background:${p.bg_color||'#FFFBE8'};${p.image_url?`background-image:url('${p.image_url}');background-size:cover;background-position:center;`:''}">
            ${p.image_url ? '' : `<span style="font-size:2.8rem;">${p.emoji||'🍪'}</span>`}
            ${p.badge ? `<span class="product-badge" style="position:absolute;top:8px;right:8px;">${p.badge}</span>` : ''}
          </div>
          <div class="pmc-card-body">
            <div class="pmc-card-name">${p.name}</div>
            <div class="pmc-card-desc">${p.description ? p.description.substring(0,55)+(p.description.length>55?'…':'') : 'No description'}</div>
            <div class="pmc-card-price">£${Number(p.price).toFixed(2)}</div>
            <div class="pmc-stock-bar">
              <span class="pmc-stock-label" style="color:${stockColor};">${stockIcon} ${stockLabel}</span>
              ${stock !== null && stock > 0 ? `<div class="pmc-stock-track"><div class="pmc-stock-fill" style="width:${Math.min(100,(stock/Math.max(stock,20))*100)}%;background:${stockColor};"></div></div>` : ''}
            </div>
            <div class="pmc-card-actions">
              <button class="action-btn primary" onclick="openProductModal(${p.id})">✏️ Edit</button>
              <button class="action-btn danger"  onclick="deleteProduct(${p.id})">🗑 Delete</button>
            </div>
          </div>
        </div>`;
    }).join('');
}

// ─── PRODUCT MODAL ────────────────────────────────────────────────────────────
let productStockPollTimer     = null;
const CLOUDINARY_CLOUD_NAME   = 'dyitrwe5h';
const CLOUDINARY_UPLOAD_PRESET = 'homegrownfoods';

function updateImagePreview(url) {
    const preview    = document.getElementById('pem-img-preview');
    const previewBox = document.getElementById('pem-img-preview-box');
    if (url) { preview.src = url; previewBox.style.display = 'block'; }
    else      { preview.src = ''; previewBox.style.display = 'none'; }
}

async function uploadToCloudinary() {
    const fileInput = document.getElementById('pem-file-input');
    const file      = fileInput.files[0];
    if (!file) return;
    if (!CLOUDINARY_CLOUD_NAME.startsWith('YOUR_')) {
        const uploadBtn = document.getElementById('pem-upload-btn');
        uploadBtn.disabled = true; uploadBtn.textContent = '⏳ Uploading…';
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
            const res  = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: 'POST', body: formData });
            if (!res.ok) throw new Error('Upload failed');
            const data = await res.json();
            document.getElementById('pem-image').value = data.secure_url;
            updateImagePreview(data.secure_url);
            showToast('✓ Image uploaded!');
        } catch (err) {
            showToast('Upload failed — check your Cloudinary config');
        } finally {
            uploadBtn.disabled = false; uploadBtn.textContent = '📷 Upload Photo'; fileInput.value = '';
        }
    } else {
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
        document.getElementById('pem-name').value  = p.name      || '';
        document.getElementById('pem-price').value = p.price     || '';
        document.getElementById('pem-emoji').value = p.emoji     || '';
        document.getElementById('pem-badge').value = p.badge     || '';
        document.getElementById('pem-image').value = p.image_url || '';
        document.getElementById('pem-desc').innerHTML = formatDesc(p.description || '');
        document.getElementById('pem-bg').value    = p.bg_color  || '#FFFBE8';
        document.getElementById('pem-stock').value = p.stock     ?? '';
        updateImagePreview(p.image_url || '');
    } else {
        ['pem-id','pem-name','pem-price','pem-emoji','pem-badge','pem-image','pem-stock'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('pem-desc').innerHTML = '';
        document.getElementById('pem-bg').value = '#FFFBE8';
        updateImagePreview('');
    }
    modal.classList.add('open');
}
function closeProductModal() { document.getElementById('product-edit-modal').classList.remove('open'); }

async function saveProductFromModal() {
    const id   = document.getElementById('pem-id').value;
    const name = document.getElementById('pem-name').value.trim();
    if (!name) { showToast('Product name is required'); return; }
    const payload = {
        name, price: parseFloat(document.getElementById('pem-price').value) || 0,
        emoji: document.getElementById('pem-emoji').value,
        badge: document.getElementById('pem-badge').value,
        image_url: document.getElementById('pem-image').value,
        description: document.getElementById('pem-desc').innerHTML.trim(),
        bg_color: document.getElementById('pem-bg').value,
        stock: parseInt(document.getElementById('pem-stock').value) || 0
    };
    const saveBtn = document.getElementById('pem-save-btn');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
        const url    = id ? `${API_BASE}/admin/products/${id}` : `${API_BASE}/admin/products`;
        const method = id ? 'PUT' : 'POST';
        const res    = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` }, body: JSON.stringify(payload) });
        if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || `Server returned ${res.status}`); }
        localStorage.removeItem(CACHE_KEY);
        showToast(id ? '✓ Product updated!' : '✓ Product added!');
        closeProductModal();
        await loadAdminData();
        renderShop();
    } catch (err) {
        showToast('Save failed: ' + err.message);
    } finally {
        saveBtn.disabled = false; saveBtn.textContent = '💾 Save Product';
    }
}

function startStockPolling() {
    stopStockPolling();
    productStockPollTimer = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/admin/products`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
            if (res.ok) {
                const fresh = await res.json();
                fresh.forEach(p => {
                    const existing = products.find(x => x.id === p.id);
                    if (existing && existing.stock !== p.stock) {
                        existing.stock = p.stock;
                        const card = document.getElementById('pmc-' + p.id);
                        if (card) {
                            const isLow = p.stock !== null && p.stock > 0 && p.stock <= 5;
                            const isOut = p.stock !== null && p.stock <= 0;
                            const c = isOut ? 'var(--danger)' : isLow ? 'var(--warning)' : 'var(--success)';
                            const l = isOut ? 'Out of Stock' : isLow ? `Low — ${p.stock} left` : `${p.stock !== null ? p.stock : '∞'} in stock`;
                            const i = isOut ? '🔴' : isLow ? '🟡' : '🟢';
                            const el = card.querySelector('.pmc-stock-label');
                            if (el) { el.style.color = c; el.textContent = `${i} ${l}`; }
                        }
                    }
                });
            }
        } catch (e) {}
    }, 20000);
}
function stopStockPolling() {
    if (productStockPollTimer) { clearInterval(productStockPollTimer); productStockPollTimer = null; }
}

// ─── PROMO CODES ──────────────────────────────────────────────────────────────
function renderPromos() {
    const tbody = document.getElementById('promos-body');
    if (!tbody) return;
    if (!promos.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem;">No active promo codes.</td></tr>';
        return;
    }
    tbody.innerHTML = promos.map(p => `
        <tr>
          <td><strong>${p.code}</strong></td>
          <td>${p.discount_percent}%</td>
          <td>${p.used_count} / ${p.max_uses !== null ? p.max_uses : '∞'}</td>
          <td><button class="action-btn danger" onclick="deletePromo(${p.id})">Remove</button></td>
        </tr>`).join('');
}

// ─── WISHLIST (CUSTOMER) ──────────────────────────────────────────────────────
function openWishlistModal(productId) {
    const p     = products.find(x => x.id === productId);
    const modal = document.getElementById('wishlist-modal');
    if (!modal) return;
    modal.dataset.productId = productId;
    const nameEl = document.getElementById('wishlist-product-name');
    if (nameEl && p) nameEl.textContent = p.name;
    document.getElementById('wishlist-email').value = '';
    document.getElementById('wishlist-msg').textContent = '';
    const btn = document.getElementById('wishlist-submit-btn');
    btn.disabled = false; btn.textContent = '🔔 Notify Me When Back In Stock';
    modal.classList.add('open');
    setTimeout(() => document.getElementById('wishlist-email').focus(), 150);
}
function closeWishlistModal() {
    const modal = document.getElementById('wishlist-modal');
    if (modal) modal.classList.remove('open');
}

async function submitWishlist() {
    const email     = document.getElementById('wishlist-email').value.trim();
    const productId = parseInt(document.getElementById('wishlist-modal').dataset.productId);
    const msgEl     = document.getElementById('wishlist-msg');
    if (!email || !email.includes('@')) {
        msgEl.style.color = 'var(--danger)';
        msgEl.textContent = 'Please enter a valid email address.';
        return;
    }
    const btn = document.getElementById('wishlist-submit-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        await fetch(`${API_BASE}/wishlist`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId, email })
        });
    } catch (err) { console.warn('Wishlist backend save failed:', err); }
    msgEl.style.color = 'var(--success)';
    msgEl.textContent = "✓ Saved! We'll email you the moment it's back in stock.";
    btn.textContent   = "✓ You're on the list!";
    setTimeout(() => { closeWishlistModal(); showToast("🔔 We'll let you know when it's back!"); }, 1800);
}

// ─── WISHLIST (ADMIN) ─────────────────────────────────────────────────────────
const EMAILJS_WISHLIST_TEMPLATE_ID = 'YOUR_WISHLIST_TEMPLATE_ID';

function renderWishlist() {
    const container = document.getElementById('wishlist-admin-content');
    if (!container) return;
    if (!wishlistEntries || !wishlistEntries.length) {
        container.innerHTML = '<p style="color:var(--text-muted);font-weight:600;">No wishlist entries yet. When customers click "🔔 Notify Me" on a sold-out product, they\'ll appear here.</p>';
        return;
    }
    const grouped = {};
    wishlistEntries.forEach(entry => {
        const pid = String(entry.product_id || entry.productId);
        if (!grouped[pid]) grouped[pid] = [];
        grouped[pid].push(entry);
    });
    let html = '';
    Object.entries(grouped).forEach(([productId, entries]) => {
        const product     = products.find(p => String(p.id) === productId);
        const productName = product ? product.name : `Product #${productId}`;
        const isOut       = product && product.stock !== null && product.stock <= 0;
        html += `
        <div class="table-wrap" style="margin-bottom:1.5rem;">
          <div style="padding:1rem 1.25rem;background:var(--green-dark);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <span style="font-family:var(--font-brand);font-size:1.15rem;color:var(--yellow);">${product ? (product.emoji||'')+ ' ' : ''}${productName}</span>
              <span style="font-size:0.78rem;font-weight:700;color:var(--green-light);">${entries.length} customer${entries.length!==1?'s':''} waiting</span>
              <span class="badge ${isOut?'badge-cancelled':'badge-ok'}">${isOut?'Still out of stock':'✓ Back in stock'}</span>
            </div>
            <div style="display:flex;gap:8px;">
              <button class="action-btn primary" onclick="notifyWishlistProduct('${productId}')" style="background:var(--yellow);color:var(--green-dark);border-color:var(--yellow);">📧 Email All (${entries.length})</button>
              <button class="action-btn danger" onclick="clearWishlistProduct('${productId}')">🗑 Clear</button>
            </div>
          </div>
          <table>
            <thead><tr><th>Email</th><th>Date Added</th><th>Actions</th></tr></thead>
            <tbody>
              ${entries.map(e => `
                <tr>
                  <td>${e.email}</td>
                  <td style="color:var(--text-muted);font-size:0.85rem;">${e.date || e.created_at || '—'}</td>
                  <td><button class="action-btn danger" onclick="removeWishlistEntry(${e.id})">Remove</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    });
    container.innerHTML = html;
}

async function notifyWishlistProduct(productId) {
    const product     = products.find(p => String(p.id) === String(productId));
    const productName = product ? product.name : `Product #${productId}`;
    const entries     = wishlistEntries.filter(e => String(e.product_id || e.productId) === String(productId));
    if (!entries.length) { showToast('No customers to notify'); return; }
    if (!confirm(`Send back-in-stock emails to ${entries.length} customer${entries.length!==1?'s':''} for "${productName}"?`)) return;

    try {
        const res = await fetch(`${API_BASE}/admin/wishlist/notify/${productId}`, {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to send');
        showToast(`✓ Notified ${data.sent} customer${data.sent!==1?'s':''} about "${productName}"`);
        await loadAdminData();
    } catch (err) {
        showToast('Failed to send notifications: ' + err.message);
    }
}

async function clearWishlistProduct(productId) {
    const product = products.find(p => String(p.id) === String(productId));
    if (!confirm(`Clear all wishlist entries for "${product ? product.name : 'this product'}"?`)) return;
    try {
        await fetch(`${API_BASE}/admin/wishlist/${productId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${adminToken}` } });
        showToast('Wishlist cleared');
        await loadAdminData();
    } catch (err) { showToast('Failed to clear wishlist'); }
}

async function removeWishlistEntry(id) {
    try {
        await fetch(`${API_BASE}/admin/wishlist/entry/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${adminToken}` } });
        showToast('Entry removed');
        await loadAdminData();
    } catch (err) { showToast('Failed to remove entry'); }
}

// ─── CHAT WIDGET (CUSTOMER) ───────────────────────────────────────────────────
function toggleChatWindow() {
    chatWindowOpen = !chatWindowOpen;
    const win = document.getElementById('chat-window');
    if (!win) return;
    win.style.display = chatWindowOpen ? 'flex' : 'none';
    if (chatWindowOpen) {
        const badge = document.getElementById('chat-unread-badge');
        if (badge) badge.style.display = 'none';
        if (chatUser) {
            showChatConversation();
        } else {
            document.getElementById('chat-identity').style.display      = 'flex';
            document.getElementById('chat-messages-area').style.display = 'none';
            document.getElementById('chat-input-area').style.display    = 'none';
            setTimeout(() => document.getElementById('chat-name-input')?.focus(), 150);
        }
    }
}

function startChat() {
    const name  = document.getElementById('chat-name-input').value.trim();
    const email = document.getElementById('chat-email-input').value.trim();
    if (!name)                     { showChatIdentityStatus('Please enter your name.', 'error'); return; }
    if (!email || !email.includes('@')) { showChatIdentityStatus('Please enter a valid email.', 'error'); return; }
    chatUser = { name, email };
    localStorage.setItem('hg_chat_user', JSON.stringify(chatUser));
    showChatConversation();
}

function showChatConversation() {
    document.getElementById('chat-identity').style.display      = 'none';
    document.getElementById('chat-messages-area').style.display = 'flex';
    document.getElementById('chat-input-area').style.display    = 'flex';
    renderLocalChat();
    const msgArea = document.getElementById('chat-messages-area');
    if (msgArea) msgArea.scrollTop = msgArea.scrollHeight;
    setTimeout(() => document.getElementById('chat-msg-input')?.focus(), 150);
}

function renderLocalChat() {
    const area = document.getElementById('chat-messages-area');
    if (!area) return;
    if (!localChatHistory.length) {
        area.innerHTML = `
        <div class="chat-welcome">
          <div class="chat-welcome-icon">🌿</div>
          <p>Hi <strong>${chatUser?.name || 'there'}</strong>! How can we help you today?</p>
          <p style="font-size:0.82rem;color:var(--text-muted);margin-top:6px;">We'll reply to your email as soon as possible.</p>
        </div>`;
        return;
    }
    area.innerHTML = localChatHistory.map(msg => `
        <div class="chat-bubble-wrap ${msg.role === 'customer' ? 'chat-bubble-right' : 'chat-bubble-left'}">
          <div class="chat-bubble ${msg.role === 'customer' ? 'chat-bubble-customer' : 'chat-bubble-admin'}">${msg.text}</div>
          <div class="chat-bubble-time">${msg.time || ''}</div>
        </div>`).join('');
    area.scrollTop = area.scrollHeight;
}

async function submitChatMessage() {
    const input = document.getElementById('chat-msg-input');
    const text  = (input?.value || '').trim();
    if (!text || !chatUser) return;
    const msg = {
        role: 'customer', text, name: chatUser.name, email: chatUser.email,
        time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        ts: Date.now()
    };
    localChatHistory.push(msg);
    localStorage.setItem('hg_chat_history', JSON.stringify(localChatHistory));
    input.value = '';
    renderLocalChat();
    try {
        await fetch(`${API_BASE}/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: chatUser.name, email: chatUser.email, message: text, ts: msg.ts })
        });
    } catch (err) { console.warn('Chat message save failed:', err); }
    showChatStatus("✓ Message sent! We'll reply to your email.", 'success');
    setTimeout(() => showChatStatus('', ''), 4000);
}

function showChatStatus(msg, type) {
    const el = document.getElementById('chat-status-msg');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--text-muted)';
}
function showChatIdentityStatus(msg, type) {
    const el = document.getElementById('chat-identity-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'error' ? 'var(--danger)' : 'var(--text-muted)';
}

// ─── CHAT ADMIN INBOX ─────────────────────────────────────────────────────────
function renderAdminChats() {
    const container = document.getElementById('chat-admin-content');
    if (!container) return;
    if (!chatMessages || !chatMessages.length) {
        container.innerHTML = `
        <div style="text-align:center;padding:3rem;color:var(--text-muted);">
          <div style="font-size:3rem;margin-bottom:1rem;">💬</div>
          <p style="font-weight:700;font-size:1rem;">No messages yet.</p>
          <p style="font-size:0.88rem;margin-top:6px;">When customers use the chat widget, their messages appear here.</p>
        </div>`;
        const badge = document.getElementById('chat-sidebar-badge');
        if (badge) badge.style.display = 'none';
        return;
    }
    const threads = {};
    chatMessages.forEach(msg => {
        const key = msg.email || 'unknown';
        if (!threads[key]) threads[key] = { name: msg.name, email: msg.email, messages: [] };
        threads[key].messages.push(msg);
    });
    const sortedThreads = Object.values(threads).sort((a, b) => {
        const aLast = a.messages[a.messages.length - 1]?.ts || 0;
        const bLast = b.messages[b.messages.length - 1]?.ts || 0;
        return bLast - aLast;
    });
    container.innerHTML = sortedThreads.map((thread, idx) => {
        const lastMsg  = thread.messages[thread.messages.length - 1];
        const lastTime = lastMsg?.ts ? new Date(lastMsg.ts).toLocaleDateString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : (lastMsg?.date || '');
        const unread   = thread.messages.filter(m => !m.read).length;
        return `
        <div class="chat-thread-card" id="thread-${idx}">
          <div class="chat-thread-header" onclick="toggleThread(${idx})">
            <div class="chat-thread-avatar">${(thread.name||'?')[0].toUpperCase()}</div>
            <div class="chat-thread-info">
              <div class="chat-thread-name">
                ${thread.name || 'Unknown'}
                ${unread ? `<span class="chat-unread-count">${unread} new</span>` : ''}
              </div>
              <div class="chat-thread-email">${thread.email}</div>
              <div class="chat-thread-preview">${(lastMsg?.message||'').substring(0,60)}${(lastMsg?.message||'').length>60?'…':''}</div>
            </div>
            <div class="chat-thread-meta">
              <div class="chat-thread-time">${lastTime}</div>
              <div class="chat-thread-count">${thread.messages.length} msg${thread.messages.length!==1?'s':''}</div>
              <button class="action-btn danger" style="margin-top:6px;font-size:0.72rem;padding:4px 10px;" onclick="event.stopPropagation(); deleteChatThread('${thread.email}','${(thread.name||'').replace(/'/g,"\'")}')">🗑 Delete</button>
            </div>
          </div>
          <div class="chat-thread-body" id="thread-body-${idx}" style="display:none;">
            <div class="chat-thread-messages">
              ${thread.messages.map(m => `
                <div class="chat-admin-bubble-wrap">
                  <div class="chat-admin-bubble">
                    <div class="chat-admin-bubble-meta">
                      <strong>${m.name || 'Customer'}</strong>
                      <span>${m.date || (m.ts ? new Date(m.ts).toLocaleString('en-GB') : '')}</span>
                    </div>
                    <div class="chat-admin-bubble-text">${m.message || ''}</div>
                  </div>
                </div>
                ${(m.replies || []).map(r => `
                  <div class="chat-admin-bubble-wrap chat-admin-reply-wrap">
                    <div class="chat-admin-bubble chat-admin-reply">
                      <div class="chat-admin-bubble-meta"><strong>You (Home Grown)</strong><span>${r.date||''}</span></div>
                      <div class="chat-admin-bubble-text">${r.text}</div>
                    </div>
                  </div>`).join('')}
              `).join('')}
            </div>
            <div class="chat-reply-box">
              <div style="font-size:0.78rem;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:var(--green-mid);margin-bottom:8px;">
                Reply to ${thread.name} · <span style="font-weight:600;text-transform:none;">${thread.email}</span>
              </div>
              <textarea id="reply-input-${idx}" rows="3"
                placeholder="Type your reply… it'll be sent to ${thread.email}"
                style="width:100%;padding:10px 14px;border:2px solid var(--border);border-radius:var(--radius);font-family:var(--font-body);font-size:0.92rem;background:var(--yellow-pale);resize:vertical;outline:none;"
                onfocus="this.style.borderColor='var(--green-leaf)';this.style.background='var(--white)'"
                onblur="this.style.borderColor='var(--border)';this.style.background='var(--yellow-pale)'"></textarea>
              <div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
                <button class="action-btn primary" onclick="sendAdminChatReply('${thread.email}','${(thread.name||'').replace(/'/g,"\\'")}',${idx})" style="padding:10px 20px;">📧 Send Reply Email</button>
                <span style="font-size:0.78rem;font-weight:700;color:var(--text-muted);">Sends email to customer via Resend</span>
              </div>
              <div id="reply-status-${idx}" style="font-size:0.82rem;font-weight:700;margin-top:6px;min-height:1.2rem;"></div>
            </div>
          </div>
        </div>`;
    }).join('');
    const totalUnread = sortedThreads.reduce((s, t) => s + t.messages.filter(m => !m.read).length, 0);
    const badge = document.getElementById('chat-sidebar-badge');
    if (badge) { badge.textContent = totalUnread || ''; badge.style.display = totalUnread ? 'inline-flex' : 'none'; }
}

async function deleteChatThread(email, name) {
    if (!confirm(`Delete all messages from ${name || email}? This cannot be undone.`)) return;
    try {
        const res = await fetch(`${API_BASE}/admin/chats/thread`, {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ email })
        });
        if (!res.ok) throw new Error('Failed to delete');
        showToast(`✓ Conversation with ${name || email} deleted`);
        await loadAdminData();
    } catch (err) {
        showToast('Failed to delete conversation');
    }
}

function toggleThread(idx) {
    const body = document.getElementById(`thread-body-${idx}`);
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    document.querySelectorAll('[id^="thread-body-"]').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.chat-thread-card').forEach(el => el.classList.remove('chat-thread-active'));
    if (!isOpen) {
        body.style.display = 'block';
        document.getElementById(`thread-${idx}`).classList.add('chat-thread-active');
        const msgs = body.querySelector('.chat-thread-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
}

async function sendAdminChatReply(email, name, idx) {
    const textarea  = document.getElementById(`reply-input-${idx}`);
    const statusEl  = document.getElementById(`reply-status-${idx}`);
    const replyText = (textarea?.value || '').trim();
    if (!replyText) {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = 'Please type a reply first.';
        return;
    }
    const btn = document.querySelector(`#thread-${idx} .action-btn.primary`);
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    statusEl.textContent = '';

    try {
        // Backend handles both saving the reply AND emailing the customer via Nodemailer
        const res = await fetch(`${API_BASE}/admin/chat/reply`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ email, name, reply: replyText, date: new Date().toLocaleString('en-GB') })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server returned ${res.status}`);
        }

        statusEl.style.color = 'var(--success)';
        statusEl.textContent = `✓ Reply sent to ${email}`;
        if (textarea) textarea.value = '';
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send Reply Email'; }
        await loadAdminData();

    } catch (err) {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = 'Failed to send: ' + (err.message || err);
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send Reply Email'; }
    }
}

// ─── BASKET ───────────────────────────────────────────────────────────────────
function addToCart(id) {
    const p  = products.find(x => x.id === id);
    if (!p) return;
    const ex = cart.find(x => x.id === id);
    if (ex) ex.qty++; else cart.push({ ...p, qty: 1 });
    updateCartUI();
    const btn = document.getElementById('add-btn-' + id);
    if (btn) { btn.textContent = '✓ Added'; btn.classList.add('added'); setTimeout(() => { btn.textContent = '+ Add to Basket'; btn.classList.remove('added'); }, 1500); }
    showToast(`${p.emoji || '🍪'} ${p.name} added!`);
}
function changeQty(id, d) {
    const item = cart.find(x => x.id === id);
    if (!item) return;
    item.qty += d;
    if (item.qty <= 0) cart = cart.filter(x => x.id !== id);
    updateCartUI();
}
function removeFromCart(id) { cart = cart.filter(x => x.id !== id); updateCartUI(); }

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
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
                <span style="font-weight:800;font-size:0.95rem;color:var(--green-dark);">£${(parseFloat(item.price)*item.qty).toFixed(2)}</span>
                <button class="remove-item" onclick="removeFromCart(${item.id})" title="Remove">🗑</button>
              </div>
            </div>`).join('');
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
    return city === 'sheffield' && /^S\d/.test(postcode);
}

function updateCheckoutTotals() {
    const subtotal = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const isPickup = document.getElementById('pickup-check')?.checked || false;
    const postcode = (document.getElementById('ch-postcode')?.value || '').trim().toUpperCase();
    const city     = (document.getElementById('ch-city')?.value || '').trim().toLowerCase();
    const btn      = document.getElementById('pay-btn');
    const msgEl    = document.getElementById('delivery-message');
    const errEl    = document.getElementById('card-errors');
    let shipping = 0, shippingLabel = '';

    if (isPickup) {
        shipping = 0; shippingLabel = '🏠 Home Pickup';
        btn.disabled = false;
        msgEl.style.color = 'var(--green-mid)'; msgEl.textContent = "✓ Great! We'll have your order ready for collection.";
        if (errEl) errEl.textContent = '';
        const msg = getFulfilmentMessage(true);
        const infoEl = document.getElementById('checkout-fulfilment-info');
        if (infoEl) { infoEl.style.display='block'; infoEl.style.background=msg.bg; infoEl.style.borderColor=msg.border; infoEl.style.color=msg.color; infoEl.innerHTML=msg.html; }
    } else {
        const hasCity = city.length > 0, hasPostcode = postcode.length > 0;
        if (!hasCity && !hasPostcode) {
            shipping = 0; shippingLabel = 'Delivery (enter city & postcode above)';
            btn.disabled = false; msgEl.textContent = '';
            const infoEl = document.getElementById('checkout-fulfilment-info'); if (infoEl) infoEl.style.display='none';
        } else if (isSheffieldDelivery()) {
            shipping = 3.00; shippingLabel = '🚚 Sheffield Delivery (+£3.00)';
            btn.disabled = false;
            msgEl.style.color = 'var(--green-mid)'; msgEl.textContent = '✓ Great news — we deliver to your area!';
            if (errEl) errEl.textContent = '';
            const msg = getFulfilmentMessage(false);
            const infoEl = document.getElementById('checkout-fulfilment-info');
            if (infoEl) { infoEl.style.display='block'; infoEl.style.background=msg.bg; infoEl.style.borderColor=msg.border; infoEl.style.color=msg.color; infoEl.innerHTML=msg.html; }
        } else {
            shipping = 0; shippingLabel = '<span style="color:var(--danger);">Delivery unavailable</span>';
            btn.disabled = true;
            msgEl.style.color = 'var(--danger)';
            msgEl.textContent = (city === 'sheffield' && hasPostcode && !/^S\d/.test(postcode))
                ? "✗ That postcode doesn't look like a Sheffield postcode (should start with S)."
                : '✗ Sorry, we only deliver within Sheffield. Please select Home Pickup instead.';
            const infoEl = document.getElementById('checkout-fulfilment-info'); if (infoEl) infoEl.style.display='none';
        }
    }

    let discount = 0, discountLabel = '';
    if (appliedPromo) { discount = subtotal * (appliedPromo.discount / 100); discountLabel = `🎟️ Promo ${appliedPromo.code} (−${appliedPromo.discount}%)`; }
    const total = Math.max(0, subtotal - discount + shipping);
    let html = cart.map(i => `<div class="os-item"><span>${i.emoji||''} ${i.name} ×${i.qty}</span><span>£${(parseFloat(i.price)*i.qty).toFixed(2)}</span></div>`).join('');
    if (discountLabel) html += `<div class="os-item" style="color:var(--success);"><span>${discountLabel}</span><span>−£${discount.toFixed(2)}</span></div>`;
    html += `<div class="os-item"><span>${shippingLabel}</span><span>${shipping > 0 ? '£'+shipping.toFixed(2) : 'Free'}</span></div>`;
    html += `<div class="os-item total"><span>Total</span><span>£${total.toFixed(2)}</span></div>`;
    document.getElementById('checkout-summary').innerHTML = html;
    document.getElementById('pay-amount').textContent = '£' + total.toFixed(2);
}

function openCheckout() {
    if (cart.length === 0) return;
    appliedPromo = null;
    const promoMsgEl = document.getElementById('promo-message');
    const promoInput = document.getElementById('promo-input');
    if (promoMsgEl) promoMsgEl.textContent = '';
    if (promoInput) promoInput.value = '';
    const pickupCheck = document.getElementById('pickup-check');
    if (pickupCheck) pickupCheck.checked = false;
    const infoEl = document.getElementById('checkout-fulfilment-info');
    if (infoEl) infoEl.style.display = 'none';
    document.getElementById('checkout-content').style.display = 'block';
    document.getElementById('success-content').style.display  = 'none';
    document.getElementById('card-errors').textContent = '';
    updateCheckoutTotals();
    if (STRIPE_PUBLISHABLE_KEY) {
        document.getElementById('stripe-alert').style.display        = 'none';
        document.getElementById('stripe-card-section').style.display = 'block';
        if (!stripeInstance) {
            stripeInstance = Stripe(STRIPE_PUBLISHABLE_KEY);
            const elements = stripeInstance.elements();
            cardElement    = elements.create('card', { style: { base: { fontFamily: "'Nunito', sans-serif", fontSize: '15px', color: '#0E3019' } } });
            cardElement.mount('#card-element');
        }
    } else {
        document.getElementById('stripe-alert').style.display        = 'block';
        document.getElementById('stripe-card-section').style.display = 'none';
    }
    document.getElementById('checkout-modal').classList.add('open');
    toggleCart();
}
function closeCheckout() { document.getElementById('checkout-modal').classList.remove('open'); }

// ─── PROMO ────────────────────────────────────────────────────────────────────
async function applyPromo() {
    const code     = (document.getElementById('promo-input')?.value || '').trim().toUpperCase();
    const email    = (document.getElementById('ch-email')?.value || '').trim();
    const msgEl    = document.getElementById('promo-message');
    const promoBtn = document.getElementById('promo-btn');
    if (!code)  { msgEl.style.color='var(--danger)'; msgEl.textContent='Please enter a promo code.'; return; }
    if (!email) { msgEl.style.color='var(--danger)'; msgEl.textContent='Please enter your email address first.'; return; }
    promoBtn.disabled = true; promoBtn.textContent = 'Checking…';
    try {
        const res  = await fetch(`${API_BASE}/validate-promo`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ code, email }) });
        const data = await res.json();
        if (data.valid) {
            appliedPromo = { code, discount: data.discount };
            msgEl.style.color = 'var(--success)'; msgEl.textContent = `✓ Code applied! ${data.discount}% off your order.`;
            promoBtn.textContent = '✓ Applied'; promoBtn.disabled = true;
            updateCheckoutTotals();
        } else {
            appliedPromo = null; msgEl.style.color = 'var(--danger)'; msgEl.textContent = data.message || 'Invalid promo code.';
            promoBtn.disabled = false; promoBtn.textContent = 'Apply';
        }
    } catch (err) {
        msgEl.style.color = 'var(--danger)'; msgEl.textContent = 'Could not validate code — please try again.';
        promoBtn.disabled = false; promoBtn.textContent = 'Apply';
    }
}

// ─── FULFILMENT DATES ─────────────────────────────────────────────────────────
function nextSlotDate(targetDay, type) {
    const nowString   = new Date().toLocaleString("en-US", { timeZone: "Europe/London" });
    const now         = new Date(nowString);
    const currentDay  = now.getDay();
    const currentHour = now.getHours();
    let canUseThisWeek = type === 'delivery'
        ? (currentDay < 4 || (currentDay === 4 && currentHour < 13))
        : (currentDay < 5 || (currentDay === 5 && currentHour < 17));
    let daysUntil = targetDay - currentDay;
    const isThisWeek = daysUntil >= 0;
    if (!isThisWeek) daysUntil += 7;
    if (!canUseThisWeek && isThisWeek) daysUntil += 7;
    const d = new Date(now);
    d.setDate(now.getDate() + daysUntil);
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function getFulfilmentMessage(isPickup) {
    if (isPickup) {
        const friday   = nextSlotDate(5, 'pickup');
        const saturday = nextSlotDate(6, 'pickup');
        return { bg:'#E8F5E9', border:'#A5D6A7', color:'#1B5E20',
            html:`<strong>Collection Details</strong><br>Your order will be ready for collection on:<br>📅 <strong>${friday}</strong> or <strong>${saturday}</strong><br>🕙 Between <strong>10am and 1pm</strong><br><br>We'll be in touch if anything changes.` };
    } else {
        const thursday = nextSlotDate(4, 'delivery');
        return { bg:'#E3F2FD', border:'#90CAF9', color:'#0D47A1',
            html:`<strong>Delivery Details</strong><br>Your order will be delivered on:<br>📅 <strong>${thursday}</strong><br>🕕 Between <strong>6pm and 8pm</strong><br><br>Please make sure someone is home to receive it.` };
    }
}

// ─── PROCESS PAYMENT ──────────────────────────────────────────────────────────
async function processPayment() {
    const fields = [['ch-fname','First name'],['ch-lname','Last name'],['ch-email','Email'],['ch-address','Address'],['ch-city','City'],['ch-postcode','Postcode']];
    for (const [id, label] of fields) {
        if (!document.getElementById(id)?.value.trim()) { showToast(`Please enter your ${label}`); return; }
    }
    const btn = document.getElementById('pay-btn');
    btn.disabled = true; btn.innerHTML = 'Processing…';
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
    customer.name     = `${customer.fname} ${customer.lname}`;
    const fullAddress = `${customer.address}, ${customer.city}, ${customer.postcode}`;
    const isPickup    = document.getElementById('pickup-check')?.checked || false;
    const subtotal    = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const discount    = appliedPromo ? subtotal * (appliedPromo.discount / 100) : 0;
    const shipping    = isPickup ? 0 : (isSheffieldDelivery() ? 3.00 : 0);
    const total       = Math.max(0, subtotal - discount + shipping).toFixed(2);

    if (!isPickup && !isSheffieldDelivery()) {
        showToast('Delivery is only available in Sheffield. Please select pickup or update your address.');
        btn.disabled = false; btn.innerHTML = `🌿 Place Order — <span id="pay-amount">£${total}</span>`;
        return;
    }

    const oid             = 'HG-' + Date.now().toString().slice(-6);
    const secureCartItems = cart.map(i => ({ id: i.id, qty: i.qty }));

    try {
        let paymentIntentId = null;
        if (STRIPE_PUBLISHABLE_KEY && stripeInstance && cardElement) {
            const res = await fetch(`${API_BASE}/create-payment-intent`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cartItems: secureCartItems, pickup: isPickup, postcode: customer.postcode,
                    receipt_email: customer.email, promoCode: appliedPromo ? appliedPromo.code : null,
                    metadata: { order_id: oid, customer_name: customer.name, email: customer.email, address: fullAddress }
                })
            });
            if (!res.ok) throw new Error('Failed to initialise payment.');
            const { clientSecret } = await res.json();
            const { paymentIntent, error } = await stripeInstance.confirmCardPayment(clientSecret, {
                payment_method: {
                    card: cardElement,
                    billing_details: {
                        name: customer.name, email: customer.email,
                        phone: customer.phone || undefined,
                        address: { line1: customer.address, city: customer.city, postal_code: customer.postcode, country: 'GB' }
                    }
                },
                receipt_email: customer.email
            });
            if (error) throw new Error(error.message);
            paymentIntentId = paymentIntent.id;
        } else {
            await new Promise(r => setTimeout(r, 700));
        }

        const orderPayload = {
            id: oid, fname: customer.fname, lname: customer.lname, email: customer.email,
            address: fullAddress, postcode: customer.postcode, cartItems: secureCartItems,
            status: 'pending', date: new Date().toLocaleDateString('en-GB'),
            timestamp: Date.now(), paymentIntentId, pickup: isPickup,
            promoCode: appliedPromo ? appliedPromo.code : null
        };

        const orderRes = await fetch(`${API_BASE}/orders`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderPayload)
        });
        if (!orderRes.ok) { const e = await orderRes.json().catch(()=>({})); throw new Error(e.error || 'Order processing failed'); }

        await sendConfirmationEmail(orderPayload, customer, total);

        document.getElementById('success-order-num').textContent = 'Order Reference: ' + oid;
        const msg   = getFulfilmentMessage(isPickup);
        const msgEl = document.getElementById('success-fulfilment-msg');
        if (msgEl) { msgEl.style.background=msg.bg; msgEl.style.border=`2px solid ${msg.border}`; msgEl.style.color=msg.color; msgEl.innerHTML=msg.html; }
        document.getElementById('checkout-content').style.display = 'none';
        document.getElementById('success-content').style.display  = 'block';
        cart = []; appliedPromo = null; updateCartUI();
        showToast('🎉 Order placed! Confirmation email sent.');
    } catch (e) {
        document.getElementById('card-errors').textContent = e.message;
    } finally {
        btn.disabled = false; btn.innerHTML = `🌿 Place Order — <span id="pay-amount">£${total}</span>`;
    }
}

// ─── EMAIL (EmailJS) ──────────────────────────────────────────────────────────
const EMAILJS_SERVICE_ID  = 'service_m69giag';
const EMAILJS_TEMPLATE_ID = 'template_vr90he9';
const EMAILJS_PUBLIC_KEY  = 'joA0S94u7fQmqjub6';

function emailJsReady() {
    return typeof emailjs !== 'undefined' &&
           !EMAILJS_SERVICE_ID.startsWith('YOUR_') &&
           !EMAILJS_TEMPLATE_ID.startsWith('YOUR_') &&
           !EMAILJS_PUBLIC_KEY.startsWith('YOUR_');
}

async function sendConfirmationEmail(order, customer, total) {
    if (!emailJsReady()) { console.info('EmailJS not configured — skipping confirmation email.'); return; }
    const itemLines = cart.length
        ? cart.map(i => `• ${i.name} × ${i.qty}   —   £${(parseFloat(i.price)*i.qty).toFixed(2)}`).join('\n')
        : (order.items || '');
    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_name: customer.name, to_email: customer.email, order_id: order.id,
            order_date: order.date, items_list: itemLines, order_total: `£${total}`,
            delivery_address: order.pickup ? '🏠 Home Pickup — no delivery needed' : order.address,
            shop_name: 'Home Grown', reply_to: 'hello@homegrown.co.uk'
        }, EMAILJS_PUBLIC_KEY);
        console.info('✓ Confirmation email sent to', customer.email);
    } catch (err) { console.warn('Confirmation email failed:', err); }
}

// ─── ADMIN CRUD ───────────────────────────────────────────────────────────────
async function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    try {
        const res = await fetch(`${API_BASE}/admin/products/${id}`, { method:'DELETE', headers:{'Authorization':`Bearer ${adminToken}`} });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        showToast('Product deleted'); await loadAdminData();
    } catch (err) { showToast('Delete failed'); }
}

async function updateOrderStatus(id, status) {
    try {
        const res = await fetch(`${API_BASE}/admin/orders/${id}`, { method:'PUT', headers:{'Content-Type':'application/json','Authorization':`Bearer ${adminToken}`}, body:JSON.stringify({ status }) });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        showToast(`Order ${id} → ${status}`); await loadAdminData();
    } catch (err) { showToast('Update failed'); }
}

async function cancelOrder(id) { if (!confirm(`Cancel order ${id}?`)) return; await updateOrderStatus(id, 'cancelled'); }

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
        await fetch(`${API_BASE}/admin/ingredients`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${adminToken}`}, body:JSON.stringify({ name, unit, stock, min_stock:min, max_stock:max }) });
        showToast('✓ ' + name + ' added');
        ['ing-name','ing-unit','ing-stock','ing-min','ing-max'].forEach(id => document.getElementById(id).value = '');
        await loadAdminData();
    } catch (err) { showToast('Failed to add ingredient'); }
}

async function restockIngredient(index) {
    const ing = ingredients[index]; if (!ing) return;
    const amt = parseFloat(prompt(`Add how much ${ing.unit} to ${ing.name}?`));
    if (isNaN(amt) || amt <= 0) return;
    const newStock = Math.min(parseFloat(ing.max_stock || ing.max || 999), parseFloat(ing.stock) + amt);
    try {
        await fetch(`${API_BASE}/admin/ingredients/${ing.id}`, { method:'PUT', headers:{'Content-Type':'application/json','Authorization':`Bearer ${adminToken}`}, body:JSON.stringify({ stock: newStock }) });
        showToast(`✓ Restocked ${ing.name}`); await loadAdminData();
    } catch (err) { showToast('Restock failed'); }
}

async function deleteIngredient(index) {
    const ing = ingredients[index];
    if (!ing || !confirm(`Remove ${ing.name}?`)) return;
    try {
        await fetch(`${API_BASE}/admin/ingredients/${ing.id}`, { method:'DELETE', headers:{'Authorization':`Bearer ${adminToken}`} });
        showToast(`${ing.name} removed`); await loadAdminData();
    } catch (err) { showToast('Delete failed'); }
}

async function addPromo() {
    const code = document.getElementById('promo-new-code').value.trim().toUpperCase();
    const disc = parseInt(document.getElementById('promo-new-discount').value);
    const max  = document.getElementById('promo-new-max').value ? parseInt(document.getElementById('promo-new-max').value) : null;
    if (!code) { showToast('Please enter a promo code'); return; }
    if (isNaN(disc) || disc < 1 || disc > 100) { showToast('Please enter a valid discount (1-100%)'); return; }
    try {
        const res = await fetch(`${API_BASE}/admin/promos`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${adminToken}`}, body:JSON.stringify({ code, discount_percent:disc, max_uses:max }) });
        if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || 'Server error'); }
        showToast('✓ Promo code added!');
        document.getElementById('promo-new-code').value=''; document.getElementById('promo-new-discount').value='10'; document.getElementById('promo-new-max').value='';
        await loadAdminData();
    } catch (err) { showToast('Failed: ' + err.message); }
}

async function deletePromo(id) {
    if (!confirm('Delete this promo code?')) return;
    try {
        await fetch(`${API_BASE}/admin/promos/${id}`, { method:'DELETE', headers:{'Authorization':`Bearer ${adminToken}`} });
        showToast('Promo code removed'); await loadAdminData();
    } catch (err) { showToast('Delete failed'); }
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
initApp();

// ═══════════════════════════════════════════════
//  CRM & CUSTOMERS
// ═══════════════════════════════════════════════

// ─── STATE ────────────────────────────────────────────────────────────────────
let crmCustomers      = [];
let crmCurrentProfile = null;   // { email, orders, messages, notes, wishlist }

// ─── LOAD & RENDER LIST ───────────────────────────────────────────────────────
async function loadCRM() {
    if (!adminToken) return;
    try {
        const res = await fetch(`${API_BASE}/admin/crm`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (res.ok) {
            crmCustomers = await res.json();
            renderCRM();
        }
    } catch (err) { console.error('CRM load failed:', err); }
}

function renderCRM() {
    const tbody   = document.getElementById('crm-tbody');
    const countEl = document.getElementById('crm-count');
    if (!tbody) return;

    if (countEl) countEl.textContent = crmCustomers.length;

    if (!crmCustomers.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:3rem;">No customers yet — they appear here once someone places an order or messages you.</td></tr>';
        return;
    }

    tbody.innerHTML = crmCustomers.map(c => {
        const initial = (c.name || c.email || '?')[0].toUpperCase();
        const ltv     = parseFloat(c.ltv || 0);
        return `
        <tr class="crm-row" onclick="openCustomerProfile('${c.email.replace(/'/g,"\\'")}')">
          <td>
            <div class="crm-avatar">${initial}</div>
          </td>
          <td>
            <div style="font-weight:800;color:var(--green-dark);">${c.name || '—'}</div>
            <small style="color:var(--text-muted);">${c.email}</small>
          </td>
          <td><strong>${c.order_count || 0}</strong></td>
          <td><strong style="color:${ltv > 0 ? 'var(--success)' : 'var(--text-muted)'};">£${ltv.toFixed(2)}</strong></td>
          <td style="color:var(--text-muted);font-size:0.85rem;">${c.last_contact || '—'}</td>
        </tr>`;
    }).join('');
}

function filterCRM(q) {
    document.querySelectorAll('#crm-tbody .crm-row').forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
    });
}

// ─── CUSTOMER PROFILE ─────────────────────────────────────────────────────────
async function openCustomerProfile(email) {
    const modal = document.getElementById('crm-profile-modal');
    if (!modal) return;

    // Show modal immediately with loading state
    modal.classList.add('open');
    document.getElementById('crm-profile-name').textContent   = 'Loading…';
    document.getElementById('crm-profile-email').textContent  = email;
    document.getElementById('crm-profile-ltv').textContent    = '£—';
    document.getElementById('crm-profile-orders').textContent = '—';
    document.getElementById('crm-profile-avatar').textContent = email[0].toUpperCase();
    document.getElementById('crm-notes-list').innerHTML       = '';
    document.getElementById('crm-wishlist').innerHTML         = '';
    document.getElementById('crm-orders-list').innerHTML      = '<p style="color:var(--text-muted);padding:1rem 0;">Loading…</p>';
    document.getElementById('crm-comms-thread').innerHTML     = '';

    switchCRMTab('overview');

    try {
        const res = await fetch(`${API_BASE}/admin/crm/customer?email=${encodeURIComponent(email)}`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (!res.ok) throw new Error('Failed to load profile');
        const data = await res.json();
        crmCurrentProfile = { email, ...data };
        renderCustomerProfile();
    } catch (err) {
        showToast('Failed to load customer profile');
        console.error(err);
    }
}

function closeCustomerProfile() {
    const modal = document.getElementById('crm-profile-modal');
    if (modal) modal.classList.remove('open');
    crmCurrentProfile = null;
}

function switchCRMTab(tab) {
    document.querySelectorAll('.crm-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.crm-tab-panel').forEach(panel => {
        panel.style.display = panel.dataset.tab === tab ? 'block' : 'none';
    });
}

function renderCustomerProfile() {
    const c = crmCurrentProfile;
    if (!c) return;

    // Derive display name from orders or messages
    const firstName = c.orders?.[0]?.fname || '';
    const lastName  = c.orders?.[0]?.lname || '';
    const name      = (firstName + ' ' + lastName).trim() || c.messages?.[0]?.name || c.email;
    const ltv       = (c.orders || []).reduce((s, o) => s + parseFloat(o.total || 0), 0);

    document.getElementById('crm-profile-name').textContent   = name;
    document.getElementById('crm-profile-email').textContent  = c.email;
    document.getElementById('crm-profile-ltv').textContent    = '£' + ltv.toFixed(2);
    document.getElementById('crm-profile-orders').textContent = (c.orders || []).length;
    document.getElementById('crm-profile-avatar').textContent = name[0].toUpperCase();

    renderCRMOverview(c);
    renderCRMOrders(c);
    renderCRMComms(c);
}

// ─── OVERVIEW TAB ─────────────────────────────────────────────────────────────
function renderCRMOverview(c) {
    // Notes
    const notes = c.notes || [];
    document.getElementById('crm-notes-list').innerHTML = notes.length
        ? notes.map(n => `
            <div class="crm-note">
              <div class="crm-note-text">${n.note.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>')}</div>
              <div class="crm-note-meta">
                ${new Date(n.created_at).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}
                <button class="action-btn danger" onclick="deleteCRMNote(${n.id})" style="margin-left:10px;padding:2px 8px;font-size:0.72rem;">Remove</button>
              </div>
            </div>`).join('')
        : '<p style="color:var(--text-muted);font-weight:600;font-size:0.9rem;">No notes yet.</p>';

    // Wishlist
    const wishlist = c.wishlist || [];
    document.getElementById('crm-wishlist').innerHTML = wishlist.length
        ? wishlist.map(w => `<span class="badge badge-pending">${w.emoji || ''}${w.emoji ? ' ' : ''}${w.product_name || 'Product #' + w.product_id}</span>`).join('')
        : '<p style="color:var(--text-muted);font-weight:600;font-size:0.9rem;">Not watching any products.</p>';
}

// ─── ORDERS TAB ───────────────────────────────────────────────────────────────
function renderCRMOrders(c) {
    const orders = c.orders || [];
    const el     = document.getElementById('crm-orders-list');
    if (!orders.length) {
        el.innerHTML = '<p style="color:var(--text-muted);font-weight:600;padding:1rem 0;">No orders yet.</p>';
        return;
    }
    el.innerHTML = `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Order #</th><th>Items</th><th>Total</th><th>Type</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              ${orders.map(o => `
                <tr>
                  <td><strong>${o.id}</strong></td>
                  <td style="font-size:0.82rem;color:var(--text-muted);">${o.items || ''}</td>
                  <td><strong>£${parseFloat(o.total).toFixed(2)}</strong></td>
                  <td>${o.pickup ? '🏠 Pickup' : '🚚 Delivery'}</td>
                  <td><span class="badge badge-${o.status}">${o.status}</span></td>
                  <td style="color:var(--text-muted);font-size:0.85rem;">${o.date || ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
}

// ─── COMMUNICATIONS TAB ───────────────────────────────────────────────────────
function renderCRMComms(c) {
    const messages = c.messages || [];
    const el       = document.getElementById('crm-comms-thread');
    if (!el) return;

    if (!messages.length) {
        el.innerHTML = '<p style="color:var(--text-muted);font-weight:600;">No messages yet — this is where chat messages from the website appear.</p>';
        return;
    }

    el.innerHTML = messages.map(m => `
        <div class="chat-admin-bubble-wrap">
          <div class="chat-admin-bubble">
            <div class="chat-admin-bubble-meta">
              <strong>${m.name || 'Customer'}</strong>
              <span>${m.date || (m.ts ? new Date(m.ts).toLocaleString('en-GB') : '')}</span>
            </div>
            <div class="chat-admin-bubble-text">${m.message || ''}</div>
          </div>
        </div>
        ${(m.replies || []).map(r => `
          <div class="chat-admin-bubble-wrap chat-admin-reply-wrap">
            <div class="chat-admin-bubble chat-admin-reply">
              <div class="chat-admin-bubble-meta">
                <strong>You (Home Grown)</strong>
                <span>${r.date || ''}</span>
              </div>
              <div class="chat-admin-bubble-text">${r.text}</div>
            </div>
          </div>`).join('')}`
    ).join('');

    // Scroll thread to bottom
    el.scrollTop = el.scrollHeight;
}

// ─── NOTES ────────────────────────────────────────────────────────────────────
async function addCRMNote() {
    const textarea = document.getElementById('crm-note-input');
    const note     = (textarea?.value || '').trim();
    if (!note || !crmCurrentProfile) return;

    const btn = document.querySelector('[onclick="addCRMNote()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
        const res = await fetch(`${API_BASE}/admin/crm/notes`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ email: crmCurrentProfile.email, note })
        });
        if (!res.ok) throw new Error('Failed to save');
        textarea.value = '';
        showToast('✓ Note saved');
        // Refresh just the notes section
        const profileRes = await fetch(`${API_BASE}/admin/crm/customer?email=${encodeURIComponent(crmCurrentProfile.email)}`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (profileRes.ok) {
            const data = await profileRes.json();
            crmCurrentProfile.notes = data.notes;
            renderCRMOverview(crmCurrentProfile);
        }
    } catch (err) {
        showToast('Failed to save note');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '+ Add Note'; }
    }
}

async function deleteCRMNote(id) {
    if (!confirm('Delete this note?')) return;
    try {
        await fetch(`${API_BASE}/admin/crm/notes/${id}`, {
            method:  'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        showToast('Note deleted');
        const profileRes = await fetch(`${API_BASE}/admin/crm/customer?email=${encodeURIComponent(crmCurrentProfile.email)}`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (profileRes.ok) {
            const data = await profileRes.json();
            crmCurrentProfile.notes = data.notes;
            renderCRMOverview(crmCurrentProfile);
        }
    } catch (err) {
        showToast('Failed to delete note');
    }
}

// ─── SEND REPLY FROM CRM ──────────────────────────────────────────────────────
async function sendCRMReply() {
    if (!crmCurrentProfile) return;
    const textarea  = document.getElementById('crm-reply-input');
    const statusEl  = document.getElementById('crm-reply-status');
    const replyText = (textarea?.value || '').trim();
    if (!replyText) { statusEl.style.color='var(--danger)'; statusEl.textContent='Please type a reply first.'; return; }

    const btn = document.getElementById('crm-reply-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    statusEl.textContent = '';

    const name = document.getElementById('crm-profile-name').textContent;

    try {
        const res = await fetch(`${API_BASE}/admin/chat/reply`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({
                email: crmCurrentProfile.email,
                name,
                reply: replyText,
                date:  new Date().toLocaleString('en-GB')
            })
        });
        if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || `Error ${res.status}`);

        textarea.value        = '';
        statusEl.style.color  = 'var(--success)';
        statusEl.textContent  = `✓ Reply sent to ${crmCurrentProfile.email}`;
        setTimeout(() => { statusEl.textContent = ''; }, 4000);

        // Refresh messages in comms tab
        const profileRes = await fetch(`${API_BASE}/admin/crm/customer?email=${encodeURIComponent(crmCurrentProfile.email)}`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        if (profileRes.ok) {
            const data = await profileRes.json();
            crmCurrentProfile.messages = data.messages;
            renderCRMComms(crmCurrentProfile);
        }
    } catch (err) {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = 'Failed: ' + err.message;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send Reply'; }
    }
}
