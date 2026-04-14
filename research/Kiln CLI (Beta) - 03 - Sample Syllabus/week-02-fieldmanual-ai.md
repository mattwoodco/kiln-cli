# **FieldManual AI**

*Grounded Systems: Real-Time Troubleshooting with Cited, Inspectable Evidence*

---

## Before You Start

Complete the Pre-Search checklist in the Appendix before writing any code. Your Pre-Search output becomes part of your final submission. (4 hours)

Run `kiln scaffold --week 2` from your existing Week 1 project root. This week extends your codebase — same repo, shared infrastructure. Read `spec.md` and `rubric.yml`. Verify your capture proxy is running with `kiln proxy status`. If you are starting fresh because Week 1 did not ship, talk to a TA immediately — you will need to bootstrap the ingestion and retrieval pipeline from scratch and the clock is already ticking.

---

## Background

A field technician arrives at a customer site. A CNC machine is throwing error code E-4073. The technician has a 400-page service manual, a parts catalog with 2,000 rows, maintenance logs from the site's CMMS, and an SOP binder of scanned PDFs. Today, the technician flips through the manual, calls the senior tech, waits on hold, and guesses. Average resolution time: 4 hours.

This is not a knowledge problem — the answer exists in the documentation. It is a retrieval problem. The right paragraph is buried in page 287 of a manual organized by subsystem, not by symptom. The relevant part number is in a spreadsheet cross-referenced by serial range. The maintenance history that explains why this error keeps recurring is in a CSV export nobody reads.

FieldManual AI solves this by grounding every answer in the exact manual section, the right part number, and the relevant maintenance history for this specific machine. Week 1 proved you can make AI cite documents. Week 2 proves you can do it under real-world constraints: multiple document types, structured and unstructured data, source authority hierarchies, model-specific filtering, and sub-4-second latency. The retrieval infrastructure you build this week becomes the backbone of Week 3's autonomous agent.

---

## Project Overview

You will build **FieldManual AI**, a grounded troubleshooting assistant for industrial service teams. It accepts natural-language questions from field technicians and returns cited, inspectable answers grounded in equipment manuals, SOPs, maintenance logs, parts catalogs, and incident histories. Every claim must trace to a specific source. Every source must be ranked by authority. Every answer must ship with an evidence bundle.

| Checkpoint | Deadline | Focus |
|------------|----------|-------|
| Pre-Search | Monday 6:00 PM CT | Source material inventory, chunking strategy, authority hierarchy design |
| MVP | Tuesday 6:00 PM CT (24 hrs) | Natural-language Q&A with citations across all document types |
| Checkpoint (optional) | Wednesday–Thursday | `kiln checkpoint` for formative feedback |
| Final Submission | Friday 10:59 PM CT | Full product with evidence bundles, conflict detection, chaos resilience, postmortem |

---

## Core Grounded Retrieval Infrastructure

### 1. Multi-Format Industrial Document Ingestion

- Extend Week 1's ingestion pipeline to handle the new document types and structures
- **Service manuals (PDF):** Section-based chunking with page numbers. Error code tables must be parsed into structured records, not treated as prose. Diagnostic procedures must preserve step ordering.
- **Parts catalog (XLSX):** Row-based records, not text chunks. Each row becomes a queryable record with: part number, description, model compatibility, serial range, supersession history. Supersession chains must be traversable (old PN → current PN).
- **Maintenance logs (CSV):** Per-entry records keyed by machine serial number. Must support temporal queries ("what happened to SN 42317 in the last 12 months?") and pattern detection ("which machines have recurring coolant pump replacements?").
- **Service bulletins (PDF):** Full-document chunks (they are short) with effective date metadata. Bulletins that supersede manual sections must be linked to the sections they replace.
- **SOPs (PDF):** Checklist-aware parsing. PM checklists must preserve item ordering and cross-reference parts catalog entries.

### 2. Source Authority Ranking

- Implement a configurable authority hierarchy:
  1. **Service bulletins** (highest) — with an effective date later than the corresponding manual section
  2. **Service manual** — primary reference for procedures and specifications
  3. **Maintenance logs / incident reports** — site-specific historical evidence
  4. **SOPs** — operational procedures
  5. **Parts catalog** — reference data
  6. **Training presentations** (lowest) — simplified, potentially inaccurate
- When a bulletin contradicts the manual, the bulletin takes precedence. The answer must cite both sources and note the update.
- The outdated parts catalog must be deprioritized. The training presentation must never override the manual.

### 3. Model & Serial Filtering

- Every query must be contextualizable to a specific machine model (e.g., VF-2) and optionally a serial number
- The retrieval layer must prefer documents matching the model/serial context
- The system must distinguish VF-2 information from VF-3 information. A question about the VF-2 must not return VF-3 procedures — even if the documents look similar
- When a serial-number-specific question has no matching records, the system must say so explicitly

### 4. Evidence Bundles & Conflict Detection

- Every answer ships with an evidence bundle: answer text, citations (source/page/section/quote), confidence score, sources consulted but not cited, and flags (gap, conflict, model mismatch, superseded information)
- When two sources disagree (e.g., manual says one torque spec, bulletin says another), surface both with dates. Resolve using the authority hierarchy but always show the user that a conflict existed.
- Strip any claim from the output that does not have a valid citation in the retrieved chunks

---

## MVP Requirements (24 hours)

Hard gate. All items required to pass. One failure = FAIL.

- Accepts natural-language questions via CLI or API
- Retrieves from all document types in the source package (PDF manual, XLSX catalog, CSV logs, PDF bulletins, PDF SOPs)
- ≥70% accuracy on the 25 graded questions (grading rubric provided with source material)
- Every answer that contains a factual claim includes a citation (source document, section/page/row, quote snippet). No citation = marked wrong regardless of answer correctness
- Correctly distinguishes VF-2 vs VF-3 information in ≥4 of 5 model-specific test questions
- Prefers the current parts catalog over the outdated parts catalog in retrieval results
- Synthesizes across maintenance logs + manual for the recurring failure question (SN 42317 coolant pump)
- P95 latency under 4 seconds for single-question response
- Extends Week 1 codebase — same repo, shared ingestion and retrieval infrastructure
- `docker compose up` builds and runs the full system on a clean machine
- Kiln capture proxy running with logged interactions
- `kiln audit` passes with zero blocking errors

---

## Testing Scenarios

### Scenario 1: Nonexistent Error Code
**Inject:** A question about error code E-9999, which does not exist in any manual.
**Expected behavior:** "Error code E-9999 not found in available documentation for the VF-2." Not a hallucinated diagnostic procedure.

### Scenario 2: Bulletin Supersedes Manual
**Inject:** A question where the answer in the manual is outdated and a service bulletin provides the correct, updated procedure.
**Expected behavior:** The answer uses the bulletin's procedure, cites both the bulletin and the manual section it supersedes, and notes the effective date of the update.

### Scenario 3: Model Mismatch
**Inject:** A question about the VF-3 machine asked in the context of VF-2 documentation.
**Expected behavior:** The system flags the model mismatch. It does not silently return VF-3 information as if it applies to the VF-2.

### Scenario 4: Unknown Serial Number
**Inject:** A maintenance history query for a serial number not present in the logs.
**Expected behavior:** "No maintenance records found for SN 99999." Not a fabricated maintenance history.

### Scenario 5: Training Presentation vs Manual
**Inject:** A question where the training presentation has a simpler but technically incorrect answer, and the manual has the correct, detailed answer.
**Expected behavior:** The manual takes precedence. The training presentation is not cited as the primary source for technical procedures.

### Scenario 6: Corrupted Data
**Inject:** A corrupted CSV maintenance log with missing columns and encoding issues.
**Expected behavior:** The system logs the parsing error, skips the corrupted entries, and answers using whatever valid data remains. It does not crash.

### Scenario 7: Multi-Document Synthesis
**Inject:** A question requiring information from the manual, a service bulletin, the parts catalog, and the maintenance logs to answer fully.
**Expected behavior:** The answer cites all relevant sources. The evidence bundle lists all consulted documents. The synthesis is coherent and grounded.

---

## Performance Targets

| Metric | Target |
|--------|--------|
| P50 latency (single question) | < 2 seconds |
| P95 latency (single question) | < 4 seconds |
| P99 latency (single question) | < 8 seconds |
| Citation accuracy (25 graded questions) | ≥ 70% |
| Model-specific filtering accuracy | ≥ 80% (4 of 5) |
| Poison document exclusion (training pres as primary source) | 100% |
| Parts catalog freshness (current over outdated) | 100% |

---

## Evaluation Framework

### Retrieval Quality

- **Precision@5:** For each of the 25 graded questions, measure how many of the top-5 retrieved chunks are relevant. Target: ≥60% average.
- **MRR (Mean Reciprocal Rank):** The correct source document should appear in the top-3 results for ≥80% of questions.
- **Authority compliance:** For questions where a bulletin supersedes the manual, the bulletin must rank higher. Measure across all bulletin-related test questions.

### Answer Quality

- **Citation validity:** Every cited source must exist in the source library. Every cited section/page must contain the referenced information. Fabricated citations are auto-fail for that question.
- **Grounding rate:** Percentage of factual claims in answers that have valid citations. Target: 100% for MVP, measured by post-processing verification.

---

## Observability Requirements

- **Extend Week 1's JSONL audit logger:** Add retrieval-specific logging per question: query → retrieved chunks (with scores and source metadata) → ranking decisions (authority, freshness, model filter) → generated answer → citation verification → final output
- **Kiln capture proxy:** Running and capturing all LLM interactions. Verify with `kiln proxy status`
- **Evidence bundle persistence:** Every answer's evidence bundle must be serializable to JSON and stored alongside the response
- **Latency profiling:** Log per-stage latency (embedding, retrieval, ranking, generation) for every question. Include in the JSONL audit log
- **Chaos results:** `kiln chaos profile --week 2` results stored in `.kiln/chaos-results/`

---

## AI Cost Analysis

### Development & Testing Costs

Track all LLM API calls during development via Kiln capture logs. Report:

- Total tokens consumed (input + output, by model)
- Total estimated cost in USD
- Breakdown by pipeline stage: embedding, retrieval reranking, generation, citation verification
- Cache hit rate and cache savings estimate
- Comparison: embedding costs vs generation costs — which dominates?

### Production Cost Projections

| Scale | Questions/Month | Estimated Monthly Cost | Key Assumptions |
|-------|----------------|----------------------|-----------------|
| Single site (1 team) | 200 | {{estimate}} | 10 techs × ~1 question/day |
| Regional (10 sites) | 2,000 | {{estimate}} | Shared embedding index |
| National (100 sites) | 20,000 | {{estimate}} | Per-site maintenance log indexing |
| Enterprise OEM (1,000 sites) | 200,000 | {{estimate}} | Multi-model equipment support |

Fill in estimates based on your actual token usage. If a grader cannot reproduce the measurement, it does not count.

---

## Technical Stack

### Recommended Path

- **Runtime:** TypeScript + Bun (extending Week 1)
- **Agent framework:** Claude Agent SDK (extending Week 1 harness)
- **Embedding:** Same as Week 1 — consistency matters for compounding
- **Vector store:** Same as Week 1 — extend the schema for new document types
- **Structured data queries:** SQL-like queries over CSV/XLSX data via DuckDB, SQLite, or in-memory filtering
- **Infrastructure:** Docker Compose, GitLab CI, Kiln CLI

### Alternative Path

- **Runtime:** Python + FastAPI (extending Week 1 if built in Python)
- **Structured data:** Pandas for CSV/XLSX queries
- **Vector store:** FAISS + SQLite (extending Week 1)

Do not switch stacks between weeks. The compounding axis is graded.

---

## Build Strategy

### Priority Order

1. **Extend ingestion for industrial documents** — the parts catalog and maintenance logs require structured parsing (row-based records, not text chunks). This is the most different thing from Week 1. Start here.
2. **Source authority hierarchy** — implement the ranking rules. Test by querying a topic where the bulletin and manual disagree. If the bulletin does not win, fix it before moving on.
3. **Model/serial filtering** — implement and test with VF-2 vs VF-3 questions. This is a pass/fail criterion.
4. **Hybrid retrieval** — combine vector search (natural language) with structured queries (serial number lookups, part number lookups). Test the recurring failure query (SN 42317 coolant pump) end-to-end.
5. **Evidence bundles and conflict detection** — build the output format. Every answer ships with the full evidence chain.
6. **Latency optimization** — profile the pipeline. Find bottlenecks. Target P95 < 4 seconds.
7. **25-question regression suite** — write it, run it, fix failures. This is your safety net for the chaos monkey.
8. **Chaos resilience** — run `kiln chaos profile --week 2` and fix failures.

### Critical Guidance

- **Structured data is not text.** The biggest trap this week is treating the parts catalog and maintenance logs as text to embed. They are structured data. You need SQL-like queries (by serial number, by part number, by date range) — not just semantic search. Build a separate retrieval path for structured data.
- **The authority hierarchy is not optional.** Multiple test questions specifically test whether bulletins outrank the manual and whether the training presentation is correctly deprioritized. If you skip this, you fail those questions.
- **Test the recurring failure question early.** The SN 42317 coolant pump question requires synthesizing maintenance logs (3 replacements) with manual diagnostics (root cause) and service bulletins (design changes). It is the hardest question and the most valuable to get right.
- **Run `kiln checkpoint` by Wednesday.** The checkpoint will flag which of the 25 graded questions you are likely failing and what evidence is missing.
- **Latency matters.** P95 under 4 seconds is a hard requirement. If your pipeline takes 10 seconds per question, you need to optimize before Thursday. Profile per-stage: is the bottleneck in embedding, retrieval, or generation?

---

## Source Material Package

Distributed as a zip file on Monday via the cohort Slack channel. Contains 10 files:

**Equipment documentation (4 files):** Service Manual — Haas VF-2 CNC Mill (synthetic, 120 pages, PDF — error codes, diagnostic procedures, torque specs, fluid specs), Parts Catalog (XLSX, 2000+ rows — part number, description, model compatibility, serial range, supersession history), Service Bulletins (5 PDFs, 2–4 pages each — technical updates, at least 2 supersede manual sections), Standard Operating Procedures (3 PDFs, 10–15 pages each — PM checklists for 500hr/1000hr/2000hr, safety lockout/tagout, coolant change).

**Site-specific data (3 files):** Maintenance Log Export (CSV, 500 rows — 12 machines over 2 years, SN 42317 has 3 coolant pump replacements), Asset Register (XLSX — serial numbers, model, install date, location, warranty), Incident Reports (3 PDFs — past failures with root-cause analysis).

**Poison documents (3 files):** Service Manual for Haas VF-3 (different model, similar structure), Outdated Parts Catalog (18 months old, superseded part numbers listed as current), Training Presentation (simplified/inaccurate technical details meant for sales, not service).

---

## Submission Requirements

| Deliverable | Requirements |
|-------------|-------------|
| **GitLab repo** | Same repo as Week 1. README updated, architecture doc extended, CI passing |
| **Docker deployment** | `docker compose up` runs the full system including Week 1 and Week 2 functionality |
| **Demo video** | 3–5 minutes. Show: error code diagnosis with citation, parts lookup with supersession, recurring failure analysis (SN 42317), model mismatch detection, at least 1 evidence bundle |
| **Kiln artifacts** | `.kiln/harness.jsonl` (captures for Week 2), `.kiln/chaos-results/` (Week 2 chaos profile), `kiln audit` passing |
| **25-question regression suite** | Automated tests with known correct answers and expected citations. Must run as part of CI or `make test`. |
| **AI cost analysis** | Completed cost table with actual development costs and projected production costs |
| **Postmortem** | What broke, what you would change, what surprised you. Minimum 500 words. Include latency profiling results. |
| **Pre-Search output** | Completed checklist from the Appendix |
| **Social post** | Post tagging @KilnAI with a screenshot or demo clip |

**Deadline: Friday 10:59 PM CT.** Submit via `kiln submit`.

### Auto-Fail Conditions

- `docker compose up` fails on grader's machine
- `kiln audit` has blocking errors at submission time
- No Kiln capture logs for Week 2 work
- System returns VF-3 information for a VF-2 question without flagging the mismatch
- Hallucinated citations (cites a manual section or part number that does not exist)
- P95 latency exceeds 4 seconds on the grader's test run
- Week 2 does not extend Week 1 codebase (separate repo or no shared infrastructure)
- Broken CI pipeline
- No postmortem

---

## Final Note

After this week, you will have a product that feels like a credible AI copilot for industrial field service — the kind of tool a reliability engineering team would actually evaluate. More importantly, you will have built a retrieval and grounding engine that handles structured data, authority hierarchies, and cross-document synthesis under latency constraints. That infrastructure is exactly what Week 3's autonomous agent needs to make decisions you can trust. Everything compounds.

---

## Appendix: Pre-Search Checklist

Complete before writing code. Submit your answers as part of the final deliverable.

### Phase 1: Problem & Constraint Research

1. Open the service manual. How is it organized? What is the structure of the error code table? How are diagnostic procedures formatted (numbered steps, flowcharts, prose)?
2. Open the parts catalog. How many sheets? What are the columns? How are supersession chains represented? What does a serial range look like?
3. Open the maintenance log CSV. What are the columns? What date format is used? How is free-text used in the "notes" column? Find the SN 42317 coolant pump entries — how many are there?
4. Open the service bulletins. How do they reference the manual sections they supersede? What metadata do they include (effective date, affected serial range)?
5. Compare the VF-2 manual and the VF-3 manual. What are the structural similarities that could cause a retrieval system to confuse them? What distinguishes them?

### Phase 2: Architecture Discovery

6. How will you chunk the service manual differently from the parts catalog? Describe your chunking strategy for each document type.
7. How will you implement structured queries for the parts catalog (by part number, model, serial range) and maintenance logs (by serial number, date range)? What technology will you use?
8. Describe your source authority hierarchy implementation. How will a bulletin that supersedes a manual section be detected and ranked higher at retrieval time?
9. How will you implement model/serial filtering? Will it be a pre-retrieval filter, a post-retrieval reranker, or both?
10. What is your latency budget per pipeline stage? (Embedding: ___ms, Retrieval: ___ms, Ranking: ___ms, Generation: ___ms, Total: < 4000ms)

### Phase 3: Post-Stack Refinement

11. How will you test the 25 graded questions? Describe your regression suite approach — what do you assert on?
12. How will you handle the corrupted CSV scenario? What does "graceful degradation" look like for your ingestion pipeline?
13. What evidence bundle format will you use? Describe the JSON structure.
14. How does your Week 2 code extend Week 1? Which modules are shared? Which are new? Draw the dependency graph.
