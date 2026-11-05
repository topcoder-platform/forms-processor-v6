import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["tools/**/*.cjs"], languageOptions: { sourceType: "commonjs", globals: { require: "readonly", module: "readonly", process: "readonly" } }, rules: { "@typescript-eslint/no-require-imports": "off" } },
);
