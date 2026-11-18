import { defineConfig } from "astro/config";
//import node from '@astrojs/node';
import vercel from "@astrojs/vercel";
import pkg from "./src/lib/pkg";

const { DEV } = import.meta.env;

// https://astro.build/config
export default defineConfig({
  site: pkg.homepage, // 'https://masthead-clean.vercel.app', // Замените на ваш домен
  output: "server", // Enables SSR across all routes
  //adapter: node({ mode: 'standalone' }),
  adapter: vercel({
    // Оптимизация под Serverless-функции Vercel
    isr: DEV
      ? undefined
      : {
          // Кэширование страниц на уровне Edge по желанию
          clearCacheOnDeploy: "always",
        },
  }),
});
