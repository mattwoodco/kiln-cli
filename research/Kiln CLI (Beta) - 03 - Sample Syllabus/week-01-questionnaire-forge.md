# **Questionnaire Forge**

*AI-First Coding Systems: Grounded Document Response at Enterprise Scale*

---

## Before You Start

Complete the Pre-Search checklist in the Appendix before writing any code. Your Pre-Search output becomes part of your final submission. (4 hours)

Run `kiln scaffold --week 1` to generate your project directory. Read `spec.md` and `rubric.yml` in their entirety before doing anything else. Start your capture proxy with `docker compose up -d` and verify it is running with `kiln proxy status`.

---

## Background

A mid-market SaaS company receives 2–5 security questionnaires per week. Each one is 50–300 questions. The answers live scattered across SOC 2 reports, policy documents, prior completed questionnaires, product docs, and tribal knowledge. Today, a human copies and pastes from old answers, updates stale references, and prays nothing is wrong. It takes days. It blocks deals.

The tooling category already exists — Inventive AI, Responsive, Loopio — and budgets are allocated. That means a working demo maps directly to recognized enterprise spend. RevOps teams, sales engineers, security and compliance teams, and proposal managers all have this exact problem. You are not building a toy. You are building the first version of a product that someone with a budget would recognize immediately.

This week is about proving you can make AI write software that is grounded in real documents. Not hallucinated. Not vaguely plausible. Grounded — with citations, confidence scores, and the discipline to say "I don't know" when the source material is not there. Every answer your system generates must trace back to a specific document, section, and quote. Anything else is fabrication, and fabrication is a failing grade.

---

## Project Overview

You will build **Questionnaire Forge**, an engine that generates first-draft answers for security questionnaires, RFPs, and procurement forms from an approved source material library. The system must parse multiple questionnaire formats, retrieve relevant source material, generate grounded answers with citations, and flag questions where the evidence is insufficient or contradictory.

| Checkpoint | Deadline | Focus |
|------------|----------|-------|
| Pre-Search | Monday 6:00 PM CT | Architecture discovery, format analysis, retrieval strategy |
| MVP | Tuesday 6:00 PM CT (24 hrs) | End-to-end pipeline: questionnaire in → answered questionnaire out |
| Checkpoint (optional) | Wednesday–Thursday | `kiln checkpoint` for formative feedback |
| Final Submission | Friday 10:59 PM CT | Full product with chaos resilience, observability, postmortem |

---

## Core RAG Infrastructure

### 1. Document Ingestion & Parsing

- Ingest PDF, DOCX, XLSX, CSV, MD, and HTML files from the provided source library
- Extract clean text with metadata: source filename, page/section number, document date, approval status
- Parse questionnaire structure from all three test formats (XLSX SIG Lite, DOCX custom assessment, PDF RFP) — extract questions, section headers, and expected answer formats into structured JSON
- Implement document freshness detection: parse dates from filenames, metadata, and content body. Flag documents as `current`, `outdated`, or `draft`
- Filter poison documents: the system must not cite material marked DRAFT or from irrelevant sources (e.g., a competitor's product sheet)

### 2. Retrieval & Ranking

- Chunk the source library with overlap. Experiment with chunk sizes (256, 512, 1024 tokens). Each chunk carries metadata: source file, section, page, date, approval status
- Implement hybrid search: semantic (vector embeddings) + keyword (BM25) retrieval
- Build a ranking layer that penalizes outdated documents, filters DRAFT/unapproved material, and boosts exact section matches
- The outdated SOC 2 must be deprioritized in favor of the current SOC 2. The DRAFT security policy and competitor product sheet must never appear in citations

### 3. Answer Generation & Citation

- For each question: retrieve top-k chunks → construct a grounded prompt → generate answer → extract citations
- Output format per answer: answer text, citations (source document, section, quote snippet), confidence score, and flags (gap, conflict, ambiguity)
- Implement gap detection: when retrieved chunks score below a relevance threshold or conflict with each other, flag the question rather than guess
- Build output formatters that write answered questionnaires back into the original format (XLSX for SIG Lite, DOCX for custom assessment)

### 4. Agent Harness & Observability

- Wrap the pipeline in an agent harness with scoped tool permissions, budget limits, and turn limits
- The Kiln capture proxy handles LLM interaction logging automatically — but you must also implement application-level structured logging in JSONL: timestamp, tool name, input summary, output summary, token cost, latency
- Every AI decision must be traceable. A grader should be able to reconstruct exactly why the system gave a specific answer to a specific question

---

## MVP Requirements (24 hours)

Hard gate. All items required to pass. One failure = FAIL.

- Working CLI or API that accepts a questionnaire file + source library path and produces an answered questionnaire
- Parses all 3 questionnaire formats (XLSX SIG Lite, DOCX custom assessment, PDF RFP excerpt)
- Generates draft answers for ≥80% of the 150 SIG Lite questions
- Every generated answer includes a citation to a specific source document and section
- ≥70% of cited sources are correct (verified against provided grading rubric)
- Flags questions where no adequate source exists (≥3 of 5 planted gaps correctly identified)
- Prefers the current SOC 2 report over the outdated SOC 2 report in all retrieval results
- Does not cite the DRAFT security policy or the competitor product sheet in any answer
- `docker compose up` builds and runs the full system on a clean machine
- Kiln capture proxy is running and `.kiln/harness.jsonl` contains logged interactions
- `kiln audit` passes with zero blocking errors

---

## Testing Scenarios

### Scenario 1: No Matching Source Material
**Inject:** A question about a security control not documented anywhere in the source library.
**Expected behavior:** The system flags the question as "insufficient evidence" with a confidence score below the threshold. It does not hallucinate an answer.

### Scenario 2: Contradictory Sources
**Inject:** A question where the current SOC 2 and an older document provide conflicting information about the same control.
**Expected behavior:** The system surfaces both sources with their dates, resolves in favor of the newer document, and notes the conflict in the output.

### Scenario 3: Nonexistent Product Feature
**Inject:** A question referencing a product capability that does not exist in any documentation.
**Expected behavior:** The system refuses to answer and flags it as "unable to verify — feature not found in available documentation." It does not fabricate a capability.

### Scenario 4: Unexpected File Format
**Inject:** A questionnaire in CSV format instead of the expected XLSX.
**Expected behavior:** The system either parses the CSV successfully or reports a clear, actionable error. It does not crash.

### Scenario 5: Duplicate Questions
**Inject:** Two questions with slightly different wording that ask the same thing.
**Expected behavior:** The system produces consistent answers for both — same citations, same substance, minor phrasing differences are acceptable.

### Scenario 6: Cross-Document Synthesis
**Inject:** A question that requires combining information from the SOC 2, the incident response plan, and the product architecture overview.
**Expected behavior:** The system retrieves from all three sources, synthesizes a coherent answer, and cites all three documents.

### Scenario 7: Empty Source Library
**Inject:** An empty source library directory.
**Expected behavior:** Graceful failure with a clear error message. No crash, no hallucinated answers.

---

## Performance Targets

| Metric | Target |
|--------|--------|
| P50 latency per question | < 3 seconds |
| P95 latency per question | < 6 seconds |
| P99 latency per question | < 10 seconds |
| Full SIG Lite (150 questions) end-to-end | < 15 minutes |
| Citation accuracy | ≥ 70% |
| Gap detection recall (planted gaps) | ≥ 60% (3 of 5) |
| Poison document exclusion | 100% (no DRAFT or competitor citations) |

---

## Observability Requirements

- **Application-level JSONL logs:** Every pipeline step logged with timestamp, tool/function name, input summary, output summary, token count, latency, and cost estimate
- **Kiln capture proxy:** Running and capturing all LLM interactions to `.kiln/harness.jsonl`. Verify with `kiln proxy status`
- **Retrieval traceability:** For every answered question, a grader must be able to see: the query → the retrieved chunks (with scores) → the generated answer → the citation verification result
- **Chaos results:** `kiln chaos profile --week 1` results stored in `.kiln/chaos-results/`

---

## AI Cost Analysis

### Development & Testing Costs

Track all LLM API calls during development. Your Kiln capture logs provide exact token counts. Report:

- Total tokens consumed (input + output, by model)
- Total estimated cost in USD
- Breakdown by pipeline stage: embedding, retrieval, generation, evaluation
- Cache hit rate if using prompt caching

### Production Cost Projections

| Scale | Questions/Month | Estimated Monthly Cost | Key Assumptions |
|-------|----------------|----------------------|-----------------|
| Pilot (1 company) | 500 | {{estimate}} | Avg 5 questionnaires × 100 questions |
| Growth (10 companies) | 5,000 | {{estimate}} | Shared embedding cache |
| Scale (100 companies) | 50,000 | {{estimate}} | Batch processing, prompt caching |
| Enterprise (1,000 companies) | 500,000 | {{estimate}} | Dedicated infrastructure |

Fill in estimates based on your actual token usage during development. If a grader cannot reproduce the measurement, it does not count.

---

## Technical Stack

### Recommended Path

- **Runtime:** TypeScript + Bun
- **Agent framework:** Claude Agent SDK
- **Embedding:** Cohere Embed v3 or OpenAI text-embedding-3-small
- **Vector store:** Chroma, Qdrant, or pgvector
- **Document parsing:** pdf-parse, mammoth (DOCX), xlsx (SheetJS)
- **Search:** Hybrid semantic + BM25 (via vector store native or custom)
- **Infrastructure:** Docker Compose, GitLab CI, Kiln CLI

### Alternative Path

- **Runtime:** Python + FastAPI
- **Embedding:** sentence-transformers
- **Vector store:** FAISS + SQLite for metadata
- **Agent framework:** Manual orchestration with Anthropic SDK

Choose one path. Do not mix. The product requirements are the same regardless of stack.

---

## Build Strategy

### Priority Order

1. **Document ingestion pipeline** — parse all file formats into clean, chunked, metadata-rich representations. This is the foundation everything else depends on. Do not skip ahead.
2. **Retrieval system** — embed chunks, build vector store, implement hybrid search. Test on 10 sample questions before moving on.
3. **Answer generation** — grounded prompt → answer → citation extraction. Get one question working end-to-end before scaling to all 150.
4. **Gap detection and poison filtering** — implement freshness ranking, DRAFT filtering, and confidence thresholds. Test against the 5 planted gaps.
5. **Output formatting** — write answered questionnaires back into original formats (XLSX, DOCX).
6. **Agent harness and observability** — wrap everything in the agent loop, add structured logging.
7. **Docker and CI** — Dockerize, write `docker-compose.yml`, verify clean-machine build.
8. **Chaos resilience** — run `kiln chaos profile --week 1` and fix failures.

### Critical Guidance

- **Do not start with answer generation.** The quality of your answers is bounded by the quality of your retrieval. If you retrieve garbage, you generate garbage. Spend Monday on ingestion and retrieval.
- **Test retrieval in isolation.** Before you wire up generation, run 10 sample questions through retrieval only. Inspect the returned chunks. If the right document is not in the top-5 results, your generation pipeline cannot save you.
- **The poison documents are the test.** If your system cites the DRAFT policy, the outdated SOC 2, or the competitor sheet, you fail specific MVP requirements. Build filtering into your retrieval layer, not as a post-processing afterthought.
- **Run `kiln checkpoint` by Wednesday.** You want to know where you stand before Thursday's build sprint. The checkpoint will tell you which rubric criteria are at-risk.
- **Docker must build on a clean machine.** The grading pipeline clones your repo and runs `docker compose build`. If it only works on your laptop, it does not ship.

---

## Source Material Package

Distributed as a zip file on Monday via the cohort Slack channel. Contains 16 files:

**Approved answer library (10 files):** SOC 2 Type II Report (PDF, 45 pages), Information Security Policy (DOCX, 12 pages), Incident Response Plan (PDF, 8 pages), Product Architecture Overview (MD, 6 pages), Privacy Policy (HTML, 4 pages), Subprocessor List (XLSX), 3 Prior Completed Questionnaires (XLSX — SIG Lite, CAIQ, and a custom format), Business Continuity Plan (PDF, 5 pages), Penetration Test Executive Summary (PDF, 3 pages), Employee Security Training Records (XLSX).

**Questionnaire inputs (3 files):** SIG Lite Questionnaire (XLSX, 150 questions), Custom Risk Assessment (DOCX, 40 free-form questions), RFP Excerpt (PDF, 25 requirements).

**Poison documents (3 files):** Outdated SOC 2 Report (2 years old, nearly identical structure), Draft Security Policy (watermarked "DRAFT — NOT APPROVED"), Competitor Product Sheet (irrelevant).

The chaos monkey grader tests against these exact documents. Do not substitute your own.

---

## Submission Requirements

| Deliverable | Requirements |
|-------------|-------------|
| **GitLab repo** | README with setup instructions, architecture doc, CI passing |
| **Docker deployment** | `docker compose up` runs the full system on a clean machine. Grader must be able to clone and run in one command. |
| **Demo video** | 3–5 minutes. Show: ingestion of source library, processing of the SIG Lite questionnaire, at least 3 example answers with citations, at least 1 flagged gap, at least 1 poison document correctly excluded. |
| **Kiln artifacts** | `.kiln/harness.jsonl` (AI interaction logs), `.kiln/chaos-results/` (chaos profile results), `kiln audit` passing |
| **AI cost analysis** | Completed cost table with actual development costs and projected production costs |
| **Postmortem** | What broke, what you would change, what surprised you. Minimum 500 words. |
| **Pre-Search output** | Completed checklist from the Appendix |
| **Social post** | Post tagging @KilnAI with a screenshot or demo clip |

**Deadline: Friday 10:59 PM CT.** Submit via `kiln submit`.

### Auto-Fail Conditions

- `docker compose up` fails on grader's machine
- `kiln audit` has blocking errors at submission time
- No Kiln capture logs (`.kiln/harness.jsonl` is empty or missing)
- Hallucinated citations (answer cites a document/section that does not exist)
- System cites the DRAFT policy or competitor product sheet
- Broken CI pipeline
- No postmortem

---

## Final Note

By Friday you will have a product demo that looks like the first version of a real AI questionnaire-response company. The underlying harness — ingestion, retrieval, grounded generation, citation, agent loop, observability — carries forward into Week 2. Nothing you build this week is throwaway.

The bar is high. The deadline is tight. But the skill you are proving — making AI produce grounded, cited, inspectable work from messy real-world documents — is the single most valuable capability in enterprise AI engineering right now. Ship it.

---

## Appendix: Pre-Search Checklist

Complete before writing code. Submit your answers as part of the final deliverable.

### Phase 1: Problem & Constraint Research

1. What are the three questionnaire formats you need to parse? What makes each one structurally different? Open the source material files and describe the structure of each.
2. How many questions are in each questionnaire? What is the expected answer format for each (free text, yes/no, multiple choice, evidence attachment)?
3. What are the 16 source material files? Create a manifest listing each file, its format, its purpose, and whether it is current, outdated, draft, or irrelevant.
4. What are the 5 planted gap questions? (You will not know exactly, but identify at least 3 topic areas where the source library is likely thin.)

### Phase 2: Architecture Discovery

5. What chunking strategy will you use? What chunk size? How will you handle tables, multi-sheet spreadsheets, and structured data differently from prose documents?
6. What embedding model will you use? What vector store? Justify the choice.
7. How will you implement hybrid search (semantic + keyword)? What library or approach?
8. How will you implement the freshness/authority ranking? Describe the rules: what gets boosted, what gets penalized, what gets filtered entirely?
9. How will you enforce citation grounding? Describe the pipeline from retrieved chunks → prompt → answer → citation verification.

### Phase 3: Post-Stack Refinement

10. What is your gap detection strategy? How will you determine that a question has insufficient source material?
11. What is your conflict detection strategy? How will you identify when two sources contradict each other?
12. What is your output formatting approach? How will you write answers back into XLSX and DOCX formats?
13. What is your Docker architecture? What services are in your `docker-compose.yml`?
14. What is your latency budget? How will you stay under the P95 target of 6 seconds per question?
