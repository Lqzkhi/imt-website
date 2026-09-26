import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  adapter: vercel(),
  site: 'https://www.integratedmath.org',
  integrations: [sitemap({ filter: (page) => !new URL(page).pathname.startsWith('/test-portal') && !new URL(page).pathname.startsWith('/api/') })],
  vite: {
    plugins: [tailwindcss()],
    // Keep small processed scripts external so the strict script-src header
    // also permits navigation and other controls in the production build.
    build: { assetsInlineLimit: 0 },
  },
});
