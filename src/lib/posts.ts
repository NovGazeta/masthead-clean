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

const POSTS_DIR = path.resolve(process.cwd(), 'src/content/posts');

// Убираем базовую Markdown-разметку для чистого поиска по тексту
function stripMarkdown(md: string): string {
  return md
    .replace(/[#>*_`~\[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

// Динамический поиск по всем полям и содержимому файлов
export async function searchPosts(query: string): Promise<Post[]> {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const allPosts = await getAllPosts();

  return allPosts.filter((post) => {
    const searchable = [
      post.title,
      post.description,
      post.author,
      post.category,
      post.plainText,
    ]
      .join(' ')
      .toLowerCase();

    return searchable.includes(trimmed);
  });
}
