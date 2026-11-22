// DevSecOps OMJ - User Management UI
// All user data is rendered with textContent / DOM APIs (never innerHTML),
// so names or emails containing HTML or script cannot execute in the page.

const API = '/api/users';
const ROLES = ['User', 'Admin'];

const state = {
  users: [],
  filter: 'All',
  search: '',
  editingId: null,
  deletingId: null,
};

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

document.addEventListener('DOMContentLoaded', () => {
  bindForm();
  bindToolbar();
  bindModals();
  void fetchUsers(); // errors are handled inside fetchUsers
});

// ---------- API ----------

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && (body.error || body.message)) message = body.error || body.message;
    } catch { /* no JSON body */ }
    throw new Error(message);
  }
  try { return await res.json(); } catch { return null; }
}

async function fetchUsers() {
  try {
    const data = await request(API);
    state.users = Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Error fetching users:', err);
    state.users = [];
    toast('Could not load users. Please try again.', 'error');
  }
  render();
}

// ---------- Validation ----------

// Checks an email address without a regular expression, so a long or crafted
// input cannot cause slow backtracking (ReDoS). Rules: at most 254 characters,
// no whitespace, exactly one "@" with text before it, and a domain with a dot
// that is not its first or last character.
function isValidEmail(email) {
  if (email.length === 0 || email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

function cleanInput(name, email, role) {
  const n = String(name || '').trim();
  const e = String(email || '').trim().toLowerCase();
  if (n.length < 2) return { error: 'Please enter a name (at least 2 characters).' };
  if (n.length > 100) return { error: 'Name is too long.' };
  if (!isValidEmail(e)) return { error: 'Please enter a valid email address.' };
  if (!ROLES.includes(role)) return { error: 'Please choose a valid role.' };
  return { value: { name: n, email: e, role } };
}

// ---------- Add user ----------

function bindForm() {
  const form = $('addUserForm');
  const btn = $('submitBtn');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const role = form.querySelector('input[name="role"]:checked').value;
    const result = cleanInput($('name').value, $('email').value, role);
    if (result.error) return toast(result.error, 'error');

    btn.disabled = true;
    try {
      await request(API, { method: 'POST', body: JSON.stringify(result.value) });
      form.reset();
      $('roleUser').checked = true;
      toast(`${result.value.name} was added.`);
      await fetchUsers();
    } catch (err) {
      console.error('Error adding user:', err);
      toast(err.message || 'Could not add user.', 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Search and filter ----------

function bindToolbar() {
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderList();
  });

  document.querySelectorAll('.filters button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.filters button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.filter = b.getAttribute('data-filter');
      renderList();
    });
  });

  // Event delegation for edit and delete buttons
  $('userList').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const user = state.users.find((u) => String(u.id) === id);
    if (!user) return;
    if (btn.getAttribute('data-action') === 'edit') openEdit(user);
    if (btn.getAttribute('data-action') === 'delete') openDelete(user);
  });
}

// ---------- Modals ----------

function bindModals() {
  document.querySelectorAll('.modal-backdrop').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.hasAttribute('data-close')) closeModal(m);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop.open').forEach(closeModal);
  });

  $('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = cleanInput($('editName').value, $('editEmail').value, $('editRole').value);
    if (result.error) return toast(result.error, 'error');
    try {
      await request(`${API}/${encodeURIComponent(state.editingId)}`, {
        method: 'PUT',
        body: JSON.stringify(result.value),
      });
      closeModal($('editModal'));
      toast('User updated.');
      await fetchUsers();
    } catch (err) {
      console.error('Error updating user:', err);
      toast(err.message || 'Could not update user.', 'error');
    }
  });

  $('confirmDelete').addEventListener('click', async () => {
    try {
      await request(`${API}/${encodeURIComponent(state.deletingId)}`, { method: 'DELETE' });
      closeModal($('deleteModal'));
      toast('User deleted.');
      await fetchUsers();
    } catch (err) {
      console.error('Error deleting user:', err);
      toast(err.message || 'Could not delete user.', 'error');
    }
  });
}

function openModal(m) {
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  const first = m.querySelector('input, select, button');
  if (first) setTimeout(() => first.focus(), 50);
}

function closeModal(m) {
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
}

function openEdit(user) {
  state.editingId = user.id;
  $('editName').value = user.name || '';
  $('editEmail').value = user.email || '';
  $('editRole').value = ROLES.includes(user.role) ? user.role : 'User';
  openModal($('editModal'));
}

function openDelete(user) {
  state.deletingId = user.id;
  $('deleteText').textContent = `${user.name} (${user.email}) will be permanently removed.`;
  openModal($('deleteModal'));
}

// ---------- Rendering ----------

function render() {
  renderStats();
  renderList();
}

function renderStats() {
  const admins = state.users.filter((u) => u.role === 'Admin').length;
  $('statTotal').textContent = state.users.length;
  $('statAdmins').textContent = admins;
  $('statUsers').textContent = state.users.length - admins;
}

function renderList() {
  const list = $('userList');
  const visible = state.users.filter((u) => {
    if (state.filter !== 'All' && u.role !== state.filter) return false;
    if (!state.search) return true;
    return `${u.name} ${u.email}`.toLowerCase().includes(state.search);
  });

  const total = state.users.length;
  $('listSummary').textContent = total === 0
    ? 'No users yet'
    : `Showing ${visible.length} of ${total} user${total === 1 ? '' : 's'}`;

  list.replaceChildren();

  if (visible.length === 0) {
    const li = el('li', 'empty');
    li.appendChild(icon('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'));
    li.appendChild(el('strong', null, total === 0 ? 'No users yet' : 'No matching users'));
    li.appendChild(el('span', null, total === 0
      ? 'Add your first user with the form.'
      : 'Try a different search or filter.'));
    list.appendChild(li);
    return;
  }

  visible.forEach((user) => list.appendChild(userRow(user)));
}

function userRow(user) {
  const li = el('li', 'user-item');

  const avatar = el('div', 'avatar', initials(user.name));
  avatar.style.background = avatarColor(user.email || user.name || '');
  avatar.setAttribute('aria-hidden', 'true');

  const info = el('div', 'user-info');
  info.appendChild(el('div', 'user-name', user.name));
  info.appendChild(el('div', 'user-email', user.email));

  const isAdmin = user.role === 'Admin';
  const badge = el('span', `badge ${isAdmin ? 'admin' : 'user'}`, isAdmin ? 'Admin' : 'User');

  const actions = el('div', 'actions');
  actions.appendChild(actionButton('edit', user, 'Edit',
    'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z'));
  actions.appendChild(actionButton('delete', user, 'Delete',
    'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'));

  li.append(avatar, info, badge, actions);
  return li;
}

function actionButton(action, user, label, path) {
  const b = el('button', `icon-btn ${action}`);
  b.type = 'button';
  b.setAttribute('data-action', action);
  b.setAttribute('data-id', String(user.id));
  b.setAttribute('aria-label', `${label} ${user.name}`);
  b.title = label;
  b.appendChild(icon(path));
  return b;
}

// ---------- Helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function icon(d) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

function avatarColor(seed) {
  const palettes = [
    ['#22d3ee', '#0e7490'], ['#8b5cf6', '#5b21b6'], ['#34d399', '#047857'],
    ['#f472b6', '#9d174d'], ['#fbbf24', '#b45309'], ['#60a5fa', '#1d4ed8'],
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const [a, b] = palettes[h % palettes.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

function toast(message, type = 'success') {
  const t = el('div', `toast ${type === 'error' ? 'error' : ''}`, message);
  $('toasts').appendChild(t);
  setTimeout(() => t.classList.add('hide'), 3200);
  setTimeout(() => t.remove(), 3600);
}
