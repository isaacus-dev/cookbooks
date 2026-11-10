import { defineConfig } from "eslint/config";

const houseRules = {
  rules: {
    "statement-spacing": {
      meta: { type: "layout", fixable: "whitespace", schema: [] },
      create(context) {
        function check(node) {
          let count = 0;
          let previous = null;
          for (const statement of node.body) {
            if (previous && statement.loc.start.line - previous.loc.end.line > 1) {
              count = 0;
            }

            count += 1;
            if (count > 8) {
              context.report({
                node: statement,
                message: "Separate groups of more than eight statements with a blank line.",
                fix(fixer) {
                  return fixer.insertTextBefore(statement, "\n");
                },
              });
              count = 1;
            }

            previous = statement;
          }
        }

        return { Program: check, BlockStatement: check };
      },
    },
    "function-spacing": {
      meta: { type: "layout", schema: [] },
      create(context) {
        return {
          Program(node) {
            const source = context.sourceCode;
            for (const [n, statement] of node.body.entries()) {
              const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
              if (declaration?.type !== "FunctionDeclaration" || n === 0) {
                continue;
              }

              const preceding = source.getTokenBefore(statement, { includeComments: true });
              if (preceding?.type === "Line" && preceding.value.trim().startsWith("region ")) {
                continue;
              }

              if (preceding && statement.loc.start.line - preceding.loc.end.line < 2) {
                context.report({ node: statement, message: "Use a blank line before a top-level function." });
              }
            }
          },
        };
      },
    },
    "imports": {
      meta: { type: "layout", schema: [] },
      create(context) {
        return {
          Program(node) {
            let previous = null;
            for (const statement of node.body.filter((item) => item.type === "ImportDeclaration")) {
              const specifier = statement.source.value;
              const named = statement.specifiers.every((item) => item.type === "ImportSpecifier");
              const group = specifier.startsWith("node:") ? 0 : specifier.startsWith(".") ? 2 : 1;
              const key = [group, Number(named), specifier.length, specifier.toLowerCase()];
              if (previous && compareImportKeys(previous.key, key) > 0) {
                context.report({ node: statement, message: "Sort imports by group, import type, then path length." });
              }

              if (previous && (key[0] !== previous.key[0] || key[1] !== previous.key[1])
                && statement.loc.start.line - previous.node.loc.end.line < 2) {
                context.report({ node: statement, message: "Separate import groups with a blank line." });
              }

              const names = statement.specifiers.filter((item) => item.type === "ImportSpecifier")
                .map((item) => item.imported.name);
              const sorted = [...names].sort((a, b) => (
                a.length - b.length || a.toLowerCase().localeCompare(b.toLowerCase())
              ));
              if (names.some((name, n) => name !== sorted[n])) {
                context.report({ node: statement, message: "Sort named imports by length, then alphabetically." });
              }

              previous = { node: statement, key };
            }
          },
        };
      },
    },
  },
};

function compareImportKeys(a, b) {
  for (const [n, value] of a.entries()) {
    if (value !== b[n]) {
      return value < b[n] ? -1 : 1;
    }
  }

  return 0;
}

export default defineConfig([
  {
    ignores: ["node_modules/**", "helpers/ftfy-data.js", "web/**", "results/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly", console: "readonly", process: "readonly",
        TextDecoder: "readonly", TextEncoder: "readonly", setTimeout: "readonly", URL: "readonly",
      },
    },
    plugins: { house: houseRules },
    rules: {
      "house/statement-spacing": "error",
      "house/function-spacing": "error",
      "house/imports": "error",
      "camelcase": ["error", { properties: "never", ignoreDestructuring: true }],
      "no-trailing-spaces": "error",
      "no-multiple-empty-lines": ["error", { max: 1, maxEOF: 0, maxBOF: 0 }],
      "no-unused-vars": ["error", { args: "after-used", caughtErrors: "all", argsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-var": "error",
      "prefer-const": "error",
      "curly": ["error", "all"],
      "eqeqeq": ["error", "always"],
      "one-var": ["error", "never"],
      "one-var-declaration-per-line": ["error", "always"],
      "func-style": ["error", "declaration", { allowArrowFunctions: false }],
      "arrow-body-style": ["error", "as-needed"],
      "object-shorthand": ["error", "always"],
      "no-else-return": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-implicit-coercion": "error",
      "semi": ["error", "always"],
      "quotes": ["error", "double", { avoidEscape: true, allowTemplateLiterals: false }],
      "indent": ["error", 2, { SwitchCase: 1 }],
      "brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "max-len": ["error", {
        code: 120, ignoreComments: true, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true,
      }],
      "padding-line-between-statements": ["error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: ["if", "for", "while", "try"], next: "*" },
      ],
    },
  },
]);
