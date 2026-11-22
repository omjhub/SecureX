// SecureX API and static frontend server.
// Security notes:
//  - Database credentials come only from environment variables (synced from AWS Secrets Manager).
//  - The frontend is served from the same origin, so CORS is not enabled.
//  - Helmet sets security headers; X-Powered-By is removed.
//  - Inputs are validated on the server; clients get generic error messages.
const express = require('express');
const helmet = require('helmet');
const mysql = require('mysql2');
const path = require('path');

const ROLES = ['Admin', 'User'];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createPool() {
  return mysql.createPool({
    host: process.env.DB_HOST || 'mysql',
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    database: requireEnv('DB_NAME'),
    waitForConnections: true,
    connectionLimit: 10,
  });
}

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

function validateUser(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body.role;
  if (name.length < 2 || name.length > 100) return { error: 'Name must be 2 to 100 characters.' };
  if (!isValidEmail(email)) return { error: 'Email address is not valid.' };
  if (!ROLES.includes(role)) return { error: 'Role must be Admin or User.' };
  return { value: { name, email, role } };
}

function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));

  const fail = (res, err) => {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }
    console.error('Database error:', err && err.code ? err.code : err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  };

  app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

  app.get('/api/users', (req, res) => {
    db.query('SELECT id, name, email, role FROM users ORDER BY id', (err, results) => {
      if (err) return fail(res, err);
      return res.json(results);
    });
  });

  app.post('/api/users', (req, res) => {
    const check = validateUser(req.body || {});
    if (check.error) return res.status(400).json({ error: check.error });
    const { name, email, role } = check.value;
    db.query('INSERT INTO users (name, email, role) VALUES (?, ?, ?)', [name, email, role], (err, results) => {
      if (err) return fail(res, err);
      return res.status(201).json({ id: results.insertId, name, email, role });
    });
  });

  app.put('/api/users/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid user id.' });
    const check = validateUser(req.body || {});
    if (check.error) return res.status(400).json({ error: check.error });
    const { name, email, role } = check.value;
    db.query('UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?', [name, email, role, id], (err, results) => {
      if (err) return fail(res, err);
      if (results.affectedRows === 0) return res.status(404).json({ error: 'User not found.' });
      return res.status(200).json({ id, name, email, role });
    });
  });

  app.delete('/api/users/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid user id.' });
    db.query('DELETE FROM users WHERE id = ?', [id], (err, results) => {
      if (err) return fail(res, err);
      if (results.affectedRows === 0) return res.status(404).json({ error: 'User not found.' });
      return res.status(200).json({ message: 'User deleted.' });
    });
  });

  const publicDir = path.join(__dirname, '../client/public');
  app.use(express.static(publicDir));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  return app;
}

// Create the users table, retrying while MySQL starts up instead of crashing.
function initDatabase(db, attempt = 1) {
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      role ENUM('Admin', 'User') NOT NULL
    )
  `;
  db.query(createUsersTable, (err) => {
    if (!err) {
      console.log('Users table ready.');
      return;
    }
    const wait = Math.min(30, attempt * 2);
    console.error(`Database not ready (${err.code}), retrying in ${wait}s (attempt ${attempt})`);
    setTimeout(() => initDatabase(db, attempt + 1), wait * 1000);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 5000;
  const db = createPool();
  initDatabase(db);
  createApp(db).listen(port, () => console.log(`Server listening on port ${port}`));
}

module.exports = { createApp, validateUser, requireEnv, initDatabase };
