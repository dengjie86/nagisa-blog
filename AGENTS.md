# nagisa-blog

- Static blog: `index.html`, `article1.html`, `style.css`, and `images/`.
- Production is Cloudflare Pages project `nagisa-blog`, branch `main`, at `https://nagisa0v0.com`. Git pushes deploy automatically.
- `wrangler.toml` keeps the current static deployment configuration. There are no active Pages Functions or D1 bindings.
- The study feature and sync API were retired after the exam. The unbound D1 database is retained as an archive; do not delete its data without an explicit request.
- Keep `.wrangler/`, `.dev.vars*`, `.env*`, and credentials out of Git. Never print OAuth/API tokens.
- Validate changes with `git diff --check`, inspect affected HTML and links, and check the Cloudflare deployment and live pages after publishing.
