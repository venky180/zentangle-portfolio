/*
 * Your details. Edit this file; nothing else needs changing.
 */
window.SITE = {
  artist: 'Zenkystan',
  title: 'Zentangles in Motion',
  tagline: 'Hand-drawn patterns you can play with. Pick a sketch, then push it, melt it, shatter it.',

  // Shown at the bottom of the index page. Plain text; blank lines start new paragraphs.
  about: `Each piece starts as ink on paper: slow, repetitive, meditative pattern-making.
Here they are traced into vectors and animated with Perlin noise, so the lines can breathe, drift and react to you.

Every animation runs live in your browser; nothing is pre-recorded.`,

  // Links in the header/footer. Remove any you don't use.
  links: [
    { label: 'Instagram', url: 'https://instagram.com/' },
    { label: 'Email', url: 'mailto:me@zenkystan.com' },
  ],

  // Let visitors save a PNG of what they made? (false = no save button)
  allowDownloads: false,

  // Animation each sketch opens in: vertex, magnet, melt, shatter, lens, wind, morph,
  // draw, ink, scan, grow, redraw
  defaultMode: 'ink',
};
