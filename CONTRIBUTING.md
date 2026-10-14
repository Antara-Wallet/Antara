# Contributing to ANTARA

Thanks for your interest in improving ANTARA. Contributions of all kinds are welcome — bug reports, fixes, docs, and features.

## Before you start

- For anything non-trivial, **open an issue first** to discuss the approach.
- For security issues, **do not** open an issue — see [SECURITY.md](SECURITY.md).

## Development

Requires Node.js 22.12+. The desktop app also needs Rust/MSVC, the C++ build tools and WebView2.

```sh
npm ci
npm --prefix server ci
cp .env.example .env.local
cp server/.env.example server/.env
npm run dev:api   # API
npm run dev       # web app
```

See the [README](README.md#getting-started) for desktop and extension builds.

## Before opening a pull request

- `npm run typecheck` — no type errors
- `npm test` — unit, config and server tests pass
- `npm run check` — project checks pass

Keep changes focused, match the surrounding code style, and never weaken a security check or commit secrets. Every PR should explain what changed, why, and what you tested.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
