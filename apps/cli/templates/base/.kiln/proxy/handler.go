package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// sharedTransport is the base http.Transport used by every ReverseProxy.
// A single transport shares an idle-connection pool across upstreams of the
// same scheme+host pair.
func newTransport() *http.Transport {
	return &http.Transport{
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ForceAttemptHTTP2:     true,
	}
}

// ProxyHandler wires an httputil.ReverseProxy to the kiln capture ring.
type ProxyHandler struct {
	upstream string // "anthropic" | "openai" | "google"
	port     int
	target   *url.URL
	proxy    *httputil.ReverseProxy
	capture  *Capture
}

// NewProxyHandler builds a reverse-proxy handler for one upstream.
func NewProxyHandler(upstream, target string, port int, capture *Capture) (*ProxyHandler, error) {
	u, err := url.Parse(target)
	if err != nil {
		return nil, fmt.Errorf("parse target %q: %w", target, err)
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("target %q missing scheme or host", target)
	}
	h := &ProxyHandler{
		upstream: upstream,
		port:     port,
		target:   u,
		capture:  capture,
	}
	rp := &httputil.ReverseProxy{
		Director:     h.director,
		Transport:    newTransport(),
		ErrorHandler: h.errorHandler,
		// ModifyResponse installs the tee-reader so SSE bytes stream to the
		// client immediately while a copy flows into the capture ring.
		ModifyResponse: h.modifyResponse,
	}
	h.proxy = rp
	return h, nil
}

func (h *ProxyHandler) director(req *http.Request) {
	req.URL.Scheme = h.target.Scheme
	req.URL.Host = h.target.Host
	req.Host = h.target.Host
	// Preserve the original path; don't rewrite.
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "kiln-proxy")
	}
}

func (h *ProxyHandler) errorHandler(w http.ResponseWriter, req *http.Request, err error) {
	// Log presence of auth headers without values.
	authPresent := req.Header.Get("Authorization") != "" || req.Header.Get("x-api-key") != ""
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadGateway)
	fmt.Fprintf(w, `{"error":"upstream_unreachable"}`)
	// Push an error entry into the capture ring so the flusher records it.
	entry := HarnessLogEntry{
		ID:         newID(),
		Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
		SourceTool: inferSourceTool(req.Header.Get("User-Agent"), h.upstream),
		Upstream:   h.upstream,
		Port:       h.port,
		Error:      fmt.Sprintf("upstream error: %v (auth_present=%t)", err, authPresent),
		Request: HarnessLogRequest{
			Method:  req.Method,
			URL:     req.URL.String(),
			Headers: scrubHeaders(req.Header),
		},
	}
	h.capture.Push(entry)
}

// ServeHTTP records a request start-time via context and delegates to the
// underlying reverse proxy.
func (h *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	// Buffer a bounded peek of the request body so we can extract the model
	// without a full JSON parse. 64KB is plenty for the first bytes that
	// contain "model": "..." — typical Anthropic/OpenAI/Google bodies put it
	// near the top.
	var modelHint string
	if r.Body != nil && r.ContentLength != 0 {
		const peekLimit = 64 * 1024
		peek := make([]byte, peekLimit)
		n, _ := io.ReadFull(r.Body, peek)
		peek = peek[:n]
		modelHint = extractModel(peek)
		// Reassemble the body: peek + remaining stream (if any).
		r.Body = readCloser{io.MultiReader(bytes.NewReader(peek), r.Body), r.Body}
	}

	// Attach per-request state to context so ModifyResponse can finish the
	// log entry.
	ctx := withReqState(r.Context(), &reqState{
		startTime:  start,
		model:      modelHint,
		sourceTool: inferSourceTool(r.Header.Get("User-Agent"), h.upstream),
		headers:    scrubHeaders(r.Header),
		method:     r.Method,
		url:        r.URL.String(),
	})
	h.proxy.ServeHTTP(w, r.WithContext(ctx))
}

// readCloser lets us replace r.Body with a fresh MultiReader while still
// closing the original underlying stream.
type readCloser struct {
	io.Reader
	orig io.Closer
}

func (r readCloser) Close() error { return r.orig.Close() }

func (h *ProxyHandler) modifyResponse(resp *http.Response) error {
	st, ok := reqStateFrom(resp.Request.Context())
	if !ok || st == nil {
		return nil
	}

	// Wrap the response body so it tees into a bounded capture buffer.
	// Bytes flow to the client as soon as the upstream emits them — the
	// tee only observes data after the client has already received it.
	const maxCapture = 256 * 1024 // capture up to 256KB of response body
	cb := &captureBuf{limit: maxCapture}
	resp.Body = teeReadCloser{
		ReadCloser: resp.Body,
		tee:        cb,
		onClose: func() {
			latency := time.Since(st.startTime).Milliseconds()
			entry := HarnessLogEntry{
				ID:         newID(),
				Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
				SourceTool: st.sourceTool,
				Model:      st.model,
				Upstream:   h.upstream,
				Port:       h.port,
				LatencyMS:  float64(latency),
				Request: HarnessLogRequest{
					Method:  st.method,
					URL:     st.url,
					Headers: st.headers,
				},
				Response: &HarnessLogResponse{
					Status:  resp.StatusCode,
					Headers: scrubHeaders(resp.Header),
					Body:    cb.String(),
				},
			}
			h.capture.Push(entry)
			interactionCount.Add(1)
		},
	}
	return nil
}

// teeReadCloser streams bytes from an upstream response body to the
// client while also duplicating them into a bounded capture buffer.
// When the body is closed we invoke onClose so the handler can push the
// finished HarnessLogEntry into the ring buffer.
type teeReadCloser struct {
	io.ReadCloser
	tee     *captureBuf
	onClose func()
}

func (t teeReadCloser) Read(p []byte) (int, error) {
	n, err := t.ReadCloser.Read(p)
	if n > 0 {
		_, _ = t.tee.Write(p[:n])
	}
	return n, err
}

func (t teeReadCloser) Close() error {
	err := t.ReadCloser.Close()
	if t.onClose != nil {
		t.onClose()
	}
	return err
}

// captureBuf is a bounded byte sink that stops collecting once it hits
// its limit. It's safe to write from a single goroutine (the one reading
// the proxied response).
type captureBuf struct {
	buf   bytes.Buffer
	limit int
}

func (c *captureBuf) Write(p []byte) (int, error) {
	room := c.limit - c.buf.Len()
	if room <= 0 {
		return len(p), nil
	}
	if len(p) > room {
		_, _ = c.buf.Write(p[:room])
		return len(p), nil
	}
	return c.buf.Write(p)
}

func (c *captureBuf) String() string {
	return c.buf.String()
}

// reqState carries per-request metadata from ServeHTTP into ModifyResponse.
type reqState struct {
	startTime  time.Time
	model      string
	sourceTool string
	headers    map[string]string
	method     string
	url        string
}

type reqStateKey struct{}

func withReqState(ctx context.Context, st *reqState) context.Context {
	return context.WithValue(ctx, reqStateKey{}, st)
}

func reqStateFrom(ctx context.Context) (*reqState, bool) {
	v := ctx.Value(reqStateKey{})
	if v == nil {
		return nil, false
	}
	st, ok := v.(*reqState)
	return st, ok
}

// modelRegex matches "model": "<value>" in a JSON body, tolerant of whitespace.
var modelRegex = regexp.MustCompile(`"model"\s*:\s*"([^"]+)"`)

// extractModel pulls the model name out of a request-body peek without
// performing a full JSON parse. Returns "" if not found.
func extractModel(body []byte) string {
	m := modelRegex.FindSubmatch(body)
	if len(m) < 2 {
		return ""
	}
	return string(m[1])
}

// inferSourceTool maps the incoming User-Agent to a canonical source tool.
// Port-based fallback: :9100=anthropic, :9101=openai, :9102=google.
func inferSourceTool(userAgent, upstream string) string {
	ua := strings.ToLower(userAgent)
	switch {
	case strings.HasPrefix(ua, "claude-code/") || strings.Contains(ua, "claude-code"):
		return "claude-code"
	case strings.HasPrefix(ua, "cursor/") || strings.Contains(ua, "cursor"):
		return "cursor"
	case strings.HasPrefix(ua, "warp/") || strings.Contains(ua, "warp"):
		return "warp"
	}
	return upstream
}

// scrubHeaders returns a flat map[string]string from http.Header with any
// credentials redacted. Value-less logging policy: we record that the
// header was present but never its actual value.
func scrubHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, v := range h {
		lk := strings.ToLower(k)
		if lk == "authorization" || lk == "x-api-key" || lk == "api-key" {
			out[k] = "<redacted>"
			continue
		}
		if len(v) > 0 {
			out[k] = v[0]
		}
	}
	return out
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
