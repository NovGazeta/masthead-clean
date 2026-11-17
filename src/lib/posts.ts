import fs from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';

export interface Post {
  slug: string;
  title: string;
  description: string;
  pubDate: Date;
  author: string;
  category: string;
  featured: boolean;
  image?: string;
  imageCaption?: string;
  readingTime: string;
  htmlContent: string;
  plainText: string;
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

function stripMarkdown(md: string): string {
  return md
    .replace(/[#>*_`~\[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Расчет времени чтения (~180 слов в минуту для русского текста)
function calculateReadingTime(plainText: string, customReadingTime?: string): string {
  if (customReadingTime && customReadingTime.trim()) {
    return customReadingTime.trim();
  }

  const words = plainText.split(/\s+/).filter(Boolean).length;
  const wordsPerMinute = 180;
  const minutes = Math.max(1, Math.ceil(words / wordsPerMinute));

  return `${minutes} мин чтения`;
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

        return {
          slug,
          title: data.title ?? 'Без названия',
          description: data.description ?? '',
          pubDate: data.pubDate ? new Date(data.pubDate) : new Date(),
          author: data.author ?? 'Редакция',
          category: data.category ?? 'Общее',
          featured: Boolean(data.featured),
          image: data.image,
          imageCaption: data.imageCaption,
          readingTime: calculateReadingTime(plainText, data.readingTime),
          htmlContent: await marked.parse(content),
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
