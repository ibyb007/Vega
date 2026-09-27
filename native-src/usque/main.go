package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/Diniboy1123/usque/cmd"
)

// Android apps have no readable /etc/resolv.conf, so Go's pure-Go DNS
// resolver (this binary is built with CGO_ENABLED=0, so there is no cgo
// resolver to fall back to) can't find a nameserver and defaults to
// 127.0.0.1:53 / [::1]:53, which always fails on-device ("connection
// refused"). The host app passes real, working DNS servers in via the
// USQUE_DNS_SERVERS env var (comma-separated host:port, e.g.
// "1.1.1.1:53,8.8.8.8:53") -- when present, every DNS lookup this binary
// makes is pinned directly to those servers instead of touching
// /etc/resolv.conf at all.
func initAndroidResolver() {
	raw := os.Getenv("USQUE_DNS_SERVERS")
	if raw == "" {
		return
	}

	var servers []string
	for _, s := range strings.Split(raw, ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, _, err := net.SplitHostPort(s); err != nil {
			s = net.JoinHostPort(s, "53")
		}
		servers = append(servers, s)
	}
	if len(servers) == 0 {
		return
	}

	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			var d net.Dialer
			var lastErr error
			for _, server := range servers {
				conn, err := d.DialContext(ctx, network, server)
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	}
}

func main() {
	initAndroidResolver()
	if err := cmd.Execute(); err != nil {
		fmt.Println("Error:", err)
		os.Exit(1)
	}
}
