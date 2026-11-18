import path from "node:path";
import matter from "gray-matter";
import fs from "node:fs/promises";
import { watch, existsSync, readdirSync } from "node:fs";
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
  slug: string;
  source?: string;
  title: string;
  subtitle?: string;
  pubDate: Date;
  authors?: string | AuthorSummary[];
  rubric: string;
  genre?: string;
  tags?: string | string[];
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

const ARTICLES_DIR = path.resolve(process.cwd(), "src/content/articles");
//const POSTS_DIR = path.resolve(process.cwd(), "src/content/posts");

let cachedPosts: Post[] | null = null;
let cachedPostsMap: Map<string, Post> | null = null;
let inFlightPromise: Promise<Post[]> | null = null;
let isWatcherInitialized = false;

export function invalidatePostsCache(): void {
  cachedPosts = null;
  cachedPostsMap = null;
}

function ensureWatcher(): void {
  if (isWatcherInitialized || !existsSync(ARTICLES_DIR)) return;

  try {
    const watcher = watch(
      ARTICLES_DIR,
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        if (!filename || filename.endsWith(".md")) {
          invalidatePostsCache();
        }
      },
    );

    watcher.on("error", (err) => {
      console.error("Ошибка наблюдателя директории статей:", err);
      isWatcherInitialized = false;
      invalidatePostsCache();
    });

    isWatcherInitialized = true;
  } catch (err) {
    console.error("Не удалось запустить рекурсивный fs.watch:", err);
  }
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

function stripMarkdown(md: string): string {
  return md
    .replace(/[#>*_`~\[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function calculateReadingTime(plainText: string, customReadingTime?: string): string {
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

function getFilesRecursively(dir: string, ext: string = ".md"): Promise<string[]> {
  const entries = readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function loadPostsFromDisk(): Promise<Post[]> {
  try {
    const mdFiles = await getFilesRecursively(ARTICLES_DIR, ".md");

    const rawPosts = await Promise.all(
      mdFiles.map(async (filePath) => {
        const relativePath = path.relative(ARTICLES_DIR, filePath);
        const slug = relativePath.replace(/\.md$/, "").replace(/\\/g, "/");
        const rawFile = await fs.readFile(filePath, "utf-8");
        const { data, content } = matter(rawFile);

        const isDraft = Boolean(data.draft);
        if (isDraft && import.meta.env.PROD) {
          return null;
        }

        const plainText = stripMarkdown(content);
        const parsedHtml = await marked.parse(content);
        const { html, toc } = extractTocAndInjectIds(parsedHtml);

        const authorsStr = (data.authors ?? data.author ?? "").trim();
        const rubricStr = (data.rubric ?? data.category ?? "").trim();
        const dateValue = data.date ?? data.pubDate;
        const pubDate = dateValue ? new Date(dateValue) : new Date();

        let rawTags: string[] = [];
        if (Array.isArray(data.tags)) {
          rawTags = data.tags.map((t) => String(t).trim()).filter(Boolean);
        } else if (typeof data.tags === "string" && data.tags.trim()) {
          rawTags = data.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        }

        return {
          slug,
          source: data.source ? String(data.source) : undefined,
          title: data.title ?? "Без названия",
          subtitle: data.subtitle ? String(data.subtitle) : undefined,
          pubDate,
          authors: parseAuthors(authorsStr),
          rubric: rubricStr,
          genre: data.genre ? String(data.genre) : undefined,
          tags: rawTags,
          draft: isDraft,
          featured: Boolean(data.featured),
          image: data.image,
          imageCaption: data.imageCaption,
          readingTime: calculateReadingTime(plainText, data.readingTime),
          toc,
          htmlContent: html,
          plainText,
        } satisfies Post;
      }),
    );

    const posts = rawPosts.filter((p): p is Post => p !== null);
    const sorted = posts.sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());

    cachedPosts = sorted;
    cachedPostsMap = new Map(sorted.map((post) => [post.slug, post]));

    return sorted;
  } catch (error) {
    console.error("Ошибка чтения коллекции articles:", error);
    return [];
  }
}

export async function getAllPosts(): Promise<Post[]> {
  ensureWatcher();

  if (cachedPosts) {
    return cachedPosts;
  }

  if (!inFlightPromise) {
    inFlightPromise = loadPostsFromDisk().finally(() => {
      inFlightPromise = null;
    });
  }

  return inFlightPromise;
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const safeSlug = slug.replace(/^\/+/, "").replace(/\/+$/, "");
  ensureWatcher();

  if (cachedPostsMap) {
    return cachedPostsMap.get(safeSlug) ?? null;
  }

  await getAllPosts();
  return cachedPostsMap?.get(safeSlug) ?? null;
}

export function getAllAuthors(posts): AuthorSummary[] {
  const map = new Map<string, AuthorSummary>();

  for (const post of posts) {
    for (const author of post.authors) {
      const existing = map.get(author.slug);
      if (!existing) {
        map.set(author.slug, {
          postCount: 1,
          latestPostDate: post.pubDate,
          rubrics: [post.rubric.trim()],
          slugName: authorNameFromSlug(author.slug),
          ...author,
        });
      } else {
        existing.postCount += 1;
        existing.rubrics.push(post.rubric.trim());
        if (post.pubDate > existing.latestPostDate) {
          existing.latestPostDate = post.pubDate;
        }
      }
    }
  }

  return Array.from(map.values())
    .map((entry) => ({
      ...entry,
      rubrics: Array.from(entry.rubrics),
    }))
    .sort((a, b) => b.postCount - a.postCount || a.name.localeCompare(b.name, "ru"));
}

export async function getAuthorBySlug(
  authorSlug: string,
): Promise<{ author?: AuthorSummary; posts: Post[] }> {
  const allPosts = await getAllPosts();
  const authors = getAllAuthors(allPosts);
  const author = authors.find((a) => a.slug == authorSlug);
  return {
    author,
    posts: authors ? allPosts.filter((p) => p.authors.find((a) => a.slug == authorSlug)) : [] };
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
  const safeSlug = path.basename(tagSlug);
  const posts = await getAllPosts();

  const matchedPosts = posts.filter((post) => post.tags.some((t) => slugifyTag(t) === safeSlug));

  if (matchedPosts.length == 0) return null;

  const samplePost = matchedPosts.find((p) => p.tags.some((t) => slugifyTag(t) === safeSlug));
  const tagName = samplePost?.tags.find((t) => slugifyTag(t) === safeSlug) ?? safeSlug;

  return { tagName, posts: matchedPosts };
}

/**
 * Возвращает список всех уникальных рубрик из опубликованных постов
 */
export async function getAllRubrics(): Promise<string[]> {
  const posts = await getAllPosts();
  const rubrics = new Set(posts.map((p) => p.rubric).filter(Boolean));
  return Array.from(rubrics).sort((a, b) => a.localeCompare(b, "ru"));
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

  const lowerQuery = trimmed.toLowerCase();
  const allPosts = await getAllPosts();

  return allPosts
    .filter((post) => {
      const searchable = [
        post.title,
        post.subtitle,
        post.authors,
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

/**
 * Склоняет существительное в зависимости от числительного (1 статья, 2 статьи, 5 статей)
 */
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

export function parseAuthors(authors: string): { name: string; role: string; slug: string }[] {
  const authorsObj: Record<string, { name: string; role: string; slug: string }> = {};
  const matrix = authors.split(",").map((m) =>
    m.trim()
      .split("(")
      .map((a) => a.replaceAll(")", "").trim())
      .filter((f) => !!f),
  );
  for (let i = 0; i < matrix.length; i++) {
    if (matrix[i].length < 1) continue;
    const [name, role] = matrix[i];
    const slug = toSlug(name);
    authorsObj[slug] = {
      name,
      role,
      slug,
    };
  }
  return Object.values(authorsObj);
};
