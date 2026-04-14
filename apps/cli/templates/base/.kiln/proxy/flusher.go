package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Flusher drains a Capture into an append-only JSONL file. The handler
// write path never blocks on disk I/O: handlers push into the in-memory
// ring buffer, this goroutine is the only writer.
type Flusher struct {
	path     string
	cap      *Capture
	interval time.Duration
	byteTrig int

	mu   sync.Mutex
	file *os.File
}

// NewFlusher opens the JSONL file for append, creating parent directories
// as needed. fsync happens on each drain batch.
func NewFlusher(path string, c *Capture, interval time.Duration, byteTrig int) (*Flusher, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if interval <= 0 {
		interval = 100 * time.Millisecond
	}
	if byteTrig <= 0 {
		byteTrig = 65536
	}
	return &Flusher{
		path:     path,
		cap:      c,
		interval: interval,
		byteTrig: byteTrig,
		file:     f,
	}, nil
}

// Run loops until ctx is cancelled, flushing on either the interval
// timer or when the ring has accumulated `byteTrig` bytes.
func (f *Flusher) Run(ctx context.Context) {
	tick := time.NewTicker(f.interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := f.FlushNow(); err != nil {
				fmt.Fprintf(os.Stderr, "[kiln-proxy] flush error: %v\n", err)
			}
		default:
			if f.cap.Bytes() >= f.byteTrig {
				if err := f.FlushNow(); err != nil {
					fmt.Fprintf(os.Stderr, "[kiln-proxy] flush error: %v\n", err)
				}
			} else {
				// Avoid a hot spin loop when the ring is quiet.
				time.Sleep(5 * time.Millisecond)
			}
		}
	}
}

// FlushNow drains the ring buffer and appends to disk with fsync.
func (f *Flusher) FlushNow() error {
	data := f.cap.Drain()
	if len(data) == 0 {
		return nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.file.Write(data); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	if err := f.file.Sync(); err != nil {
		return fmt.Errorf("fsync: %w", err)
	}
	return nil
}

// Close flushes any remaining data and closes the underlying file.
func (f *Flusher) Close() error {
	if err := f.FlushNow(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.file != nil {
		err := f.file.Close()
		f.file = nil
		return err
	}
	return nil
}
