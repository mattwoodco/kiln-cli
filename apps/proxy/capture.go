package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// HarnessLogEntry mirrors `HarnessLogEntrySchema` in
// `packages/shared/src/schemas/harness-log.ts`. We hand-mirror the shape
// so the Go proxy has no runtime dependency on the TS schema.
type HarnessLogEntry struct {
	ID         string              `json:"id"`
	Timestamp  string              `json:"timestamp"`
	SourceTool string              `json:"source_tool"`
	Model      string              `json:"model,omitempty"`
	Request    HarnessLogRequest   `json:"request"`
	Response   *HarnessLogResponse `json:"response,omitempty"`
	LatencyMS  float64             `json:"latency_ms,omitempty"`
	Upstream   string              `json:"upstream"` // "anthropic" | "openai" | "google"
	Port       int                 `json:"port"`
	Error      string              `json:"error,omitempty"`
}

// HarnessLogRequest mirrors `HarnessLogRequestSchema`.
type HarnessLogRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	// Body is intentionally omitted on capture — the ring buffer is a
	// compact interaction log, not a request archive. The peek used for
	// model extraction is discarded after use.
}

// HarnessLogResponse mirrors `HarnessLogResponseSchema`.
type HarnessLogResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	// Body is the teed capture buffer (bounded, see handler.go).
	Body string `json:"body,omitempty"`
}

// Capture is a bounded, byte-budgeted ring buffer of serialized JSONL entries.
// Push is non-blocking: if appending an entry would exceed the byte budget we
// evict the oldest entries first (and emit a single stderr warning on first
// drop so operators notice buffer pressure).
type Capture struct {
	mu        sync.Mutex
	entries   [][]byte
	bytes     int
	limit     int
	warnedBuf bool
}

// NewCapture returns a Capture sized to roughly `limitBytes` of serialized
// JSONL. The limit is advisory: a single oversized entry will still be
// stored (it evicts everything smaller and becomes the head).
func NewCapture(limitBytes int) *Capture {
	if limitBytes <= 0 {
		limitBytes = 32 * 1024 * 1024
	}
	return &Capture{limit: limitBytes}
}

// Push serializes an entry and appends it to the ring. On overflow, the
// oldest entries are dropped and a warning is emitted to stderr once.
// Push never blocks on I/O and never returns an error — the flusher is
// responsible for durability.
func (c *Capture) Push(e HarnessLogEntry) {
	line, err := json.Marshal(e)
	if err != nil {
		// Should never happen — the struct has no unencodable fields.
		fmt.Fprintf(os.Stderr, "[kiln-proxy] marshal error: %v\n", err)
		return
	}
	// Append newline — JSONL format.
	line = append(line, '\n')

	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = append(c.entries, line)
	c.bytes += len(line)
	for c.bytes > c.limit && len(c.entries) > 1 {
		dropped := c.entries[0]
		c.entries = c.entries[1:]
		c.bytes -= len(dropped)
		if !c.warnedBuf {
			fmt.Fprintln(os.Stderr, "[kiln-proxy] ring buffer full, dropped oldest entry")
			c.warnedBuf = true
		}
	}
}

// Drain atomically removes every buffered entry and returns it as one
// concatenated byte slice ready for append-write to disk. The caller owns
// the returned slice.
func (c *Capture) Drain() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) == 0 {
		return nil
	}
	out := make([]byte, 0, c.bytes)
	for _, e := range c.entries {
		out = append(out, e...)
	}
	c.entries = nil
	c.bytes = 0
	return out
}

// Len returns the number of buffered entries (mainly for tests).
func (c *Capture) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// Bytes returns the buffered byte count (mainly for tests).
func (c *Capture) Bytes() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bytes
}
