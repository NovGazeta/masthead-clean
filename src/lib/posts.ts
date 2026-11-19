import { turso } from "@/lib/turso";
import { marked } from "marked";
import { toSlug, fromSlug } from "@/lib/translit";

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface AuthorSummary {
  name: string;
  slug: string;
  slugName?: string;
  role?: string;
  bio?: string;
  postCount?: number;
  latestPostDate?: Date;
  rubrics?: string[];
}

export interface PostImage {
  id: number;
  url: string;
  alt?: string;
  position: number;
}

export interface Post {
  id: number;
  slug: string;
  source?: string;
  title: string;
  subtitle?: string;
  pubDate: Date;
  authors: AuthorSummary[];
  rubric: string;
  genre?: string;
  tags: string[];
  draft?: boolean;
  featured?: boolean;
  image?: string;
  imageCaption?: string;
  images?: PostImage[];
  readingTime?: string;
  toc?: TocItem[];
  htmlContent: string;
  plainText: string;
}

export interface TagSummary {
  name: string;
  slug: string;
  postCount: number;
}

export interface PaginatedResult<T> {
  items: T[];
  currentPage: number;
  totalPages: number;
  totalItems: number;
  perPage: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export interface PaginatedPostsOptions {
  page?: number;
  perPage?: number;
  rubricSlug?: string;
  authorSlug?: string;
  tagSlug?: string;
}

export interface SearchResult extends Post {
  snippetHtml: string;
}

const BASE_POST_SELECT = `
  SELECT
    p.*,
    r.name as rubric_name,
    r.slug as rubric_slug,
    (
      SELECT json_group_array(json_object('name', a.name, 'slug', a.slug, 'role', a.role))
      FROM posts_authors pa
      JOIN authors a ON pa.author_id = a.id
      WHERE pa.post_id = p.id
    ) as authors_json,
    (
      SELECT json_group_array(json_object('name', t.name, 'slug', t.slug))
      FROM posts_tags pt
      JOIN tags t ON pt.tag_id = t.id
      WHERE pt.post_id = p.id
    ) as tags_json,
    (
      SELECT json_group_array(json_object('id', img.id, 'url', img.url, 'alt', img.alt, 'position', img.position))
      FROM (
        SELECT id, url, alt, position
        FROM images
        WHERE post_id = p.id
        ORDER BY position ASC, id ASC
      ) img
    ) as images_json
  FROM posts p
  LEFT JOIN rubrics r ON p.rubric_id = r.id
`;

export function slugify(text: string): string {
  return toSlug(text);
}

export function slugifyTag(tag: string): string {
  return toSlug(tag);
}

export function slugifyAuthor(author: string): string {
  return toSlug(author);
}

export function authorNameFromSlug(slug: string): string {
  return fromSlug(slug, false)
    .split(/(\s+|-)/)
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join("");
}

export function stripMarkdown(md: string): string {
  return md
    .replace(/[#>*_`~\[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function calculateReadingTime(plainText: string, customReadingTime?: string): string {
  if (customReadingTime && customReadingTime.trim()) {
    return customReadingTime.trim();
  }

  const words = plainText.split(/\s+/).filter(Boolean).length;
  const wordsPerMinute = 180;
  const minutes = Math.max(1, Math.ceil(words / wordsPerMinute));

  return `${minutes} мин чтения`;
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function extractTocAndInjectIds(rawHtml: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const usedIds = new Map<string, number>();

  const html = rawHtml.replace(
    /<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (_match, levelStr: string, attrs: string, innerHtml: string) => {
      const level = Number(levelStr) as 2 | 3;
      const cleanText = innerHtml.replace(/<[^>]+>/g, "").trim();

      if (!cleanText) {
        return `<h${level}${attrs}>${innerHtml}</h${level}>`;
      }

      const existingIdMatch = attrs.match(/\bid=["']([^"']+)["']/i);
      let id = existingIdMatch ? existingIdMatch[1] : slugifyHeading(cleanText) || "section";

      const count = usedIds.get(id) ?? 0;
      usedIds.set(id, count + 1);
      if (count > 0) {
        id = `${id}-${count + 1}`;
      }

      toc.push({ id, text: cleanText, level });

      if (existingIdMatch) {
        return `<h${level}${attrs}>${innerHtml}</h${level}>`;
      }

      return `<h${level}${attrs} id="${id}">${innerHtml}</h${level}>`;
    },
  );

  return { html, toc };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHighlightedSnippet(post: Post, query: string): string {
  const sourceText = [post.subtitle, post.plainText].filter(Boolean).join(" — ");
  const lowerText = sourceText.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  let rawExcerpt = "";

  if (matchIndex === -1) {
    rawExcerpt = sourceText.slice(0, 180) + (sourceText.length > 180 ? "…" : "");
  } else {
    const radius = 85;
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(sourceText.length, matchIndex + query.length + radius);

    const prefix = start > 0 ? "…" : "";
    const suffix = end < sourceText.length ? "…" : "";
    rawExcerpt = prefix + sourceText.slice(start, end).trim() + suffix;
  }

  const safeText = escapeHtml(rawExcerpt);
  const regex = new RegExp(`(${escapeRegExp(escapeHtml(query))})`, "gi");

  return safeText.replace(regex, "<mark>$1</mark>");
}

function splitOutsideParens(input: string, delimiter = ","): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of input) {
    if (char === "(") {
      depth += 1;
      current += char;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (char === delimiter && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

export function parseAuthors(authorsInput: unknown): AuthorSummary[] {
  if (!authorsInput) return [];

  if (Array.isArray(authorsInput)) {
    return authorsInput.flatMap((item) => {
      if (typeof item === "string") {
        return parseAuthors(item);
      }
      if (item && typeof item === "object" && "name" in item) {
        const name = String(item.name).trim();
        if (!name) return [];
        return [
          {
            name,
            slug: "slug" in item && item.slug ? String(item.slug) : slugify(name),
            role: "role" in item && item.role ? String(item.role).trim() : undefined,
          },
        ];
      }
      return [];
    });
  }

  const rawString = String(authorsInput).trim();
  if (!rawString) return [];

  const authorsMap = new Map<string, AuthorSummary>();
  const chunks = splitOutsideParens(rawString, ",");

  for (const chunk of chunks) {
    const parenMatch = chunk.match(/^([^(]+?)\s*\(([^)]*)\)\s*$/);

    let name: string;
    let role: string | undefined;

    if (parenMatch) {
      name = parenMatch[1].trim();
      const insideParens = parenMatch[2].trim();
      role = insideParens || undefined;
    } else {
      const openIdx = chunk.indexOf("(");
      if (openIdx !== -1) {
        name = chunk.slice(0, openIdx).trim();
        const rest = chunk.slice(openIdx + 1).replace(/\)+$/, "").trim();
        role = rest || undefined;
      } else {
        name = chunk.replace(/\)+$/, "").trim();
        role = undefined;
      }
    }

    if (!name) continue;

    const slug = toSlug(name);
    if (!slug) continue;

    if (!authorsMap.has(slug)) {
      authorsMap.set(slug, {
        name,
        slug,
        role,
      });
    } else if (role && !authorsMap.get(slug)!.role) {
      authorsMap.get(slug)!.role = role;
    }
  }

  return Array.from(authorsMap.values());
}

function mapRowToPost(row: any): Post {
  const authors: AuthorSummary[] = row.authors_json ? JSON.parse(row.authors_json) : [];
  const tagsData = row.tags_json ? JSON.parse(row.tags_json) : [];
  const tags: string[] = tagsData.map((t: any) => t.name || t);

  const imagesRaw = row.images_json ? JSON.parse(row.images_json) : [];
  const images: PostImage[] = imagesRaw
    .filter((img: any) => img && img.url)
    .map((img: any) => ({
      id: Number(img.id),
      url: String(img.url),
      alt: img.alt ? String(img.alt) : undefined,
      position: Number(img.position ?? 0),
    }));

  const rawHtml = row.htmlContent || (row.content ? (marked.parse(row.content) as string) : "");
  const { html, toc } = extractTocAndInjectIds(rawHtml);
  const plainText = stripMarkdown(row.content || "");

  return {
    id: Number(row.id),
    slug: row.slug,
    source: row.source || undefined,
    title: row.title,
    subtitle: row.subtitle || undefined,
    pubDate: new Date(row.pub_date || row.date),
    authors,
    rubric: row.rubric_name || "",
    genre: row.genre || undefined,
    tags,
    draft: Boolean(row.draft),
    featured: Boolean(row.featured),
    image: row.image || images[0]?.url || undefined,
    imageCaption: row.imageCaption || images[0]?.alt || undefined,
    images,
    readingTime: row.reading_time || calculateReadingTime(plainText),
    toc,
    htmlContent: html,
    plainText,
  } satisfies Post;
}

function buildPostFilterWhere(options: Omit<PaginatedPostsOptions, "page" | "perPage">): {
  whereSql: string;
  args: (string | number)[];
} {
  const conditions: string[] = ["p.draft = 0"];
  const args: (string | number)[] = [];

  if (options.rubricSlug) {
    conditions.push("r.slug = ?");
    args.push(options.rubricSlug);
  }

  if (options.authorSlug) {
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM posts_authors pa
        JOIN authors a ON pa.author_id = a.id
        WHERE pa.post_id = p.id AND LOWER(a.slug) = LOWER(?)
      )
    `);
    args.push(options.authorSlug);
  }

  if (options.tagSlug) {
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM posts_tags pt
        JOIN tags t ON pt.tag_id = t.id
        WHERE pt.post_id = p.id AND LOWER(t.slug) = LOWER(?)
      )
    `);
    args.push(options.tagSlug);
  }

  return {
    whereSql: `WHERE ${conditions.join(" AND ")}`,
    args,
  };
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const safeSlug = slug.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!safeSlug) return null;

  try {
    const result = await turso.execute({
      sql: `${BASE_POST_SELECT} WHERE p.slug = ? AND p.draft = 0 LIMIT 1;`,
      args: [safeSlug],
    });

    const row = result.rows[0];
    return row ? mapRowToPost(row) : null;
  } catch (error) {
    console.error("Ошибка получения поста по slug из Turso:", error);
    return null;
  }
}

export async function getRecentPosts(limit = 20): Promise<Post[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));

  try {
    const result = await turso.execute({
      sql: `${BASE_POST_SELECT} WHERE p.draft = 0 ORDER BY p.pub_date DESC, p.date DESC LIMIT ?;`,
      args: [safeLimit],
    });

    return result.rows.map(mapRowToPost);
  } catch (error) {
    console.error("Ошибка получения последних постов из Turso:", error);
    return [];
  }
}

export async function getRelatedPosts(
  currentSlug: string,
  rubricName: string,
  limit = 3,
): Promise<Post[]> {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const cleanRubric = rubricName.trim();
  const collected = new Map<string, Post>();

  try {
    if (cleanRubric) {
      const sameRubricRes = await turso.execute({
        sql: `
          ${BASE_POST_SELECT}
          WHERE p.draft = 0
            AND p.slug != ?
            AND LOWER(TRIM(COALESCE(r.name, ''))) = LOWER(?)
          ORDER BY p.pub_date DESC, p.date DESC
          LIMIT ?;
        `,
        args: [currentSlug, cleanRubric, safeLimit],
      });

      for (const row of sameRubricRes.rows) {
        const mapped = mapRowToPost(row);
        collected.set(mapped.slug, mapped);
      }
    }

    if (collected.size < safeLimit) {
      const needed = safeLimit - collected.size;
      const fallbackRes = await turso.execute({
        sql: `
          ${BASE_POST_SELECT}
          WHERE p.draft = 0
            AND p.slug != ?
            AND LOWER(TRIM(COALESCE(r.name, ''))) != LOWER(?)
          ORDER BY p.pub_date DESC, p.date DESC
          LIMIT ?;
        `,
        args: [currentSlug, cleanRubric, needed],
      });

      for (const row of fallbackRes.rows) {
        const mapped = mapRowToPost(row);
        if (!collected.has(mapped.slug)) {
          collected.set(mapped.slug, mapped);
        }
      }
    }

    return Array.from(collected.values()).slice(0, safeLimit);
  } catch (error) {
    console.error("Ошибка получения похожих постов из Turso:", error);
    return [];
  }
}

export async function getPaginatedPosts(
  options: PaginatedPostsOptions = {},
): Promise<PaginatedResult<Post>> {
  const requestedPage = options.page ?? 1;
  const perPage = Math.max(1, Math.min(100, Math.floor(options.perPage ?? 9)));
  const { whereSql, args } = buildPostFilterWhere(options);

  try {
    const countResult = await turso.execute({
      sql: `
        SELECT COUNT(*) as total
        FROM posts p
        LEFT JOIN rubrics r ON p.rubric_id = r.id
        ${whereSql};
      `,
      args,
    });

    const totalItems = Number(countResult.rows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
    const currentPage = Number.isFinite(requestedPage)
      ? Math.min(totalPages, Math.max(1, Math.floor(requestedPage)))
      : 1;
    const offset = (currentPage - 1) * perPage;

    const rowsResult = await turso.execute({
      sql: `
        ${BASE_POST_SELECT}
        ${whereSql}
        ORDER BY p.pub_date DESC, p.date DESC
        LIMIT ? OFFSET ?;
      `,
      args: [...args, perPage, offset],
    });

    return {
      items: rowsResult.rows.map(mapRowToPost),
      currentPage,
      totalPages,
      totalItems,
      perPage,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
    };
  } catch (error) {
    console.error("Ошибка пагинированного получения постов из Turso:", error);
    return {
      items: [],
      currentPage: 1,
      totalPages: 1,
      totalItems: 0,
      perPage,
      hasPrev: false,
      hasNext: false,
    };
  }
}

export async function getAllAuthors(): Promise<AuthorSummary[]> {
  try {
    const result = await turso.execute(`
      SELECT
        a.name,
        a.slug,
        a.role,
        COUNT(p.id) as post_count,
        MAX(COALESCE(p.pub_date, p.date)) as latest_post_date,
        GROUP_CONCAT(DISTINCT r.name) as rubrics_csv
      FROM authors a
      JOIN posts_authors pa ON pa.author_id = a.id
      JOIN posts p ON p.id = pa.post_id AND p.draft = 0
      LEFT JOIN rubrics r ON p.rubric_id = r.id
      GROUP BY a.id, a.name, a.slug, a.role
      ORDER BY post_count DESC, a.name COLLATE NOCASE ASC;
    `);

    return result.rows.map((row: any) => ({
      name: String(row.name),
      slug: String(row.slug),
      slugName: authorNameFromSlug(String(row.slug)),
      role: row.role ? String(row.role) : undefined,
      bio: row.role ? String(row.role) : undefined,
      postCount: Number(row.post_count ?? 0),
      latestPostDate: row.latest_post_date ? new Date(String(row.latest_post_date)) : undefined,
      rubrics: row.rubrics_csv
        ? String(row.rubrics_csv)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    }));
  } catch (error) {
    console.error("Ошибка получения авторов из Turso:", error);
    return [];
  }
}

export async function getAuthorBySlug(authorSlug: string): Promise<AuthorSummary | null> {
  const raw = decodeURIComponent(authorSlug).trim();
  if (!raw) return null;

  const normalizedSlug = slugifyAuthor(raw);
  const candidates = Array.from(
    new Set([raw, raw.toLowerCase(), normalizedSlug].filter(Boolean)),
  );

  try {
    const placeholders = candidates.map(() => "?").join(", ");
    const result = await turso.execute({
      sql: `
        SELECT
          a.name,
          a.slug,
          a.role,
          COUNT(p.id) as post_count,
          MAX(COALESCE(p.pub_date, p.date)) as latest_post_date,
          GROUP_CONCAT(DISTINCT r.name) as rubrics_csv
        FROM authors a
        LEFT JOIN posts_authors pa ON pa.author_id = a.id
        LEFT JOIN posts p ON p.id = pa.post_id AND p.draft = 0
        LEFT JOIN rubrics r ON p.rubric_id = r.id
        WHERE LOWER(a.slug) IN (${placeholders})
        GROUP BY a.id, a.name, a.slug, a.role
        LIMIT 1;
      `,
      args: candidates.map((c) => c.toLowerCase()),
    });

    const row = result.rows[0];
    if (!row) return null;

    return {
      name: String(row.name),
      slug: String(row.slug),
      slugName: authorNameFromSlug(String(row.slug)),
      role: row.role ? String(row.role) : undefined,
      bio: row.role ? String(row.role) : undefined,
      postCount: Number(row.post_count ?? 0),
      latestPostDate: row.latest_post_date ? new Date(String(row.latest_post_date)) : undefined,
      rubrics: row.rubrics_csv
        ? String(row.rubrics_csv)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    };
  } catch (error) {
    console.error("Ошибка получения автора по slug из Turso:", error);
    return null;
  }
}

export async function getAllTags(): Promise<TagSummary[]> {
  try {
    const result = await turso.execute(`
      SELECT
        t.name,
        t.slug,
        COUNT(p.id) as post_count
      FROM tags t
      JOIN posts_tags pt ON pt.tag_id = t.id
      JOIN posts p ON p.id = pt.post_id AND p.draft = 0
      GROUP BY t.id, t.name, t.slug
      ORDER BY post_count DESC, t.name COLLATE NOCASE ASC;
    `);

    return result.rows.map((row: any) => ({
      name: String(row.name),
      slug: String(row.slug),
      postCount: Number(row.post_count ?? 0),
    }));
  } catch (error) {
    console.error("Ошибка получения тегов из Turso:", error);
    return [];
  }
}

export async function getPostsByTag(
  tagSlug: string,
): Promise<{ tagName: string; posts: Post[] } | null> {
  const safeSlug = slugifyTag(tagSlug);
  if (!safeSlug) return null;

  try {
    const tagRes = await turso.execute({
      sql: `SELECT name, slug FROM tags WHERE slug = ? LIMIT 1;`,
      args: [safeSlug],
    });

    const postsRes = await turso.execute({
      sql: `
        ${BASE_POST_SELECT}
        WHERE p.draft = 0
          AND EXISTS (
            SELECT 1
            FROM posts_tags pt
            JOIN tags t ON pt.tag_id = t.id
            WHERE pt.post_id = p.id AND t.slug = ?
          )
        ORDER BY p.pub_date DESC, p.date DESC;
      `,
      args: [safeSlug],
    });

    const posts = postsRes.rows.map(mapRowToPost);
    if (posts.length === 0) return null;

    const tagName = tagRes.rows[0]?.name ? String(tagRes.rows[0].name) : safeSlug;
    return { tagName, posts };
  } catch (error) {
    console.error("Ошибка получения статей по тегу из Turso:", error);
    return null;
  }
}

export async function getAllRubrics(): Promise<string[]> {
  try {
    const result = await turso.execute("SELECT name FROM rubrics ORDER BY name ASC;");
    return result.rows.map((row: any) => String(row.name));
  } catch (err) {
    console.error("Ошибка получения рубрик из Turso:", err);
    return [];
  }
}

export function paginateItems<T>(
  items: T[],
  requestedPage: number,
  perPage = 9,
): PaginatedResult<T> {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const currentPage = Number.isFinite(requestedPage)
    ? Math.min(totalPages, Math.max(1, Math.floor(requestedPage)))
    : 1;

  const start = (currentPage - 1) * perPage;
  const sliced = items.slice(start, start + perPage);

  return {
    items: sliced,
    currentPage,
    totalPages,
    totalItems,
    perPage,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}

export async function searchPosts(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const ftsRes = await turso.execute({
      sql: `
        SELECT p.slug
        FROM posts_fts fts
        JOIN posts p ON fts.rowid = p.id
        WHERE posts_fts MATCH ? AND p.draft = 0
        ORDER BY rank
        LIMIT 50;
      `,
      args: [trimmed],
    });

    const matchedSlugs = ftsRes.rows.map((r: any) => String(r.slug)).filter(Boolean);
    if (matchedSlugs.length === 0) return [];

    const placeholders = matchedSlugs.map(() => "?").join(", ");
    const rowsRes = await turso.execute({
      sql: `${BASE_POST_SELECT} WHERE p.draft = 0 AND p.slug IN (${placeholders});`,
      args: matchedSlugs,
    });

    const orderMap = new Map(matchedSlugs.map((slug, idx) => [slug, idx]));
    const mapped = rowsRes.rows
      .map(mapRowToPost)
      .sort((a, b) => (orderMap.get(a.slug) ?? 0) - (orderMap.get(b.slug) ?? 0));

    return mapped.map((post) => ({
      ...post,
      snippetHtml: buildHighlightedSnippet(post, trimmed),
    }));
  } catch (err) {
    console.warn("FTS5 поиск недоступен, выполняем фоллбек по LIKE в SQL:", err);
    const pattern = `%${trimmed}%`;

    try {
      const likeRes = await turso.execute({
        sql: `
          ${BASE_POST_SELECT}
          WHERE p.draft = 0
            AND (
              p.title LIKE ?
              OR COALESCE(p.subtitle, '') LIKE ?
              OR COALESCE(p.content, '') LIKE ?
              OR COALESCE(p.tags, '') LIKE ?
            )
          ORDER BY p.pub_date DESC, p.date DESC
          LIMIT 50;
        `,
        args: [pattern, pattern, pattern, pattern],
      });

      return likeRes.rows.map(mapRowToPost).map((post) => ({
        ...post,
        snippetHtml: buildHighlightedSnippet(post, trimmed),
      }));
    } catch (fallbackErr) {
      console.error("Ошибка фоллбек-поиска в Turso:", fallbackErr);
      return [];
    }
  }
}

export function pluralizeRu(
  count: number,
  forms: [one: string, few: string, many: string],
): string {
  const abs = Math.abs(count);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 19) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

export function getPostWord(count: number): string {
  return pluralizeRu(count, ["статья", "статьи", "статей"]);
}
