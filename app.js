// --- CONFIGURATION & STATE ---
// This tells the app to look for your Netlify functions
const API_BASE = window.location.origin + '/api'; 
let adminToken = localStorage.getItem('hg_admin_token') || null; 

let STRIPE_PUBLISHABLE_KEY = ''; 
let BACKEND_URL = `${API_BASE}/create-payment-intent`;

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

// --- FETCH STRIPE KEY FROM NETLIFY ---
async function fetchConfig() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        if (res.ok) {
            const data = await res.json();
            STRIPE_PUBLISHABLE_KEY = data.stripePublishableKey;
        }
    } catch (e) {
        console.error("Stripe config fetch failed.");
    }
}

// --- FETCH PRODUCTS FROM NEON DATABASE ---
async function fetchProducts() {
    try {
        const res = await fetch(`${API_BASE}/products`);
        if (!res.ok) throw new Error(`DB Status: ${res.status}`);
        
        products = await res.json();
        
        // Hide the loading message and show the grid
        document.getElementById('shop-loading').style.display = 'none';
        document.getElementById('products-grid').style.display = 'grid';
        
        renderShop();
    } catch (error) {
        document.getElementById('shop-loading').innerHTML = 
            `<div style="color:var(--danger); padding: 2rem; font-weight:800;">Database Connection Error.</div>`;
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

// --- AUTH & ADMIN DATA ---
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
      } else { showToast('Invalid credentials'); }
  } catch (error) { showToast('Auth Server Unreachable.'); }
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

// --- SHOP RENDERING ---
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

// --- BASKET & MODALS ---
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
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div style="font-weight:800;">£${(parseFloat(item.price) * item.qty).toFixed(2)}</div>
        </div>
        <button class="remove-item" onclick="removeFromCart(${item.id})">🗑</button>
      </div>`).join('');
    document.getElementById('cart-total-amount').textContent = '£' + total.toFixed(2);
    document.getElementById('cart-footer').style.display = 'block';
  }
}

// Modal Toggle Functions
function toggleCart() { document.getElementById('cart-overlay').classList.toggle('open'); }
function closeCartOnOverlay(e) { if(e.target.id === 'cart-overlay') toggleCart(); }
function removeFromCart(id) { cart = cart.filter(x => x.id !== id); updateCartUI(); }

// --- CHECKOUT ---
function openCheckout() {
  if (cart.length === 0) return;
  const total = cart.reduce((s, x) => s + parseFloat(x.price) * x.qty, 0) + 3.50;
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

// --- ADMIN MGT ---
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
    try {
        const url = id ? `${API_BASE}/admin/products/${id}` : `${API_BASE}/admin/products`;
        await fetch(url, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
            body: JSON.stringify(payload)
        });
        showToast('Saved to cloud!'); loadAdminData();
    } catch (e) { showToast('Sync failed'); }
}

function showToast(msg) { 
  const t = document.getElementById('toast'); 
  t.textContent = msg; 
  t.classList.add('show'); 
  setTimeout(() => t.classList.remove('show'), 2500); 
}

initApp();
