# Sources

Everything this design draws on, grouped by role. IDs `S1`–`S18` and `D1`–`D13` are cited
from `ARCHITECTURE.md`. The benchmark numbers quoted in the landscape section are
**vendor-reported** and rarely comparable across systems. See the methodology caveats in L14
and L15.

## Cognitive science → design

| id | source | used for |
|---|---|---|
| S1 | Gutiérrez et al., *HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs* — https://arxiv.org/pdf/2405.14831 | hippocampal indexing as retrieval; PPR spreading activation |
| S2 | Gutiérrez et al., *From RAG to Memory: Non-Parametric Continual Learning for LLMs* (HippoRAG 2, ICML 2025) — https://arxiv.org/abs/2502.14802 | passage nodes in the graph; recognition-memory filter; no factual-recall regression |
| S3 | Teyler & Rudy (2007), *The hippocampal indexing theory and episodic memory: updating the index*, Hippocampus 17:1158 — https://pubmed.ncbi.nlm.nih.gov/17696170/ · https://www.researchgate.net/publication/6143768_The_hippocampal_indexing_theory_and_episodic_memory_Updating_the_index | content vs. index split |
| S4 | *Reassessment of the Hippocampal Index Theory* — https://www.authorea.com/doi/10.22541/au.176442317.74625166 | index as sparse, hash-like pointers; pattern completion |
| S5 | Kumaran, Hassabis & McClelland (2016), *What Learning Systems do Intelligent Agents Need? CLS Theory Updated* — https://www.researchgate.net/publication/303982652_What_Learning_Systems_do_Intelligent_Agents_Need_Complementary_Learning_Systems_Theory_Updated | fast episodic / slow semantic; offline replay → consolidation job |
| S6 | Tse et al. (2007), *Schemas and Memory Consolidation*, Science 316:76 — https://science.sciencemag.org/content/316/5821/76.abstract · sleep-spindle follow-up: https://www.jneurosci.org/content/36/13/3799 | schema-accelerated consolidation → schema-fit gate |
| S7 | *To update or to create? The influence of novelty and prior knowledge on memory networks*, Phil. Trans. R. Soc. B — https://royalsocietypublishing.org/rstb/article/379/1906/20230238/42861/To-update-or-to-create-The-influence-of-novelty | update-vs-create decision in consolidation |
| S8 | *Attention to Event Segmentation Improves Memory in Young Adults* — https://pmc.ncbi.nlm.nih.gov/articles/PMC11774534/ | episodes bounded at prediction-error boundaries |
| S9 | Radvansky & Zacks (2017), *Event boundaries in memory and cognition* — https://memorylab.nd.edu/assets/259507/radvansky_zacks_2017_current_opinion_in_behavioral_science_.pdf | within-event order memory; topic-shift segmentation |
| S10 | Collins & Loftus (1975), *A Spreading-Activation Theory of Semantic Processing* — https://faculty.sites.uci.edu/eloftus/files/2024/08/CollinsLoftus_PsychReview_75.pdf · overview: https://en.wikipedia.org/wiki/Spreading_activation | spreading activation from cue nodes |
| S11 | *An Integrated Computational Framework for the Neurobiology of Memory Based on the ACT-R Declarative Memory System* — https://link.springer.com/article/10.1007/s42113-023-00189-y | base-level activation, power law of forgetting |
| S12 | *Eviction Without Deletion: Running an ACT-R Decay Policy for Agent Memory* — https://dev.to/futhgar/eviction-without-deletion-running-an-act-r-decay-policy-for-agent-memory-36hi · Taatgen, Lebiere & Anderson, *Modeling paradigms in ACT-R* — https://www.ai.rug.nl/~niels/publications/taatgenLebiereAnderson.pdf | d = 0.5 default; forgetting as demotion; retrieval-probability equation |
| S13 | Lee, Nader & Schiller (2017), *An Update on Memory Reconsolidation Updating*, TiCS — https://www.sciencedirect.com/science/article/abs/pii/S1364661317300785 | recall makes memory labile → reconsolidation window |
| S14 | *Molecular Mechanisms of Reconsolidation-Dependent Memory Updating* — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7555418/ | updating requires new information at retrieval |
| S15 | Johnson, Hashtroudi & Lindsay (1993), *Source monitoring* · Johnson, *Source monitoring and memory distortion* — https://www.semanticscholar.org/paper/Source-monitoring-and-memory-distortion.-Johnson/46e0c3e61c5f239a858e8c3b9ac26f5e5813beaa | provenance + trust on every fact |
| S16 | Rasmussen et al., *Zep: A Temporal Knowledge Graph Architecture for Agent Memory* — https://arxiv.org/html/2501.13956v1 · Zep blog on bi-temporal edges — https://blog.getzep.com/beyond-static-knowledge-graphs/ | bi-temporal fact model; invalidation instead of deletion |
| S17 | *Agent Memory Systems and Knowledge Graphs: Letta, Mem0, Graphiti, and Cognee* — https://codepointer.substack.com/p/agent-memory-systems-and-knowledge · Graphiti temporal model — https://www.mintlify.com/getzep/graphiti/concepts/temporal-model | Graphiti's `valid_at` / `invalid_at` / `expired_at` semantics |
| S18 | Node.js issue #56951, *Add SQLite FTS5 Extension* — https://github.com/nodejs/node/issues/56951 · openclaw #20987, *node:sqlite compiled without FTS5* — https://github.com/openclaw/openclaw/issues/20987 | FTS5 probe + BM25 fallback |

## Dreaming (REM) → design

| id | source | used for |
|---|---|---|
| D1 | Lewis, Knoblich & Poe (2018), *How Memory Replay in Sleep Boosts Creative Problem-Solving*, Trends in Cognitive Sciences — https://pubmed.ncbi.nlm.nih.gov/29776467/ | NREM forms schemas, REM recombines across them |
| D2 | Cai et al. (2009), *REM, not incubation, improves creativity by priming associative networks*, PNAS — https://www.pnas.org/doi/10.1073/pnas.0900271106 | remote associations as REM's output |
| D3 | Fosse, Fosse, Hobson & Stickgold (2003), *Dreaming and Episodic Memory: A Functional Dissociation?*, J. Cognitive Neuroscience — https://direct.mit.edu/jocn/article-abstract/15/1/1/3724/Dreaming-and-Episodic-Memory-A-Functional | recombination, not replay |
| D4 | Wamsley et al. (2010), *Dreaming of a Learning Task Is Associated with Enhanced Sleep-Dependent Memory Consolidation*, Current Biology — https://pubmed.ncbi.nlm.nih.gov/20417102/ | sampling recent activity |
| D5 | Hoel (2021), *The overfitted brain: Dreams evolved to assist generalization*, Patterns — https://www.sciencedirect.com/science/article/pii/S2666389921000647 | noise share |
| D6 | Izawa et al. (2019), *REM sleep–active MCH neurons are involved in forgetting hippocampus-dependent memories*, Science — https://www.science.org/doi/10.1126/science.aax9238 | read-once log, expiry |
| D7 | Crick & Mitchison (1983), *The function of dream sleep*, Nature — https://www.nature.com/articles/304111a0 | pruning ungrounded proposals |
| D8 | Tononi & Cirelli (2014), *Sleep and the Price of Plasticity*, Neuron — https://pmc.ncbi.nlm.nih.gov/articles/PMC3921176/ | dream edges start at weight 0 |
| D9 | Walker & van der Helm (2009), *Overnight therapy? The role of sleep in emotional brain processing*, Psychological Bulletin — https://pubmed.ncbi.nlm.nih.gov/19702380/ | context; emotional processing not modeled |
| D10 | Revonsuo (2000), *The reinterpretation of dreams*, Behavioral and Brain Sciences — https://www.cambridge.org/core/journals/behavioral-and-brain-sciences/article/abs/reinterpretation-of-dreams-an-evolutionary-hypothesis-of-the-function-of-dreaming/EE0E7DB39E361540D2DDA79C262EDA7E | context; threat simulation not modeled |
| D11 | Hinton, Dayan, Frey & Neal (1995), *The "Wake-Sleep" Algorithm for Unsupervised Neural Networks*, Science — https://www.science.org/doi/10.1126/science.7761831 | learning from self-generated samples |
| D12 | Shin et al. (2017), *Continual Learning with Deep Generative Replay* — https://arxiv.org/abs/1705.08690 | synthesized rehearsal |
| D13 | Lin et al. (2025), *Sleep-time Compute: Beyond Inference Scaling at Test-time* — https://arxiv.org/abs/2504.13171 | LLM agents computing offline |

## Agent-memory engineering

| id | source | used for |
|---|---|---|
| E1 | Park et al. (2023), *Generative Agents* — recency / importance / relevance scoring; reflection. Survey: *Memory for Autonomous LLM Agents* — https://arxiv.org/html/2603.07670v1 | importance term; reflection → `schemas/` |
| E2 | Mastra, *Observational Memory* — https://mastra.ai/blog/observational-memory · reference — https://mastra.ai/docs/memory/observational-memory | observer/reflector compression, an alternative in the owner's framework |
| E3 | Dataview, *Adding Metadata* (inline fields; bracketed `[key:: value]`) — https://blacksmithgu.github.io/obsidian-dataview/annotation/add-metadata/ · Tasks plugin Dataview format — https://publish.obsidian.md/tasks/Reference/Task+Formats/Dataview+Format | fact-line syntax (ADR-0002) |
| E4 | Graphiti MCP server README — https://github.com/getzep/graphiti/blob/main/mcp_server/README.md · repo — https://github.com/getzep/graphiti | comparison point; OpenAI-compatible local endpoints |
| E5 | Basic Memory — https://github.com/basicmachines-co/basic-memory | markdown-first memory with a derived index: the closest prior art |

## Landscape surveyed before building (memory systems with MCP)

| id | source |
|---|---|
| L1 | Hindsight paper, *Hindsight is 20/20* — https://arxiv.org/pdf/2512.12818 |
| L2 | VentureBeat on Hindsight — https://venturebeat.com/data/with-91-accuracy-open-source-hindsight-agentic-memory-provides-20-20-vision |
| L3 | Cognee v1.6.0 release notes (telemetry fingerprinting) — https://sourceforge.net/projects/cognee.mirror/files/v1.6.0/ |
| L4 | Cognee issue #5023 (MCP auth header mismatch) — https://github.com/topoteretes/cognee/issues/5023 |
| L5 | MemFabric (comparison of permission-scoped recall across systems) — https://pypi.org/project/memfabric/0.2.0/ |
| L6 | Mem0 self-hosted setup — https://docs.mem0.ai/open-source/setup |
| L7 | Mem0 issue #3729 (PostHog telemetry despite opt-out) — https://github.com/mem0ai/mem0/issues/3729 |
| L8 | Supermemory self-hosting — https://supermemory.ai/docs/self-hosting/overview |
| L9 | *MCP Memory Server: What It Is & How to Choose (2026)* — https://dev.to/mind_anthony/mcp-memory-server-what-it-is-how-to-choose-2026-3co5 |
| L10 | Mastra OM research write-up — https://mastra.ai/research/observational-memory |
| L11 | *Best AI agent memory tools in 2026* (Braintrust) — https://www.braintrust.dev/articles/best-ai-agent-memory-tools-2026 |
| L12 | *Best AI Agent Memory in 2026: A Decision Map* — https://dev.to/izgorodin/best-ai-agent-memory-in-2026-a-decision-map-not-a-ranking-4n35 |
| L13 | *Memory MCP Servers Compared* (Unblocked) — https://getunblocked.com/blog/memory-mcp-servers-compared/ |
| L14 | *Spatial Metaphors for LLM Memory: A Critical Analysis of MemPalace* (benchmark-claims audit) — https://arxiv.org/pdf/2604.21284 |
| L15 | *Agentic Context Management* (benchmark-methodology caveats) — https://arxiv.org/pdf/2607.21503 |

## Security references

| id | source | lesson |
|---|---|---|
| X1 | mcp-memory-service CVEs (CVE-2026-33010 wildcard CORS with credentials; CVE-2026-49291 read scope could call mutating tools; CVE-2026-50027 unauthenticated document routes) — https://app.opencve.io/cve/?product=mcp-memory-service&vendor=doobidoo | auth on every route; scope-checked writes; no wildcard CORS |
| X2 | mcp-memory-keeper CVE-2026-54561 (arbitrary file read via import path) — https://app.opencve.io/cve/?product=mcp-memory-keeper&vendor=mkreyman | vault-confined paths |
| X3 | Owner's internal audits (project docs, not public): *Security audit: vectorize-io/hindsight* and *Security audit: dowlings/librechat-mnemonic* | no-auth `0.0.0.0` defaults; MCP auth bypass flag; automatic memory as a persistent injection channel; recall-scope leakage |
| X4 | Owner's internal guides: *Reusable GitHub Actions Pipeline for Multi-Arch Docker Images to GHCR* and *Hardened Network-Isolated docker-compose for Testing opencode against OpenRouter* | packaging and CI supply chain (Packaging phase); spend-capped OpenRouter keys |
