# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo. Although it's a pnpm monorepo (`packages/core`, `packages/angular`, `packages/capacitor`), architectural decisions are recorded globally, not per-package.

## Before exploring, read these

- **`CLAUDE.md`** at the repo root — the source of truth for the wire contract, terminology firewall, and conventions.
- **`docs/decisions.md`** — this repo's ADR log (numbered ADR-NNN entries). Read the ADRs that touch the area you're about to work in. There is no `docs/adr/` directory; decisions live in this single file.
- **`docs/spec.md`** — the 5.0 build spec: event catalogue, wire contract, terminology firewall (N3).

If a `CONTEXT.md` gets created later by `/domain-modeling`, read it too. If any of these files don't exist, **proceed silently** — don't flag their absence or suggest creating them upfront.

## Use the project's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CLAUDE.md` and `docs/spec.md`. The terminology firewall is a hard rule: never use `span`/`trace`/`telemetry`/`instrumentation`/`otel` in public surface — say `event`/`performance data`/`capture`.

## Flag ADR conflicts

If your output contradicts an existing ADR in `docs/decisions.md`, surface it explicitly rather than silently overriding:

> _Contradicts ADR-029 (console-to-breadcrumbs) — but worth reopening because…_
