package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---------------- handler forwards headers ----------------

func TestHandler_ForwardsHeadersAndAuth(t *testing.T) {
	var gotAuth, gotXKey, gotUA, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotXKey = r.Header.Get("x-api-key")
		gotUA = r.Header.Get("User-Agent")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	cap := NewCapture(1024 * 1024)
	h, err := NewProxyHandler("anthropic", upstream.URL, 9100, cap)
	if err != nil {
		t.Fatalf("NewProxyHandler: %v", err)
	}

	front := httptest.NewServer(h)
	defer front.Close()

	req, _ := http.NewRequest("POST", front.URL+"/v1/messages",
		strings.NewReader(`{"model":"claude-opus-4-6","messages":[]}`))
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("x-api-key", "sk-test")
	req.Header.Set("User-Agent", "claude-code/1.2.3")
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()

	if gotAuth != "Bearer secret" {
		t.Errorf("Authorization not forwarded, got %q", gotAuth)
	}
	if gotXKey != "sk-test" {
		t.Errorf("x-api-key not forwarded, got %q", gotXKey)
	}
	if gotUA != "claude-code/1.2.3" {
		t.Errorf("User-Agent not forwarded, got %q", gotUA)
	}
	if !strings.Contains(gotBody, `"model":"claude-opus-4-6"`) {
		t.Errorf("body not forwarded intact, got %q", gotBody)
	}

	// Wait for ModifyResponse / Close tee to fire.
	time.Sleep(30 * time.Millisecond)

	if cap.Len() != 1 {
		t.Fatalf("expected 1 captured entry, got %d", cap.Len())
	}
	drained := cap.Drain()
	var entry HarnessLogEntry
	if err := json.Unmarshal(trimNL(drained), &entry); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, drained)
	}
	if entry.SourceTool != "claude-code" {
		t.Errorf("source_tool inference: got %q want claude-code", entry.SourceTool)
	}
	if entry.Model != "claude-opus-4-6" {
		t.Errorf("model extraction: got %q want claude-opus-4-6", entry.Model)
	}
	if entry.Upstream != "anthropic" || entry.Port != 9100 {
		t.Errorf("upstream/port: got %s/%d", entry.Upstream, entry.Port)
	}
	// Authorization / x-api-key MUST be redacted in the captured log.
	if v := entry.Request.Headers["Authorization"]; v != "<redacted>" {
		t.Errorf("Authorization not redacted in capture, got %q", v)
	}
	if v := entry.Request.Headers["X-Api-Key"]; v != "<redacted>" {
		t.Errorf("x-api-key not redacted in capture, got %q", v)
	}
}

// ---------------- SSE tee delivers first chunk quickly ----------------

func TestHandler_SSEFirstChunkLatency(t *testing.T) {
	// Upstream holds the response body open and emits chunks. We verify
	// the client receives the first chunk well before the upstream closes.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("response writer not a flusher")
		}
		fmt.Fprint(w, "data: first\n\n")
		fl.Flush()
		time.Sleep(200 * time.Millisecond)
		fmt.Fprint(w, "data: second\n\n")
		fl.Flush()
	}))
	defer upstream.Close()

	cap := NewCapture(1024 * 1024)
	h, err := NewProxyHandler("anthropic", upstream.URL, 9100, cap)
	if err != nil {
		t.Fatalf("NewProxyHandler: %v", err)
	}
	front := httptest.NewServer(h)
	defer front.Close()

	req, _ := http.NewRequest("POST", front.URL+"/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-5"}`))
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()

	rd := bufio.NewReader(resp.Body)
	// Read first non-empty line.
	line, err := rd.ReadString('\n')
	if err != nil {
		t.Fatalf("read first chunk: %v", err)
	}
	firstChunkTime := time.Since(start)

	if !strings.Contains(line, "first") {
		t.Errorf("first chunk content: got %q", line)
	}
	// Upstream sleeps 200ms between chunks; the tee must not force us
	// to wait that long for the first byte. Give a generous 100ms budget
	// to account for CI jitter — the point is we don't block behind the
	// full upstream body.
	if firstChunkTime > 100*time.Millisecond {
		t.Errorf("SSE first chunk too slow: %v (want <100ms)", firstChunkTime)
	}
	// Drain the rest so the tee closes cleanly.
	_, _ = io.Copy(io.Discard, resp.Body)
}

// ---------------- ring buffer overflow drops oldest ----------------

func TestCapture_OverflowDropsOldest(t *testing.T) {
	// Small limit so a handful of entries trigger eviction.
	cap := NewCapture(2048)
	for i := 0; i < 100; i++ {
		cap.Push(HarnessLogEntry{
			ID:         fmt.Sprintf("id-%03d", i),
			Timestamp:  "2026-04-14T00:00:00Z",
			SourceTool: "test",
			Upstream:   "anthropic",
			Port:       9100,
			Request: HarnessLogRequest{
				Method:  "POST",
				URL:     "http://x/y",
				Headers: map[string]string{"X-T": "v"},
			},
		})
	}
	if cap.Bytes() > 2048 {
		t.Errorf("bytes exceed limit: %d > 2048", cap.Bytes())
	}
	if cap.Len() == 0 {
		t.Fatal("buffer fully drained")
	}
	drained := cap.Drain()
	// The oldest IDs should NOT be present.
	if strings.Contains(string(drained), "id-000") {
		t.Errorf("expected oldest entry id-000 to be evicted")
	}
	// The newest ID should be present.
	if !strings.Contains(string(drained), "id-099") {
		t.Errorf("expected newest entry id-099 to remain")
	}
}

// ---------------- model extraction without full parse ----------------

func TestExtractModel(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{`{"model":"claude-opus-4-6","messages":[]}`, "claude-opus-4-6"},
		{`{ "model" :  "gpt-4o-mini" , "temperature": 0.2}`, "gpt-4o-mini"},
		{`{"messages":[],"model":"gemini-2.5-pro"}`, "gemini-2.5-pro"},
		{`{"stream":true}`, ""},
		{`not even json`, ""},
	}
	for _, c := range cases {
		got := extractModel([]byte(c.in))
		if got != c.want {
			t.Errorf("extractModel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ---------------- flusher round-trip ----------------

func TestFlusher_WritesRoundTrippableJSONL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "h.jsonl")
	cap := NewCapture(1024 * 1024)
	f, err := NewFlusher(path, cap, 10*time.Millisecond, 65536)
	if err != nil {
		t.Fatalf("NewFlusher: %v", err)
	}
	defer f.Close()

	cap.Push(HarnessLogEntry{
		ID:         "abc",
		Timestamp:  "2026-04-14T12:00:00Z",
		SourceTool: "claude-code",
		Model:      "claude-opus-4-6",
		Upstream:   "anthropic",
		Port:       9100,
		LatencyMS:  12.5,
		Request: HarnessLogRequest{
			Method:  "POST",
			URL:     "/v1/messages",
			Headers: map[string]string{"Content-Type": "application/json"},
		},
		Response: &HarnessLogResponse{
			Status:  200,
			Headers: map[string]string{"Content-Type": "application/json"},
			Body:    `{"ok":true}`,
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	go f.Run(ctx)
	defer cancel()

	// Allow at least one interval to tick.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		b, _ := os.ReadFile(path)
		if len(b) > 0 {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read jsonl: %v", err)
	}
	if len(b) == 0 {
		t.Fatal("jsonl file empty after flush")
	}
	line := trimNL(b)
	var got HarnessLogEntry
	if err := json.Unmarshal(line, &got); err != nil {
		t.Fatalf("unmarshal roundtrip: %v\n%s", err, line)
	}
	if got.ID != "abc" || got.Model != "claude-opus-4-6" || got.Upstream != "anthropic" {
		t.Errorf("roundtrip mismatch: %+v", got)
	}
	if got.Response == nil || got.Response.Status != 200 {
		t.Errorf("roundtrip response: %+v", got.Response)
	}
}

// ---------------- health endpoint ----------------

func TestHealthHandler(t *testing.T) {
	srv := httptest.NewServer(healthHandler("anthropic", 9100))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), `"status":"ok"`) {
		t.Errorf("payload: %s", b)
	}
	if !strings.Contains(string(b), `"upstream":"anthropic"`) {
		t.Errorf("payload missing upstream: %s", b)
	}
}

// ---------------- source-tool inference ----------------

func TestInferSourceTool(t *testing.T) {
	cases := []struct {
		ua, upstream, want string
	}{
		{"claude-code/1.0.0", "anthropic", "claude-code"},
		{"cursor/0.45.1", "anthropic", "cursor"},
		{"warp/1.0", "anthropic", "warp"},
		{"curl/8.0", "openai", "openai"},
		{"", "google", "google"},
	}
	for _, c := range cases {
		got := inferSourceTool(c.ua, c.upstream)
		if got != c.want {
			t.Errorf("inferSourceTool(%q, %q) = %q, want %q", c.ua, c.upstream, got, c.want)
		}
	}
}

// ---------------- helpers ----------------

func trimNL(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}
