const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// == PostgreSQL database for thread persistence ==
const db = require('./db');

// Init DB tables on startup (non-blocking)
if (process.env.DATABASE_URL) {
  db.initDB()
    .then(() => console.log('[DB] PostgreSQL ready'))
    .catch(e => console.error('[DB] Init error:', e.message));
} else {
  console.log('[DB] DATABASE_URL not set — thread persistence disabled');
}
