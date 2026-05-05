import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Calendario',
        short_name: 'Calendario',
        description: 'Calendario privado con sincronización Google',
        theme_color: '#0ea5e9',
        background_color: '#f7f8fb',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/, /^\/auth/],
        runtimeCaching: [
          { urlPattern: /^https:\/\/.*\.supabase\.co\/.*$/i, handler: 'NetworkOnly' },
          { urlPattern: /^https:\/\/(www\.googleapis\.com|accounts\.google\.com)\/.*$/i, handler: 'NetworkOnly' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
