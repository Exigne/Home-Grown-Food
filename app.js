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
let shopFilter       = 'all';
var productMode      = {}; // { [productId]: 'once' | 'sub' }
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
    startCountdown(); // live cut-off timer

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
    if (s === 'crm') loadCRM();
    else if (s === 'campaigns') loadCampaigns();
    else loadAdminData();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatDesc(text) {
    if (!text) return '';
    if (/<[a-z][\s\S]*>/i.test(text)) return text;
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ─── RENDER SHOP ──────────────────────────────────────────────────────────────
// ─── SHOP FILTER CHIPS ───────────────────────────────────────────────────────
// Base chips always shown — shown only if matching products exist
var BASE_CHIPS = [
    { label: 'All',          key: 'all'        },
    { label: 'In Stock',     key: 'instock'    },
    { label: 'Best Sellers', key: 'Best Seller' },
    { label: 'Vegan',        key: 'Vegan'      },
    { label: 'Gluten-Free',  key: 'Gluten-Free'}
];
function renderShopChips() {
    var chipsEl = document.getElementById('shop-filter-chips');
    if (!chipsEl) return;
    // Collect any badge values not already covered by BASE_CHIPS
    var baseKeys   = BASE_CHIPS.map(function(c) { return c.key; });
    var extraChips = [];
    products.forEach(function(p) {
        if (p.badge && baseKeys.indexOf(p.badge) === -1 &&
            !extraChips.some(function(c) { return c.key === p.badge; })) {
            extraChips.push({ label: p.badge, key: p.badge });
        }
    });
    // Only show chips that have at least one matching product
    var visible = BASE_CHIPS.concat(extraChips).filter(function(chip) {
        if (chip.key === 'all')     return true;
        if (chip.key === 'instock') return products.some(function(p) {
            return p.stock === null || p.stock === undefined || p.stock > 0;
        });
        return products.some(function(p) { return (p.badge || '') === chip.key; });
    });
    chipsEl.innerHTML = visible.map(function(chip) {
        var active = shopFilter === chip.key ? ' shop-chip-active' : '';
        return '<button class="shop-chip' + active + '" onclick="setShopFilter(this.dataset.key)" data-key="'
            + chip.key.replace(/"/g, '&quot;') + '">' + chip.label + '</button>';
    }).join('');
}


function setShopFilter(filter) {
    shopFilter = filter;
    renderShopChips();
    renderShop();
}

function renderShop() {
    const grid = document.getElementById('products-grid');
    if (!products.length) {
        grid.innerHTML = '<p style="color:var(--text-muted); font-weight:700;">No products available.</p>';
        renderShopChips();
        return;
    }

    renderShopChips();

    const sorted = [...products].sort((a, b) => {
        const aOut = a.stock !== undefined && a.stock !== null && a.stock <= 0;
        const bOut = b.stock !== undefined && b.stock !== null && b.stock <= 0;
        if (aOut && !bOut) return 1;
        if (!aOut && bOut) return -1;
        return 0;
    });
    // Apply chip filter
    var filtered = shopFilter === 'all' ? sorted
        : shopFilter === 'instock' ? sorted.filter(function(p) {
            return p.stock === null || p.stock === undefined || p.stock > 0;
          })
        : sorted.filter(function(p) {
            return (p.badge || '') === shopFilter;
          });

    if (!filtered.length) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-muted);">'
            + '<div style="font-size:2.5rem;margin-bottom:1rem;">&#x1F50D;</div>'
            + '<p style="font-weight:700;font-size:1rem;">No products match &ldquo;' + (shopFilter === 'all' ? 'All' : shopFilter) + '&rdquo;</p>'
            + '</div>';
        return;
    }

    grid.innerHTML = filtered.map(p => {
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
          ${outOfStock
            ? `<div class="product-footer">
                 <span class="product-price">£${Number(p.price).toFixed(2)}</span>
                 <button class="notify-btn" onclick="event.stopPropagation(); openWishlistModal(${p.id})">🔔 Notify Me</button>
               </div>`
            : p.subscription_enabled
              ? `<div class="product-footer product-footer-toggle">
                   <div class="mode-toggle" onclick="event.stopPropagation()">
                     <button class="mode-btn mode-active" id="mode-once-${p.id}"
                             onclick="setProductMode(${p.id},'once')">
                       <span class="mode-label">One-time</span>
                       <span class="mode-price">£${Number(p.price).toFixed(2)}</span>
                     </button>
                     <button class="mode-btn" id="mode-sub-${p.id}"
                             onclick="setProductMode(${p.id},'sub')">
                       <span class="mode-label">📦 Monthly + Delivery</span>
                       <span class="mode-price">£${(Number(p.price)+3.99).toFixed(2)}/mo</span>
                     </button>
                   </div>
                   <button class="add-btn" id="add-btn-${p.id}"
                           onclick="event.stopPropagation(); addToCart(${p.id})">+ Add</button>
                 </div>`
              : `<div class="product-footer">
                   <span class="product-price">£${Number(p.price).toFixed(2)}</span>
                   <button class="add-btn" id="add-btn-${p.id}"
                           onclick="event.stopPropagation(); addToCart(${p.id})">+ Add to Basket</button>
                 </div>`
          }
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
        var stripePriceEl = document.getElementById('pem-stripe-recurring');
        if (stripePriceEl) stripePriceEl.value = p.stripe_recurring_price_id || '';
        var subEnabledEl = document.getElementById('pem-subscription-enabled');
        if (subEnabledEl) subEnabledEl.checked = !!p.subscription_enabled;
        updateImagePreview(p.image_url || '');
    } else {
        ['pem-id','pem-name','pem-price','pem-emoji','pem-badge','pem-image','pem-stock'].forEach(id => document.getElementById(id).value = '');
        var subEl2 = document.getElementById('pem-subscription-enabled'); if (subEl2) subEl2.checked = false;
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
    const stripeEl = document.getElementById('pem-stripe-recurring');
    const payload = {
        name, price: parseFloat(document.getElementById('pem-price').value) || 0,
        emoji: document.getElementById('pem-emoji').value,
        badge: document.getElementById('pem-badge').value,
        image_url: document.getElementById('pem-image').value,
        description: document.getElementById('pem-desc').innerHTML.trim(),
        bg_color: document.getElementById('pem-bg').value,
        stock: parseInt(document.getElementById('pem-stock').value) || 0,
        stripe_recurring_price_id: stripeEl ? stripeEl.value.trim() : '',
        subscription_enabled: (function(){ var el = document.getElementById('pem-subscription-enabled'); return el ? el.checked : false; })()
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
// (renderAdminChats moved to CRM section below)

// ─── BASKET ───────────────────────────────────────────────────────────────────
function addToCart(id) {
    const p    = products.find(x => x.id === id);
    if (!p) return;
    const mode = productMode[id] || 'once';
    // Monthly subscription: product price + £3.99 mandatory delivery
    const displayPrice = mode === 'sub' ? Number(p.price) + 3.99 : Number(p.price);
    // Find existing item with same id — update mode & price if changed
    const ex = cart.find(x => x.id === id);
    if (ex) {
        ex.qty++;
        ex.mode         = mode;
        ex.displayPrice = displayPrice;
    } else {
        cart.push({ ...p, qty: 1, mode, displayPrice });
    }
    updateCartUI();
    const btn = document.getElementById('add-btn-' + id);
    const label = mode === 'sub' ? '✓ Subscribed' : '✓ Added';
    if (btn) { btn.textContent = label; btn.classList.add('added'); setTimeout(() => { btn.textContent = '+ Add'; btn.classList.remove('added'); }, 1500); }
    showToast((mode === 'sub' ? '📦 ' : (p.emoji || '🍪') + ' ') + p.name + (mode === 'sub' ? ' — weekly subscription!' : ' added!'));
}

function setProductMode(id, mode) {
    productMode[id] = mode;
    var onceBtn = document.getElementById('mode-once-' + id);
    var subBtn  = document.getElementById('mode-sub-' + id);
    if (onceBtn) onceBtn.classList.toggle('mode-active', mode === 'once');
    if (subBtn)  subBtn.classList.toggle('mode-active', mode === 'sub');
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
        itemsEl.innerHTML = cart.map(item => {
            const isSub     = item.mode === 'sub';
            const unitPrice = item.displayPrice !== undefined ? item.displayPrice : parseFloat(item.price);
            const lineTotal = (unitPrice * item.qty).toFixed(2);
            const priceLabel = isSub
                ? `£${unitPrice.toFixed(2)}/mo <span style="background:#E8F5E9;color:var(--green-dark);border-radius:999px;padding:1px 7px;font-size:0.7rem;font-weight:800;margin-left:4px;">📦 Monthly inc. £3.99 delivery</span>`
                : `£${unitPrice.toFixed(2)} each`;
            return `<div class="cart-item">
              <div class="cart-item-emoji">${item.emoji || '🍪'}</div>
              <div class="cart-item-info">
                <div class="cart-item-name">${item.name}</div>
                <div class="cart-item-price">${priceLabel}</div>
                <div class="cart-item-qty">
                  <button class="qty-btn" onclick="changeQty(${item.id},-1)">−</button>
                  <span class="qty-num">${item.qty}</span>
                  <button class="qty-btn" onclick="changeQty(${item.id},1)">+</button>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
                <span style="font-weight:800;font-size:0.95rem;color:var(--green-dark);">£${lineTotal}${isSub ? '/mo' : ''}</span>
                <button class="remove-item" onclick="removeFromCart(${item.id})" title="Remove">🗑</button>
              </div>
            </div>`;
        }).join('');
        // Use displayPrice for subtotal
        const displaySubtotal = cart.reduce((s, x) => {
            const up = x.displayPrice !== undefined ? x.displayPrice : parseFloat(x.price);
            return s + up * x.qty;
        }, 0);
        document.getElementById('cart-total-amount').textContent = '£' + displaySubtotal.toFixed(2);
        footerEl.style.display = 'block';
    }
}

function toggleCart() { document.getElementById('cart-overlay').classList.toggle('open'); }
function closeCartOnOverlay(e) { if (e.target.id === 'cart-overlay') toggleCart(); }

// ─── CHECKOUT ─────────────────────────────────────────────────────────────────
function hasDeliveryAddress() {
    const city     = (document.getElementById('ch-city')?.value || '').trim();
    const postcode = (document.getElementById('ch-postcode')?.value || '').trim();
    return city.length > 0 && postcode.length > 0;
}

function updateCheckoutTotals() {
    const subtotal = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
    const isPickup = document.getElementById('pickup-check')?.checked || false;
    const postcode = (document.getElementById('ch-postcode')?.value || '').trim().toUpperCase();
    const city     = (document.getElementById('ch-city')?.value || '').trim().toLowerCase();
    const btn      = document.getElementById('pay-btn');
    const msgEl    = document.getElementById('delivery-message');
    const errEl    = document.getElementById('card-errors');
    let shipping = 0, shippingLabel = '🏠 Collection';

    // One-time orders are collection only. Delivery is a subscription-only perk.
    btn.disabled = false;
    if (errEl) errEl.textContent = '';
    msgEl.style.color = 'var(--green-mid)';
    msgEl.textContent = "✓ We'll have your order ready for collection.";
    const msg = getFulfilmentMessage(true);
    const infoEl = document.getElementById('checkout-fulfilment-info');
    if (infoEl) { infoEl.style.display='block'; infoEl.style.background=msg.bg; infoEl.style.borderColor=msg.border; infoEl.style.color=msg.color; infoEl.innerHTML=msg.html; }

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
    const shipping    = 0; // collection only for one-time orders
    const total       = Math.max(0, subtotal - discount + shipping).toFixed(2);

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
            promoCode: appliedPromo ? appliedPromo.code : null,
            marketingConsent: getMarketingConsent()
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


// ═══════════════════════════════════════════════
//  CAMPAIGNS
// ═══════════════════════════════════════════════
var campaigns       = [];
var quillEditor     = null;
var availableTags   = [];

// ─── LOAD & RENDER LIST ──
async function loadCampaigns() {
    if (!adminToken) return;
    try {
        var res = await fetch(API_BASE + '/admin/campaigns', {
            headers: { 'Authorization': 'Bearer ' + adminToken }
        });
        if (res.ok) { campaigns = await res.json(); renderCampaigns(); }
    } catch (err) { console.error('Campaigns load failed:', err); }
}

function renderCampaigns() {
    var tbody = document.getElementById('campaigns-body');
    if (!tbody) return;
    if (!campaigns.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2.5rem;">No campaigns yet. Click "New Campaign" to create your first.</td></tr>';
        return;
    }
    tbody.innerHTML = campaigns.map(function(c) {
        var openRate  = c.sent_count > 0 ? Math.round((c.open_count / c.sent_count) * 100) : 0;
        var clickRate = c.sent_count > 0 ? Math.round((c.click_count / c.sent_count) * 100) : 0;
        var statusBadge = {
            draft:     '<span class="badge" style="background:#eee;color:#666;">Draft</span>',
            scheduled: '<span class="badge" style="background:#FFF3CD;color:#856404;">🗓 Scheduled</span>',
            sending:   '<span class="badge" style="background:#CCE5FF;color:#004085;">Sending…</span>',
            sent:      '<span class="badge badge-delivered">✓ Sent</span>'
        }[c.status] || c.status;

        var seg = c.segment || {};
        var segLabel = seg.type === 'tag' ? ('Tag: ' + (seg.tag||'')) :
                       seg.type === 'recent' ? 'Recent buyers' :
                       seg.type === 'never'  ? 'Never ordered' :
                       seg.type === 'vip'    ? 'VIPs' : 'All subscribers';

        return '<tr>' +
            '<td><strong>' + (c.name || 'Untitled') + '</strong><br><small style="color:var(--text-muted);">' + (c.subject || '') + '</small></td>' +
            '<td>' + statusBadge + '</td>' +
            '<td style="font-size:0.85rem;">' + segLabel + '</td>' +
            '<td>' + (c.sent_count || 0) + '</td>' +
            '<td>' + (c.status === 'sent' ? openRate + '%' : '—') + '</td>' +
            '<td>' + (c.status === 'sent' ? clickRate + '%' : '—') + '</td>' +
            '<td>' +
                (c.status === 'sent'
                    ? '<button class="action-btn" onclick="viewCampaignStats(' + c.id + ')">📊 Stats</button>'
                    : '<button class="action-btn primary" onclick="editCampaign(' + c.id + ')">Edit</button>') +
                ' <button class="action-btn danger" onclick="deleteCampaign(' + c.id + ')">Delete</button>' +
            '</td>' +
            '</tr>';
    }).join('');
}

// ─── BUILDER ──
async function openCampaignBuilder() {
    document.getElementById('campaign-modal-title').textContent = 'New Campaign';
    document.getElementById('campaign-id').value       = '';
    document.getElementById('campaign-name').value     = '';
    document.getElementById('campaign-subject').value  = '';
    document.getElementById('campaign-segment-type').value = 'all';
    document.getElementById('campaign-schedule').value = '';
    document.getElementById('campaign-status-msg').textContent = '';
    document.getElementById('segment-tag-wrap').style.display = 'none';

    document.getElementById('campaign-modal').classList.add('open');

    // Init Quill once, after modal is visible
    setTimeout(function() {
        if (!quillEditor) {
            quillEditor = new Quill('#campaign-editor', {
                theme: 'snow',
                modules: {
                    toolbar: [
                        [{ header: [1, 2, 3, false] }],
                        ['bold', 'italic', 'underline'],
                        [{ list: 'ordered' }, { list: 'bullet' }],
                        ['link', 'image'],
                        ['clean']
                    ]
                }
            });
            quillEditor.on('text-change', updateCampaignPreview);
        }
        quillEditor.setContents([]); // clear
        updateCampaignPreview();
    }, 100);

    await loadTagsForSegment();
    updateSegmentCount();
}

function closeCampaignBuilder() {
    document.getElementById('campaign-modal').classList.remove('open');
}

async function loadTagsForSegment() {
    try {
        var res = await fetch(API_BASE + '/admin/tags', { headers: { 'Authorization': 'Bearer ' + adminToken } });
        if (res.ok) {
            availableTags = await res.json();
            var sel = document.getElementById('campaign-segment-tag');
            sel.innerHTML = availableTags.length
                ? availableTags.map(function(t){ return '<option value="'+t+'">'+t+'</option>'; }).join('')
                : '<option value="">No tags yet — add tags in CRM</option>';
        }
    } catch(e) {}
}

function onSegmentTypeChange() {
    var type = document.getElementById('campaign-segment-type').value;
    document.getElementById('segment-tag-wrap').style.display = type === 'tag' ? 'block' : 'none';
    updateSegmentCount();
}

function buildSegmentObject() {
    var type = document.getElementById('campaign-segment-type').value;
    var seg = { type: type };
    if (type === 'tag')    seg.tag = document.getElementById('campaign-segment-tag').value;
    if (type === 'recent') seg.orderedWithinDays = 30;
    if (type === 'never')  seg.neverOrdered = true;
    if (type === 'vip')    seg.ltvMin = 50;
    return seg;
}

async function updateSegmentCount() {
    var countEl = document.getElementById('segment-count');
    if (countEl) countEl.textContent = '…';
    try {
        var res = await fetch(API_BASE + '/admin/segment/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
            body: JSON.stringify({ segment: buildSegmentObject() })
        });
        var data = await res.json();
        if (countEl) countEl.textContent = data.count != null ? data.count : '—';
    } catch(e) { if (countEl) countEl.textContent = '—'; }
}

function getCampaignStyle() {
    var g = function(id, def) { var el = document.getElementById(id); return el ? el.value : def; };
    return {
        headerColor: g('campaign-header-color', '#164A2E'),
        headerText:  g('campaign-header-text', '#FFD93D'),
        bodyBg:      g('campaign-body-bg', '#FFFBE8'),
        btnColor:    g('campaign-btn-color', '#164A2E'),
        font:        g('campaign-font', 'Arial, sans-serif'),
        headerStyle: g('campaign-header-style', 'brand'),
        headingText: g('campaign-heading-text', '')
    };
}

// Build the full styled campaign email HTML (used for preview and sending)
function buildCampaignHTML(bodyHtml, style) {
    style = style || getCampaignStyle();
    var header = '';
    if (style.headerStyle === 'brand') {
        header = '<div style="background:' + style.headerColor + ';padding:22px;text-align:center;">' +
                 '<div style="color:' + style.headerText + ';font-size:1.6rem;font-weight:bold;letter-spacing:0.03em;">Home Grown</div>' +
                 '<div style="color:' + style.headerText + ';opacity:0.75;font-size:0.7rem;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px;">Food That Makes You Feel Good</div>' +
                 '</div>';
    } else if (style.headerStyle === 'text' && style.headingText) {
        header = '<div style="background:' + style.headerColor + ';padding:22px;text-align:center;">' +
                 '<div style="color:' + style.headerText + ';font-size:1.4rem;font-weight:bold;">' + style.headingText.replace(/</g,'&lt;') + '</div></div>';
    }
    return '<div style="font-family:' + style.font + ';max-width:600px;margin:0 auto;border:2px solid ' + style.headerColor + ';border-radius:14px;overflow:hidden;">' +
        header +
        '<div style="padding:28px;background:' + style.bodyBg + ';color:#0E3019;line-height:1.7;">' + bodyHtml + '</div>' +
        '<div style="background:' + style.headerColor + ';padding:12px;text-align:center;">' +
        '<div style="color:' + style.headerText + ';opacity:0.7;font-size:0.7rem;">Home Grown · Handmade in Sheffield · homegrownfoods.online</div>' +
        '</div></div>';
}

function updateCampaignPreview() {
    var previewEl = document.getElementById('campaign-preview-frame');
    if (!previewEl || !quillEditor) return;

    // Toggle custom heading input visibility
    var hStyle = document.getElementById('campaign-header-style');
    var hWrap  = document.getElementById('campaign-heading-wrap');
    if (hStyle && hWrap) hWrap.style.display = hStyle.value === 'text' ? 'block' : 'none';

    var bodyHtml = quillEditor.root.innerHTML.split('{{first_name}}').join('Jane');
    var subject  = (document.getElementById('campaign-subject').value || '').trim();
    var shell    = buildCampaignHTML(bodyHtml, getCampaignStyle());

    previewEl.innerHTML =
        (subject ? '<div style="background:#f5f5f5;padding:8px 14px;font-size:0.8rem;color:#555;border-bottom:1px solid #ddd;margin-bottom:8px;border-radius:4px;"><strong>Subject:</strong> ' + subject.replace(/</g,'&lt;') + '</div>' : '') +
        shell;
}

async function saveCampaign(action) {
    var statusEl = document.getElementById('campaign-status-msg');
    var name     = (document.getElementById('campaign-name').value || '').trim();
    var subject  = (document.getElementById('campaign-subject').value || '').trim();
    var bodyHtml = quillEditor ? quillEditor.root.innerHTML : '';
    var id       = document.getElementById('campaign-id').value;

    if (!name)    { statusEl.style.color='var(--danger)'; statusEl.textContent='Please enter a campaign name.'; return; }
    if (!subject) { statusEl.style.color='var(--danger)'; statusEl.textContent='Please enter a subject line.'; return; }

    // Wrap the raw editor content in the styled shell so the sent email is fully branded
    var styledHtml = buildCampaignHTML(bodyHtml, getCampaignStyle());
    var payload = {
        name: name, subject: subject, body_html: styledHtml,
        segment: buildSegmentObject(), status: 'draft'
    };

    if (action === 'schedule') {
        var when = document.getElementById('campaign-schedule').value;
        if (!when) { statusEl.style.color='var(--danger)'; statusEl.textContent='Please pick a schedule date/time.'; return; }
        payload.status = 'scheduled';
        payload.scheduled_at = new Date(when).toISOString();
    }

    statusEl.style.color = 'var(--text-muted)';
    statusEl.textContent = 'Saving…';

    try {
        var url    = id ? (API_BASE + '/admin/campaigns/' + id) : (API_BASE + '/admin/campaigns');
        var method = id ? 'PUT' : 'POST';
        var res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
            body: JSON.stringify(payload)
        });
        var saved = await res.json();
        if (!res.ok) throw new Error(saved.error || 'Save failed');

        if (action === 'send') {
            statusEl.textContent = 'Sending…';
            var sendRes = await fetch(API_BASE + '/admin/campaigns/' + saved.id + '/send', {
                method: 'POST', headers: { 'Authorization': 'Bearer ' + adminToken }
            });
            var sendData = await sendRes.json();
            if (!sendRes.ok) throw new Error(sendData.error || 'Send failed');
            statusEl.style.color = 'var(--success)';
            statusEl.textContent = '✓ Sent to ' + sendData.sent + ' recipients!';
            showToast('📣 Campaign sent to ' + sendData.sent + ' people');
        } else {
            statusEl.style.color = 'var(--success)';
            statusEl.textContent = action === 'schedule' ? '✓ Scheduled!' : '✓ Draft saved!';
            showToast(action === 'schedule' ? 'Campaign scheduled' : 'Draft saved');
        }
        await loadCampaigns();
        setTimeout(closeCampaignBuilder, 1200);
    } catch (err) {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = 'Failed: ' + err.message;
    }
}

async function editCampaign(id) {
    var c = campaigns.find(function(x){ return x.id === id; });
    if (!c) return;
    await openCampaignBuilder();
    document.getElementById('campaign-modal-title').textContent = 'Edit Campaign';
    document.getElementById('campaign-id').value      = c.id;
    document.getElementById('campaign-name').value    = c.name || '';
    document.getElementById('campaign-subject').value = c.subject || '';
    var seg = c.segment || {};
    document.getElementById('campaign-segment-type').value = seg.type || 'all';
    onSegmentTypeChange();
    if (seg.type === 'tag' && seg.tag) {
        document.getElementById('campaign-segment-tag').value = seg.tag;
    }
    setTimeout(function() {
        if (quillEditor) { quillEditor.root.innerHTML = c.body_html || ''; updateCampaignPreview(); }
    }, 200);
    updateSegmentCount();
}

async function deleteCampaign(id) {
    if (!confirm('Delete this campaign?')) return;
    try {
        await fetch(API_BASE + '/admin/campaigns/' + id, {
            method: 'DELETE', headers: { 'Authorization': 'Bearer ' + adminToken }
        });
        showToast('Campaign deleted');
        await loadCampaigns();
    } catch(e) { showToast('Delete failed'); }
}

function viewCampaignStats(id) {
    var c = campaigns.find(function(x){ return x.id === id; });
    if (!c) return;
    var openRate  = c.sent_count > 0 ? Math.round((c.open_count / c.sent_count) * 100) : 0;
    var clickRate = c.sent_count > 0 ? Math.round((c.click_count / c.sent_count) * 100) : 0;
    document.getElementById('stats-campaign-name').textContent = c.name || 'Campaign Stats';
    document.getElementById('stats-sent').textContent      = c.sent_count || 0;
    document.getElementById('stats-delivered').textContent = c.sent_count || 0;
    document.getElementById('stats-openrate').textContent  = openRate + '%';
    document.getElementById('stats-opens').textContent     = (c.open_count || 0) + ' opens';
    document.getElementById('stats-clickrate').textContent = clickRate + '%';
    document.getElementById('stats-clicks').textContent    = (c.click_count || 0) + ' clicks';
    document.getElementById('campaign-stats-modal').classList.add('open');
}

// Wire segment type + subject change to preview/count
document.addEventListener('DOMContentLoaded', function() {
    var st = document.getElementById('campaign-segment-type');
    var st2 = document.getElementById('campaign-segment-tag');
    var subj = document.getElementById('campaign-subject');
    if (st)  st.addEventListener('change', updateSegmentCount);
    if (st2) st2.addEventListener('change', updateSegmentCount);
    if (subj) subj.addEventListener('input', updateCampaignPreview);
});


// ─── BOOT ─────────────────────────────────────────────────────────────────────
initApp();

// ═══════════════════════════════════════════════
//  CRM & CUSTOMERS
// ═══════════════════════════════════════════════

// ─── EMAIL TEMPLATES (wrapper-based)
// Template = the branded shell. Admin types only the core message.
var EMAIL_TEMPLATES = {
    general: {
        label:       'General Message',
        subject:     'A message from Home Grown',
        intro:       'Hi [name],',
        outro:       'If you have any questions, just use the chat widget on our website.',
        cta:         'Visit Our Shop',
        placeholder: 'Write your message here...'
    },
    reply: {
        label:       'Reply to Query',
        subject:     'Re: Your message to Home Grown',
        intro:       'Hi [name], thanks so much for getting in touch!',
        outro:       'If you need anything else, drop us a message via the chat on our website.',
        cta:         'Visit Our Shop',
        placeholder: 'Type your reply here...'
    },
    promo: {
        label:       'Promo Offer',
        subject:     'A special offer just for you!',
        intro:       'Hi [name], we have an exciting offer just for you!',
        outro:       "This offer won't last long - head to the shop to redeem it!",
        cta:         'Shop Now & Redeem',
        placeholder: 'Describe your promo offer here... (include the code!)'
    },
    new_product: {
        label:       'New Product',
        subject:     'Something new just dropped at Home Grown!',
        intro:       'Hi [name], exciting news - something brand new has just launched!',
        outro:       'Be one of the first to try it - limited small batches available.',
        cta:         'Shop the New Drop',
        placeholder: 'Tell them about the new product... what makes it special?'
    }
};

// Build the full branded HTML email: template shell wraps the core message
function buildEmailHTML(templateKey, recipientName, coreMessage) {
    var t     = EMAIL_TEMPLATES[templateKey] || EMAIL_TEMPLATES.general;
    var name  = recipientName || 'there';
    var intro = t.intro.split('[name]').join(name);
    var isHtml   = /<[a-z][\s\S]*>/i.test(coreMessage);
    var bodyHtml = isHtml ? coreMessage
        : coreMessage.split('\n').map(function(l) {
            return l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          }).join('<br>');
    var contentWrapper;
    if (templateKey === 'promo') {
        contentWrapper = '<div style="background:#FFF9C4;border:2px solid #F0C820;border-radius:12px;padding:20px 24px;margin:20px 0;color:#0E3019;line-height:1.8;">'
            + '<div style="font-size:1rem;font-weight:bold;color:#5C4A00;margin-bottom:8px;">Special Offer</div>'
            + bodyHtml + '</div>';
    } else if (templateKey === 'new_product') {
        contentWrapper = '<div style="background:#164A2E;color:#FFD93D;border-radius:8px;padding:10px 16px;margin-bottom:16px;font-weight:bold;font-size:0.9rem;text-align:center;letter-spacing:0.08em;">Just Launched</div>'
            + '<div style="color:#0E3019;line-height:1.8;margin-bottom:20px;">' + bodyHtml + '</div>';
    } else {
        contentWrapper = '<div style="color:#0E3019;line-height:1.8;margin-bottom:20px;">' + bodyHtml + '</div>';
    }
    return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:3px solid #164A2E;border-radius:16px;overflow:hidden;">'
        + '<div style="background:#164A2E;padding:24px;text-align:center;">'
        + '<h1 style="color:#FFD93D;margin:0;font-size:2rem;letter-spacing:0.03em;">Home Grown</h1>'
        + '<p style="color:#6BBF4A;margin:6px 0 0;font-size:0.8rem;letter-spacing:0.12em;text-transform:uppercase;">Food That Makes You Feel Good</p>'
        + '</div>'
        + '<div style="padding:32px;background:#FFFBE8;">'
        + '<p style="color:#0E3019;font-size:1rem;margin-bottom:16px;">' + intro + '</p>'
        + contentWrapper
        + '<p style="color:#5A8A6A;font-size:0.9rem;">' + t.outro + '</p>'
        + '<p style="color:#999;font-size:0.8rem;margin-top:8px;">Please do not reply directly to this email.</p>'
        + '<div style="text-align:center;margin-top:28px;">'
        + '<a href="https://homegrownfoods.online" style="background:#164A2E;color:#FFD93D;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:0.95rem;">'
        + t.cta + ' &rarr;</a>'
        + '</div></div>'
        + '<div style="background:#164A2E;padding:14px;text-align:center;">'
        + '<p style="color:#A8D97F;margin:0;font-size:0.78rem;">Home Grown &middot; Handmade in Sheffield &middot; homegrownfoods.online</p>'
        + '</div></div>';
}

function applyMessageTemplate(context) {
    var selectId = context === 'crm' ? 'crm-template-select' : 'broadcast-template-select';
    var selectEl = document.getElementById(selectId);
    if (!selectEl || !selectEl.value) return;
    var key = selectEl.value;
    var t   = EMAIL_TEMPLATES[key];
    if (!t) return;

    // Store last used key for preview
    // Store selected template key in module-level variable (more reliable than dataset)
    if (context === 'broadcast') {
        window._broadcastTemplateKey = key;
        var sEl = document.getElementById('broadcast-subject');
        if (sEl) sEl.value = t.subject;  // always update subject when template changes
    }
    updateBroadcastPreview();  // show preview immediately on template select

    // Update placeholder and clear textarea so admin just types the core message
    var msgId = context === 'crm' ? 'crm-reply-input' : 'broadcast-message';
    var mEl   = document.getElementById(msgId);
    if (mEl) {
        mEl.setAttribute('data-placeholder', t.placeholder);
        if (mEl.tagName === 'TEXTAREA') { mEl.placeholder = t.placeholder; mEl.value = ''; }
        else mEl.innerHTML = '';
        mEl.focus();
    }

    if (context === 'broadcast') updateBroadcastPreview();
    if (context === 'crm') window._crmTemplateKey = key;
    selectEl.value = '';
}

// ─── BROADCAST LIVE PREVIEW ───────────────────────────────────────────────────
// ─── BROADCAST LIVE PREVIEW ───────────────────────────────────────────────────
function updateBroadcastPreview() {
    var previewEl = document.getElementById('broadcast-preview-frame');
    if (!previewEl) return;

    var tKey    = window._broadcastTemplateKey || 'general';
    var bMsgEl  = document.getElementById('broadcast-message');
    var message = bMsgEl ? (bMsgEl.tagName === 'TEXTAREA' ? bMsgEl.value : bMsgEl.innerHTML).trim() : '';
    var subject = (document.getElementById('broadcast-subject').value || '').trim();

    // Always show preview — placeholder styling when no message yet
    var previewMsg = message || '<span style="color:#bbb;font-style:italic;">(type your message on the left to see it here)</span>';
    var html = buildEmailHTML(tKey, '[Customer Name]', previewMsg);

    if (subject) {
        html = '<div style="background:#f5f5f5;padding:8px 14px;border-bottom:2px solid #ddd;font-size:0.82rem;color:#444;">'
             + '<strong>Subject:</strong> ' + subject.replace(/&/g,'&amp;').replace(/</g,'&lt;')
             + '</div>' + html;
    }
    previewEl.innerHTML = html;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function timeAgo(dateStr) {
    if (!dateStr) return '—';
    var d = new Date(dateStr);
    if (isNaN(d)) return '—';
    var days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days === 0)  return 'Today';
    if (days === 1)  return 'Yesterday';
    if (days < 7)    return days + ' days ago';
    if (days < 30)   return Math.floor(days / 7) + ' week' + (Math.floor(days / 7) > 1 ? 's' : '') + ' ago';
    if (days < 365)  return Math.floor(days / 30) + ' month' + (Math.floor(days / 30) > 1 ? 's' : '') + ' ago';
    return Math.floor(days / 365) + ' year' + (Math.floor(days / 365) > 1 ? 's' : '') + ' ago';
}

function memberSince(orders, messages) {
    var dates = [];
    if (orders   && orders.length)   dates.push(new Date(orders[orders.length - 1].created_at));
    if (messages && messages.length) dates.push(new Date(messages[0].created_at));
    if (!dates.length) return '—';
    var earliest = new Date(Math.min.apply(null, dates.map(function(d) { return d.getTime(); })));
    return earliest.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function parseOrderItems(orders) {
    var counts = {};
    orders.forEach(function(order) {
        (order.items || '').split(',').forEach(function(item) {
            var trimmed = item.trim();
            var xIdx    = trimmed.search(/[x×]\s*\d+/i);
            if (xIdx === -1) return;
            var name     = trimmed.substring(0, xIdx).trim();
            var qtyMatch = trimmed.match(/\d+$/);
            var qty      = qtyMatch ? parseInt(qtyMatch[0]) : 1;
            if (name) counts[name] = (counts[name] || 0) + qty;
        });
    });
    return counts;
}

// ─── LOAD & RENDER LIST ───────────────────────────────────────────────────────
async function loadCRM() {
    if (!adminToken) return;
    try {
        const res = await fetch(API_BASE + '/admin/crm', {
            headers: { 'Authorization': 'Bearer ' + adminToken }
        });
        if (res.ok) { crmCustomers = await res.json(); renderCRM(); }
    } catch (err) { console.error('CRM load failed:', err); }
}

function renderCRM() {
    const tbody   = document.getElementById('crm-tbody');
    const countEl = document.getElementById('crm-count');
    if (!tbody) return;

    if (!crmCustomers.length) {
        if (countEl) countEl.textContent = '0';
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:3rem;">No customers yet.</td></tr>';
        return;
    }

    // Split into customers (have orders) and non-customers (chat/wishlist only)
    var customers    = crmCustomers.filter(function(c) { return parseInt(c.order_count || 0) > 0; });
    var nonCustomers = crmCustomers.filter(function(c) { return parseInt(c.order_count || 0) === 0; });
    if (countEl) countEl.textContent = customers.length + (nonCustomers.length ? ' + ' + nonCustomers.length + ' non-customers' : '');

    function buildRow(c, idx) {
        var name         = c.display_name || c.name || (c.emails && c.emails[0]) || c.email || '?';
        var initial      = name[0].toUpperCase();
        var ltv          = parseFloat(c.ltv || 0);
        var emails       = c.emails || (c.email ? [c.email] : []);
        var emailDisplay = emails.length > 1
            ? emails[0] + ' <span style="color:var(--green-mid);font-weight:800;">+' + (emails.length - 1) + ' more</span>'
            : (emails[0] || '—');
        var msgCount  = parseInt(c.message_count || 0);
        var unread    = parseInt(c.unread_count  || 0);
        var msgBadge = unread > 0
            ? ' <span style="background:var(--danger);color:white;border-radius:999px;padding:2px 8px;font-size:0.68rem;font-weight:800;margin-left:4px;display:inline-block;">&#x1F4AC; ' + unread + ' new</span>'
            : '';
        return '<tr class="crm-row" onclick="openCRMCustomer(' + idx + ')">' +
            '<td><div class="crm-avatar">' + initial + '</div></td>' +
            '<td><div style="font-weight:800;color:var(--green-dark);">' + name + msgBadge + '</div>' +
            '<small style="color:var(--text-muted);">' + emailDisplay + '</small></td>' +
            '<td><strong>' + (c.order_count || 0) + '</strong></td>' +
            '<td><strong style="color:' + (ltv > 0 ? 'var(--success)' : 'var(--text-muted)') + ';">£' + ltv.toFixed(2) + '</strong></td>' +
            '<td style="color:var(--text-muted);font-size:0.85rem;">' + (c.last_contact || '—') + '</td>' +
            '</tr>';
    }

    var rows = customers.map(function(c, i) { return buildRow(c, crmCustomers.indexOf(c)); }).join('');

    // Non-customers section divider
    if (nonCustomers.length) {
        rows += '<tr><td colspan="5" style="padding:12px 16px;background:var(--yellow-pale);border-top:2px solid var(--border);">' +
            '<span style="font-size:0.72rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-muted);">Non-Customers — Chat & Wishlist Only</span>' +
            '<span style="margin-left:8px;font-size:0.72rem;color:var(--text-muted);font-weight:600;">(' + nonCustomers.length + ' contact' + (nonCustomers.length !== 1 ? 's' : '') + ' · moves to Customers when they place an order)</span>' +
            '</td></tr>';
        rows += nonCustomers.map(function(c, i) { return buildRow(c, crmCustomers.indexOf(c)); }).join('');
    }

    tbody.innerHTML = rows;
}

// Index-based lookup — passes all emails for this consolidated customer
function openCRMCustomer(idx) {
    var customer = crmCustomers[idx];
    if (!customer) return;

    // emails can be a JS array, a PostgreSQL array string "{a,b}", or null
    var emails = customer.emails;
    if (!emails) {
        emails = customer.email ? [customer.email] : [];
    } else if (typeof emails === 'string') {
        // PostgreSQL array format: "{email1,email2}"
        emails = emails.replace(/^\{|\}$/g, '').split(',')
                       .map(function(e) { return e.replace(/^"|"$/g,'').trim(); })
                       .filter(Boolean);
    } else if (!Array.isArray(emails)) {
        emails = [String(emails)];
    }

    if (!emails.length) { showToast('No email address found for this customer'); return; }
    var name = customer.display_name || customer.name || emails[0];
    openCustomerProfile(emails, name);
}

function filterCRM(q) {
    document.querySelectorAll('#crm-tbody .crm-row').forEach(function(row) {
        row.style.display = row.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
    });
}

// ─── OPEN & CLOSE PROFILE ─────────────────────────────────────────────────────
async function openCustomerProfile(emailsOrEmail, displayName) {
    const modal = document.getElementById('crm-profile-modal');
    if (!modal) return;
    modal.classList.add('open');

    // Normalise: accept single email string or array
    const emails = Array.isArray(emailsOrEmail) ? emailsOrEmail : [emailsOrEmail];

    // ── Optimistic badge clear: happens instantly, before profile even loads ──
    var anyUnread = false;
    crmCustomers.forEach(function(c) {
        var cEmails = c.emails || (c.email ? [c.email] : []);
        if (emails.some(function(e) { return cEmails.indexOf(e) !== -1; })) {
            if (parseInt(c.unread_count || 0) > 0) anyUnread = true;
            c.unread_count = 0;
        }
    });
    if (anyUnread) renderCRM(); // only re-render if there was actually a badge to clear

    // Fire-and-forget backend mark-as-read
    emails.forEach(function(em) {
        fetch(API_BASE + '/admin/chats/read', {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
            body:    JSON.stringify({ email: em })
        }).catch(function() {});
    });
    const name   = displayName || emails[0];

    ['crm-profile-name','crm-profile-ltv','crm-profile-orders',
     'crm-profile-last-order','crm-profile-since'].forEach(function(id) {
        const el = document.getElementById(id);
        if (el) el.textContent = '…';
    });
    document.getElementById('crm-profile-name').textContent   = name;
    document.getElementById('crm-profile-avatar').textContent = name[0].toUpperCase();
    document.getElementById('crm-profile-emails').innerHTML   = '<span style="color:var(--green-light);font-size:0.82rem;">Loading…</span>';
    document.getElementById('crm-product-chart').innerHTML    = '<p style="color:var(--text-muted);font-size:0.88rem;">Loading…</p>';
    document.getElementById('crm-orders-list').innerHTML      = '<p style="color:var(--text-muted);font-size:0.88rem;">Loading…</p>';
    document.getElementById('crm-notes-list').innerHTML       = '';
    document.getElementById('crm-wishlist').innerHTML         = '';
    document.getElementById('crm-comms-thread').innerHTML     = '';

    try {
        var emailsQuery = emails.filter(Boolean).map(encodeURIComponent).join(',');
        if (!emailsQuery) throw new Error('No valid email addresses to query');
        const res = await fetch(API_BASE + '/admin/crm/customer?emails=' + emailsQuery, {
            headers: { 'Authorization': 'Bearer ' + adminToken }
        });
        if (!res.ok) {
            var errData = await res.json().catch(function() { return {}; });
            throw new Error(errData.error || ('Server returned ' + res.status));
        }
        const data = await res.json();
        crmCurrentProfile = Object.assign({ emails: emails, display_name: name }, data);
        renderCustomerProfile();
    } catch (err) {
        showToast('Failed to load profile: ' + err.message);
        console.error('CRM profile error:', err);
    }
}

function closeCustomerProfile() {
    const modal = document.getElementById('crm-profile-modal');
    if (modal) modal.classList.remove('open');
    crmCurrentProfile = null;
}

// ─── RENDER PROFILE ───────────────────────────────────────────────────────────
function renderCustomerProfile() {
    const c = crmCurrentProfile;
    if (!c) return;

    const firstName = (c.orders && c.orders[0]) ? c.orders[0].fname : '';
    const lastName  = (c.orders && c.orders[0]) ? c.orders[0].lname : '';
    const name      = (firstName + ' ' + lastName).trim()
                      || (c.messages && c.messages[0] && c.messages[0].name)
                      || c.email;
    const ltv       = (c.orders || []).reduce(function(s, o) { return s + parseFloat(o.total || 0); }, 0);
    const lastOrder = (c.orders && c.orders[0]) ? (c.orders[0].created_at || c.orders[0].date) : null;

    document.getElementById('crm-profile-avatar').textContent     = name[0].toUpperCase();
    document.getElementById('crm-profile-name').textContent       = name;
    document.getElementById('crm-profile-ltv').textContent        = '£' + ltv.toFixed(2);
    document.getElementById('crm-profile-orders').textContent     = (c.orders || []).length;
    document.getElementById('crm-profile-last-order').textContent = timeAgo(lastOrder);
    document.getElementById('crm-profile-since').textContent      = memberSince(c.orders, c.messages);

    // Show all email addresses as badges in the header
    const allEmails = c.emails || [c.email];
    const emailsEl  = document.getElementById('crm-profile-emails');
    if (emailsEl) {
        emailsEl.innerHTML = allEmails.map(function(em, i) {
            const tag = i === 0 ? 'primary' : 'alt';
            return '<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.12);' +
                   'border:1px solid rgba(255,255,255,0.25);border-radius:999px;padding:3px 10px;' +
                   'font-size:0.75rem;color:var(--yellow-pale);font-weight:600;">' +
                   '<span style="width:6px;height:6px;border-radius:50%;background:' + (i === 0 ? 'var(--yellow)' : 'var(--green-light)') + ';flex-shrink:0;"></span>' +
                   em + '</span>';
        }).join('');
    }

    // Populate the email picker dropdown
    const picker = document.getElementById('crm-reply-email');
    if (picker) {
        picker.innerHTML = allEmails.map(function(em, i) {
            const label = i === 0 ? em + ' (primary)' : em;
            return '<option value="' + em + '">' + label + '</option>';
        }).join('');
    }

    renderProductChart(c.orders || []);
    renderCRMOrders(c);
    renderCRMOverview(c);
    renderCRMComms(c);
    loadCRMTags();
}

// ─── CRM TAGS ──
async function loadCRMTags() {
    if (!crmCurrentProfile) return;
    var primaryEmail = (crmCurrentProfile.emails && crmCurrentProfile.emails[0]) || crmCurrentProfile.email;
    try {
        var res = await fetch(API_BASE + '/admin/tags/' + encodeURIComponent(primaryEmail), {
            headers: { 'Authorization': 'Bearer ' + adminToken }
        });
        var tags = res.ok ? await res.json() : [];
        renderCRMTags(tags);
    } catch(e) { renderCRMTags([]); }
}

function renderCRMTags(tags) {
    var el = document.getElementById('crm-tags-list');
    if (!el) return;
    el.innerHTML = tags.length ? tags.map(function(t) {
        return '<span style="display:inline-flex;align-items:center;gap:5px;background:var(--green-dark);color:var(--yellow);border-radius:999px;padding:3px 10px;font-size:0.78rem;font-weight:700;">'
            + t + ' <span style="cursor:pointer;opacity:0.7;" onclick="removeCRMTag(\'' + t.replace(/'/g,"&#39;") + '\')">✕</span></span>';
    }).join('') : '<span style="color:var(--text-muted);font-size:0.85rem;font-weight:600;">No tags yet.</span>';
}

async function addCRMTag() {
    var input = document.getElementById('crm-tag-input');
    var tag   = (input.value || '').trim();
    if (!tag || !crmCurrentProfile) return;
    var primaryEmail = (crmCurrentProfile.emails && crmCurrentProfile.emails[0]) || crmCurrentProfile.email;
    try {
        await fetch(API_BASE + '/admin/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
            body: JSON.stringify({ email: primaryEmail, tag: tag })
        });
        input.value = '';
        showToast('🏷️ Tag added');
        loadCRMTags();
    } catch(e) { showToast('Failed to add tag'); }
}

async function removeCRMTag(tag) {
    if (!crmCurrentProfile) return;
    var primaryEmail = (crmCurrentProfile.emails && crmCurrentProfile.emails[0]) || crmCurrentProfile.email;
    try {
        await fetch(API_BASE + '/admin/tags', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
            body: JSON.stringify({ email: primaryEmail, tag: tag })
        });
        loadCRMTags();
    } catch(e) { showToast('Failed to remove tag'); }
}

// ─── PRODUCT CHART ────────────────────────────────────────────────────────────
function renderProductChart(orders) {
    const el      = document.getElementById('crm-product-chart');
    if (!el) return;
    const counts  = parseOrderItems(orders);
    const entries = Object.keys(counts).map(function(k) { return [k, counts[k]]; })
                          .sort(function(a, b) { return b[1] - a[1]; });

    if (!entries.length) {
        el.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;font-weight:600;">No orders yet.</p>';
        return;
    }

    const max = entries[0][1];
    el.innerHTML = entries.map(function(entry) {
        const name = entry[0];
        const qty  = entry[1];
        const pct  = Math.round((qty / max) * 100);
        return '<div style="margin-bottom:10px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
            '<span style="font-size:0.82rem;font-weight:700;color:var(--text);max-width:220px;' +
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + name + '">' + name + '</span>' +
            '<span style="font-size:0.78rem;font-weight:800;color:var(--green-mid);margin-left:8px;flex-shrink:0;">×' + qty + '</span>' +
            '</div>' +
            '<div style="background:var(--border);border-radius:999px;height:9px;overflow:hidden;">' +
            '<div style="background:linear-gradient(90deg,var(--green-dark),var(--green-leaf));' +
            'height:100%;border-radius:999px;width:' + pct + '%;transition:width 0.5s ease;"></div>' +
            '</div></div>';
    }).join('');
}

// ─── ORDER HISTORY ────────────────────────────────────────────────────────────
function renderCRMOrders(c) {
    const orders = c.orders || [];
    const el     = document.getElementById('crm-orders-list');
    if (!el) return;
    if (!orders.length) {
        el.innerHTML = '<p style="color:var(--text-muted);font-weight:600;font-size:0.88rem;">No orders yet.</p>';
        return;
    }
    el.innerHTML = orders.map(function(o) {
        return '<div style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">' +
            '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:800;font-size:0.85rem;color:var(--green-dark);">' + o.id + '</div>' +
            '<div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (o.items || '—') + '</div>' +
            '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">' +
            (o.pickup ? '🏠 Pickup' : '🚚 Delivery') + ' · ' + (o.date || '') + '</div>' +
            '</div>' +
            '<div style="text-align:right;flex-shrink:0;">' +
            '<div style="font-weight:800;font-size:0.95rem;color:var(--green-dark);">£' + parseFloat(o.total).toFixed(2) + '</div>' +
            '<span class="badge badge-' + o.status + '" style="margin-top:4px;">' + o.status + '</span>' +
            '</div></div>';
    }).join('') + '<div style="height:4px;"></div>';
}

// ─── OVERVIEW (NOTES + WATCHLIST) ─────────────────────────────────────────────
function renderCRMOverview(c) {
    const notes = c.notes || [];
    document.getElementById('crm-notes-list').innerHTML = notes.length
        ? notes.map(function(n) {
            const safeNote = n.note.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            const safeNoteWithBreaks = safeNote.split('\n').join('<br>');

            return '<div class="crm-note">' +
                '<div class="crm-note-text">' + safeNoteWithBreaks + '</div>' +
                '<div class="crm-note-meta">' +
                new Date(n.created_at).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) +
                '<button class="action-btn danger" onclick="deleteCRMNote(' + n.id + ')" ' +
                'style="margin-left:10px;padding:2px 8px;font-size:0.72rem;">Remove</button>' +
                '</div></div>';
          }).join('')
        : '<p style="color:var(--text-muted);font-weight:600;font-size:0.88rem;">No notes yet.</p>';

    const wishlist = c.wishlist || [];
    document.getElementById('crm-wishlist').innerHTML = wishlist.length
        ? wishlist.map(function(w) {
            return '<span class="badge badge-pending" style="margin:2px;">' +
                   (w.emoji ? w.emoji + ' ' : '') +
                   (w.product_name || 'Product #' + w.product_id) + '</span>';
          }).join('')
        : '<p style="color:var(--text-muted);font-weight:600;font-size:0.88rem;">No items on watchlist.</p>';
}

// ─── COMMUNICATIONS ───────────────────────────────────────────────────────────
function renderCRMComms(c) {
    const messages = c.messages || [];
    const el       = document.getElementById('crm-comms-thread');
    const countEl  = document.getElementById('crm-comms-count');
    if (!el) return;
    if (countEl) countEl.textContent = messages.length ? messages.length + ' message' + (messages.length !== 1 ? 's' : '') : '';

    if (!messages.length) {
        el.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">' +
            '<div style="font-size:2.5rem;margin-bottom:0.5rem;">💬</div>' +
            '<p style="font-weight:700;">No messages yet.</p>' +
            '<p style="font-size:0.85rem;margin-top:4px;">Use the reply box below to start a conversation.</p></div>';
        return;
    }

    el.innerHTML = messages.map(function(m) {
        const replies = (m.replies || []).map(function(r) {
            return '<div class="chat-admin-bubble-wrap chat-admin-reply-wrap">' +
                '<div class="chat-admin-bubble chat-admin-reply">' +
                '<div class="chat-admin-bubble-meta"><strong>Home Grown</strong><span>' + (r.date || '') + '</span></div>' +
                '<div class="chat-admin-bubble-text">' + r.text + '</div>' +
                '</div></div>';
        }).join('');
        return '<div class="chat-admin-bubble-wrap">' +
            '<div class="chat-admin-bubble">' +
            '<div class="chat-admin-bubble-meta"><strong>' + (m.name || 'Customer') + '</strong>' +
            '<span>' + (m.date || (m.ts ? new Date(m.ts).toLocaleString('en-GB') : '')) + '</span></div>' +
            '<div class="chat-admin-bubble-text">' + (m.message || '') + '</div>' +
            '</div></div>' + replies;
    }).join('');

    el.scrollTop = el.scrollHeight;
}

// ─── NOTES ────────────────────────────────────────────────────────────────────
async function addCRMNote() {
    const textarea = document.getElementById('crm-note-input');
    const note     = (textarea ? textarea.value : '').trim();
    if (!note || !crmCurrentProfile) return;
    const btn = document.querySelector('[onclick="addCRMNote()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const res = await fetch(API_BASE + '/admin/crm/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
            body: JSON.stringify({ email: crmCurrentProfile.email, note: note })
        });
        if (!res.ok) throw new Error('Failed');
        textarea.value = '';
        showToast('✓ Note saved');
        var eQ2 = (crmCurrentProfile.emails || [crmCurrentProfile.email]).filter(Boolean).map(encodeURIComponent).join(',');
        const data = await (await fetch(API_BASE + '/admin/crm/customer?emails=' + eQ2,
            { headers: { 'Authorization': 'Bearer ' + adminToken } })).json();
        crmCurrentProfile.notes = data.notes;
        renderCRMOverview(crmCurrentProfile);
    } catch (err) { showToast('Failed to save note'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '+ Add Note'; } }
}

async function deleteCRMNote(id) {
    if (!confirm('Delete this note?')) return;
    try {
        await fetch(API_BASE + '/admin/crm/notes/' + id, {
            method: 'DELETE', headers: { 'Authorization': 'Bearer ' + adminToken }
        });
        showToast('Note deleted');
        var eQ3 = (crmCurrentProfile.emails || [crmCurrentProfile.email]).filter(Boolean).map(encodeURIComponent).join(',');
        const data = await (await fetch(API_BASE + '/admin/crm/customer?emails=' + eQ3,
            { headers: { 'Authorization': 'Bearer ' + adminToken } })).json();
        crmCurrentProfile.notes = data.notes;
        renderCRMOverview(crmCurrentProfile);
    } catch (err) { showToast('Failed to delete note'); }
}

// ─── SEND REPLY ───────────────────────────────────────────────────────────────
async function sendCRMReply() {
    if (!crmCurrentProfile) return;
    const editor    = document.getElementById('crm-reply-input');
    const statusEl  = document.getElementById('crm-reply-status');
    const replyText = editor ? (editor.tagName === 'TEXTAREA' ? editor.value : editor.innerHTML).trim() : '';
    if (!replyText) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = 'Please type a reply.'; return; }

    const btn         = document.getElementById('crm-reply-btn');
    const name        = document.getElementById('crm-profile-name').textContent;
    const picker      = document.getElementById('crm-reply-email');
    const targetEmail = picker ? picker.value : (crmCurrentProfile.emails && crmCurrentProfile.emails[0]) || crmCurrentProfile.email;
    const templateKey = window._crmTemplateKey || 'general';
    const t           = EMAIL_TEMPLATES[templateKey] || EMAIL_TEMPLATES.general;
    if (!targetEmail) { statusEl.style.color='var(--danger)'; statusEl.textContent='Please select an email address.'; return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    statusEl.textContent = '';

    // Build the full branded email HTML using the selected template wrapper
    const htmlContent = buildEmailHTML(templateKey, name, replyText);

    try {
        const res = await fetch(API_BASE + '/admin/chat/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
            body: JSON.stringify({
                email:       targetEmail,
                name:        name,
                reply:       replyText,
                htmlContent: htmlContent,
                subject:     t.subject,
                date:        new Date().toLocaleString('en-GB')
            })
        });
        if (!res.ok) throw new Error((await res.json().catch(function(){return {};})).error || 'Error ' + res.status);
        if (editor) { if (editor.tagName === 'TEXTAREA') editor.value = ''; else editor.innerHTML = ''; }
        statusEl.style.color = 'var(--success)';
        statusEl.textContent = '✓ Sent to ' + crmCurrentProfile.email;
        setTimeout(function() { statusEl.textContent = ''; }, 4000);
        const emailsQuery = (crmCurrentProfile.emails || [crmCurrentProfile.email]).map(encodeURIComponent).join(',');
        const data = await (await fetch(API_BASE + '/admin/crm/customer?emails=' + emailsQuery,
            { headers: { 'Authorization': 'Bearer ' + adminToken } })).json();
        crmCurrentProfile.messages = data.messages;
        renderCRMComms(crmCurrentProfile);
    } catch (err) {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = 'Failed: ' + err.message;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send Reply'; }
    }
}

// Legacy stubs — prevent errors if old cached HTML references these
function renderAdminChats() {}
function switchCRMTab() {}
function toggleThread() {}
function sendAdminChatReply() {}
function deleteChatThread() {}

// ─── BROADCAST EMAIL ──────────────────────────────────────────────────────────
function openBroadcast() {
    const modal     = document.getElementById('broadcast-modal');
    const countEl   = document.getElementById('broadcast-count');
    const statusEl  = document.getElementById('broadcast-status');
    const subjectEl = document.getElementById('broadcast-subject');
    const msgEl     = document.getElementById('broadcast-message');
    const btn       = document.getElementById('broadcast-send-btn');

    if (countEl) countEl.textContent = crmCustomers.length + ' customer email address' + (crmCustomers.length !== 1 ? 'es' : '');
    if (statusEl)  statusEl.textContent  = '';
    if (subjectEl) subjectEl.value       = '';
    if (msgEl)     msgEl.value           = '';
    if (btn)     { btn.disabled = false; btn.textContent = '📧 Send to All Customers'; }
    if (modal)     modal.classList.add('open');

    setTimeout(function() {
        var s = document.getElementById('broadcast-subject');
        if (s) s.focus();
    }, 150);
}

function closeBroadcast() {
    var modal = document.getElementById('broadcast-modal');
    if (modal) modal.classList.remove('open');
}

async function sendBroadcast() {
    var subject  = (document.getElementById('broadcast-subject').value || '').trim();
    var bcMsgEl  = document.getElementById('broadcast-message');
    var message  = (bcMsgEl ? (bcMsgEl.tagName === 'TEXTAREA' ? bcMsgEl.value : bcMsgEl.innerHTML) : '').trim();
    var statusEl = document.getElementById('broadcast-status');
    var btn      = document.getElementById('broadcast-send-btn');

    if (!subject) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = 'Please enter a subject line.'; return; }
    if (!message) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = 'Please write a message.'; return; }

    if (!confirm('Send this email to ALL customers? This cannot be undone.')) return;

    btn.disabled    = true;
    btn.textContent = 'Sending…';
    statusEl.style.color = 'var(--text-muted)';
    statusEl.textContent = 'Sending — this may take a moment…';

    try {
        var res = await fetch(API_BASE + '/admin/crm/broadcast', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
            body:    JSON.stringify({ subject: subject, message: message })
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Broadcast failed');

        statusEl.style.color = 'var(--success)';
        statusEl.textContent = '✓ Sent to ' + data.sent + ' customer' + (data.sent !== 1 ? 's' : '') +
            (data.failed ? ' · ' + data.failed + ' failed' : '') + '.';
        btn.textContent = '✓ Sent!';
        showToast('📢 Broadcast sent to ' + data.sent + ' customers');

        // Clear the form after a delay
        setTimeout(function() {
            document.getElementById('broadcast-subject').value = '';
            var bcEl = document.getElementById('broadcast-message');
            if (bcEl) { if (bcEl.tagName === 'TEXTAREA') bcEl.value = ''; else bcEl.innerHTML = ''; }
            btn.disabled    = false;
            btn.textContent = '📧 Send to All Customers';
        }, 3000);

    } catch (err) {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = 'Failed: ' + err.message;
        btn.disabled    = false;
        btn.textContent = '📧 Send to All Customers';
    }
}

// ═══════════════════════════════════════════════
//  LIVE CUT-OFF COUNTDOWN
// ═══════════════════════════════════════════════
var _countdownTimer = null;

function getNextCutoff() {
    // Always counts down to the next Friday 5pm pickup cut-off only
    var londonStr = new Date().toLocaleString('en-US', { timeZone: 'Europe/London' });
    var now  = new Date(londonStr);
    var day  = now.getDay();
    var mins = now.getHours() * 60 + now.getMinutes();

    var deadline = new Date(now);
    // Days until next Friday (5), wrapping if past Friday 5pm
    var daysToFri = (5 - day + 7) % 7;
    if (daysToFri === 0 && mins >= 17 * 60) daysToFri = 7; // past cutoff, next week
    deadline.setDate(now.getDate() + daysToFri);
    deadline.setHours(17, 0, 0, 0);

    return { label: 'Friday &amp; Saturday Home Pickup', type: 'pickup', deadline: deadline };
}

function startCountdown() {
    var bannerEl = document.getElementById('cutoff-banner');
    var textEl   = document.getElementById('cutoff-text');
    if (!bannerEl || !textEl) return;

    function tick() {
        var info = getNextCutoff();
        var diff = info.deadline.getTime() - Date.now();
        if (diff <= 0) { tick(); return; } // just ticked over, recalculate

        var h  = Math.floor(diff / 3600000);
        var m  = Math.floor((diff % 3600000) / 60000);
        var s  = Math.floor((diff % 60000) / 1000);
        var hh = String(h).padStart(2, '0');
        var mm = String(m).padStart(2, '0');
        var ss = String(s).padStart(2, '0');

        var emoji = info.type === 'delivery' ? '🚚' : '🏠';
        textEl.innerHTML = emoji + ' Order in the next <strong>' + hh + 'h ' + mm + 'm ' + ss + 's</strong> for <strong>' + info.label + '</strong>!';
        bannerEl.style.display = 'block';
    }

    tick();
    if (_countdownTimer) clearInterval(_countdownTimer);
    _countdownTimer = setInterval(tick, 1000);
}

// ═══════════════════════════════════════════════
//  SUBSCRIBE & SAVE
// ═══════════════════════════════════════════════

async function subscribeToProduct(productId) {
    var p = products.find(function(x) { return x.id === productId; });
    if (!p) return;

    var priceId = p.stripe_recurring_price_id;
    if (!priceId) {
        showToast('Subscription not yet available for this product — contact us to arrange!');
        return;
    }

    var email = '';
    try {
        var stored = JSON.parse(localStorage.getItem('hg_chat_user') || 'null');
        if (stored && stored.email) email = stored.email;
    } catch(e) {}

    var btn = document.getElementById('sub-btn-' + productId);
    if (btn) { btn.disabled = true; btn.textContent = 'Setting up…'; }

    try {
        var res = await fetch(API_BASE + '/create-subscription-session', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                priceId:       priceId,
                productName:   p.name,
                customerEmail: email
            })
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not start subscription');
        // Redirect to Stripe Checkout
        window.location.href = data.url;
    } catch (err) {
        showToast('Subscription error: ' + err.message);
        if (btn) { btn.disabled = false; btn.textContent = '📦 Subscribe & Save 10%'; }
    }
}

// ═══════════════════════════════════════════════
//  GDPR CONSENT HELPER
// ═══════════════════════════════════════════════
function getMarketingConsent() {
    var el = document.getElementById('marketing-consent');
    return el ? el.checked : false;
}
