# Graphify Local Setup for AI Trader

Graphify provides a local knowledge graph of the AI Trader repository that Codex and Claude Code can use as a navigation aid for broad architecture, dependency, lifecycle, and cross-file questions.

The setup used by AI Trader is intentionally lightweight:

- Graphify runs locally.
- The generated graph lives under `graphify-out/`.
- `graphify-out/` is ignored by Git.
- Codex and Claude use one focused graph query to orient themselves before normal source inspection.
- Source code remains authoritative.
- The stock Graphify skills, hooks, and MCP integration are **not** part of this setup.

This guide is written as a complete Windows setup checklist so the same environment can be reproduced on another development machine.

---

## 1. Prerequisites

Before starting, make sure the AI Trader repository is already cloned locally and that you can open it in VS Code.

Typical repository location:

```text
C:\Users\<your-user>\Desktop\AI Trader Backend
```

Open a PowerShell terminal from the repository root before running the commands below.

You should also confirm that the repository itself is healthy before introducing Graphify:

```powershell
git status --short
```

A clean working tree is ideal, but not strictly required if you already know which local changes are intentional.

---

## 2. Install `uv`

Graphify is installed with `uv`, so install `uv` first.

### 2.1 Check whether `uv` is already installed

```powershell
uv --version
```

If PowerShell returns a version, skip to the Graphify installation section.

If PowerShell says that `uv` is not recognized, install it with Windows Package Manager:

```powershell
winget install astral-sh.uv
```

### 2.2 Refresh PATH after installation

On Windows, `winget` may report that `uv` is installed while an already-open VS Code terminal still cannot find it.

After installation:

1. Close the active VS Code terminal.
2. If `uv` is still not recognized, close VS Code completely.
3. Reopen VS Code.
4. Open a fresh PowerShell terminal.
5. Run:

```powershell
uv --version
```

A successful result should look similar to:

```text
uv 0.x.x (... x86_64-pc-windows-msvc)
```

The exact version will vary.

---

## 3. Install Graphify

The Python package name is `graphifyy`, but the installed command is `graphify`.

Install it with:

```powershell
uv tool install graphifyy
```

Then verify the executable:

```powershell
graphify --version
```

A successful result should return a Graphify version, for example:

```text
graphify 0.9.90
```

The exact version may change over time.

---

## 4. Install SQL parsing support

AI Trader contains Prisma migration SQL files. Without the optional SQL parser, Graphify may warn that `.sql` files contributed no symbols because the SQL parser is missing.

Install Graphify with SQL parser support by injecting `tree-sitter-sql` into the existing tool environment:

```powershell
uv tool install graphifyy --with tree-sitter-sql --force
```

Verify again:

```powershell
graphify --version
```

This is preferred over running `pip install tree-sitter-sql` separately because Graphify is installed inside the `uv` tool environment.

---

## 5. Repository integration used by AI Trader

AI Trader intentionally does **not** use Graphify's full stock agent integration.

During benchmarking, the stock Graphify integration caused substantially higher Codex context and cumulative input usage because it added a large skill, reference documentation, and repeated graph-query workflow.

The winning configuration was much smaller:

- one focused Graphify query;
- a 2,000-token graph result budget;
- queries anchored around concrete model/service/symbol names from the user's request;
- source verification afterward;
- no Graphify skills;
- no Graphify hooks;
- no MCP integration.

The repository's `AGENTS.md` and `CLAUDE.md` contain the lightweight behavior rules. Do not install the stock Graphify Codex or Claude integration on top of this configuration unless intentionally re-evaluating it.

In particular, do **not** run commands such as:

```powershell
graphify install --project --platform codex
```

or:

```powershell
graphify install --project --platform claude
```

for the normal AI Trader development setup.

Those commands install the heavier integration that the project deliberately moved away from.

---

## 6. Build the local AI Trader graph

AI Trader defines an npm convenience script for the full local graph build.

From the repository root, run:

```powershell
npm run graphify:build
```

The script currently runs:

```powershell
graphify extract . --code-only && graphify cluster-only . --no-label
```

### What the build does

The first command:

```powershell
graphify extract . --code-only
```

scans code files and builds the local structural graph without using an LLM to process non-code repository content.

The second command:

```powershell
graphify cluster-only . --no-label
```

performs community clustering and generates the graph report/visualization without using a model to generate community names.

`--no-label` is intentional: it keeps graph generation deterministic and avoids unnecessary model/token cost.

### Expected output

Graphify should report counts for nodes, edges, and communities and write output under:

```text
graphify-out/
```

On the original AI Trader benchmark machine, the graph was approximately:

```text
8,860 nodes
26,185 edges
288 communities
```

These values will change as the repository evolves, so different counts are not by themselves a problem.

You may also see a small number of SQL files reported as yielding no symbols. That is acceptable if the SQL parser is installed and Graphify explains that those particular files simply do not contain structures its extractor models.

---

## 7. Confirm the graph exists

After the build, verify the main graph file:

```powershell
Test-Path graphify-out\graph.json
```

Expected result:

```text
True
```

You can also inspect the generated directory:

```powershell
Get-ChildItem graphify-out
```

Typical generated files include items such as:

```text
graph.json
manifest.json
GRAPH_REPORT.md
graph.html
.graphify_analysis.json
.graphify_root
cache\
reflections\
```

The exact set may vary by Graphify version.

---

## 8. `graphify-out/` is local-only

The entire generated Graphify output directory is ignored by Git:

```gitignore
graphify-out/
```

Confirm that Git is not trying to track the generated graph:

```powershell
git status --short
```

You should **not** see hundreds or thousands of generated Graphify files listed.

Do not commit:

- `graphify-out/`
- `graph.json`
- `GRAPH_REPORT.md`
- Graphify cache files
- Graphify reflection files
- generated HTML graph output

The graph is derived local tooling state, not repository source of truth.

---

## 9. Update the graph after code changes

AI Trader also defines:

```powershell
npm run graphify:update
```

The update command currently runs the same extraction/clustering sequence as the build command:

```powershell
graphify extract . --code-only && graphify cluster-only . --no-label
```

Graphify uses its manifest/cache to reuse unchanged work where possible, so rerunning extraction on an existing graph can behave incrementally.

### When to refresh the graph

Run:

```powershell
npm run graphify:update
```

after changes that are likely to alter repository structure or relationships, for example:

- completing a substantial feature;
- merging a large feature branch;
- pulling a large batch of upstream changes;
- adding or moving major services, models, workers, controllers, routes, or UI areas;
- changing important cross-file dependencies;
- performing a refactor that moves architectural responsibilities;
- changing Prisma schema relationships or other important structural definitions.

You do **not** need to rebuild the graph after every tiny code edit.

Examples that generally do not require an immediate update:

- changing copy/text;
- a small styling edit;
- a one-line bug fix with no structural impact;
- updating a test expectation;
- editing comments or documentation only.

If an agent's Graphify results appear stale or inconsistent with source, update the graph before relying on it again.

---

## 10. How Codex and Claude are expected to use Graphify

The project instructions in `AGENTS.md` and `CLAUDE.md` are intentionally narrow.

When `graphify-out/graph.json` exists, agents should use Graphify only for broad architecture, dependency, lifecycle, or cross-file questions.

The intended pattern is:

```text
User asks broad repository question
        ↓
ONE focused Graphify query
        ↓
Graph returns likely symbols/files/relationships
        ↓
Agent reads relevant source files
        ↓
Agent verifies important claims in source
        ↓
Answer
```

The Graphify query should be anchored around concrete names from the request, such as:

```text
ExternalSignal
SignalEvaluation
OrderIntent
TrackedPosition
MarketRegime
riskGate
placeOrder
```

rather than simply restating an entire broad question in prose.

The project uses a query budget of:

```text
--budget 2000
```

Example:

```powershell
graphify query "ExternalSignal SignalDelivery SignalEvaluation OrderIntent risk gate placeOrder broker submission relationships" --budget 2000
```

Graphify output is treated as a navigation aid only.

Important conclusions must still be verified against source files.

---

## 11. What agents should not do

The lightweight AI Trader setup deliberately avoids several behaviors.

Agents should not:

- read the full Graphify skill or Graphify reference documentation for ordinary repository questions;
- read `graphify-out/graph.json` directly;
- use `GRAPH_REPORT.md` as authoritative source evidence;
- run a chain of repeated Graphify queries unless the first query fails to identify useful candidates;
- rebuild/update the graph automatically during ordinary analysis;
- install Graphify if it is missing unless explicitly asked;
- add Graphify hooks, skills, or MCP configuration unless intentionally evaluating a new integration design.

If `graphify-out/graph.json` does not exist, agents should fall back to normal repository exploration.

---

## 12. Optional manual Graphify queries

You can query Graphify directly from PowerShell to inspect repository structure yourself.

For example:

```powershell
graphify query "ExternalSignal SignalEvaluation OrderIntent" --budget 2000
```

Or:

```powershell
graphify query "TrackedPosition lifecycle reconciliation exit safety" --budget 2000
```

Or:

```powershell
graphify query "MarketRegime strategy eligibility external signals EntryDecision" --budget 2000
```

Expect Graphify to return graph nodes, file locations, relationships, and community information rather than a polished architectural explanation.

That is intentional. Its main role is to help locate where the agent should inspect next.

---

## 13. Optional graph visualization

Graphify generates:

```text
graphify-out\graph.html
```

You can open this file in a browser to inspect the clustered repository graph visually.

For large repositories such as AI Trader, Graphify may render an aggregated community view instead of every individual node at once.

The visualization can be useful for exploration, but it is not required for Codex or Claude to use the local graph.

---

## 14. Troubleshooting

### `uv` is installed but PowerShell says it is not recognized

Close the terminal and reopen it.

If that is not enough, completely restart VS Code and open a fresh PowerShell terminal.

Then retry:

```powershell
uv --version
```

---

### `graphify` is not recognized after installation

Restart VS Code/PowerShell so the `uv` tool executable path is refreshed.

Then verify:

```powershell
graphify --version
```

If necessary, reinstall:

```powershell
uv tool install graphifyy
```

---

### Graphify warns that SQL parsing support is missing

Install the SQL parser inside the Graphify `uv` environment:

```powershell
uv tool install graphifyy --with tree-sitter-sql --force
```

Then rerun:

```powershell
npm run graphify:build
```

---

### Graphify reports a few SQL files with zero symbols

If `tree-sitter-sql` is installed and Graphify explains that the remaining files simply contain no modeled symbols, this is generally fine.

The important distinction is:

- **parser missing** → fix the installation;
- **file parsed but yielded no symbols** → usually harmless.

---

### Graph results look stale

Update the graph:

```powershell
npm run graphify:update
```

Then retry the query.

---

### `graphify-out/` appears in Git status

Confirm `.gitignore` contains:

```gitignore
graphify-out/
```

Then rerun:

```powershell
git status --short
```

If Graphify output had previously been added to Git tracking, ignoring it alone will not remove already-tracked files. In that case, inspect Git state before removing anything from the index.

---

## 15. Recommended laptop setup checklist

Use this abbreviated checklist when copying the AI Trader development environment to a new Windows machine.

### Repository

```powershell
git pull
```

Confirm the project contains the Graphify guidance in:

```text
AGENTS.md
CLAUDE.md
```

and the npm scripts:

```text
graphify:build
graphify:update
```

### Install `uv`

```powershell
winget install astral-sh.uv
```

Restart VS Code.

```powershell
uv --version
```

### Install Graphify + SQL support

```powershell
uv tool install graphifyy --with tree-sitter-sql --force
```

```powershell
graphify --version
```

### Build the graph

From the repository root:

```powershell
npm run graphify:build
```

### Verify

```powershell
Test-Path graphify-out\graph.json
```

Expected:

```text
True
```

Check Git:

```powershell
git status --short
```

`graphify-out/` should not appear.

At this point, Codex and Claude Code can use the local graph automatically according to the project instructions.

---

## 16. Current AI Trader Graphify philosophy

The project intentionally uses Graphify as a **small navigation accelerator**, not as an agent framework.

Benchmarking showed that the lightweight approach was substantially more effective than the stock integration. The best-performing configuration used:

- no stock Graphify skills;
- no hooks;
- no MCP integration;
- one symbol-anchored query;
- `--budget 2000`;
- direct source verification afterward.

This reduced Codex cumulative input usage and investigation time across the benchmark architecture questions, and also reduced Claude Code context usage and work time.

If the Graphify integration is changed in the future, benchmark the new behavior before adopting it project-wide.

---

## 17. Source of truth

Graphify is never the source of truth for AI Trader behavior.

Priority should remain:

1. current source code;
2. current database/schema definitions where applicable;
3. current project architecture/development documentation;
4. Graphify as a navigation/indexing aid.

If Graphify disagrees with current source, trust the source and refresh the graph.
