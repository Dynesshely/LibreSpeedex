/**
 * Tailwind drives the modern (and now only) frontend.
 *
 * The palette is deliberately expressed in terms of the CSS custom properties
 * declared in `frontend/styling/colors.css`, so there is exactly one place to
 * change the screen colours: flip the variable, and both the utility classes
 * and the hand written CSS follow.
 *
 * Build with `npm run css` (input: frontend/styling/tailwind.src.css).
 */
module.exports = {
  content: ["./index.html", "./stability.html", "./frontend/javascript/**/*.js"],
  /* The project ships its own reset in frontend/styling/index.css and the
     gauges rely on it. Tailwind's preflight would fight with that. */
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        phosphor: "rgb(var(--crt-phosphor) / <alpha-value>)",
        magenta: "rgb(var(--crt-magenta) / <alpha-value>)",
        screen: "rgb(var(--crt-screen) / <alpha-value>)",
        ink: "rgb(var(--crt-ink) / <alpha-value>)",
        muted: "rgb(var(--crt-muted) / <alpha-value>)",
        amber: "rgb(var(--crt-amber) / <alpha-value>)",
      },
      fontFamily: {
        term: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "DejaVu Sans Mono",
          "Liberation Mono",
          "monospace",
        ],
        sans: ["Inter", "sans-serif"],
      },
      letterSpacing: {
        terminal: "0.12em",
      },
      boxShadow: {
        phosphor: "0 0 1.2rem rgb(var(--crt-phosphor) / 0.35)",
        "phosphor-lg": "0 0 3rem rgb(var(--crt-phosphor) / 0.3)",
      },
    },
  },
  plugins: [],
};
