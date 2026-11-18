DROP TABLE IF EXISTS rubrics;
-- Таблица рубрик (1:M с постами)
CREATE TABLE IF NOT EXISTS rubrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

DROP TABLE IF EXISTS authors;
-- Таблица авторов
CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT
);

DROP TABLE IF EXISTS tags;
-- Таблица тегов
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

DROP TABLE IF EXISTS posts;
-- Основная таблица постов
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  source TEXT,
  genre TEXT,
  authors TEXT,
  tags TEXT,
  reading_time TEXT,
  content TEXT,
  htmlContent TEXT,
  rubric_id INTEGER,
  featured INTEGER DEFAULT 0,
  draft INTEGER DEFAULT 0,
  date TEXT NOT NULL,
  pub_date DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE SET NULL
);

DROP TABLE IF EXISTS posts_authors;
-- Связующая таблица: Посты <-> Авторы (M:N)
CREATE TABLE IF NOT EXISTS posts_authors (
  post_id INTEGER,
  author_id INTEGER,
  PRIMARY KEY (post_id, author_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
);

DROP TABLE IF EXISTS posts_tags;
-- Связующая таблица: Посты <-> Теги (M:N)
CREATE TABLE IF NOT EXISTS posts_tags (
  post_id INTEGER,
  tag_id INTEGER,
  PRIMARY KEY (post_id, tag_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

DROP TABLE IF EXISTS authors_rubrics;
-- Связующая таблица: Авторы <-> Рубрики (M:N)
CREATE TABLE IF NOT EXISTS authors_rubrics (
  author_id INTEGER,
  rubric_id INTEGER,
  PRIMARY KEY (author_id, rubric_id),
  FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE,
  FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE CASCADE
);

-- Индексы производительности
CREATE INDEX IF NOT EXISTS idx_posts_draft_pubdate ON posts(draft, pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_posts_rubric ON posts(rubric_id);

DROP TABLE IF EXISTS posts_fts;
-- FTS5 полнотекстовый поиск
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title,
  subtitle,
  content,
  content='posts',
  content_rowid='id'
);

-- Триггеры автоматической синхронизации FTS
CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, subtitle, content)
  VALUES (new.id, new.title, new.subtitle, new.content);
END;

CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, subtitle, content)
  VALUES('delete', old.id, old.title, old.subtitle, old.content);
END;

CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, subtitle, content)
  VALUES('delete', old.id, old.title, old.subtitle, old.content);
  INSERT INTO posts_fts(rowid, title, subtitle, content)
  VALUES (new.id, new.title, new.subtitle, new.content);
END;
