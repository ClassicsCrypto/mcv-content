# Synthetic NFT collection fixtures — `nft-acme`

> **Every file here is synthetic and authored for this repository** (release-spec §5.3, RD-17;
> model §13.3 r1). Nothing here is, derives from, or resembles a real NFT, collection, contract,
> token, image, or marketplace listing. See `fixtures/PROVENANCE.md`.

These fixtures exercise the trait-index build path in `engine/library/tags/build-index.js`
(release-spec §5.3 / §7.8). They replace any real instance collection estate: the build tool is
**collection-agnostic** and discovers collections by scanning a metadata root, so the fixture
ships a tiny set rather than a full collection.

## Layout

`metadata/` is the directory you point the builder at (its `metadataRoot`). It contains two
collections, one per supported metadata layout the loader auto-detects:

| Collection | Layout | Tokens | Exercises |
|---|---|---|---|
| `acme-explorers/` | one OpenSea-style JSON file per token (`<id>.json` with an `attributes` array) | 25 | `loadJsonPerToken` |
| `acme-orbiters/` | a single `traits.csv` (`token_id,trait_type,value`, one row per trait) | 8 | `loadCsv` |

The 25-token JSON collection satisfies the RD-17 "25-token synthetic collection" requirement;
the CSV collection is added so both loader paths are covered by one fixture root.

## Build it

```sh
# Point the builder at this fixture metadata root and write indexes to a scratch dir.
node -e "require('./engine/library/tags/build-index.js').buildAndWrite({ \
  metadataRoot: 'fixtures/nft-acme/metadata', outDir: '/tmp/acme-tags' })"
# => /tmp/acme-tags/{by-token.json, by-trait.json, summary.json}
```

In a live instance the operator instead drops their real collection metadata under
`$CONTENT_HOME/library/metadata/<collection>/` and runs the builder with no overrides; the import
path for real collections is documented in `docs/configuration.md`.

## Trait vocabulary (synthetic)

All trait types and values are invented for this fixture (`Suit`, `Helmet`, `Tool`, `Backdrop`,
`Rarity` for explorers; `Rarity`, `Orbit Band`, `Finish` for orbiters) and carry no meaning
outside it. The `image` URIs are obvious `ipfs://example-placeholder/...` strings, not real CIDs.
