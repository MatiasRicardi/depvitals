# What

Describe the change and the problem it solves. Link the issue this closes (`Closes #123`).

# Scope check

- [ ] This change belongs to a scheduled roadmap release (or is a bug fix / docs / tooling change).
- [ ] No extra abstraction was introduced "for the future".
- [ ] No code in the target project is executed, and `package.json` is never modified.

# Quality

- [ ] `pnpm run check` passes locally (format, lint, typecheck, tests).
- [ ] Tests cover the change, including a fixture for any newly supported scenario.
- [ ] For detection changes: the false-positive risk is stated, and uncertain results are reported as
      `Needs Review`.
- [ ] Breaking changes are marked (`!` in the commit / `BREAKING CHANGE:` footer) and documented.
- [ ] `CHANGELOG.md` updated when the change is user-visible.

# Notes for the reviewer

Anything worth pointing out: trade-offs, known limitations, follow-up work.
