# Idle list max fidelity

## Design reference

- Verified state name: `Automations - Task list Idle-time task / max`

## Required behavior

1. When the task list contains cards, render the Keep-awake notice after the tabs and before the task-card grid.
2. A failed idle-time task with a retained queue position renders both the red `Failure` status and the dimmed queue-position badge.
3. The Automations page title uses the frame typography: `30px` font size, `34px` line height, medium weight, and `0.114px` letter spacing.

## Root cause

- The populated list and Keep-awake notice were rendered by separate branches whose visual order did not match the frame.
- The task footer resolver returned only one presentation, so the failed branch discarded the still-relevant queue position.
- The page heading reused a compact UI typography token intended for smaller settings headings.

## Compatibility boundary

- These rules apply to the shared Automations UI on desktop and mobile Web.
- The responsive card layout remains unchanged; only element order, status composition, and heading typography are affected.

## Verification

- Presentation unit tests cover the failed-task secondary queue badge.
- Source fidelity tests cover the page heading typography.
- The populated-list regression test covers the Keep-awake notice appearing before the task grid.
