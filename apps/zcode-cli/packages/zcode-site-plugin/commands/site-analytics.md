---
description: Show visit analytics of a ZCode Sites site.
argument-hint: "[site id] [24h|7d|30d]"
skills: site-deploy
---

Use the `site-deploy` skill for this request:

$ARGUMENTS

Run `zcode-site analytics` with `--site <id>` when a site id is given (otherwise the linked site) and `--range` when a range is given (default 7d). Summarize page views, visitors, average visit duration and bounce rate, the trend, and the top pages, referrers, devices and regions. If there are no visits, say so; the numbers only count browser visits since the site's current address was set.
