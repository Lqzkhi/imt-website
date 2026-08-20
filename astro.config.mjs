import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  adapter: vercel(),
  site: 'https://integratedmathtournament.org',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  server: {
    allowedHosts: true, 
  }
});
