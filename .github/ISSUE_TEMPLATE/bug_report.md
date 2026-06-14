---
name: Bug report
about: Report something the engine does wrong, so we can reproduce and fix it
title: "[bug] "
labels: ["bug"]
assignees: []
---

<!--
Before filing: please search existing issues first.
SECURITY: do NOT file a security vulnerability here — follow SECURITY.md (private reporting).
REDACTION: do NOT paste secrets, tokens, webhook URLs, or real channel/user/guild IDs.
Replace any instance values with placeholders like <CHANNEL_ID>, $CONTENT_HOME, you@example.com.
-->

## Summary

<!-- One or two sentences describing the bug. -->

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What you expected to happen. -->

## Actual behavior

<!-- What actually happened. Paste relevant output, redacted — values of documented variables are
masked at write time, but verify nothing instance-specific slips through. -->

```
<paste redacted output / error here>
```

## Environment

- Engine version (`engine --version`, i.e. `node bin/engine.js --version`):
- Node.js version (`node --version`; the engine floor is Node 22):
- Host runtime (OpenClaw is the reference; note version, or "generic / other" with which):
- OS / platform:
- Affected platform lane, if any (Twitter/X, Giphy, Instagram, Facebook, YouTube):

## Mode

<!-- Which mode was active? SAFE (default) / LIVE_PREVIEW / LIVE. Note any --mode or ENGINE_MODE override. -->

## Additional context

<!-- Anything else: config snippets (redacted), which verb, whether the zero-key `engine fixture-run` reproduces it. -->

---

- [ ] I searched existing issues and this is not a duplicate.
- [ ] I removed all secrets, tokens, and real channel/user/guild IDs from this report.
- [ ] This is **not** a security vulnerability (those go through [SECURITY.md](../../SECURITY.md), not public issues).
