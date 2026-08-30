/**
 * Captures the screenshots used by the documentation site.
 *
 * Walks the real wizard against whatever Prometheus the app is pointed at, in
 * both colour schemes, and writes element-tight PNGs into docs/assets/shots.
 * Run it with the fixture stack up (`npm run demo`) so the shots show the
 * checkout-api example the guide is written around.
 *
 *   npm run docs:shots
 *
 * Needs Playwright, which is deliberately not a dependency of this project:
 *   npm i -D playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const BASE = process.env.BASE ?? 'http://localhost:8787'
const OUT = process.env.OUT ?? 'docs/assets/shots'
const JOB = process.env.JOB ?? 'checkout-api'

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const problems = []

for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  })
  page.on('pageerror', (e) => problems.push(`[${theme}] ${e}`))
  page.on('console', (m) => m.type() === 'error' && problems.push(`[${theme}] ${m.text()}`))

  const shot = async (locator, name) => {
    await locator.screenshot({ path: `${OUT}/${name}-${theme}.png` })
    process.stdout.write(`  ${name}-${theme}.png\n`)
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.target-list')
  await page.waitForTimeout(400)

  // --- Step 1: picking a service ------------------------------------------
  await shot(page.locator('.target-list'), 'step1-targets')

  await page.getByRole('button', { name: new RegExp(JOB) }).first().click()
  await page.waitForSelector('.filter-row', { timeout: 15000 })
  await page.waitForTimeout(700)
  await shot(page.locator('.filter-row'), 'step1-filters')

  // --- Step 2: choosing a question ----------------------------------------
  await page.getByRole('button', { name: /Continue with/ }).click()
  await page.waitForSelector('.offer', { timeout: 25000 })
  await page.waitForTimeout(500)
  await shot(page.locator('.offer-grid').first(), 'step2-questions')
  await shot(page.locator('.offer').filter({ hasText: /happy users/i }), 'step2-card')
  await shot(
    page.locator('.offer').filter({ hasText: /pummelling the database/i }),
    'step2-dependency',
  )

  // --- Step 3: the report --------------------------------------------------
  await page
    .locator('.offer', { hasText: /happy users/i })
    .getByRole('button', { name: 'Find out' })
    .click()
  await page.waitForSelector('.verdict', { timeout: 40000 })
  await page.waitForTimeout(1000)

  await shot(page.locator('.verdict'), 'report-verdict')
  await shot(page.locator('.report-controls'), 'report-controls')
  await shot(page.locator('.stat-row'), 'report-stats')

  const latency = page.locator('.panel', { hasText: 'Response time percentiles' })
  await shot(latency, 'panel-chart')

  // Hover to demonstrate the crosshair and tooltip layer
  const svg = latency.locator('.chart-svg')
  const box = await svg.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.45)
    await page.waitForTimeout(350)
    await shot(latency.locator('.chart-wrap'), 'panel-tooltip')
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
  }

  // Table twin, then PromQL reveal
  await latency.getByRole('button', { name: 'Table' }).click()
  await page.waitForTimeout(300)
  await shot(latency, 'panel-table')
  await latency.getByRole('button', { name: 'Chart' }).click()
  await page.waitForTimeout(200)

  await latency.getByRole('button', { name: 'PromQL' }).click()
  await page.waitForTimeout(300)
  await shot(latency.locator('.promql'), 'panel-promql')
  await latency.getByRole('button', { name: 'PromQL' }).click()

  const ranked = page.locator('.panel', { hasText: 'Slowest endpoints' })
  await shot(ranked, 'panel-ranked')

  // Provenance disclosure — which metric each signal resolved to
  const provenance = page.locator('details', { hasText: /Metrics this used/ })
  await provenance.locator('summary').click()
  await page.waitForTimeout(300)
  await shot(provenance, 'report-provenance')

  await page.close()
}

await browser.close()
console.log(problems.length ? `\nPROBLEMS:\n${problems.join('\n')}` : '\nno console errors')
