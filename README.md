# خبرخوان — Persian news aggregator

Fetches RSS from Iranian news agencies, removes duplicate wire stories,
and renders a plain static site (no database, no WordPress).

    node build.mjs        # refresh + rebuild into ./site

GitHub Actions runs it every 30 minutes and publishes to GitHub Pages.
`archive.json` is the story archive and is committed so the site keeps growing.
Sources and categories live in `feeds.json`.
