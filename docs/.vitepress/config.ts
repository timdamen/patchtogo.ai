import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'patchtogo',
  description: 'Fast, reviewable security patches for npm packages that are stuck on a CVE.',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [{ text: 'How it works', link: '/how-it-works' }],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/' },
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
