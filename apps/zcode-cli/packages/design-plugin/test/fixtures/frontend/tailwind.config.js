// Static parse only: if this file were executed, the sentinel below would be written.
const colors = require('tailwindcss/colors');
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'EXECUTED'), 'x');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#d1495b', 600: "#b23a4b" },
        slate: colors.slate,
        sand: `#${'e9dcc9'}`,
        current: 'currentColor',
        surface: 'hsl(var(--surface) / <alpha-value>)',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      spacing: { 18: '4.5rem' },
      borderRadius: { xl: '1rem', DEFAULT: '6px', lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)' },
    },
  },
  plugins: [require('@tailwindcss/forms')],
};
