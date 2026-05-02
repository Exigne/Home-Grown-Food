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

// --- INITIALIZE APP ---
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
            STRIPE_PUBLISHABLE_KEY = data.stripePublishableKey;
        }
    } catch (e) { console.error("Config fetch failed"); }
}

async function fetchProducts() {
    try {
        const res = await fetch(`${API_BASE}/products`);
        products = await res.json();
        document.getElementById('shop-loading').style.display = 'none';
        document.getElementById('products-grid').style.display = 'grid';
        renderShop();
    } catch (error) {
        document.getElementById('shop-loading').textContent = "Database Error.";
    }
}

// --- NAVIGATION ---
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
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass })
      });
      if (res.ok) {
          const data = await res.json();
          adminToken = data.token;
          localStorage.setItem('hg_admin_token', adminToken);
          showView('admin');
      } else { showToast('Invalid credentials'); }
  } catch (error) { showToast('Login failed'); }
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
  } catch (error) { console.error("Admin sync failed"); }
}

// --- RENDERING ---
function renderShop() {
  const grid = document.getElementById('products-grid');
  grid.innerHTML = products.map(p => `
    <div class="product-card">
      <div class="product-img" style="background-color: ${p.bg_color}; ${p.image_url ? `background-image: url('${p.image_url}'); background-size: cover;` : ''}">
        ${p.image_url ? '' : `<span style="font-size:3.5rem;">${p.emoji}</span>`}
        ${p.badge ? `<span class="product-badge">${p.badge}</span>` : ''}
      </div>
      <div class="product-info">
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${p.description || ''}</div>
        <div class="product-meta">
          <span class="product-price">£${Number(p.price).toFixed(2)}</span>
          <button class="add-btn" onclick="addToCart(${p.id})">Add +</button>
        </div>
      </div>
    </div>`).join('');
}

function renderAdmin() {
  renderDashboard();
  renderOrdersTable();
  renderIngredients();
  renderProductMgmt();
  renderShipping();
}

function renderDashboard() {
  const total = orders.reduce((s, o) => s + parseFloat(o.total), 0);
  document.getElementById('stat-revenue').textContent = '£' + total.toFixed(2);
  document.getElementById('stat-orders').textContent = orders.length;
  document.getElementById('stat-pending').textContent = orders.filter(o => o.status === 'pending').length;
  
  const tbody = document.getElementById('dashboard-orders-body');
  tbody.innerHTML = orders.slice(0,5).map(o => `
    <tr><td>${o.id}</td><td>${o.fname}</td><td>£${o.total}</td><td>${o.status}</td><td>${o.date}</td></tr>
  `).join('');
}

function renderProductMgmt() {
  document.getElementById('product-mgmt-grid').innerHTML = products.map(p => `
    <div class="product-mgmt-card">
      <div class="pmc-emoji" style="background:${p.bg_color}">${p.emoji || '🍪'}</div>
      <div style="flex:1;"><strong>${p.name}</strong><br><small>£${p.price}</small></div>
      <button class="action-btn" onclick="editProduct(${p.id})">✏️</button>
      <button class="action-btn danger" onclick="deleteProduct(${p.id})">🗑</button>
    </div>`).join('');
}

function renderIngredients() {
  const tbody = document.getElementById('ingredients-body');
  tbody.innerHTML = ingredients.map(ing => `
    <tr>
        <td>${ing.name}</td><td>${ing.stock}</td><td>${ing.unit}</td>
        <td><div class="progress-bar-wrap"><div class="progress-bar prog-ok" style="width:70%"></div></div></td>
        <td><span class="badge badge-ok">OK</span></td>
        <td><button class="action-btn">+ Restock</button></td>
    </tr>`).join('');
}

function renderOrdersTable() {
  const tbody = document.getElementById('orders-body');
  tbody.innerHTML = orders.map(o => `
    <tr>
        <td>${o.id}</td><td>${o.fname} ${o.lname}</td><td>${o.items}</td><td>£${o.total}</td><td>${o.status}</td>
        <td><button class="action-btn primary" onclick="updateOrderStatus('${o.id}', 'shipped')">Ship</button></td>
    </tr>`).join('');
}

function renderShipping() {
  const el = document.getElementById('shipping-cards');
  const active = orders.filter(o => ['pending', 'shipped'].includes(o.status));
  el.innerHTML = active.map(o => `
    <div class="tracking-card">
        <div class="tracking-header"><span class="order-id">${o.id}</span></div>
        <div class="tracking-steps">
            <div class="tracking-step done"><div class="ts-dot">✓</div><div class="ts-label">Ordered</div></div>
            <div class="tracking-step ${o.status === 'shipped' ? 'current' : ''}"><div class="ts-dot">2</div><div class="ts-label">Shipped</div></div>
        </div>
    </div>`).join('');
}

// --- BASKET & CHECKOUT ---
function addToCart(id) {
  const p = products.find(x => x.id === id);
  const ex = cart.find(x => x.id === id);
  if(ex) ex.qty++; else cart.push({...p, qty:1});
  updateCartUI();
  showToast(`${p.name} added!`);
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
        <div class="cart-item-emoji">${item.emoji || '🍪'}</div>
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-qty">
            <button class="qty-btn" onclick="changeQty(${item.id},-1)">−</button>
            <span class="qty-num">${item.qty}</span>
            <button class="qty-btn" onclick="changeQty(${item.id},1)">+</button>
          </div>
        </div>
        <div style="font-weight:800;">£${(parseFloat(item.price) * item.qty).toFixed(2)}</div>
      </div>`).join('');
    document.getElementById('cart-total-amount').textContent = '£' + total.toFixed(2);
    document.getElementById('cart-footer').style.display = 'block';
  }
}

function changeQty(id, d) {
    const i = cart.find(x => x.id === id);
    if(i) { i.qty += d; if (i.qty <= 0) cart = cart.filter(x => x.id !== id); updateCartUI(); }
}
function toggleCart() { document.getElementById('cart-overlay').classList.toggle('open'); }
function closeCartOnOverlay(e) { if(e.target.id === 'cart-overlay') toggleCart(); }

function openCheckout() {
  if (cart.length === 0) return;
  const total = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0) + 3.50;
  document.getElementById('checkout-summary').innerHTML = cart.map(i => `<div class="os-item"><span>${i.name} ×${i.qty}</span><span>£${(parseFloat(i.price)*i.qty).toFixed(2)}</span></div>`).join('');
  document.getElementById('pay-amount').textContent = '£' + total.toFixed(2);
  
  if (STRIPE_PUBLISHABLE_KEY && !stripeInstance) {
      stripeInstance = Stripe(STRIPE_PUBLISHABLE_KEY);
      const elements = stripeInstance.elements();
      cardElement = elements.create('card');
      cardElement.mount('#card-element');
  }
  document.getElementById('checkout-modal').classList.add('open');
  toggleCart();
}

function closeCheckout() { document.getElementById('checkout-modal').classList.remove('open'); }

async function processPayment() {
    const btn = document.getElementById('pay-btn');
    btn.disabled = true; btn.textContent = 'Processing...';
    const total = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0) + 3.50;
    try {
        const res = await fetch(`${API_BASE}/create-payment-intent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: Math.round(total * 100) })
        });
        const { clientSecret } = await res.json();
        const { paymentIntent, error } = await stripeInstance.confirmCardPayment(clientSecret, {
            payment_method: { card: cardElement }
        });
        if (error) throw new Error(error.message);

        const oid = 'HG-' + Date.now().toString().slice(-6);
        await fetch(`${API_BASE}/orders`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: oid,
                fname: document.getElementById('ch-fname').value,
                lname: document.getElementById('ch-lname').value,
                email: document.getElementById('ch-email').value,
                address: document.getElementById('ch-address').value,
                items: cart.map(i => `${i.name} ×${i.qty}`).join(', '),
                total: total.toFixed(2),
                status: 'pending',
                date: new Date().toLocaleDateString('en-GB'),
                paymentIntentId: paymentIntent.id
            })
        });
        document.getElementById('checkout-content').style.display = 'none';
        document.getElementById('success-content').style.display = 'block';
        document.getElementById('success-order-num').textContent = 'Order: ' + oid;
        cart = []; updateCartUI();
    } catch (e) { document.getElementById('card-errors').textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = 'Place Order'; }
}

// --- ADMIN CRUD ---
function resetProductForm() {
    document.getElementById('prod-id').value = '';
    ['prod-name','prod-price','prod-emoji','prod-badge','prod-image','prod-desc'].forEach(id => document.getElementById(id).value = '');
}

function editProduct(id) {
    const p = products.find(x => x.id === id);
    document.getElementById('prod-id').value = p.id;
    document.getElementById('prod-name').value = p.name;
    document.getElementById('prod-price').value = p.price;
    document.getElementById('prod-emoji').value = p.emoji;
    document.getElementById('prod-badge').value = p.badge;
    document.getElementById('prod-image').value = p.image_url;
    document.getElementById('prod-desc').value = p.description;
    document.getElementById('product-form-title').textContent = "Edit Snack";
}

async function saveProduct() {
    const id = document.getElementById('prod-id').value;
    const payload = {
        name: document.getElementById('prod-name').value,
        price: parseFloat(document.getElementById('prod-price').value),
        emoji: document.getElementById('prod-emoji').value,
        badge: document.getElementById('prod-badge').value,
        image_url: document.getElementById('prod-image').value,
        description: document.getElementById('prod-desc').value,
        bg_color: document.getElementById('prod-bg').value
    };
    const url = id ? `${API_BASE}/admin/products/${id}` : `${API_BASE}/admin/products`;
    await fetch(url, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
        body: JSON.stringify(payload)
    });
    showToast('Product Saved!'); resetProductForm(); loadAdminData();
}

async function deleteProduct(id) {
    if(!confirm('Delete?')) return;
    await fetch(`${API_BASE}/admin/products/${id}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    showToast('Deleted'); loadAdminData();
}

async function updateOrderStatus(id, status) {
  await fetch(`${API_BASE}/admin/orders/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ status })
  });
  loadAdminData();
}

function showAdminSection(s, e) {
    document.querySelectorAll('.admin-section').forEach(el => el.classList.remove('active'));
    document.getElementById('section-' + s).classList.add('active');
    loadAdminData();
}

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
}

initApp();
