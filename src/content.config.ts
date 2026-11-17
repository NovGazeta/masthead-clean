import { defineCollection } from 'astro:content';
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const postsCollection = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.date(),
    author: z.string().default('Редакция'),
    category: z.string(),
    featured: z.boolean().default(false),
    image: z.string().optional(),
    imageCaption: z.string().optional(),
    readingTime: z.string().optional(),
  }),
});

export const collections = {
  posts: postsCollection,
};
