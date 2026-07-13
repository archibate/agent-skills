---
name: grep-app
description: >
  Code search across millions of public GitHub repositories via grep.app. Use before writing or planning code to find real-world usage of libraries, frameworks, APIs, algorithms, or syntax patterns. Prefer this over web search for code examples.
---

# grep.app

Search real-world code examples from over a million public GitHub repositories. Powered by [grep.app](https://grep.app) MCP. No API key required.

## searchGitHub

Find real-world code examples by searching for **literal code patterns** (like grep), not keywords.

- `query` (required): literal code pattern (e.g. `useState(`, `import React from`, `async function`)
- `language`: array of language filters (e.g. `Python`, `TypeScript`, `TSX`, `Java`, `Go`, `Rust`, `C#`, `YAML`, `Markdown`)
- `repo`: filter by repository (e.g. `facebook/react`, `vercel/`) — partial names match
- `path`: filter by file path (e.g. `src/components/Button.tsx`, `/route.ts`) — partial paths match
- `useRegexp`: interpret query as regex (default: `false`). Prefix with `(?s)` for multiline
- `matchCase`: case-sensitive search (default: `false`)
- `matchWholeWords`: match whole words only (default: `false`)

### Basic usage

```bash
scripts/mcpcall.py searchGitHub query:"useState("
scripts/mcpcall.py searchGitHub query:"getServerSession" --args '{"language": ["TypeScript", "TSX"]}'
scripts/mcpcall.py searchGitHub query:"CORS(" matchCase:true --args '{"language": ["Python"]}'
```

### Filter by repo or path

```bash
scripts/mcpcall.py searchGitHub query:"createContext" repo:"facebook/react"
scripts/mcpcall.py searchGitHub query:"export default" path:"/route.ts" --args '{"language": ["TypeScript"]}'
```

### Regex patterns

```bash
scripts/mcpcall.py searchGitHub query:"(?s)useEffect\\(\\(\\) => \\{.*removeEventListener" useRegexp:true
scripts/mcpcall.py searchGitHub query:"(?s)try \\{.*await" useRegexp:true --args '{"language": ["TypeScript"]}'
```

## Tips

- Search for **actual code** that appears in files, not keywords or questions
  - Good: `useState(`, `import React from`, `async function`
  - Bad: `react tutorial`, `best practices`, `how to use`
- Use `(?s)` prefix in regex to match across multiple lines
- Filter by `language` to narrow results to relevant file types
- Filter by `repo` with org prefix (e.g. `vercel/`) to search within an organization
- Combine `matchCase:true` with specific function names for precise matches
