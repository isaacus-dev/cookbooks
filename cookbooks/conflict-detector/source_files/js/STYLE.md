# JavaScript style

Python here is held to the house style and checked by `isaacus-style` from [isaacus-core](https://github.com/isaacus-dev/isaacus-core). The pipeline modules are checked with `npm run lint` using `eslint.config.js`; the rules below also guide manual review. They draw on [MDN's JavaScript code style guidelines](https://developer.mozilla.org/en-US/docs/MDN/Writing_guidelines/Code_style_guide/JavaScript). MDN uses Prettier for formatting; the import ordering, spacing, and statement limits below are project house rules carried over from Python. Keep the two implementations easy to compare, with JavaScript naming, idioms, and language semantics taking precedence over a literal translation.

## Mirror the Python

- Keep corresponding files and functions in the same order where practical, so the two versions read side by side. Use JavaScript's own abstractions where language differences require them.
- Functions, variables, parameters, option keys, and internal object properties and methods use `camelCase`, so Python's `index_document(path, *, use_cache=True)` is `indexDocument(docPath, { useCache = true } = {})`. A function that isn't exported takes no leading underscore.
- Classes and constructors use `PascalCase`. Factory functions use `camelCase`, such as `createClause()`.
- Fixed configuration and symbolic constants use `UPPER_SNAKE_CASE`, such as `PIPELINE_VERSION`. Other module bindings use `camelCase`, such as `markdownCache`; declaring a binding with `const` does not make its name uppercase.
- Keys that are data keep their own spelling: fields written to JSON that the Python reads or writes too (`seg_id`, `gaps_reference`), and parameters an SDK or HTTP API defines (`is_iql`, `max_tokens`). Bind them to camelCase names: `{ gaps_reference: gapsReference }`.
- A helper with no Python twin stands in for a library Python imports, and lives where Python uses that library: `ftfy.js` and `text2markdown.js` for their Python packages, `mapPool()` for `ThreadPoolExecutor` in `document_analysis.js`.
- A keyword-only parameter (`*, use_cache=True`) becomes a trailing options object with defaults: `{ useCache = true } = {}`. No more than three positional parameters before it.
- A `msgspec.Struct` becomes a factory function returning a plain object, with `@property` methods represented by getters. Keep the pipeline functional, with corresponding Python and JavaScript stages following the same procedural flow.
- Use `async` when a function needs `await` or a promise-returning contract. Asynchronous work includes timers, events, and other promises as well as I/O. Callers may await a promise, return it directly, or compose it with other promises. Handle rejections at an appropriate boundary; deliberately detached work needs explicit error handling.

## Modules and imports

- ES modules (`"type": "module"` in `package.json`), with the `node:` prefix on built-in modules.
- Imports go at the top of the file, never partway down.
- House rule: three groups, a blank line between each: built-in modules, packages, then local files. Within a group, default and namespace imports (`import fs from`) come first, then a blank line, then named imports (`import { a } from`).
- Within each set, sort by module specifier length, shortest first, breaking ties alphabetically ignoring case. Names inside braces are sorted the same way. This is ruff's length-sorted isort, as the Python uses.
- No unused imports, variables or parameters.

## Layout

The line limit, blank-line requirements, and statement limit in this section are house rules.

- Two-space indent, double quotes, semicolons, lines of 120 characters at most. A long prompt or other string written out as data is exempt.
- No region markers.
- One blank line between top-level functions.
- A blank line after a guard clause (an early `return`, `throw`, `continue` or `break`), and above a final `return` that has other statements before it. No more than eight statements in a row without a blank line.
- Always use braces for control flow statements and loops, including guards with a single statement. Put the body on its own line.

## Code

- `const` by default, `let` only when the value is reassigned, never `var`. One declaration per line.
- `===` and `!==`. The only loose comparison is `== null`, and only with a reason.
- Function declarations for named functions. Arrow functions for callbacks, with an implicit return where the body is one expression; don't assign one to a name.
- Template literals for interpolation, plain strings otherwise.
- `for...of` or an array method (`map`, `find`, `some`) over an index loop. Never `for...in` over an array.
- No `else` after a `return`.
- Literals for objects and arrays, property shorthand (`{ name, text }`) and `Object.hasOwn()`.
- `Number(value)` and `String(value)`, not `+value` or `"" + value`.
- Catch only an error you can recover from, and drop the parameter when it's unused: `catch { … }`. No `eval` or `new Function`.

## Comments

- No docstrings, JSDoc or module header comments, matching the Python in this repo.
- Comment only what the code can't say: why, not what. Use `//` on its own line above the code, with a blank line above it unless it opens a block.
- A paragraph is one line, however long, and the editor wraps it.
- Annotations take the Python shapes and tags: `// NOTE(design): …` with `design`, `impl`, `perf`, `gotcha`, `assume`, `future` or `just`, and `// TODO(now): …` with `now`, `next` or `perf`.
