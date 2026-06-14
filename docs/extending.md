# Extending the engine

Where the engine has real seams you can plug into, and where it ships an opinionated stack instead.
The worked examples below load against the actual interfaces in `engine/` — the signatures here are
the ones in the code, not aspirational ones.

## 1. Seam summary

| Seam | v1 status |
|---|---|
| Scraper / trend provider | interface declared + manual-submission path first-class; reference adapter optional |
| LLM provider (chain seats) | host-runtime-owned (the engine never calls a chain-seat LLM) |
| LLM/vision/media provider (engine-side calls) | provider config block (§5 below) |
| Publisher | interface declared + two adapters ship (Postiz, Giphy) |
| Approval surface | card schema declared + Discord reference implementation ships |
| Media gen / visual indexing / retrieval | retrieval contract declared; provider block for the calls |
| Rules & codes | fully open day one (see [`rule-authoring.md`](rule-authoring.md)) |
| Archetypes | user-defined alongside any extracted set |
| Platform descriptors | registry declared (§3 below) |
| Writing frameworks | replaceable shipped assets in `rules/core/frameworks/` |
| Workflows | text-heavy / video-heavy ship; new types register via descriptor + pipeline contract |
| Campaigns | runtime extension surface |
| Templates | every shipped template overridable per install; overrides survive upgrades |

Two seams are roadmap, not v1: a second approval surface beyond Discord, and per-seat LLM-provider
routing beyond the engine-side provider block.

## 2. Publisher adapters (`engine/publishers/publisher.js`)

The publisher seam is the single contract the executor publishes through. **No engine component may
call a publisher API except inside an adapter registered here.** An adapter is any object exposing
the four required methods as functions (duck-typed — it need not extend a base class):

```js
const adapter = {
  // Hand a packaged item to the publisher. IDEMPOTENT BY content_id: handing the same content_id
  // off twice MUST NOT create a second post. The reference Postiz adapter creates a DRAFT by
  // default (the second gate) and the queue advances to `handed_off`.
  handoff(pkg, options) {
    // ... call your backend, deduping on pkg.content_id ...
    return { external_ref: '<backend-post-id>', state: 'handed_off' };
  },

  // The truth-check that advances handed_off -> published and prevents mis-reported publishes.
  // If your backend CANNOT honestly report publish state, return UNVERIFIABLE — NEVER a fabricated
  // `published`. (This is exactly why TikTok is out of v1.)
  verifyStatus(external_ref, options) {
    return { state: 'published' }; // or 'handed_off' | 'unverifiable' | 'not_found' | 'failed_handoff'
  },

  // Engagement metrics for an analytics checkpoint ('1h' | '24h' | '7d'). No metrics?
  // return { supported: false }.
  fetchMetrics(external_ref, checkpoint, options) {
    return { metrics: { likes: 0, reposts: 0 } };
  },

  // Static declaration so the executor/packager route without probing.
  capabilities() {
    return { draft_gate: true, media_types: ['image', 'video'], limits: { text: 280 } };
  },
};
```

Register it on module load (the shipped adapters self-register on require):

```js
const publisher = require('../publishers/publisher');
publisher.register('my-backend', adapter); // 'my-backend' is the brand.json `publisher` enum value
```

`register` validates the shape and throws (naming the missing methods) if the adapter is malformed,
so a broken adapter fails at load, not at publish. The executor resolves the adapter named by the
brand's `platforms[].publisher` binding via `publisher.get(name)`; an unregistered name throws
`PublisherNotRegisteredError`, which surfaces as a precise wiring error in `engine status`.

The states an adapter may return are the public lifecycle subset
(`publisher.PUBLISH_STATE`): `handed_off`, `published`, `failed_handoff`, `unverifiable`, `not_found`
— never a raw backend status string.

**The cautionary contract test:** `engine/publishers/__tests__/publisher-contract.test.js` asserts an
adapter whose backend cannot confirm publication returns `unverifiable`, not `published`. This is the
TikTok-false-PUBLISHED defect encoded as a test; honor it when you write an adapter.

**Credentials:** an adapter resolves its own credentials via `engine/shared/secrets.js` by the §4
variable NAMES only (`POSTIZ_API_KEY` / `POSTIZ_API_URL` / `GIPHY_API_KEY` / `GIPHY_USERNAME`).
Platform-direct publish credentials are permitted **only** inside a registered adapter; each gets a
named row in `.env.example`. No other component reads them.

## 3. Platform descriptors (`schemas/config/platform-descriptor.schema.json`)

Adding a platform is one descriptor + one packager template + one gate module + an adapter binding —
not six subsystem edits. A descriptor declares:

```jsonc
{
  "id": "my-platform",
  "aliases": ["mp"],
  "workflow_class": "TEXT_HEAVY",          // or "VISUAL_HEAVY" — picks the lane
  "packager_contract_ref": "...",          // the packager template for this platform
  "gates_ref": "...",                      // the per-platform gate module
  "publisher": "my-backend",               // the registered adapter name
  "limits": { "text": 280 }
}
```

Then add a `PLAT.<PLATFORM>_<CHECK>` code to `rules/codes.md` for each platform gate (e.g.
`PLAT.TWITTER_HASHTAG_PRESENT`) and a paired rule file. v1 ships six descriptors (the supported set
plus the TikTok manual descriptor).

## 4. Scraper / trend adapters

The scraper/trend interface is `fetch(query|account, window) → corpus-item[]` (conforming to
`schemas/inputs/corpus-item.schema.json`), with provider-declared rate/ToS metadata. **Everything an
adapter returns is Zone U** — `untrusted-scraped` by default; it enters seat prompts only inside data
fences and may modify rules/config only through a reviewed learning record. The manual-submission
path is contractually equal to a scraper, so vendor breakage never blocks setup. See
[`data-policy.md`](data-policy.md) for the legal posture.

## 5. Provider config blocks (engine-side LLM/vision/media calls)

Engine-side components that call a provider directly — the visual gate, the library indexer, media
generation — take a `provider` config block instead of baking a vendor per call-site:

```jsonc
{
  "kind": "cli",                 // 'cli' | 'http'; absent/unknown ⇒ degrade-to-skip
  "model": "<model-id>",
  "endpoint_env": "<ENV_VAR_NAME>",   // the §4 env-var NAME whose value is the credential/endpoint
  "timeout_ms": 120000,               // a hard ceiling, never unbounded
  "options": { "command": "<image-capable-command>", "image_flag": "--image" }
}
```

Model and timeout selection live here, **never in vendor-named env vars.** The vision provider
(`engine/gate/visual-check/provider.js`) is the reference: a `cli` provider spawns the configured
command with the image path as an argv value and the prompt on stdin (`shell:false` always — no
injection), bounded by `timeout_ms`. An absent or unknown `kind` means **no provider** → the visual
gate degrades to skip-with-warning (the `VIS.SKIPPED_NO_PROVIDER` soft code), never an auto-pass and
never a crash. This is the same honest-status discipline as the publisher seam: the engine never
fabricates a pass.

> Chain-seat LLM routing (writer/gate/matcher) is owned by your host runtime, not this block. The
> provider block covers only the LLM calls the *engine* itself makes.

## 6. Approval surface

The surface-neutral **card schema** (`schemas/artifacts/approval-card.schema.json`) and **decision
schema** (`schemas/artifacts/approval-decision.schema.json`) are the interface;
`engine/shared/components-v2.js` plus the reaction listener are the Discord reference implementation.
Approval semantics — the action set, attribution, TTL — live in the schema, **not** in the emoji
order. The Discord reaction mapping is reference-implementation detail. A second surface (Slack-class)
behind the same card schema is roadmap.

## 7. What is fixed (forking territory)

These are fixed in v1; changing them means forking, and that is the honest answer: the agent roster
shape and handoff contracts; the gate-layer ordering and union-of-codes contract; the
no-publish-without-approval invariant; the mode-ladder semantics; the queue state vocabulary; N=3
variants; the single-runner lock.

## See also

- [`rule-authoring.md`](rule-authoring.md) — the rules/codes seam (fully open).
- [`configuration.md`](configuration.md) — where descriptor ids and publisher bindings live.
- [`setup/platforms.md`](setup/platforms.md) — wiring an adapter into a brand's platform.
