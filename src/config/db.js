const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

// Neon drops idle connections; without a listener pg-pool's 'error' event crashes the process.
// The pool discards the broken client on its own, so logging is enough.
pool.on('error', (err) => {
  console.error('Idle DB client error:', err.message);
});

module.exports = pool;
