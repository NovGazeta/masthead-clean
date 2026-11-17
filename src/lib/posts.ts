import fs from 'node:fs/promises';
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
  htmlContent: string;
  plainText: string;
}

export interface SearchResult extends Post {
  snippetHtml: string;
}

const POSTS_DIR = path.resolve(process.cwd(), 'src/content/posts');

function stripMarkdown(md: string): string {
  return md
    .replace(/[#>*_`~\[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

// Формируем фрагмент текста вокруг найденного слова и оборачиваем совпадения в <mark>
function buildHighlightedSnippet(post: Post, query: string): string {
  const sourceText = [post.description, post.plainText].filter(Boolean).join(' — ');
  const lowerText = sourceText.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  let rawExcerpt = '';

  if (matchIndex === -1) {
    // Если совпадение было только в заголовке, авторе или рубрике — берем начало описания/текста
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

export async function getAllPosts(): Promise<Post[]> {
  try {
    const files = await fs.readdir(POSTS_DIR);
    const mdFiles = files.filter((file) => file.endsWith('.md'));

    const posts = await Promise.all(
      mdFiles.map(async (filename) => {
        const slug = filename.replace(/\.md$/, '');
        const filePath = path.join(POSTS_DIR, filename);
        const rawFile = await fs.readFile(filePath, 'utf-8');
        const { data, content } = matter(rawFile);

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
          htmlContent: await marked.parse(content),
          plainText: stripMarkdown(content),
        } satisfies Post;
      })
    );

    return posts.sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());
  } catch (error) {
    console.error('Ошибка чтения директории постов:', error);
    return [];
  }
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const safeSlug = path.basename(slug);
  const filePath = path.join(POSTS_DIR, `${safeSlug}.md`);

  try {
    const rawFile = await fs.readFile(filePath, 'utf-8');
    const { data, content } = matter(rawFile);

    return {
      slug: safeSlug,
      title: data.title ?? 'Без названия',
      description: data.description ?? '',
      pubDate: data.pubDate ? new Date(data.pubDate) : new Date(),
      author: data.author ?? 'Редакция',
      category: data.category ?? 'Общее',
      featured: Boolean(data.featured),
      image: data.image,
      imageCaption: data.imageCaption,
      htmlContent: await marked.parse(content),
      plainText: stripMarkdown(content),
    };
  } catch {
    return null;
  }
}

// Поиск с возвратом сниппета с подсветкой
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
