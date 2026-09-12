import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import eslintConfigPrettier from "eslint-config-prettier";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  eslintConfigPrettier,
  {
    // next-env.d.ts is generated/managed by Next.js itself (regenerated on
    // every `next dev`/`next build`) and its triple-slash references are
    // required by Next's own convention — not something we should edit or lint.
    ignores: [".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"],
  },
  {
    // CLAUDE.md rule: src/core must stay framework-independent and
    // deterministic. It may depend only on src/lib (plain utilities) and
    // other src/core modules.
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["next", "next/*"],
              message: "src/core must not import Next.js. Keep it framework-independent.",
            },
            {
              group: ["@/db/*", "@/telegram/*", "@/providers/*", "@/insights/*", "@/app/*"],
              message:
                "src/core must not import database, Telegram, provider, insights, or app code. Pass data in as plain arguments instead.",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
