const { chromium } = require('playwright')
const path = require('path')

const PROTO = (f) => 'file://' + path.resolve(__dirname, '..', '..', 'open_design', f)

const pairs = [
  ['scenes', PROTO('scenes.html'), 'http://localhost:3402/scenes'],
  ['settings', PROTO('settings.html'), 'http://localhost:3402/settings'],
  ['data', PROTO('data-hub.html'), 'http://localhost:3402/data-hub'],
  ['skills', PROTO('skills.html'), 'http://localhost:3402/skills'],
  ['index', PROTO('index.html'), 'http://localhost:3402/'],
]

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  for (const [name, proto, next] of pairs) {
    for (const [tag, url] of [['proto', proto], ['next', next]]) {
      const page = await ctx.newPage()
      await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {})
      await page.waitForTimeout(700)
      await page.screenshot({ path: `/tmp/cmp_${name}_${tag}.png` })
      await page.close()
    }
    console.log('shot', name)
  }
  await browser.close()
})()
