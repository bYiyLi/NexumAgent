package lifecycle

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestAuthorizationCallbackReceipt(t *testing.T) {
	const state = "test-receipt-state"
	const code = "test-receipt-authorization-code"
	tests := []struct {
		name, language            string
		approved                  bool
		title, guidance, closeTab string
	}{
		{"approved Chinese", "zh-CN", true, "已收到授权", "查看后续进度。", "可以关闭此标签页"},
		{"denied Chinese", "zh-CN", false, "本次授权未完成", "选择「重新检查」后再次授权", "可以关闭此标签页"},
		{"approved English", "en-US", true, "Authorization received", "Return to Nexum Desktop to view progress.", "You can close this tab"},
		{"denied English", "en-US", false, "Authorization not completed", "select “Check again” in the app", "You can close this tab"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := &authorization{state: state, language: tt.language, result: make(chan callbackResult, 1)}
			srv := httptest.NewUnstartedServer(http.HandlerFunc(a.callback))
			a.listener = srv.Listener
			srv.Start()
			defer srv.Close()

			query := url.Values{"state": {state}}
			wantResult, status := callbackResult{denial: "denied"}, "denied"
			if tt.approved {
				query.Set("code", code)
				wantResult, status = callbackResult{code: code}, "approved"
			} else {
				query.Set("error", "access_denied")
			}

			resp, err := srv.Client().Get(srv.URL + callbackPath + "?" + query.Encode())
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("callback returned %d", resp.StatusCode)
			}
			for header, want := range map[string]string{
				"Content-Type":            "text/html; charset=utf-8",
				"Cache-Control":           "no-store",
				"Referrer-Policy":         "no-referrer",
				"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
			} {
				if got := resp.Header.Get(header); got != want {
					t.Errorf("%s = %q, want %q", header, got, want)
				}
			}
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			html := string(body)
			for _, want := range []string{
				`<html lang="` + tt.language + `">`, `<h1>` + tt.title + `</h1>`,
				`class="status status-` + status + `"`, tt.guidance, tt.closeTab, `id="nexum-mark-a"`,
			} {
				if !strings.Contains(html, want) {
					t.Errorf("receipt missing %q", want)
				}
			}
			if strings.Contains(html, state) || strings.Contains(html, code) {
				t.Fatal("receipt exposes authorization parameters")
			}
			select {
			case result := <-a.result:
				if result != wantResult {
					t.Fatal("callback delivered the wrong result to Desktop")
				}
			default:
				t.Fatal("callback did not deliver the result to Desktop")
			}
		})
	}
}
