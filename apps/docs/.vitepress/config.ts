import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'patchtogo',
  description: 'Fast, reviewable security patches for npm packages that are stuck on a CVE.',
  head: [['link', { rel: 'icon', href: '/favicon.ico', sizes: 'any' }]],
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg', alt: 'patchtogo' },
    nav: [
      { text: 'Why', link: '/why-patchtogo' },
      { text: 'How it works', link: '/how-it-works' }
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Why patchtogo.ai', link: '/why-patchtogo' },
          { text: 'How it works', link: '/how-it-works' }
        ]
      }
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/timdamen/patchtogo.ai' }],
    footer: {
      message: 'Released under the MIT License. Patches are provided without warranty.'
    }
  }
})
