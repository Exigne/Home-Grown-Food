// ═══════════════════════════════════════════════
//  HOME GROWN — app.js
// ═══════════════════════════════════════════════

// --- CONFIGURATION & STATE ---
const API_BASE = window.location.origin + '/api';
let adminToken = localStorage.getItem('hg_admin_token') || null;
let STRIPE_PUBLISHABLE_KEY = '';
let cart = [];
let orders = [];
let ingredients = [];
let products = [];
let stripeInstance = null;
let cardElement = null;

// ─── INITIALIZE ──────────────────────────────────────────────────────────────
async function initApp() {
    await fetchConfig();
    await fetchProducts();
    updateCartUI();
}

async function fetchConfig() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        if (res.ok) {
            const data = await res.json();
            STRIPE_PUBLISHABLE_KEY = data.stripePublishableKey || 'pk_live_51PU4upEFaqxyf7ELOsith63WwqUuTzYYzEreW1DEyqn6o2KoLBkzYDLECvMznQZiG9enOc7hhu7kFdai1Cg4eFVK00ZV9S7qmV';
        }
    } catch (e) {
        console.warn('Config fetch failed — running in demo mode');
    }
}

async function fetchProducts() {
    try {
        const res = await fetch(`${API_BASE}/products`);
        if (!res.ok) throw new Error('Bad response');
        products = await res.json();
        document.getElementById('shop-loading').style.display = 'none';
        document.getElementById('products-grid').style.display = 'grid';
        renderShop();
    } catch (error) {
        document.getElementById('shop-loading').textContent = 'Could not load products. Please check your backend connection.';
        console.error('Products fetch failed:', error);
    }
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
        const [ordRes, ingRes, prodRes] = await Promise.all([
            fetch(`${API_BASE}/admin/orders`,      { headers }),
            fetch(`${API_BASE}/admin/ingredients`, { headers }),
            fetch(`${API_BASE}/admin/products`,    { headers })
        ]);
        if (ordRes.ok)  orders      = await ordRes.json();
        if (ingRes.ok)  ingredients = await ingRes.json();
        if (prodRes.ok) products    = await prodRes.json();
        renderAdmin();
    } catch (error) {
        console.error('Admin data sync failed:', error);
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

    loadAdminData();
}

// ─── RENDER SHOP ──────────────────────────────────────────────────────────────
function renderShop() {
    const grid = document.getElementById('products-grid');
    if (!products.length) {
        grid.innerHTML = '<p style="color:var(--text-muted); font-weight:700;">No products available.</p>';
        return;
    }
    grid.innerHTML = products.map(p => `
        <div class="product-card" onclick="openProductModal(${p.id})">
          <div class="product-img" style="background-color:${p.bg_color || '#FFFBE8'};${p.image_url ? `background-image:url('${p.image_url}');background-size:cover;background-position:center;` : ''}">
            ${p.image_url ? '' : `<span style="font-size:3.5rem;">${p.emoji || '🍪'}</span>`}
            ${p.badge ? `<span class="product-badge">${p.badge}</span>` : ''}
          </div>
          <div class="product-info">
            <div class="product-name">${p.name}</div>
            <div class="product-desc">${p.description || ''}</div>
            <div class="product-meta">
              <span class="product-price">£${Number(p.price).toFixed(2)}</span>
              <button class="add-btn" id="add-btn-${p.id}" onclick="event.stopPropagation(); addToCart(${p.id})">Add +</button>
            </div>
          </div>
        </div>`
    ).join('');
}

// ─── PRODUCT DETAIL MODAL ─────────────────────────────────────────────────────
function openProductModal(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;

    document.getElementById('pm-name').textContent  = p.name;
    document.getElementById('pm-price').textContent = '£' + Number(p.price).toFixed(2);
    document.getElementById('pm-desc').textContent  = p.description || '';
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

    document.getElementById('pm-add-btn').onclick = () => { addToCart(id); closeProductModal(); };
    document.getElementById('product-modal').classList.add('open');
}

function closeProductModal() {
    document.getElementById('product-modal').classList.remove('open');
}

function closeProductModalOnOverlay(e) {
    if (e.target.id === 'product-modal') closeProductModal();
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
            ${o.pickup ? '<span style="font-size:0.7rem; margin-left:4px;">🏠</span>' : ''}
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
    const el = document.getElementById('shipping-cards');
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
    if (!products.length) {
        grid.innerHTML = '<p style="color:var(--text-muted); font-size:0.9rem; font-weight:600; grid-column:1/-1;">No products yet. Add one above.</p>';
        return;
    }
    grid.innerHTML = products.map(p => `
        <div class="product-mgmt-card">
          <div class="pmc-emoji" style="background:${p.bg_color || '#FFFBE8'};">${p.emoji || '🍪'}</div>
          <div style="flex:1;">
            <div class="pmc-name">${p.name}</div>
            <div class="pmc-stock">${p.description ? p.description.substring(0, 40) + '…' : 'No description'}</div>
          </div>
          <div class="pmc-price">£${Number(p.price).toFixed(2)}</div>
          <button class="action-btn" onclick="editProduct(${p.id})" title="Edit">✏️</button>
          <button class="action-btn danger" onclick="deleteProduct(${p.id})" title="Delete">🗑</button>
        </div>`
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
    const total = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const count = cart.reduce((s, x) => s + x.qty, 0);
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
        document.getElementById('cart-total-amount').textContent = '£' + total.toFixed(2);
        footerEl.style.display = 'block';
    }
}

function toggleCart() { document.getElementById('cart-overlay').classList.toggle('open'); }
function closeCartOnOverlay(e) { if (e.target.id === 'cart-overlay') toggleCart(); }

// ─── CHECKOUT ─────────────────────────────────────────────────────────────────
function openCheckout() {
    if (cart.length === 0) return;
    const subtotal = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const isPickup = document.getElementById('pickup-check')?.checked || false;
    const shipping = isPickup ? 0 : 3.50;
    const total    = subtotal + shipping;

    document.getElementById('checkout-summary').innerHTML =
        cart.map(i => `<div class="os-item"><span>${i.emoji || ''} ${i.name} ×${i.qty}</span><span>£${(parseFloat(i.price) * i.qty).toFixed(2)}</span></div>`).join('') +
        (shipping > 0
            ? `<div class="os-item"><span>Shipping</span><span>£${shipping.toFixed(2)}</span></div>`
            : `<div class="os-item" style="color:var(--green-mid);"><span>🏠 Home Pickup</span><span>£0.00</span></div>`) +
        `<div class="os-item total"><span>Total</span><span>£${total.toFixed(2)}</span></div>`;

    document.getElementById('pay-amount').textContent = '£' + total.toFixed(2);
    document.getElementById('card-errors').textContent = '';
    document.getElementById('checkout-content').style.display = 'block';
    document.getElementById('success-content').style.display  = 'none';

    if (STRIPE_PUBLISHABLE_KEY) {
        document.getElementById('stripe-alert').style.display        = 'none';
        document.getElementById('stripe-card-section').style.display = 'block';
        if (!stripeInstance) {
            stripeInstance = Stripe(STRIPE_PUBLISHABLE_KEY);
            const elements = stripeInstance.elements();
            cardElement = elements.create('card', {
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

function togglePickup() {
    const subtotal = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const isPickup = document.getElementById('pickup-check').checked;
    const shipping = isPickup ? 0 : 3.50;
    const total    = subtotal + shipping;

    document.getElementById('checkout-summary').innerHTML =
        cart.map(i => `<div class="os-item"><span>${i.emoji || ''} ${i.name} ×${i.qty}</span><span>£${(parseFloat(i.price) * i.qty).toFixed(2)}</span></div>`).join('') +
        (shipping > 0
            ? `<div class="os-item"><span>Shipping</span><span>£${shipping.toFixed(2)}</span></div>`
            : `<div class="os-item" style="color:var(--green-mid);"><span>🏠 Home Pickup</span><span>£0.00</span></div>`) +
        `<div class="os-item total"><span>Total</span><span>£${total.toFixed(2)}</span></div>`;

    document.getElementById('pay-amount').textContent = '£' + total.toFixed(2);
}

function closeCheckout() {
    document.getElementById('checkout-modal').classList.remove('open');
}

// ─── PROCESS PAYMENT ──────────────────────────────────────────────────────────
async function processPayment() {
    const fields = [
        ['ch-fname', 'First name'], ['ch-lname', 'Last name'],
        ['ch-email', 'Email'], ['ch-address', 'Address'],
        ['ch-city', 'City'], ['ch-postcode', 'Postcode']
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

    // Collect all customer details in one place — used for Stripe, order record, and email
    const customer = {
        fname:    document.getElementById('ch-fname').value.trim(),
        lname:    document.getElementById('ch-lname').value.trim(),
        name:     `${document.getElementById('ch-fname').value.trim()} ${document.getElementById('ch-lname').value.trim()}`,
        email:    document.getElementById('ch-email').value.trim(),
        address:  document.getElementById('ch-address').value.trim(),
        city:     document.getElementById('ch-city').value.trim(),
        postcode: document.getElementById('ch-postcode').value.trim(),
        phone:    document.getElementById('ch-phone')?.value.trim() || ''
    };
    const fullAddress = `${customer.address}, ${customer.city}, ${customer.postcode}`;

    const subtotal = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const isPickup = document.getElementById('pickup-check')?.checked || false;
    const shipping = isPickup ? 0 : 3.50;
    const total    = (subtotal + shipping).toFixed(2);
    const oid      = 'HG-' + Date.now().toString().slice(-6);

    try {
        let paymentIntentId = null;

        if (STRIPE_PUBLISHABLE_KEY && stripeInstance && cardElement) {
            // Send full customer info to backend so it attaches to the Stripe payment
            const res = await fetch(`${API_BASE}/create-payment-intent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount:        Math.round(parseFloat(total) * 100),
                    currency:      'gbp',
                    receipt_email: customer.email,      // Stripe sends its own receipt
                    metadata: {                         // visible in Stripe Dashboard
                        order_id:      oid,
                        customer_name: customer.name,
                        email:         customer.email,
                        address:       fullAddress,
                        items:         cart.map(i => `${i.name} x${i.qty}`).join(', ')
                    }
                })
            });
            const { clientSecret } = await res.json();

            // Pass billing_details so name/email/address appear on the charge in Stripe
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
            // Demo mode — no Stripe key configured
            await new Promise(r => setTimeout(r, 700));
        }

        // Build and save the order record
        const orderPayload = {
            id:              oid,
            fname:           customer.fname,
            lname:           customer.lname,
            email:           customer.email,
            address:         fullAddress,
            items:           cart.map(i => `${i.name} ×${i.qty}`).join(', '),
            total:           total,
            status:          'pending',
            date:            new Date().toLocaleDateString('en-GB'),
            timestamp:       Date.now(),
            paymentIntentId: paymentIntentId,
            pickup:          isPickup
        };

        try {
            await fetch(`${API_BASE}/orders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderPayload)
            });
        } catch (saveErr) {
            console.warn('Could not save order to backend:', saveErr);
        }

        // Send confirmation email to customer
        await sendConfirmationEmail(orderPayload, customer);

        // Show success
        document.getElementById('success-order-num').textContent = 'Order Reference: ' + oid;
        document.getElementById('checkout-content').style.display = 'none';
        document.getElementById('success-content').style.display  = 'block';
        cart = [];
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
//
//  Free tier: 200 emails/month, no backend needed — purely client-side.
//
//  SETUP (5 minutes):
//    1. Sign up at https://emailjs.com
//    2. Add a Service → connect your Gmail or business inbox
//    3. Create an Email Template using these variables:
//         {{to_name}}          Customer's full name
//         {{to_email}}         Customer's email  ← set as "To Email" in the template
//         {{order_id}}         e.g. HG-123456
//         {{order_date}}       e.g. 04/05/2026
//         {{items_list}}       e.g. Honey Oat Clusters ×2, Crackers ×1
//         {{order_total}}      e.g. £12.50
//         {{delivery_address}} Full delivery address (or "Home Pickup")
//         {{shop_name}}        Home Grown
//         {{reply_to}}         Your business email
//    4. Replace the three IDs below with your real values from the EmailJS dashboard
//
const EMAILJS_SERVICE_ID  = 'YOUR_SERVICE_ID';   // e.g. 'service_abc123'
const EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID';  // e.g. 'template_xyz789'
const EMAILJS_PUBLIC_KEY  = 'YOUR_PUBLIC_KEY';   // e.g. 'aBcDeFgHiJkLmNoP'

function emailJsReady() {
    return typeof emailjs !== 'undefined' &&
           !EMAILJS_SERVICE_ID.startsWith('YOUR_') &&
           !EMAILJS_TEMPLATE_ID.startsWith('YOUR_') &&
           !EMAILJS_PUBLIC_KEY.startsWith('YOUR_');
}

async function sendConfirmationEmail(order, customer) {
    if (!emailJsReady()) {
        console.info('EmailJS not configured — skipping confirmation email. See the SETUP notes in app.js.');
        return;
    }

    const itemLines = cart.length
        ? cart.map(i => `• ${i.name} × ${i.qty}   —   £${(parseFloat(i.price) * i.qty).toFixed(2)}`).join('\n')
        : order.items;

    const templateParams = {
        to_name:          customer.name,
        to_email:         customer.email,
        order_id:         order.id,
        order_date:       order.date,
        items_list:       itemLines,
        order_total:      `£${parseFloat(order.total).toFixed(2)}`,
        delivery_address: order.pickup ? '🏠 Home Pickup — no delivery needed' : order.address,
        shop_name:        'Home Grown',
        reply_to:         'hello@homegrown.co.uk'  // ← change to your business email
    };

    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams, EMAILJS_PUBLIC_KEY);
        console.info('✓ Confirmation email sent to', customer.email);
    } catch (err) {
        // Don't block the success screen if the email fails
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
    document.getElementById('product-form-title').textContent = 'Add New Snack';
}

function editProduct(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    document.getElementById('prod-id').value    = p.id;
    document.getElementById('prod-name').value  = p.name || '';
    document.getElementById('prod-price').value = p.price || '';
    document.getElementById('prod-emoji').value = p.emoji || '';
    document.getElementById('prod-badge').value = p.badge || '';
    document.getElementById('prod-image').value = p.image_url || '';
    document.getElementById('prod-desc').value  = p.description || '';
    document.getElementById('prod-bg').value    = p.bg_color || '#FFFBE8';
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
        bg_color:    document.getElementById('prod-bg').value
    };

    try {
        const url    = id ? `${API_BASE}/admin/products/${id}` : `${API_BASE}/admin/products`;
        const method = id ? 'PUT' : 'POST';
        await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body: JSON.stringify(payload)
        });
        showToast(id ? '✓ Product updated!' : '✓ Product added!');
        resetProductForm();
        await loadAdminData();
    } catch (err) {
        showToast('Save failed — check your connection');
    }
}

async function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    try {
        await fetch(`${API_BASE}/admin/products/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        showToast('Product deleted');
        await loadAdminData();
    } catch (err) {
        showToast('Delete failed');
    }
}

async function updateOrderStatus(id, status) {
    try {
        await fetch(`${API_BASE}/admin/orders/${id}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ status })
        });
        showToast(`Order ${id} → ${status}`);
        await loadAdminData();
    } catch (err) {
        showToast('Update failed');
    }
}

async function cancelOrder(id) {
    if (!confirm(`Cancel order ${id}?`)) return;
    await updateOrderStatus(id, 'cancelled');
}

// ─── ORDER FILTERING ──────────────────────────────────────────────────────────
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

// ─── INGREDIENT ACTIONS ───────────────────────────────────────────────────────
async function addIngredient() {
    const name  = document.getElementById('ing-name').value.trim();
    const unit  = document.getElementById('ing-unit').value.trim();
    const stock = parseFloat(document.getElementById('ing-stock').value) || 0;
    const min   = parseFloat(document.getElementById('ing-min').value)   || 0;
    const max   = parseFloat(document.getElementById('ing-max').value)   || 10;

    if (!name || !unit) { showToast('Please enter ingredient name and unit'); return; }

    try {
        await fetch(`${API_BASE}/admin/ingredients`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ name, unit, stock, min_stock: min, max_stock: max })
        });
        showToast('✓ ' + name + ' added');
        ['ing-name','ing-unit','ing-stock','ing-min','ing-max'].forEach(id => document.getElementById(id).value = '');
        await loadAdminData();
    } catch (err) {
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
        await fetch(`${API_BASE}/admin/ingredients/${ing.id}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body:    JSON.stringify({ stock: newStock })
        });
        showToast(`✓ Restocked ${ing.name}`);
        await loadAdminData();
    } catch (err) {
        showToast('Restock failed');
    }
}

async function deleteIngredient(index) {
    const ing = ingredients[index];
    if (!ing || !confirm(`Remove ${ing.name}?`)) return;
    try {
        await fetch(`${API_BASE}/admin/ingredients/${ing.id}`, {
            method:  'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        showToast(`${ing.name} removed`);
        await loadAdminData();
    } catch (err) {
        showToast('Delete failed');
    }
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
initApp();
