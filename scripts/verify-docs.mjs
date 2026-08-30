/**
 * Checks the documentation site for broken links, broken images, missing
 * anchors, console errors and horizontal overflow, in both colour schemes and
 * at mobile width.
 *
 *   npm run docs:serve      # in one terminal
 *   npm run docs:verify     # in another
 *
 * Needs Playwright, which is deliberately not a dependency of this project:
 *   npm i -D playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'

// Defaults to `npm run docs:serve`. Point BASE at a subpath such as
// http://localhost:8090/promql_helper/ to check the relative links behave the
// way they will on a GitHub Pages project site.
const BASE = process.env.BASE ?? 'http://localhost:8090/'
const PAGES = ['index.html', 'guide.html', 'investigations.html', 'architecture.html', 'reference.html']

const browser = await chromium.launch()
let bad = 0

for (const theme of ['light', 'dark']) {
  for (const file of PAGES) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1200 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    })

    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('requestfailed', (r) => errors.push(`FAILED ${r.url()}`))

    await page.goto(BASE + file, { waitUntil: 'networkidle' })
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(900)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(300)

    // Every <img> must have actually decoded.
    const brokenImages = await page.evaluate(() =>
      [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
    )

    // Every internal link must resolve.
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href'))
        .filter((h) => h && !h.startsWith('#') && !h.startsWith('http')),
    )
    const brokenLinks = []
    for (const href of [...new Set(links)]) {
      const res = await page.request.get(new URL(href, BASE + file).toString())
      if (!res.ok()) brokenLinks.push(`${href} → ${res.status()}`)
    }

    // Every in-page anchor must exist.
    const brokenAnchors = await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="#"]')]
        .map((a) => a.getAttribute('href'))
        .filter((h) => h !== '#' && !document.getElementById(decodeURIComponent(h.slice(1)))),
    )

    // Nothing may overflow the viewport horizontally.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )

    const problems = [
      ...errors.map((e) => `console: ${e}`),
      ...brokenImages.map((i) => `image: ${i}`),
      ...brokenLinks.map((l) => `link: ${l}`),
      ...brokenAnchors.map((a) => `anchor: ${a}`),
      ...(overflow > 1 ? [`horizontal overflow: ${overflow}px`] : []),
    ]

    if (problems.length) {
      bad++
      console.log(`✗ ${theme}/${file}`)
      problems.forEach((p) => console.log(`    ${p}`))
    } else {
      console.log(`✓ ${theme}/${file}`)
    }

    await page.screenshot({ path: `/tmp/docs-shots/${file}-${theme}.png`, fullPage: true })
    await page.close()
  }
}

// Mobile pass on the widest page.
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' })
await mobile.goto(BASE + 'guide.html', { waitUntil: 'networkidle' })
await mobile.waitForTimeout(500)
const mobileOverflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
)
console.log(mobileOverflow > 1 ? `✗ mobile overflow: ${mobileOverflow}px` : '✓ mobile 390px')
await mobile.screenshot({ path: '/tmp/docs-shots/mobile-guide.png', fullPage: false })
await mobile.close()

await browser.close()
console.log(bad === 0 ? '\nall pages clean' : `\n${bad} page(s) with problems`)
