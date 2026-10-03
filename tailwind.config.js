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
        accent: "rgb(var(--crt-accent) / <alpha-value>)",
        alt: "rgb(var(--crt-alt) / <alpha-value>)",
        screen: "rgb(var(--crt-screen) / <alpha-value>)",
        ink: "rgb(var(--crt-ink) / <alpha-value>)",
        muted: "rgb(var(--crt-muted) / <alpha-value>)",
        warn: "rgb(var(--crt-warn) / <alpha-value>)",
        bad: "rgb(var(--crt-bad) / <alpha-value>)",
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
        /* Wide tracking is reserved for the small uppercase meta labels; body
           text and commands run at nearly normal spacing. Over-tracking
           everything is the quickest way to look like a sci-fi HUD. */
        label: "0.1em",
        terminal: "0.02em",
      },
      boxShadow: {
        /* Kept low: a heavy bloom reads as decoration, which is exactly what
           this palette is trying not to be. */
        accent: "0 0 1.2rem rgb(var(--crt-accent) / 0.28)",
        "accent-lg": "0 0 2rem rgb(var(--crt-accent) / 0.22)",
      },
    },
  },
  plugins: [],
};
