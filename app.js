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
            if (STRIPE_PUBLISHABLE_KEY && window.Stripe) {
                stripeInstance = Stripe(STRIPE_PUBLISHABLE_KEY);
            }
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

// --- NAVIGATION & AUTH ---
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

// --- MAIN RENDERERS ---
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
  renderPayments();
}

// --- ADMIN SUB-RENDERERS ---
function renderDashboard() {
  const total = orders.reduce((s, o) => s + parseFloat(o.total), 0);
  document.getElementById('stat-revenue').textContent = '£' + total.toFixed(2);
  document.getElementById('stat-orders').textContent = orders.length;
  document.getElementById('stat-pending').textContent = orders.filter(o => o.status === 'pending').length;
  document.getElementById('stat-lowstock').textContent = ingredients.filter(i => parseFloat(i.stock) < parseFloat(i.min_stock || 0)).length;

  const tbody = document.getElementById('dashboard-orders-body');
  tbody.innerHTML = orders.slice(0,5).map(o => `
    <tr><td><strong>${o.id}</strong></td><td>${o.fname}</td><td>£${o.total}</td><td><span class="badge badge-${o.status}">${o.status}</span></td><td>${o.date}</td></tr>
  `).join('');
}

function renderShipping() {
  const el = document.getElementById('shipping-cards');
  const active = orders.filter(o => ['pending', 'processing', 'shipped'].includes(o.status));
  if(active.length === 0) { el.innerHTML = "<p>No active shipments.</p>"; return; }
  
  const steps = ['Ordered', 'Processing', 'Dispatched', 'In Transit', 'Delivered'];
  el.innerHTML = active.map(o => {
    const si = o.status === 'pending' ? 0 : o.status === 'processing' ? 1 : 3;
    return `
      <div class="tracking-card">
        <div class="tracking-header"><span class="order-id">${o.id}</span> <span class="badge badge-${o.status}">${o.status}</span></div>
        <div class="tracking-steps">
          ${steps.map((s, i) => `
            <div class="tracking-step ${i <= si ? 'done' : ''} ${i === si ? 'current' : ''}">
              <div class="ts-dot">${i < si ? '✓' : i + 1}</div>
              <div class="ts-label">${s}</div>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderIngredients() {
  const tbody = document.getElementById('ingredients-body');
  tbody.innerHTML = ingredients.map((ing, idx) => {
      const pct = Math.min(100, (ing.stock / (ing.max_stock || 100)) * 100);
      const isLow = parseFloat(ing.stock) < parseFloat(ing.min_stock || 0);
      return `
        <tr>
            <td><strong>${ing.name}</strong></td><td>${ing.stock}</td><td>${ing.unit}</td>
            <td><div class="progress-bar-wrap"><div class="progress-bar ${isLow ? 'prog-critical' : 'prog-ok'}" style="width:${pct}%"></div></div></td>
            <td><span class="badge badge-${isLow ? 'low' : 'ok'}">${isLow ? 'Low' : 'OK'}</span></td>
            <td><button class="action-btn" onclick="restockIngredient(${idx})">+ Restock</button></td>
        </tr>`;
  }).join('');
}

function renderPayments() {
  const chart = document.getElementById('revenue-chart');
  if(!chart) return;
  const last7 = [];
  for(let i=6; i>=0; i--) {
      const d = new Date(); d.setDate(d.getDate()-i);
      const ds = d.toLocaleDateString('en-GB');
      const rev = orders.filter(o => o.date === ds).reduce((s, o) => s + parseFloat(o.total), 0);
      last7.push({ day: d.toLocaleDateString('en-GB', {weekday: 'short'}), val: rev });
  }
  const max = Math.max(...last7.map(d => d.val), 1);
  chart.innerHTML = last7.map(d => `
    <div class="chart-bar-wrap">
      <div class="chart-bar" style="height:${(d.val/max)*100}px"></div>
      <div class="chart-bar-label">${d.day}</div>
    </div>`).join('');

  const pBody = document.getElementById('payments-body');
  if(pBody) pBody.innerHTML = orders.map(o => `<tr><td>${o.id}</td><td>£${o.total}</td><td>${o.date}</td><td><span class="badge badge-paid">Paid</span></td></tr>`).join('');
}

// --- BASKET LOGIC ---
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

// --- CHECKOUT & STRIPE ---
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
                id: oid, fname: document.getElementById('ch-fname').value,
                lname: document.getElementById('ch-lname').value,
                email: document.getElementById('ch-email').value,
                address: document.getElementById('ch-address').value,
                items: cart.map(i => `${i.name} ×${i.qty}`).join(', '),
                total: total.toFixed(2), status: 'pending',
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

// --- ADMIN CRUD & MISC ---
function resetProductForm() {
    document.getElementById('prod-id').value = '';
    ['prod-name','prod-price','prod-emoji','prod-badge','prod-image','prod-desc'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('product-form-title').textContent = "Add New Snack";
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

async function restockIngredient(idx) {
    const ing = ingredients[idx];
    const amt = prompt(`Add how much ${ing.unit} to ${ing.name}?`);
    if(amt) {
        const newStock = parseFloat(ing.stock) + parseFloat(amt);
        await fetch(`${API_BASE}/admin/ingredients/${ing.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body: JSON.stringify({ stock: newStock })
        });
        loadAdminData();
    }
}

async function updateOrderStatus(id, status) {
  await fetch(`${API_BASE}/admin/orders/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ status })
  });
  loadAdminData();
}

function saveSettings() {
    const key = document.getElementById('set-stripe-key').value;
    const url = document.getElementById('set-backend-url').value;
    if(key) localStorage.setItem('hg_stripe_key', key);
    if(url) localStorage.setItem('hg_backend_url', url);
    showToast("Settings saved locally!");
}

function openReadme() { document.getElementById('readme-modal').classList.add('open'); }
function closeCheckout() { document.getElementById('checkout-modal').classList.remove('open'); }

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
}

initApp();
