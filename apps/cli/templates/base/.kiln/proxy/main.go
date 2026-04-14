// Source of truth: apps/proxy/. Regenerate via bunx turbo run sync-proxy-templates (TODO).
// Package main is the kiln-proxy entrypoint.
//
// kiln-proxy is a lightweight reverse proxy that sits in front of
// Anthropic / OpenAI / Google GenAI endpoints, streams SSE responses
// transparently to the calling agent, and captures each interaction as a
// JSONL record matching `HarnessLogEntrySchema` in `@kiln/shared`.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"
)

// Config holds runtime configuration read from environment variables.
type Config struct {
	AnthropicUpstream string
	OpenAIUpstream    string
	GoogleUpstream    string
	LogFile           string
	BufferSizeBytes   int
	FlushIntervalMS   int
	FlushBytes        int
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func loadConfig() Config {
	return Config{
		AnthropicUpstream: envOr("ANTHROPIC_UPSTREAM", "https://api.anthropic.com"),
		OpenAIUpstream:    envOr("OPENAI_UPSTREAM", "https://api.openai.com"),
		GoogleUpstream:    envOr("GOOGLE_UPSTREAM", "https://generativelanguage.googleapis.com"),
		LogFile:           envOr("LOG_FILE", "/data/.kiln/harness.jsonl"),
		BufferSizeBytes:   envInt("BUFFER_SIZE_MB", 32) * 1024 * 1024,
		FlushIntervalMS:   envInt("FLUSH_INTERVAL_MS", 100),
		FlushBytes:        envInt("FLUSH_BYTES", 65536),
	}
}

// interactionCount is exposed on /healthz for smoke tests.
var interactionCount atomic.Uint64

type healthPayload struct {
	Status       string `json:"status"`
	Interactions uint64 `json:"interactions"`
	Upstream     string `json:"upstream"`
	Port         int    `json:"port"`
}

func healthHandler(upstream string, port int) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthPayload{
			Status:       "ok",
			Interactions: interactionCount.Load(),
			Upstream:     upstream,
			Port:         port,
		})
	}
}

// listener describes one upstream the proxy fronts.
type listener struct {
	port     int
	upstream string
	target   string
}

func buildListeners(cfg Config) []listener {
	return []listener{
		{port: 9100, upstream: "anthropic", target: cfg.AnthropicUpstream},
		{port: 9101, upstream: "openai", target: cfg.OpenAIUpstream},
		{port: 9102, upstream: "google", target: cfg.GoogleUpstream},
	}
}

func main() {
	cfg := loadConfig()
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("[kiln-proxy] starting: log_file=%s buffer=%dMB flush_ms=%d flush_bytes=%d",
		cfg.LogFile, cfg.BufferSizeBytes/1024/1024, cfg.FlushIntervalMS, cfg.FlushBytes)

	capture := NewCapture(cfg.BufferSizeBytes)
	flusher, err := NewFlusher(cfg.LogFile, capture,
		time.Duration(cfg.FlushIntervalMS)*time.Millisecond, cfg.FlushBytes)
	if err != nil {
		log.Fatalf("[kiln-proxy] flusher init failed: %v", err)
	}

	flushCtx, flushCancel := context.WithCancel(context.Background())
	defer flushCancel()
	go flusher.Run(flushCtx)

	servers := make([]*http.Server, 0, 3)
	for _, l := range buildListeners(cfg) {
		handler, err := NewProxyHandler(l.upstream, l.target, l.port, capture)
		if err != nil {
			log.Fatalf("[kiln-proxy] handler init failed for %s: %v", l.upstream, err)
		}
		mux := http.NewServeMux()
		mux.HandleFunc("/healthz", healthHandler(l.upstream, l.port))
		mux.Handle("/", handler)
		srv := &http.Server{
			Addr:              fmt.Sprintf(":%d", l.port),
			Handler:           mux,
			ReadHeaderTimeout: 10 * time.Second,
		}
		servers = append(servers, srv)
		go func(s *http.Server, up string, p int) {
			log.Printf("[kiln-proxy] listening upstream=%s port=%d", up, p)
			if err := s.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Fatalf("[kiln-proxy] listen error on %d: %v", p, err)
			}
		}(srv, l.upstream, l.port)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("[kiln-proxy] shutdown signal received, draining")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shutdownCtx)
	}
	flushCancel()
	if err := flusher.FlushNow(); err != nil {
		log.Printf("[kiln-proxy] final flush error: %v", err)
	}
	if err := flusher.Close(); err != nil {
		log.Printf("[kiln-proxy] flusher close error: %v", err)
	}
	log.Printf("[kiln-proxy] shutdown complete")
}
