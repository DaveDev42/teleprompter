/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // Semantic tokens — use these instead of raw zinc/blue/etc.
        tp: {
          bg: "var(--tp-bg)",
          "bg-secondary": "var(--tp-bg-secondary)",
          "bg-tertiary": "var(--tp-bg-tertiary)",
          "bg-elevated": "var(--tp-bg-elevated)",
          "bg-input": "var(--tp-bg-input)",
          surface: "var(--tp-surface)",
          "surface-hover": "var(--tp-surface-hover)",
          "surface-active": "var(--tp-surface-active)",
          "user-bubble": "var(--tp-user-bubble)",
          "assistant-bubble": "var(--tp-assistant-bubble)",
          border: "var(--tp-border)",
          "border-subtle": "var(--tp-border-subtle)",
          "border-focus": "var(--tp-border-focus)",
          "text-primary": "var(--tp-text-primary)",
          "text-secondary": "var(--tp-text-secondary)",
          "text-tertiary": "var(--tp-text-tertiary)",
          accent: "var(--tp-accent)",
          "accent-hover": "var(--tp-accent-hover)",
          success: "var(--tp-success)",
          warning: "var(--tp-warning)",
          error: "var(--tp-error)",
        },
      },
      borderRadius: {
        badge: "6px",
        btn: "10px",
        search: "10px",
        card: "12px",
        bubble: "16px",
      },
    },
  },
  plugins: [],
};
