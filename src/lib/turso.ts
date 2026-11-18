//process.env.PRIVATE_TURSO_PLATFORM_TOKEN
//PRIVATE_TURSO_DATABASE_URL

/*

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  description TEXT,
  pub_date TEXT NOT NULL,
  rubric TEXT,
  genre TEXT,
  authors TEXT, -- JSON-строка или массив
  tags TEXT,    -- JSON-строка или массив
  draft INTEGER DEFAULT 0,
  content TEXT NOT NULL, -- Сам текст статьи (Markdown или HTML)
  reading_time TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

*/

import { createClient } from "@libsql/client";

// Инициализация клиента Turso
const turso = createClient({
  url: import.meta.env.PRIVATE_TURSO_DATABASE_URL || process.env.PRIVATE_TURSO_DATABASE_URL || "",
  authToken: import.meta.env.PRIVATE_TURSO_AUTH_TOKEN || process.env.PRIVATE_TURSO_AUTH_TOKEN || "",
});
