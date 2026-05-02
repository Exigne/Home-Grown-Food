// --- CONFIGURATION & STATE ---
const API_BASE = 'http://localhost:3000/api'; // We will change this when you deploy the backend
let adminToken = localStorage.getItem('hg_admin_token') || null;

let STRIPE_PUBLISHABLE_KEY = localStorage.getItem('hg_stripe_key') || '';
let BACKEND_URL = localStorage.getItem('hg_backend_url') || '';

let cart = [];
let orders = [];      // Will be populated from Neon DB
let ingredients = []; // Will be populated from Neon DB
let stripeInstance = null;
let cardElement = null;

// --- PRODUCT DATA ---
const PRODUCTS = [
  {id:1, name:'Honey Oat Clusters', emoji:'🍯', price:5.50, desc:'Golden oat clusters with local honey & toasted almonds', bg:'#FFF8D0', badge:'Best Seller'},
  {id:2, name:'Chilli Lime Popcorn', emoji:'🍿', price:4.00, desc:'Air-popped corn with zesty lime & a gentle chilli kick', bg:'#FFF0E8', badge:''},
  {id:3, name:'Rosemary Crackers', emoji:'🌿', price:4.50, desc:'Thin, crisp crackers with fresh rosemary & sea salt', bg:'#EDFAE0', badge:''},
  {id:4, name:'Dark Chocolate Bark', emoji:'🍫', price:6.50, desc:'72% dark chocolate with pistachios & dried cranberries', bg:'#F8F0E8', badge:'New'},
  {id:5, name:'Spiced Nut Mix', emoji:'🥜', price:5.00, desc:'Cashews, almonds & walnuts roasted with warming spices', bg:'#FFF5E0', badge:''},
  {id:6, name:'Lemon Shortbread', emoji:'🍋', price:5.50, desc:'Buttery shortbread infused with real lemon zest', bg:'#FFFFF0', badge:'New'},
];


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
          loadAdminData(); // Fetch secure data from Neon
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
          document.getElementById('admin-login-screen').style.display = 'none';
          document.getElementById('admin-layout').style.display = 'grid';
          loadAdminData();
      } else {
          showToast('Invalid credentials');
      }
  } catch (error) {
      showToast('Cannot connect to backend server.');
  }
}

async function loadAdminData() {
  try {
      // Fetch Orders
      const orderRes = await fetch(`${API_BASE}/admin/orders`, {
          headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      if(orderRes.ok) orders = await orderRes.json();

      // Fetch Ingredients
      const ingRes = await fetch(`${API_BASE}/admin/ingredients`, {
          headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      if(ingRes.ok) ingredients = await ingRes.json();

      renderAdmin();
  } catch (error) {
      console.error("Failed to load admin data", error);
      if (error.message.includes('token')) {
          adminToken = null;
          localStorage.removeItem('hg_admin_token');
          showView('admin'); // Kick back to login
      }
  }
}


// --- SHOP & CART LOGIC ---
function renderShop() {
  const grid = document.getElementById('products-grid');
  grid.innerHTML = PRODUCTS.map(p => `
    <div class="product-card">
      <div class="product-img" style="background:${p.bg};">
        <span style="font-size:3.5rem;">${p.emoji}</span>
        ${p.badge ? `<span class="product-badge">${p.badge}</span>` : ''}
      </div>
      <div class="product-info">
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${p.desc}</div>
        <div class="product-meta">
          <span class="product-price">£${p.price.toFixed(2)}</span>
          <button class="add-btn" id="add-btn-${p.id}" onclick="addToCart(${p.id})">Add +</button>
        </div>
      </div>
    </div>`).join('');
}

function addToCart(id) {
  const p = PRODUCTS.find(x => x.id === id);
  const ex = cart.find(x => x.id === id);
  if(ex) ex.qty++; else cart.push({...p, qty:1});
  updateCartUI();
  const btn = document.getElementById('add-btn-'+id);
  btn.textContent = '✓ Added'; btn.classList.add('added');
  setTimeout(() => { btn.textContent = 'Add +'; btn.classList.remove('added'); }, 1500);
  showToast(`${p.emoji} ${p.name} added!`);
}

function removeFromCart(id) { cart = cart.filter(x => x.id !== id); updateCartUI(); }

function changeQty(id, d) {
  const i = cart.find(x => x.id === id);
  if(!i) return;
  i.qty += d;
  if(i.qty <= 0) removeFromCart(id); else updateCartUI();
}

function updateCartUI() {
  const total = cart.reduce((s, x) => s + x.price * x.qty, 0);
  const count = cart.reduce((s, x) => s + x.qty, 0);
  document.getElementById('cart-count').textContent = count;
  const itemsEl = document.getElementById('cart-items');
  const footerEl = document.getElementById('cart-footer');
  
  if (cart.length === 0) {
    itemsEl.innerHTML = `<div class="empty-cart"><div class="ec-icon">🧺</div><p style="font-weight:700;">Your basket is empty</p></div>`;
    footerEl.style.display = 'none';
  } else {
    itemsEl.innerHTML = cart.map(item => `
      <div class="cart-item">
        <div class="cart-item-emoji">${item.emoji}</div>
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-price">£${item.price.toFixed(2)} each</div>
          <div class="cart-item-qty">
            <button class="qty-btn" onclick="changeQty(${item.id}, -1)">−</button>
            <span class="qty-num">${item.qty}</span>
            <button class="qty-btn" onclick="changeQty(${item.id}, 1)">+</button>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:800;font-size:0.9rem;color:var(--green-dark);">£${(item.price * item.qty).toFixed(2)}</div>
          <button class="remove-item" onclick="removeFromCart(${item.id})" style="margin-top:8px;">🗑</button>
        </div>
      </div>`).join('');
    document.getElementById('cart-total-amount').textContent = '£' + total.toFixed(2);
    footerEl.style.display = 'block';
  }
}

function toggleCart() { document.getElementById('cart-overlay').classList.toggle('open'); }
function closeCartOnOverlay(e) { if(e.target === document.getElementById('cart-overlay')) toggleCart(); }


// --- CHECKOUT & STRIPE ---
function openCheckout() {
  if (cart.length === 0) return;
  const total = cart.reduce((s, x) => s + x.price * x.qty, 0);
  const shipping = 3.50; 
  const grand = total + shipping;
  
  document.getElementById('checkout-summary').innerHTML =
    cart.map(i => `<div class="os-item"><span>${i.emoji} ${i.name} ×${i.qty}</span><span>£${(i.price * i.qty).toFixed(2)}</span></div>`).join('') +
    `<div class="os-item"><span>Shipping</span><span>£${shipping.toFixed(2)}</span></div>
     <div class="os-item total"><span>Total</span><span>£${grand.toFixed(2)}</span></div>`;
  
  document.getElementById('pay-amount').textContent = '£' + grand.toFixed(2);
  document.getElementById('checkout-content').style.display = 'block';
  document.getElementById('success-content').style.display = 'none';
  
  if (STRIPE_PUBLISHABLE_KEY) {
    document.getElementById('stripe-card-section').style.display = 'block';
    if (!stripeInstance) {
      stripeInstance = Stripe(STRIPE_PUBLISHABLE_KEY);
      const elements = stripeInstance.elements();
      cardElement = elements.create('card', {style: {base: {fontFamily: "'Nunito',sans-serif", fontSize: '15px', color: '#0E3019'}}});
      cardElement.mount('#card-element');
    }
  }
  
  document.getElementById('checkout-modal').classList.add('open');
  toggleCart();
}

function closeCheckout() { document.getElementById('checkout-modal').classList.remove('open'); }

async function processPayment() {
  const fname = document.getElementById('ch-fname').value.trim();
  const lname = document.getElementById('ch-lname').value.trim();
  const email = document.getElementById('ch-email').value.trim();
  const address = document.getElementById('ch-address').value.trim();
  const city = document.getElementById('ch-city').value.trim();
  const postcode = document.getElementById('ch-postcode').value.trim();
  
  if(!fname || !lname || !email || !address || !city || !postcode) {
      showToast('Please fill in all delivery details'); return;
  }
  
  const btn = document.getElementById('pay-btn');
  btn.disabled = true; 
  btn.textContent = 'Processing...';
  const total = cart.reduce((s, x) => s + x.price * x.qty, 0) + 3.50;
  let paymentOk = false;

  // Process Stripe if configured
  if (STRIPE_PUBLISHABLE_KEY && BACKEND_URL) {
    try {
      const res = await fetch(BACKEND_URL, {
          method: 'POST', 
          headers: {'Content-Type': 'application/json'}, 
          body: JSON.stringify({ amount: Math.round(total * 100), currency: 'gbp' })
      });
      const { clientSecret } = await res.json();
      const { error } = await stripeInstance.confirmCardPayment(clientSecret, {
          payment_method: { card: cardElement, billing_details: { name: fname + ' ' + lname, email } }
      });
      
      if (error) {
          document.getElementById('card-errors').textContent = error.message;
          btn.disabled = false; btn.innerHTML = `🌿 Place Order — £${total.toFixed(2)}`;
          return;
      }
      paymentOk = true;
    } catch(e) {
      document.getElementById('card-errors').textContent = 'Payment error. Please try again.';
      btn.disabled = false; btn.innerHTML = `🌿 Place Order — £${total.toFixed(2)}`;
      return;
    }
  } else {
      // Demo Mode Fallback
      await new Promise(r => setTimeout(r, 700));
      paymentOk = true;
  }

  if (paymentOk) {
    const oid = 'HG-' + Date.now().toString().slice(-6);
    const newOrder = {
        id: oid, fname, lname, email, 
        address: `${address}, ${city}, ${postcode}`, 
        items: cart.map(i => `${i.name} ×${i.qty}`).join(', '), 
        total: total.toFixed(2), 
        status: 'pending', 
        date: new Date().toLocaleDateString('en-GB')
    };

    // SEND ORDER TO BACKEND
    try {
        await fetch(`${API_BASE}/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newOrder)
        });
        
        cart = [];
        updateCartUI();
        document.getElementById('success-order-num').textContent = 'Order: ' + oid;
        document.getElementById('checkout-content').style.display = 'none';
        document.getElementById('success-content').style.display = 'block';
        showToast('🎉 Order placed!');
    } catch (error) {
        showToast('Error saving order. Please contact support.');
    } finally {
        btn.disabled = false;
    }
  }
}


// --- ADMIN UI RENDERING ---
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
  renderShipping();
  renderIngredients();
  renderPayments();
  renderProductMgmt();
}

function renderDashboard() {
  const total = orders.reduce((s, o) => s + parseFloat(o.total), 0);
  document.getElementById('stat-revenue').textContent = '£' + total.toFixed(2);
  document.getElementById('stat-orders').textContent = orders.length;
  document.getElementById('stat-pending').textContent = orders.filter(o => o.status === 'pending').length;
  
  // Notice ingredients use _stock suffix based on database columns
  document.getElementById('stat-lowstock').textContent = ingredients.filter(i => parseFloat(i.stock) < parseFloat(i.min_stock)).length;
  
  const tbody = document.getElementById('dashboard-orders-body');
  tbody.innerHTML = orders.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem;">No orders yet</td></tr>' :
    orders.slice(0, 5).map(o => `<tr><td><strong>${o.id}</strong></td><td>${o.fname} ${o.lname}</td><td>${o.items.substring(0,35)}${o.items.length>35?'...':''}</td><td><strong>£${o.total}</strong></td><td><span class="badge badge-${o.status}">${o.status}</span></td><td>${o.date}</td></tr>`).join('');
}

function renderOrdersTable() {
  const tbody = document.getElementById('orders-body');
  tbody.innerHTML = orders.length === 0 ? '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2rem;">No orders yet.</td></tr>' :
    orders.map(o => `<tr>
      <td><strong>${o.id}</strong></td>
      <td>${o.fname} ${o.lname}<br><small style="color:var(--text-muted)">${o.email}</small></td>
      <td style="font-size:0.8rem;">${o.address}</td>
      <td style="font-size:0.82rem;">${o.items}</td>
      <td><strong>£${o.total}</strong></td>
      <td><span class="badge badge-${o.status}">${o.status}</span></td>
      <td>
        ${o.status === 'pending' ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}', 'processing')">Process</button>` : ''}
        ${o.status === 'processing' ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}', 'shipped')">Ship</button>` : ''}
        ${o.status === 'shipped' ? `<button class="action-btn" onclick="updateOrderStatus('${o.id}', 'delivered')">Delivered</button>` : ''}
        <button class="action-btn danger" onclick="cancelOrder('${o.id}')">Cancel</button>
      </td></tr>`).join('');
}

function renderShipping() {
  const el = document.getElementById('shipping-cards');
  const active = orders.filter(o => ['processing', 'shipped'].includes(o.status));
  if(active.length === 0) { el.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;font-weight:600;">No active shipments yet.</p>'; return; }
  const steps = ['Ordered', 'Processing', 'Dispatched', 'In Transit', 'Delivered'];
  
  el.innerHTML = active.map(o => {
    const si = o.status === 'processing' ? 1 : o.status === 'shipped' ? 3 : 4;
    return `<div class="tracking-card">
      <div class="tracking-header"><span class="order-id">${o.id}</span><span class="badge badge-${o.status}">${o.status}</span><span style="color:var(--text-muted);font-size:0.85rem;font-weight:600;margin-left:auto;">${o.fname} ${o.lname}</span></div>
      <div style="font-size:0.82rem;color:var(--text-muted);font-weight:600;margin-bottom:1rem;">${o.items}</div>
      <div class="tracking-steps">${steps.map((s, i) => `<div class="tracking-step ${i < si ? 'done' : ''} ${i === si ? 'current' : ''}"><div class="ts-dot">${i < si ? '✓' : i + 1}</div><div class="ts-label">${s}</div></div>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:1.5rem;align-items:center;">
        ${o.status === 'processing' ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}', 'shipped')">Mark Shipped</button>` : ''}
        ${o.status === 'shipped' ? `<button class="action-btn primary" onclick="updateOrderStatus('${o.id}', 'delivered')">Mark Delivered</button>` : ''}
      </div></div>`;
  }).join('');
}

function renderIngredients() {
  const tbody = document.getElementById('ingredients-body');
  tbody.innerHTML = ingredients.map(ing => {
    const stock = parseFloat(ing.stock);
    const max = parseFloat(ing.max_stock);
    const min = parseFloat(ing.min_stock);
    
    const pct = Math.min(100, Math.round((stock / max) * 100));
    const status = stock < min ? (stock < min * 0.5 ? 'critical' : 'low') : 'ok';
    
    return `<tr>
      <td><strong>${ing.name}</strong></td>
      <td>${stock} / ${max}</td>
      <td>${ing.unit}</td>
      <td style="min-width:120px;"><div class="progress-bar-wrap"><div class="progress-bar prog-${status}" style="width:${pct}%;"></div></div></td>
      <td><span class="badge badge-${status}">${status}</span></td>
      <td>
        <button class="action-btn" onclick="restockIngredient(${ing.id})">+ Restock</button>
        <button class="action-btn danger" onclick="deleteIngredient(${ing.id})">Remove</button>
      </td>
    </tr>`;
  }).join('');
}

function renderPayments() {
  const total = orders.reduce((s, o) => s + parseFloat(o.total), 0);
  document.getElementById('pay-total').textContent = '£' + total.toFixed(2);
  document.getElementById('pay-count').textContent = orders.length;
  document.getElementById('pay-avg').textContent = orders.length ? '£' + (total / orders.length).toFixed(2) : '£0.00';
  
  const tbody = document.getElementById('payments-body');
  tbody.innerHTML = orders.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem;">No transactions yet.</td></tr>' :
    orders.map(o => `<tr><td><strong>${o.id}</strong></td><td>${o.fname} ${o.lname}</td><td><strong>£${o.total}</strong></td><td>${o.date}</td><td><span class="badge badge-paid">Paid</span></td></tr>`).join('');
}

function renderProductMgmt() {
  document.getElementById('product-mgmt-grid').innerHTML = PRODUCTS.map(p => `
    <div class="product-mgmt-card">
      <div class="pmc-emoji" style="background:${p.bg};">${p.emoji}</div>
      <div style="flex:1;"><div class="pmc-name">${p.name}</div><div class="pmc-stock">In production</div></div>
      <div class="pmc-price">£${p.price.toFixed(2)}</div>
    </div>`).join('');
}


// --- ADMIN ACTIONS (API CALLS) ---

function filterOrders(q) { document.querySelectorAll('#orders-body tr').forEach(r => { r.style.display = r.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none'; }); }
function filterOrdersByStatus(s) { document.querySelectorAll('#orders-body tr').forEach(r => { r.style.display = !s || r.textContent.toLowerCase().includes(s) ? '' : 'none'; }); }

async function updateOrderStatus(id, status) {
  try {
      await fetch(`${API_BASE}/admin/orders/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
          body: JSON.stringify({ status })
      });
      showToast(`Order ${id} updated to ${status}`);
      loadAdminData(); // Refresh UI
  } catch(e) { showToast('Failed to update order'); }
}

async function cancelOrder(id) {
  if(confirm(`Cancel order ${id}?`)) {
      await updateOrderStatus(id, 'cancelled');
  }
}

async function addIngredient() {
  const name = document.getElementById('ing-name').value.trim();
  const unit = document.getElementById('ing-unit').value.trim();
  const stock = parseFloat(document.getElementById('ing-stock').value) || 0;
  const min_stock = parseFloat(document.getElementById('ing-min').value) || 0;
  const max_stock = parseFloat(document.getElementById('ing-max').value) || 10;
  
  if(!name || !unit) { showToast('Please enter name and unit'); return; }
  
  try {
      await fetch(`${API_BASE}/admin/ingredients`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
          body: JSON.stringify({ name, unit, stock, min_stock, max_stock })
      });
      ['ing-name','ing-unit','ing-stock','ing-min','ing-max'].forEach(id => document.getElementById(id).value = '');
      showToast('✓ ' + name + ' added');
      loadAdminData();
  } catch(e) { showToast('Failed to add ingredient'); }
}

async function restockIngredient(id) {
  const ing = ingredients.find(i => i.id === id);
  if(!ing) return;
  const amt = parseFloat(prompt(`Add how much ${ing.unit} to ${ing.name}?`));
  
  if(!isNaN(amt) && amt > 0) {
      const newStock = Math.min(parseFloat(ing.max_stock), parseFloat(ing.stock) + amt);
      try {
          await fetch(`${API_BASE}/admin/ingredients/${id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
              body: JSON.stringify({ stock: newStock })
          });
          showToast('✓ Restocked ' + ing.name);
          loadAdminData();
      } catch(e) { showToast('Failed to restock'); }
  }
}

async function deleteIngredient(id) {
  const ing = ingredients.find(i => i.id === id);
  if(confirm(`Remove ${ing.name}?`)) {
      try {
          await fetch(`${API_BASE}/admin/ingredients/${id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${adminToken}` }
          });
          showToast('✓ Removed ' + ing.name);
          loadAdminData();
      } catch(e) { showToast('Failed to remove'); }
  }
}

// --- SETTINGS & UTILS ---
function saveSettings() {
  const key = document.getElementById('set-stripe-key').value.trim();
  const url = document.getElementById('set-backend-url').value.trim();
  if(key) { STRIPE_PUBLISHABLE_KEY = key; localStorage.setItem('hg_stripe_key', key); }
  if(url) { BACKEND_URL = url; localStorage.setItem('hg_backend_url', url); }
  showToast('✓ Settings saved!');
}

function loadSettings() {
  if(STRIPE_PUBLISHABLE_KEY) document.getElementById('set-stripe-key').value = STRIPE_PUBLISHABLE_KEY;
  if(BACKEND_URL) document.getElementById('set-backend-url').value = BACKEND_URL;
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// --- INITIALIZE ---
renderShop();
updateCartUI();
loadSettings();
