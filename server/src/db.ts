import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const pilots = sqliteTable('pilots', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  callsign: text('callsign').notNull(),
  tailColor: text('tail_color').notNull().default('red'),
  invertY: integer('invert_y', { mode: 'boolean' }).notNull().default(false),
  sensitivity: real('sensitivity').notNull().default(1.0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const seeds = sqliteTable('seeds', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  preset: text('preset').notNull(),
  upvotes: integer('upvotes').notNull().default(0),
  creatorCallsign: text('creator_callsign').notNull(),
  createdAt: text('created_at').notNull(),
});

export const postcards = sqliteTable('postcards', {
  id: text('id').primaryKey(),
  seedCode: text('seed_code').notNull(),
  preset: text('preset').notNull(),
  callsign: text('callsign').notNull(),
  imageDataUrl: text('image_data_url').notNull(),
  altitude: integer('altitude').notNull(),
  speed: integer('speed').notNull(),
  gLoad: real('g_load').notNull(),
  heading: integer('heading').notNull(),
  createdAt: text('created_at').notNull(),
});

export const sorties = sqliteTable('sorties', {
  id: text('id').primaryKey(),
  seedCode: text('seed_code').notNull(),
  callsign: text('callsign').notNull(),
  clearTimeMs: integer('clear_time_ms').notNull(),
  ringsCount: integer('rings_count').notNull(),
  createdAt: text('created_at').notNull(),
});

export function createDatabase(dbPath: string) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pilots (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      callsign TEXT NOT NULL,
      tail_color TEXT NOT NULL DEFAULT 'red',
      invert_y INTEGER NOT NULL DEFAULT 0,
      sensitivity REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seeds (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      preset TEXT NOT NULL,
      upvotes INTEGER NOT NULL DEFAULT 0,
      creator_callsign TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS postcards (
      id TEXT PRIMARY KEY,
      seed_code TEXT NOT NULL,
      preset TEXT NOT NULL,
      callsign TEXT NOT NULL,
      image_data_url TEXT NOT NULL,
      altitude INTEGER NOT NULL,
      speed INTEGER NOT NULL,
      g_load REAL NOT NULL,
      heading INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sorties (
      id TEXT PRIMARY KEY,
      seed_code TEXT NOT NULL,
      callsign TEXT NOT NULL,
      clear_time_ms INTEGER NOT NULL,
      rings_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const db = drizzle(sqlite, {
    schema: { pilots, seeds, postcards, sorties },
  });

  // Seed initial curated worlds if empty
  const existing = sqlite.prepare('SELECT COUNT(*) AS cnt FROM seeds').get() as { cnt: number };
  if (existing.cnt === 0) {
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      'INSERT INTO seeds (code, name, preset, upvotes, creator_callsign, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insert.run('LAKE-4821', 'Autumn Basin', 'last-light', 12, 'FALCON-1', now);
    insert.run('CRAG-7712', 'Copper Ridge', 'crimson-dusk', 8, 'VIXEN-7', now);
    insert.run('PINE-3094', 'North Fjord', 'high-alpine', 6, 'KESTREL', now);
  }

  return { db, sqlite };
}
