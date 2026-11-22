const { requireEnv, initDatabase } = require('../server');

describe('requireEnv', () => {
  const saved = process.env.SECUREX_TEST_VAR;
  afterEach(() => {
    if (saved === undefined) delete process.env.SECUREX_TEST_VAR;
    else process.env.SECUREX_TEST_VAR = saved;
  });

  test('returns the value when the variable is set', () => {
    process.env.SECUREX_TEST_VAR = 'value';
    expect(requireEnv('SECUREX_TEST_VAR')).toBe('value');
  });

  test('throws when the variable is missing, so the app never starts without secrets', () => {
    delete process.env.SECUREX_TEST_VAR;
    expect(() => requireEnv('SECUREX_TEST_VAR')).toThrow('Missing required environment variable: SECUREX_TEST_VAR');
  });
});

describe('initDatabase', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('creates the users table on the first try', () => {
    const db = { query: jest.fn((sql, cb) => cb(null)) };
    initDatabase(db);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS users/);
  });

  test('retries with a delay while MySQL is still starting', () => {
    let attempts = 0;
    const db = {
      query: jest.fn((sql, cb) => {
        attempts += 1;
        cb(attempts < 3 ? { code: 'ECONNREFUSED' } : null);
      }),
    };
    initDatabase(db);
    expect(db.query).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2000);
    expect(db.query).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(4000);
    expect(db.query).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(60000);
    expect(db.query).toHaveBeenCalledTimes(3);
  });
});

describe('email validation', () => {
  const { validateUser } = require('../server');
  const ok = (email) => !validateUser({ name: 'Ada', email, role: 'User' }).error;

  test.each(['ada@example.com', 'a.b+tag@mail.example.co.uk'])('accepts %s', (email) => {
    expect(ok(email)).toBe(true);
  });

  test.each(['', 'ada', '@example.com', 'ada@', 'ada@example', 'ada@.com', 'ada@example.', 'a@b@c.com', 'ada @example.com'])(
    'rejects %p', (email) => {
      expect(ok(email)).toBe(false);
    });

  test('handles a very long hostile input quickly', () => {
    const start = Date.now();
    expect(ok('a@' + 'a.'.repeat(5000) + '@')).toBe(false);
    expect(Date.now() - start).toBeLessThan(50);
  });
});
