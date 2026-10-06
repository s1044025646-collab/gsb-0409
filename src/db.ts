import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leader INTEGER NOT NULL,
      trump TEXT,
      total_tricks INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS initial_hands (
      game_id INTEGER NOT NULL,
      seat INTEGER NOT NULL,
      ord INTEGER NOT NULL,
      suit TEXT NOT NULL,
      rank TEXT NOT NULL,
      PRIMARY KEY (game_id, seat, ord),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );
    CREATE TABLE IF NOT EXISTS play_events (
      game_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      seat INTEGER NOT NULL,
      suit TEXT NOT NULL,
      rank TEXT NOT NULL,
      request_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (game_id, seq),
      UNIQUE (game_id, request_id),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );
  `);
  return db;
}

export function closeDb(db: DatabaseSync): void {
  db.close();
}
