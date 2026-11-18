import pkg from "@/lib/pkg";

console.log(process.env.NODE_ENV);

export const config = {
  name: pkg.name,
  title: pkg.title,
  homepage: pkg.homepage,
  repositoryUrl: pkg.repository.url,
  authorUrl: pkg.author.url,
  node_env: process.env.NODE_ENV,
  dev: import.meta.env.DEV,
  prod: import.meta.env.PROD,
};
