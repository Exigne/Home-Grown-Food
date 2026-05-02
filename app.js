// --- CONFIGURATION & STATE ---
const API_BASE = window.location.origin + '/api'; 
let adminToken = localStorage.getItem('hg_admin_token') || null; // Token remains for session persistence

let STRIPE_PUBLISHABLE_KEY = ''; // Fetched from Cloud
let BACKEND_URL = `${API_BASE}/create-payment-intent`;

let cart = [];
let orders = [];      
let ingredients = []; 
let products = [];    
let stripeInstance = null;
let cardElement = null;

// --- INITIALIZE APP ---
async function initApp() {
    // We fetch the Stripe Key from your cloud environment first
    await fetchConfig(); 
    await fetchProducts(); 
    updateCartUI();
}

// --- FETCH CONFIG FROM CLOUD ---
async function fetchConfig() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        if (res.ok) {
            const data = await res.json();
            STRIPE_PUBLISHABLE_KEY = data.stripePublishableKey;
        }
    } catch (e) {
        console.error("Cloud config could not be reached.");
    }
}

// --- FETCH PRODUCTS FROM NEON DATABASE ---
async function fetchProducts() {
    try {
        const res = await fetch(`${API_BASE}/products`);
        if (!res.ok) throw new Error(`DB Status: ${res.status}`);
        
        products = await res.json();
        
        document.getElementById('shop-loading').style.display = 'none';
        document.getElementById('products-grid').style.display = 'grid';
        
        renderShop();
        if(document.getElementById('view-admin').classList.contains('active')) renderProductMgmt();
    } catch (error) {
        document.getElementById('shop-loading').innerHTML = 
            `<div style="color:var(--danger); padding: 2rem;">Database Connection Error.</div>`;
    }
}

// --- NAVIGATION & AUTHENTICATION ---
function showView(v, e) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
  if (e) e.target.classList.add('active');
  
  if (v === 'admin') {
      if (adminToken) {
          document.getElementById('admin-login-screen').style.display = 'none';
          document.getElementById('admin-layout').style.display = 'grid';
          loadAdminData();
      } else {
          document.getElementById('admin-login-screen').style.display = 'block';
          document.getElementById('admin-layout').style.display = 'none';
      }
  }
}

async function handleAdminLogin() {
  const user = document.getElementById('admin-user').value;
  const pass = document.getElementById('admin-pass').value;
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
          showView('admin');
          loadAdminData();
      } else { showToast('Invalid credentials'); }
  } catch (error) { showToast('Cloud Auth Server Unreachable.'); }
}

async function loadAdminData() {
  try {
      const headers = { 'Authorization': `Bearer ${adminToken}` };
      const [ordRes, ingRes, prodRes] = await Promise.all([
          fetch(`${API_BASE}/admin/orders`, { headers }),
          fetch(`${API_BASE}/admin/ingredients`, { headers }),
          fetch(`${API_BASE}/admin/products`, { headers })
      ]);

      if(ordRes.ok) orders = await ordRes.json();
      if(ingRes.ok) ingredients = await ingRes.json();
      if(prodRes.ok) products = await prodRes.json();

      renderAdmin();
  } catch (error) {
      console.error("Admin sync failed");
  }
}

// --- SHOP & CART ---
function renderShop() {
  const grid = document.getElementById('products-grid');
  grid.innerHTML = products.map(p => `
    <div class="product-card" onclick="openProductModal(${p.id})">
      <div class="product-img" style="background-color: ${p.bg_color || '#FFFBE8'}; ${p.image_url ? `background-image: url('${p.image_url}'); background-size: cover;` : ''}">
        ${p.image_url ? '' : `<span style="font-size:3.5rem;">${p.emoji || '🍪'}</span>`}
        ${p.badge ? `<span class="product-badge">${p.badge}</span>` : ''}
      </div>
      <div class="product-info">
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${p.description || ''}</div>
        <div class="product-meta">
          <span class="product-price">£${Number(p.price).toFixed(2)}</span>
          <button class="add-btn" onclick="event.stopPropagation(); addToCart(${p.id})">Add +</button>
        </div>
      </div>
    </div>`).join('');
}

function openProductModal(id) {
    const p = products.find(x => x.id === id);
    if(!p) return;
    document.getElementById('pm-name').textContent = p.name;
    document.getElementById('pm-price').textContent = '£' + Number(p.price).toFixed(2);
    document.getElementById('pm-desc').textContent = p.description || '';
    const imgCont = document.getElementById('pm-img-container');
    if (p.image_url) {
        imgCont.style.backgroundImage = `url('${p.image_url}')`;
        imgCont.style.backgroundColor = 'transparent';
        document.getElementById('pm-emoji').textContent = '';
    } else {
        imgCont.style.backgroundImage = 'none';
        imgCont.style.backgroundColor = p.bg_color || '#FFFBE8';
        document.getElementById('pm-emoji').textContent = p.emoji || '🍪';
    }
    document.getElementById('pm-add-btn').onclick = () => { addToCart(p.id); closeProductModal(); };
    document.getElementById('product-modal').classList.add('open');
}

function closeProductModal() { document.getElementById('product-modal').classList.remove('open'); }

function addToCart(id) {
  const p = products.find(x => x.id === id);
  const ex = cart.find(x => x.id === id);
  if(ex) ex.qty++; else cart.push({...p, qty:1});
  updateCartUI();
  showToast(`${p.name} added to cloud basket!`);
}

function updateCartUI() {
  const total = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
  document.getElementById('cart-count').textContent = cart.reduce((s, x) => s + x.qty, 0);
  const itemsEl = document.getElementById('cart-items');
  if (cart.length === 0) {
    itemsEl.innerHTML = `<div class="empty-cart"><p>Basket is empty</p></div>`;
    document.getElementById('cart-footer').style.display = 'none';
  } else {
    itemsEl.innerHTML = cart.map(item => `
      <div class="cart-item">
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-qty">
            <button class="qty-btn" onclick="changeQty(${item.id}, -1)">−</button>
            <span>${item.qty}</span>
            <button class="qty-btn" onclick="changeQty(${item.id}, 1)">+</button>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:800;">£${(parseFloat(item.price) * item.qty).toFixed(2)}</div>
          <button class="remove-item" onclick="removeFromCart(${item.id})">🗑</button>
        </div>
      </div>`).join('');
    document.getElementById('cart-total-amount').textContent = '£' + total.toFixed(2);
    document.getElementById('cart-footer').style.display = 'block';
  }
}

function removeFromCart(id) { cart = cart.filter(x => x.id !== id); updateCartUI(); }
function changeQty(id, d) {
  const i = cart.find(x => x.id === id);
  if(!i) return;
  i.qty += d;
  if(i.qty <= 0) removeFromCart(id); else updateCartUI();
}
function toggleCart() { document.getElementById('cart-overlay').classList.toggle('open'); }
function closeCartOnOverlay(e) { if(e.target === document.getElementById('cart-overlay')) toggleCart(); }

// --- CHECKOUT & STRIPE ---
function openCheckout() {
  if (cart.length === 0) return;

  const subtotal = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0);
  const total = subtotal + 3.50;
  
  // Update Price Breakdown
  document.getElementById('summary-subtotal').textContent = '£' + subtotal.toFixed(2);
  document.getElementById('summary-total').textContent = '£' + total.toFixed(2);
  document.getElementById('pay-amount-btn').textContent = '£' + total.toFixed(2);
  
  // Build Itemized List
  const summaryList = document.getElementById('checkout-summary-list');
  summaryList.innerHTML = cart.map(item => `
    <div class="summary-item">
      <span>${item.name} × ${item.qty}</span>
      <span>£${(parseFloat(item.price) * item.qty).toFixed(2)}</span>
    </div>
  `).join('');

  // Stripe Logic (Existing)
  if (STRIPE_PUBLISHABLE_KEY && window.Stripe) {
      if (!stripeInstance) {
          stripeInstance = Stripe(STRIPE_PUBLISHABLE_KEY);
          const elements = stripeInstance.elements();
          cardElement = elements.create('card', {
              style: {
                  base: { fontSize: '16px', color: '#164A2E', fontFamily: 'Nunito, sans-serif' }
              }
          });
          cardElement.mount('#card-element');
      }
  }

  document.getElementById('checkout-modal').classList.add('open');
  toggleCart(); 
}

// --- ADMIN MANAGEMENT ---
function showAdminSection(s, e) {
  document.querySelectorAll('.admin-section').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.admin-menu-item').forEach(el => el.classList.remove('active'));
  document.getElementById('section-' + s).classList.add('active');
  if(e) e.currentTarget.classList.add('active');
  renderAdmin();
}

function renderAdmin() {
  renderDashboard();
  renderOrdersTable();
  renderIngredients();
  renderProductMgmt();
}

function renderDashboard() {
  const total = orders.reduce((s, o) => s + parseFloat(o.total), 0);
  document.getElementById('stat-revenue').textContent = '£' + total.toFixed(2);
  document.getElementById('stat-orders').textContent = orders.length;
  document.getElementById('stat-pending').textContent = orders.filter(o => o.status === 'pending').length;
  document.getElementById('stat-lowstock').textContent = ingredients.filter(i => parseFloat(i.stock) < parseFloat(i.min_stock)).length;
}

function renderOrdersTable() {
  const tbody = document.getElementById('orders-body');
  tbody.innerHTML = orders.map(o => `<tr><td>${o.id}</td><td>${o.fname} ${o.lname}</td><td>${o.address}</td><td>${o.items}</td><td>£${o.total}</td><td>${o.status}</td><td><button class="action-btn primary" onclick="updateOrderStatus('${o.id}', 'processing')">Process</button></td></tr>`).join('');
}

function renderIngredients() {
  const tbody = document.getElementById('ingredients-body');
  tbody.innerHTML = ingredients.map(ing => `<tr><td>${ing.name}</td><td>${ing.stock} / ${ing.max_stock}</td><td>${ing.unit}</td><td><span class="badge badge-${parseFloat(ing.stock) < parseFloat(ing.min_stock) ? 'low' : 'ok'}">${parseFloat(ing.stock) < parseFloat(ing.min_stock) ? 'Low' : 'OK'}</span></td><td><button class="action-btn" onclick="restockIngredient(${ing.id})">+ Restock</button></td></tr>`).join('');
}

function renderProductMgmt() {
  document.getElementById('product-mgmt-grid').innerHTML = products.map(p => `
    <div class="product-mgmt-card" style="display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #eee;">
      <div style="display:flex; gap:10px; align-items:center;">
        <div style="width:40px; height:40px; display:flex; align-items:center; justify-content:center; background:${p.bg_color}; border-radius:5px; background-image: url('${p.image_url}'); background-size: cover;">${p.image_url ? '' : (p.emoji || '🍪')}</div>
        <strong>${p.name}</strong>
      </div>
      <div>
        <button class="action-btn" onclick="editProduct(${p.id})">✏️ Edit</button>
        <button class="action-btn danger" onclick="deleteProduct(${p.id})">🗑 Delete</button>
      </div>
    </div>`).join('');
}

function resetProductForm() {
    document.getElementById('product-form-title').textContent = "Add New Snack";
    document.getElementById('prod-id').value = '';
    ['prod-name', 'prod-price', 'prod-emoji', 'prod-badge', 'prod-image', 'prod-desc'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('prod-bg').value = '#FFFBE8';
}

function editProduct(id) {
    const p = products.find(x => x.id === id);
    if(!p) return;
    document.getElementById('product-form-title').textContent = "Edit Snack";
    document.getElementById('prod-id').value = p.id;
    document.getElementById('prod-name').value = p.name;
    document.getElementById('prod-price').value = p.price;
    document.getElementById('prod-emoji').value = p.emoji || '';
    document.getElementById('prod-badge').value = p.badge || '';
    document.getElementById('prod-image').value = p.image_url || '';
    document.getElementById('prod-desc').value = p.description || '';
    document.getElementById('prod-bg').value = p.bg_color || '#FFFBE8';
}

async function saveProduct() {
    const id = document.getElementById('prod-id').value;
    const payload = {
        name: document.getElementById('prod-name').value.trim(),
        price: parseFloat(document.getElementById('prod-price').value) || 0,
        emoji: document.getElementById('prod-emoji').value.trim(),
        badge: document.getElementById('prod-badge').value.trim(),
        image_url: document.getElementById('prod-image').value.trim(),
        description: document.getElementById('prod-desc').value.trim(),
        bg_color: document.getElementById('prod-bg').value.trim() || '#FFFBE8'
    };
    if (!payload.name || payload.price <= 0) { showToast('Name/Price required'); return; }
    try {
        const url = id ? `${API_BASE}/admin/products/${id}` : `${API_BASE}/admin/products`;
        const res = await fetch(url, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body: JSON.stringify(payload)
        });
        if (res.ok) { showToast('Cloud sync complete!'); resetProductForm(); await loadAdminData(); }
        else { showToast('Save failed'); }
    } catch (e) { showToast('Database unreachable'); }
}

async function deleteProduct(id) {
    if(!confirm('Permanently delete from cloud?')) return;
    try {
        await fetch(`${API_BASE}/admin/products/${id}`, {
            method: 'DELETE', headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        showToast('Deleted'); await loadAdminData();
    } catch (e) { showToast('Delete failed'); }
}

async function updateOrderStatus(id, status) {
  try {
      await fetch(`${API_BASE}/admin/orders/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
          body: JSON.stringify({ status })
      });
      showToast(`Status updated: ${status}`); loadAdminData();
  } catch(e) { showToast('Update failed'); }
}

function showToast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }

initApp();
