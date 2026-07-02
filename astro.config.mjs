import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'server',
  adapter: vercel(),
  site: 'https://integratedmathtournament.org',
  integrations: [sitemap()],
  // Add this block below:
  server: {
    allowedHosts: true, 
  }
});