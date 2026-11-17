import fs from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface Post {
  slug: string;
  title: string;
  description: string;
  pubDate: Date;
  author: string;
  authorSlug: string;
  authorBio?: string;
  category: string;
  featured: boolean;
  image?: string;
  imageCaption?: string;
  readingTime: string;
  toc: TocItem[];
  htmlContent: string;
  plainText: string;
}

export interface AuthorSummary {
  name: string;
  slug: string;
  bio: string;
  postCount: number;
  latestPostDate: Date;
  categories: string[];
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

const POSTS_DIR = path.resolve(process.cwd(), 'src/content/posts');

let cachedPosts: Post[] | null = null;
let cachedPostsMap: Map<string, Post> | null = null;
let inFlightPromise: Promise<Post[]> | null = null;
let isWatcherInitialized = false;

export function invalidatePostsCache(): void {
  cachedPosts = null;
  cachedPostsMap = null;
}

function ensureWatcher(): void {
  if (isWatcherInitialized || !existsSync(POSTS_DIR)) return;

  try {
    const watcher = watch(POSTS_DIR, { persistent: false }, (_eventType, filename) => {
      if (!filename || filename.endsWith('.md')) {
        invalidatePostsCache();
      }
    });

    watcher.on('error', (err) => {
      console.error('Ошибка наблюдателя директории постов:', err);
      isWatcherInitialized = false;
      invalidatePostsCache();
    });

    isWatcherInitialized = true;
  } catch (err) {
    console.error('Не удалось запустить fs.watch для директории постов:', err);
  }
}

const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function slugifyAuthor(name: string): string {
  const transliterated = name
    .toLowerCase()
    .split('')
    .map((char) => CYRILLIC_MAP[char] ?? char)
    .join('');

  return (
    transliterated
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-') || 'editorial'
  );
}

function stripMarkdown(md: string): string {
  return md
    .replace(/[#>*_`~\[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
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
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function extractTocAndInjectIds(rawHtml: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const usedIds = new Map<string, number>();

  const html = rawHtml.replace(
    /<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (_match, levelStr: string, attrs: string, innerHtml: string) => {
      const level = Number(levelStr) as 2 | 3;
      const cleanText = innerHtml.replace(/<[^>]+>/g, '').trim();

      if (!cleanText) {
        return `<h${level}${attrs}>${innerHtml}</h${level}>`;
      }

      const existingIdMatch = attrs.match(/\bid=["']([^"']+)["']/i);
      let id = existingIdMatch ? existingIdMatch[1] : slugifyHeading(cleanText) || 'section';

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
    }
  );

  return { html, toc };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildHighlightedSnippet(post: Post, query: string): string {
  const sourceText = [post.description, post.plainText].filter(Boolean).join(' — ');
  const lowerText = sourceText.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  let rawExcerpt = '';

  if (matchIndex === -1) {
    rawExcerpt = sourceText.slice(0, 180) + (sourceText.length > 180 ? '…' : '');
  } else {
    const radius = 85;
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(sourceText.length, matchIndex + query.length + radius);

    const prefix = start > 0 ? '…' : '';
    const suffix = end < sourceText.length ? '…' : '';
    rawExcerpt = prefix + sourceText.slice(start, end).trim() + suffix;
  }

  const safeText = escapeHtml(rawExcerpt);
  const regex = new RegExp(`(${escapeRegExp(escapeHtml(query))})`, 'gi');

  return safeText.replace(regex, '<mark>$1</mark>');
}

async function loadPostsFromDisk(): Promise<Post[]> {
  try {
    const files = await fs.readdir(POSTS_DIR);
    const mdFiles = files.filter((file) => file.endsWith('.md'));

    const posts = await Promise.all(
      mdFiles.map(async (filename) => {
        const slug = filename.replace(/\.md$/, '');
        const filePath = path.join(POSTS_DIR, filename);
        const rawFile = await fs.readFile(filePath, 'utf-8');
        const { data, content } = matter(rawFile);
        const plainText = stripMarkdown(content);
        const parsedHtml = await marked.parse(content);
        const { html, toc } = extractTocAndInjectIds(parsedHtml);
        const authorName = (data.author ?? 'Редакция').trim();

        return {
          slug,
          title: data.title ?? 'Без названия',
          description: data.description ?? '',
          pubDate: data.pubDate ? new Date(data.pubDate) : new Date(),
          author: authorName,
          authorSlug: data.authorSlug ? String(data.authorSlug).trim() : slugifyAuthor(authorName),
          authorBio: data.authorBio ? String(data.authorBio).trim() : undefined,
          category: data.category ?? 'Общее',
          featured: Boolean(data.featured),
          image: data.image,
          imageCaption: data.imageCaption,
          readingTime: calculateReadingTime(plainText, data.readingTime),
          toc,
          htmlContent: html,
          plainText,
        } satisfies Post;
      })
    );

    const sorted = posts.sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());

    cachedPosts = sorted;
    cachedPostsMap = new Map(sorted.map((post) => [post.slug, post]));

    return sorted;
  } catch (error) {
    console.error('Ошибка чтения директории постов:', error);
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
  const safeSlug = path.basename(slug);
  ensureWatcher();

  if (cachedPostsMap) {
    return cachedPostsMap.get(safeSlug) ?? null;
  }

  await getAllPosts();
  return cachedPostsMap?.get(safeSlug) ?? null;
}

// Сбор агрегированного списка всех авторов издания
export async function getAllAuthors(): Promise<AuthorSummary[]> {
  const posts = await getAllPosts();
  const map = new Map<
    string,
    {
      name: string;
      slug: string;
      bio: string;
      postCount: number;
      latestPostDate: Date;
      categories: Set<string>;
    }
  >();

  for (const post of posts) {
    const existing = map.get(post.authorSlug);
    if (!existing) {
      map.set(post.authorSlug, {
        name: post.author,
        slug: post.authorSlug,
        bio: post.authorBio ?? 'Постоянный автор и обозреватель издания The Masthead.',
        postCount: 1,
        latestPostDate: post.pubDate,
        categories: new Set([post.category]),
      });
    } else {
      existing.postCount += 1;
      if (post.authorBio) {
        existing.bio = post.authorBio;
      }
      if (post.pubDate > existing.latestPostDate) {
        existing.latestPostDate = post.pubDate;
      }
      existing.categories.add(post.category);
    }
  }

  return Array.from(map.values())
    .map((entry) => ({
      ...entry,
      categories: Array.from(entry.categories),
    }))
    .sort((a, b) => b.postCount - a.postCount || a.name.localeCompare(b.name, 'ru'));
}

export async function getAuthorBySlug(
  authorSlug: string
): Promise<{ author: AuthorSummary; posts: Post[] } | null> {
  const safeSlug = path.basename(authorSlug);
  const [authors, allPosts] = await Promise.all([getAllAuthors(), getAllPosts()]);
  const author = authors.find((a) => a.slug === safeSlug);

  if (!author) return null;

  const posts = allPosts.filter((p) => p.authorSlug === safeSlug);
  return { author, posts };
}

// Универсальная серверная пагинация списков
export function paginateItems<T>(
  items: T[],
  requestedPage: number,
  perPage = 9
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
        post.description,
        post.author,
        post.category,
        post.plainText,
      ]
        .join(' ')
        .toLowerCase();

      return searchable.includes(lowerQuery);
    })
    .map((post) => ({
      ...post,
      snippetHtml: buildHighlightedSnippet(post, trimmed),
    }));
}
