# Vault schema (v1)

This is the contract between humans, agents, and the indexer. The vault is the
source of truth; everything in `.circadia/index.sqlite` is derived from it
(plus the access log). If the indexer and this document disagree, this document
wins and the indexer has a bug.

`circadia lint` checks a vault against this spec.

---

## 1. Layout

```
<vault>/
  episodes/YYYY/MM/<YYYY-MM-DD>-<slug>.md   # episodic memory — one event per file
  entities/<kind>/<slug>.md                 # semantic memory — people, projects, concepts…
  schemas/<slug>.md                         # consolidated summaries (derived: true)
  procedures/<slug>.md                      # procedural memory — how-tos, standing rules
  _meta/                                    # human docs about this vault (not indexed)
  .circadia/
    index.sqlite                            # derived; safe to delete; gitignored
    access.jsonl                            # retrieval log; NOT derivable — keep it
    triples/                                # (hipporag mode) cached LLM extractions
```

- Only `*.md` files outside `_meta/`, `.circadia/`, and dot-folders are indexed.
- Folder placement is a convention; the **`type` frontmatter field is authoritative.**
  A file in `entities/` with `type: episode` is indexed as an episode (and `lint` warns).
- Filenames are slugs: lowercase, `a-z0-9-`. The **note id is the filename without
  `.md`**, unless frontmatter sets `id`. Ids must be unique across the vault.
- Wikilinks resolve by id, then by `aliases`, then by title (case-insensitive).

## 2. Frontmatter

Frontmatter is a YAML **subset** (the parser is zero-dependency, see
`src/vault/frontmatter.ts`). Supported:

- `key: value` scalars — strings, numbers, `true`/`false`, `null`
- quoted strings (`"…"` or `'…'`) — **required for wikilinks**: `source: "[[x]]"`
- inline lists: `tags: [a, b, "c d"]`
- block lists:
  ```yaml
  aliases:
    - Project X
    - px
  ```
- `#` comments on their own line

Not supported: nested maps, multi-line strings, anchors. Keep frontmatter flat.

### Common fields (all note types)

| field        | required | type                         | notes |
|--------------|----------|------------------------------|-------|
| `type`       | yes      | `entity` \| `episode` \| `schema` \| `procedure` | authoritative note type |
| `id`         | no       | slug                         | defaults to filename |
| `title`      | no       | string                       | defaults to first `# H1`, then id |
| `aliases`    | no       | list of strings              | used for wikilink + cue resolution |
| `tags`       | no       | list of strings              | drive `graph.scopes` rules |
| `created`    | no       | ISO date/datetime            | |
| `updated`    | no       | ISO date/datetime            | |
| `importance` | no       | number 0–1                   | salience at encode time; default 0.5 |
| `graph`      | no       | `wikilink` \| `typed` \| `hipporag` | per-note override of extraction mode (§6) |

### `type: entity`

| field  | required | notes |
|--------|----------|-------|
| `kind` | yes      | open vocabulary; recommended: `person`, `project`, `concept`, `place`, `tool`, `org`, `thing` |

### `type: episode`

Episodes are **append-only**: written once, never edited, except that consolidation
may set `consolidated`. Correct a wrong episode by writing a new one that says so.

| field          | required | notes |
|----------------|----------|-------|
| `started`      | yes      | ISO datetime with offset |
| `ended`        | no       | ISO datetime |
| `source`       | yes      | `chat` \| `import` \| `manual` \| `tool` |
| `by`           | yes      | who produced the content: `user` \| `agent` \| `tool` \| `web` \| `import` |
| `session`      | no       | opaque session id; episodes from one session share it |
| `boundary`     | no       | why the episode ended: `topic-shift` \| `session-end` \| `manual` \| `size` |
| `participants` | no       | list of quoted wikilinks |
| `consolidated` | no       | ISO date consolidation last processed this episode |

### `type: schema`

Consolidated summaries written by the consolidation job ("reflection"). Humans may edit
them; the next consolidation run treats human edits as authoritative.

| field       | required | notes |
|-------------|----------|-------|
| `derived`   | yes      | `true` |
| `sources`   | yes      | list of quoted wikilinks to the episodes/entities summarised |
| `generated` | yes      | ISO date |
| `model`     | no       | model id that produced it |

### `type: procedure`

How-tos and standing behavioural rules. No extra required fields. Procedures are
retrieved like anything else but are candidates for always-on context in future phases.

## 3. Body

- Content is split into **passages** at `#`, `##`, and `###` headings. Each passage is a
  node in the graph (HippoRAG 2 "passage node") and the unit returned by recall.
- `## Facts` and `## History` sections (names configurable, `vault.factsHeading` /
  `vault.historyHeading`) are parsed as fact lines (§4), not as prose passages. Their
  text is still keyword-indexed as one "facts" passage so fact content is searchable.
- Wikilinks anywhere in the body become `link` edges from this note to the target.
  Unresolved links are kept as dangling edges to a placeholder node (they flag
  something worth filing later) and reported by `lint`.

## 4. Fact lines

A fact is one Markdown list item inside `## Facts` or `## History`. It uses
[Dataview](https://blacksmithgu.github.io/obsidian-dataview/) **bracketed inline fields**
so every field is queryable in Obsidian, and fields are delimited unambiguously.

```md
## Facts
- [runs_on:: [[pi-cluster]]] [valid:: 2026-08-11..] [at:: 2026-08-11] [by:: user] [src:: [[2026-08-11-deploy]]] ^f-9x2k
- [status:: active] [valid:: 2026-06..] [by:: user]
- [maintained_by:: [[alex]]] [by:: agent] [src:: [[2026-09-02-standup]]] [conf:: 0.7] — inferred from standup notes

## History
- ~~[runs_on:: [[old-laptop]]] [valid:: 2026-07..2026-08-11]~~ [at:: 2026-07-02] [superseded:: 2026-08-11] [by:: user] ^f-1a7q
```

### 4.1 Grammar

```
fact-line   := "- " [ "~~" ] claim [ "~~" ] { " " field } [ " " comment ] [ " " block-id ]
claim       := "[" predicate ":: " object "]" { " " meta-field }     # meta may sit inside ~~ too
field       := "[" key ":: " value "]"
predicate   := snake_case identifier that is NOT a reserved key
object      := wikilink | literal
comment     := ("—" | "--") free text
block-id    := "^" [a-z0-9-]+          # Obsidian block reference; stable fact id
```

- The **subject** of every fact is the note it lives in.
- Exactly **one** non-reserved key per line: that is the predicate. Everything else is metadata.
- **Object** is a wikilink (→ an entity edge) or a literal (→ a value on the edge).
- Brackets nest: `[runs_on:: [[x|alias]]]` is valid; the parser matches balanced brackets.

### 4.2 Reserved keys

| key          | meaning | default when absent |
|--------------|---------|---------------------|
| `valid`      | **world time**: interval the fact was true, `from..to`, either side may be empty | `..` (always) |
| `at`         | **system time**: when this fact was recorded | note `updated`, then `created`, then file mtime |
| `superseded` | **system time**: when this fact stopped being believed (Graphiti `expired_at`) | — |
| `by`         | source kind: `user` \| `agent` \| `tool` \| `web` \| `import` | `user` |
| `src`        | provenance wikilink, normally to an episode | — |
| `trust`      | `high` \| `medium` \| `low` | from `by`: user→high, import→medium, agent→medium, tool→low, web→low |
| `conf`       | confidence 0–1 (extractor's or author's) | 1 |
| `id`         | alternative to a trailing `^block-id` | hash of (note, predicate, object, valid.from) |

### 4.3 Time values

`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a full ISO-8601 datetime. Intervals are
**half-open**: `valid:: 2026-07..2026-08-11` means from the start of July 2026 up to
(not including) the start of 11 Aug 2026. A bare value `valid:: 2026-08` means
`2026-08..` (from then on).

### 4.4 Status

| written as | status | indexed as |
|---|---|---|
| plain line in `## Facts` | `current` | edge with `expired_at = null` |
| `~~claim~~` anywhere, or any line with `superseded::` | `superseded` | edge with `expired_at = superseded` |
| plain line in `## History` without `superseded::` | `historical` | edge with `invalid_at` from `valid`; still believed, no longer true |

Never delete a fact to "change" it. Strike it, add `[superseded:: date]`, move it to
`## History`, and add the new fact to `## Facts`. This is the bi-temporal model: world
time (`valid`) and system time (`at`/`superseded`) are recorded independently, so
"what was true in July" and "what did we believe in July" are both answerable.

### 4.5 Provenance and trust (source monitoring)

- `by: agent | tool | web` facts **must** have `src::` pointing at the episode they
  came from. `lint` errors otherwise.
- Recall renders `trust: low` facts as quoted data (see `docs/SECURITY.md`); they are
  never presented to a model as instructions.
- Only the consolidation job (Phase 4) writes `by: agent` facts. The MCP `remember`
  tool writes **episodes only**.

## 5. Predicate vocabulary

Predicates live in `circadia.config.json` under `predicates`:

```json
"predicates": {
  "strict": false,
  "defs": {
    "runs_on":       { "object": "entity",  "inverse": "hosts",    "description": "software/service runs on hardware/host" },
    "maintained_by": { "object": "entity",  "inverse": "maintains" },
    "status":        { "object": "literal", "values": ["active", "paused", "archived"] }
  }
}
```

- `strict: false` (default): unknown predicates are indexed; `lint` warns.
- `strict: true`: unknown predicates are a lint error.
- `inverse` lets graph traversal label reverse edges; edges are always traversable both
  ways for spreading activation regardless.

## 6. Graph modes and extraction scopes

How much structure is extracted per note is decided by `graph.scopes` in config (first
matching rule wins), overridden by a note's `graph:` frontmatter:

| mode       | edge origins indexed/used | cost |
|------------|---------------------------|------|
| `wikilink` | `contains`, `link` | none — pure parse |
| `typed`    | + `fact`, `provenance` | none — pure parse |
| `hipporag` | + `triple`, `synonym` (LLM-extracted phrase graph) | LLM + embeddings; cached in `.circadia/triples/` |

See `docs/RETRIEVAL.md` for how modes are chosen at query time.

## 7. Versioning

This is schema **v1**. `_meta/` in a vault created by `circadia init` records the
version. Breaking changes bump the version and ship a migration in `src/vault/migrate/`.
