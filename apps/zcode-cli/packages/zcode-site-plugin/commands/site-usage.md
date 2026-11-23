---
description: Show ZCode Sites usage and plan limits.
skills: site-deploy
---

Use the `site-deploy` skill for this request:

$ARGUMENTS

Run `zcode-site usage` and show traffic, requests and storage against the plan limits for the current period. If `canDeploy` is false, explain `exceededReasons`: new deployments are paused until the next period, and upgrading their plan raises the limits.
