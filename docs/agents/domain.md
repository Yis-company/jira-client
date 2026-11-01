# Domain docs

## Layout and reading order

This is a single-context application: React and Rust implement one desktop Jira workspace, not independent product domains.

- Read root `GLOSSARY.md` if present. If a future `GLOSSARY-MAP.md` exists, follow its pointers for the topic instead.
- Read relevant `docs/adr/` entries if present.
- Missing glossary or ADR files are normal: proceed silently. Create them lazily only when domain modeling resolves a term or decision; do not scaffold empty documents.
- Read `PRODUCT.md` for durable product truth and `README.md` for current supported behavior and release workflow.
- Preserve the existing decisions in `docs/implementation/`, `docs/feasibility/2026-09-26.md`, and approved `.codex/plans/` records. These are historical slice records; use the current README and source to establish later behavior rather than treating every older deferral as current.

## Consumer rules

Use the glossary's vocabulary when it exists; do not substitute conflicting synonyms. Surface contradictions with relevant decisions instead of silently replacing them. Note material terminology gaps for domain modeling without expanding an unrelated task.

Keep Jira's remote confirmation, the complete saved snapshot, pending local intent, and uncertain write outcomes distinct. Rust owns persistence, transport, and recovery; React reads typed IPC and owns presentation state. Preserve these existing boundaries unless Yi approves a change.
