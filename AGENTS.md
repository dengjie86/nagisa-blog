# nagisa-blog

- Existing blog is static HTML/CSS. `study/index.html` embeds the 1,121-question source bank; preserve its question IDs and source answers.
- `study/sync.js` synchronizes one intentionally public, shared progress state for every visitor. There is no login or per-user data isolation. Do not introduce individual profiles without a user request.
- `/api/study-progress` is a Cloudflare Pages Function backed by the `STUDY_DB` D1 binding in `wrangler.toml`. Field timestamps merge independent edits; a reset timestamp prevents old devices from restoring cleared data. Polling returns only changed fields.
- Keep `.wrangler/`, `.dev.vars*`, `.env*`, and credentials out of Git. Never print OAuth/API tokens.
- `study/index.html` versions its sync asset URLs with `?v=shared-1`. Bump this version when replacing these assets to avoid a cached SPA fallback or stale asset response.
- Local setup: `npx wrangler@4 d1 migrations apply nagisa-study-progress --local`, then `npx wrangler@4 pages dev . --ip 127.0.0.1 --port 8788 --show-interactive-dev-session false`.
- API checks: `node --test tests/study-progress.test.mjs`. These checks only allow localhost and modify the local test database. Never run destructive test resets against production.
- Before publishing, test two independent browser contexts for merging, offline retry, draft persistence, and shared reset. Check desktop/mobile rendering and preserve local-only progress during migration.
- Production is Cloudflare Pages project `nagisa-blog`, branch `main`, at `https://nagisa0v0.com`. Git pushes deploy automatically. Apply new D1 migrations before the matching deployment, then verify the Pages check and the live endpoint.
