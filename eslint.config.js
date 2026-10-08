import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

// Focused on bugs rather than style: hook rules, accessibility and unsafe patterns.
export default tseslint.config(
  { ignores: ["dist", ".wrangler", "node_modules", "renderer", ".claude"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // The codebase types external rows and provider payloads loosely on purpose.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Players show generated speech and user uploads; the script and caption editor are the text alternative.
      "jsx-a11y/media-has-caption": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
