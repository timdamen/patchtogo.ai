import { inject } from '@vercel/analytics'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp() {
    inject({ framework: 'vitepress' })
  }
} satisfies Theme
