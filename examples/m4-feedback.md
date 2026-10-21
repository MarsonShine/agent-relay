# One issue from import to delivery

Use a registered repository and its trusted GitHub configuration. Import one issue by number and an idempotency key:

```text
node dist/cli.js task import --issue <issue-number> --key <import-key> --data-dir <private-data-dir>
```

Read the returned task ID and use `task status <task-id>` until local `accepted` is true. Acceptance means the current local candidate passed its checks and independent review; it does not publish anything. Publish explicitly with the current task version:

```text
node dist/cli.js task publish <task-id> --version <task-version> --data-dir <private-data-dir>
```

Check status for delivery state, CI, and inbox. The service watches only within its configured polling interval, count, page, and task deadline limits. Authorized feedback can return the task to local work; it does not extend those limits. A requirement update comment can use this form (the revision is illustrative):

```text
/relay {"kind":"requirement","requirementVersion":1,"revision":"0123456789abcdef0123456789abcdef01234567","files":["<project-relative-file>"],"text":"<requested requirement update>"}
```

Comments cannot change trusted commands, models, permissions, or budgets. When the bounded feedback window is ready to close, complete delivery explicitly:

Requirement feedback raises the requirement version and returns the task to triage; implementation or design feedback keeps the version and returns to its corresponding stage.

```text
node dist/cli.js task complete-delivery <task-id> --version <task-version> --data-dir <private-data-dir>
```

Completion closes the feedback window; it does not merge the pull request.
