const request = require('supertest');
const { createApp, validateUser } = require('../server');

// A fake database: each test sets what the next query returns.
function fakeDb() {
  const db = {
    calls: [],
    next: { err: null, results: [] },
    query(sql, params, cb) {
      const callback = typeof params === 'function' ? params : cb;
      db.calls.push({ sql, params: typeof params === 'function' ? [] : params });
      callback(db.next.err, db.next.results);
    },
  };
  return db;
}

describe('validateUser', () => {
  test('accepts a valid user and normalises the email', () => {
    expect(validateUser({ name: ' Ada ', email: 'ADA@Test.io', role: 'Admin' }))
      .toEqual({ value: { name: 'Ada', email: 'ada@test.io', role: 'Admin' } });
  });
  test.each([
    [{ name: 'A', email: 'a@b.co', role: 'User' }, 'Name'],
    [{ name: 'Ada', email: 'not-an-email', role: 'User' }, 'Email'],
    [{ name: 'Ada', email: 'a@b.co', role: 'Root' }, 'Role'],
  ])('rejects invalid input %#', (body, word) => {
    expect(validateUser(body).error).toMatch(word);
  });
});

describe('Users API', () => {
  let db;
  let app;
  beforeEach(() => {
    db = fakeDb();
    app = createApp(db);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('GET /api/users returns the users', async () => {
    db.next.results = [{ id: 1, name: 'Ada', email: 'ada@test.io', role: 'User' }];
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('POST /api/users creates a user with a parameterised query', async () => {
    db.next.results = { insertId: 7 };
    const res = await request(app).post('/api/users').send({ name: 'Ada', email: 'ada@test.io', role: 'User' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(7);
    expect(db.calls[0].params).toEqual(['Ada', 'ada@test.io', 'User']);
  });

  test('POST /api/users rejects invalid input before touching the database', async () => {
    const res = await request(app).post('/api/users').send({ name: '<b>', email: 'x', role: 'User' });
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  test('POST /api/users returns 409 for a duplicate email', async () => {
    db.next.err = { code: 'ER_DUP_ENTRY' };
    const res = await request(app).post('/api/users').send({ name: 'Ada', email: 'ada@test.io', role: 'User' });
    expect(res.status).toBe(409);
  });

  test('database errors are not leaked to the client', async () => {
    db.next.err = { code: 'ER_ACCESS_DENIED_ERROR', message: "Access denied for user 'appuser'" };
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/appuser|Access denied/);
  });

  test('PUT /api/users/:id updates a user', async () => {
    db.next.results = { affectedRows: 1 };
    const res = await request(app).put('/api/users/3').send({ name: 'Ada', email: 'ada@test.io', role: 'Admin' });
    expect(res.status).toBe(200);
    expect(db.calls[0].params).toEqual(['Ada', 'ada@test.io', 'Admin', 3]);
  });

  test('PUT returns 404 when the user does not exist', async () => {
    db.next.results = { affectedRows: 0 };
    const res = await request(app).put('/api/users/99').send({ name: 'Ada', email: 'ada@test.io', role: 'User' });
    expect(res.status).toBe(404);
  });

  test('DELETE rejects a non-numeric id', async () => {
    const res = await request(app).delete('/api/users/1%20OR%201=1');
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  test('DELETE /api/users/:id deletes a user', async () => {
    db.next.results = { affectedRows: 1 };
    const res = await request(app).delete('/api/users/3');
    expect(res.status).toBe(200);
  });

  test('responses carry security headers and hide Express', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  test('no CORS header is sent to other origins', async () => {
    const res = await request(app).get('/api/users').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
