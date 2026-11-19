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
  postCount?: number;
  latestPostDate?: Date;
  rubrics?: string[];
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

export interface SearchResult extends Post {
  snippetHtml: string;
}

// Вспомогательная функция для создания слага из строки
export function slugify(text: string): string {
  return toSlug(text);
}

export function slugifyTag(tag: string): string {
  return toSlug(tag);
}

export function slugifyAuthor(author: string): string {
  return toSlug(author);
}

// Вспомогательная функция для отображения имени автора по его slug с капитализацией всех слов:
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
    return authorsInput
      .flatMap((item) => {
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
    // Ищем первую пару скобок: "Имя Фамилия (роль, доп. инфо)"
    const parenMatch = chunk.match(/^([^(]+?)\s*\(([^)]*)\)\s*$/);

    let name: string;
    let role: string | undefined;

    if (parenMatch) {
      name = parenMatch[1].trim();
      const insideParens = parenMatch[2].trim();
      role = insideParens || undefined;
    } else {
      // На случай незакрытой скобки или обычной строки без скобок
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

// Людмила Рыбина (Обозреватель, rybinal@yandex.ru), Марина Аромштам
// Александр Подрабинек (журналист, политзаключенный в СССР)
// Борис Вишневский (обозреватель, депутат ЗакСа Петербурга)
// Юрий Сафронов (обозреватель «Новой», журналист RFI, Париж)
// Юлия (Мартовалиева)
// Никита Кричевский (д.э.н., профессор)
// Роман Шлейнов («Важные истории», региональный редактор OCCRP)
// Леонид Никитинский (обозреватель, член СПЧ)
// Александр Лебедев (акционер «Новой газеты», д.э.н.)
// Виталий Ярошевский (Заместитель главного редактора, редактор отдела «Общество»)
// Александр Покровский (писатель, офицер-подводник)
// Сергей Канев (криминальный репортер, sbultik@gmail.com)
// Юрий Батурин (член-корреспондент РАН, летчик-космонавт РФ)


/**
 * Получение всех опубликованных постов из Turso с реляционными данными
 */
export async function getAllPosts(): Promise<Post[]> {
  try {
    const result = await turso.execute(`
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
        ) as tags_json
      FROM posts p
      LEFT JOIN rubrics r ON p.rubric_id = r.id
      WHERE p.draft = 0
      ORDER BY p.pub_date DESC, p.date DESC;
    `);

    return result.rows.map((row: any) => {
      const authors: AuthorSummary[] = row.authors_json ? JSON.parse(row.authors_json) : [];
      const tagsData = row.tags_json ? JSON.parse(row.tags_json) : [];
      const tags: string[] = tagsData.map((t: any) => t.name || t);

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
        image: row.image || undefined,
        imageCaption: row.imageCaption || undefined,
        readingTime: row.reading_time || calculateReadingTime(plainText),
        toc,
        htmlContent: html,
        plainText,
      } satisfies Post;
    });
  } catch (error) {
    console.error("Ошибка получения постов из Turso:", error);
    return [];
  }
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const safeSlug = slug.replace(/^\/+/, "").replace(/\/+$/, "");
  const posts = await getAllPosts();
  return posts.find((p) => p.slug === safeSlug) ?? null;
}

export function getAllAuthors(posts: Post[]): AuthorSummary[] {
  const map = new Map<string, AuthorSummary>();

  for (const post of posts) {
    for (const author of post.authors) {
      const existing = map.get(author.slug);
      if (!existing) {
        map.set(author.slug, {
          postCount: 1,
          rubrics: new Set([post.rubric.trim()]),
          latestPostDate: post.pubDate,
          slugName: authorNameFromSlug(author.slug),
          ...author,
        });
      } else {
        existing.postCount = (existing.postCount || 1) + 1;
        existing.rubrics?.add(post.rubric.trim());
        if (existing.latestPostDate && post.pubDate > existing.latestPostDate) {
          existing.latestPostDate = post.pubDate;
        }
      }
    }
  }

  return Array.from(map.values())
    .map((entry) => ({
      ...entry,
      rubrics: Array.from(entry.rubrics || []),
    }))
    .sort((a, b) => (b.postCount || 0) - (a.postCount || 0) || a.name.localeCompare(b.name, "ru"));
}

export async function getAuthorBySlug(
  authorSlug: string,
): Promise<{ author?: AuthorSummary; posts: Post[] }> {
  const allPosts = await getAllPosts();
  const authors = getAllAuthors(allPosts);
  const author = authors.find((a) => a.slug === authorSlug);
  return {
    author,
    posts: author ? allPosts.filter((p) => p.authors.some((a) => a.slug === authorSlug)) : [],
  };
}

export async function getAllTags(): Promise<TagSummary[]> {
  const posts = await getAllPosts();
  const tagMap = new Map<string, { name: string; slug: string; count: number }>();

  for (const post of posts) {
    for (const rawTag of post.tags) {
      const slug = slugifyTag(rawTag);
      if (!tagMap.has(slug)) {
        tagMap.set(slug, { name: rawTag, slug, count: 1 });
      } else {
        tagMap.get(slug)!.count += 1;
      }
    }
  }

  return Array.from(tagMap.values())
    .map((t) => ({ name: t.name, slug: t.slug, postCount: t.count }))
    .sort((a, b) => b.postCount - a.postCount || a.name.localeCompare(b.name, "ru"));
}

export async function getPostsByTag(
  tagSlug: string,
): Promise<{ tagName: string; posts: Post[] } | null> {
  const safeSlug = slugifyTag(tagSlug);
  const posts = await getAllPosts();

  const matchedPosts = posts.filter((post) => post.tags.some((t) => slugifyTag(t) === safeSlug));

  if (matchedPosts.length === 0) return null;

  const sampleTag = matchedPosts.flatMap((p) => p.tags).find((t) => slugifyTag(t) === safeSlug);
  const tagName = sampleTag || safeSlug;

  return { tagName, posts: matchedPosts };
}

export async function getAllRubrics(): Promise<string[]> {
  try {
    const result = await turso.execute("SELECT name FROM rubrics ORDER BY name ASC;");
    return result.rows.map((row: any) => row.name);
  } catch (err) {
    console.error("Ошибка получения рубрик из Turso:", err);
    const posts = await getAllPosts();
    const rubrics = new Set(posts.map((p) => p.rubric).filter(Boolean));
    return Array.from(rubrics).sort((a, b) => a.localeCompare(b, "ru"));
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
    // Используем FTS5 поиск в базе данных Turso
    const result = await turso.execute({
      sql: `
        SELECT p.slug
        FROM posts_fts fts
        JOIN posts p ON fts.rowid = p.id
        WHERE posts_fts MATCH ? AND p.draft = 0
        ORDER BY rank;
      `,
      args: [trimmed],
    });

    const matchedSlugs = new Set(result.rows.map((r: any) => r.slug));
    const allPosts = await getAllPosts();

    return allPosts
      .filter((post) => matchedSlugs.has(post.slug))
      .map((post) => ({
        ...post,
        snippetHtml: buildHighlightedSnippet(post, trimmed),
      }));
  } catch (err) {
    console.warn("FTS5 поиск недоступен, выполняем фоллбек по памяти:", err);
    const lowerQuery = trimmed.toLowerCase();
    const allPosts = await getAllPosts();

    return allPosts
      .filter((post) => {
        const searchable = [
          post.title,
          post.subtitle,
          JSON.stringify(post.authors),
          post.rubric,
          post.genre,
          ...post.tags,
          post.plainText,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return searchable.includes(lowerQuery);
      })
      .map((post) => ({
        ...post,
        snippetHtml: buildHighlightedSnippet(post, trimmed),
      }));
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
