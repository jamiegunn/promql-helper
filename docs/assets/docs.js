/* Progressive enhancement only — every page reads fine with JS disabled. */

// Reveal figures and specimens as they scroll into view.
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const targets = document.querySelectorAll('.reveal')

if (reduced || !('IntersectionObserver' in window)) {
  targets.forEach((el) => el.classList.add('shown'))
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('shown')
        observer.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
  )
  targets.forEach((el) => observer.observe(el))
}

// Highlight the section of the current page you are reading.
const marks = [...document.querySelectorAll('.rail-list a[href^="#"]')]
const sections = marks
  .map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))))
  .filter(Boolean)

if (sections.length > 0) {
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        marks.forEach((a) => a.classList.remove('is-active'))
        const active = marks.find((a) => a.hash.slice(1) === entry.target.id)
        active?.classList.add('is-active')
      }
    },
    { rootMargin: '0px 0px -70% 0px' },
  )
  sections.forEach((section) => spy.observe(section))
}
