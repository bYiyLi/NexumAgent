package main

import "errors"

// OpenMarketplace opens only the market for this Desktop build's profile.
// The WebView and the selected Agent never supply a URL.
func (s *FoundationService) OpenMarketplace() error {
	if err := s.requireReady(); err != nil {
		return err
	}
	if s.openAgentBrowser == nil {
		return errors.New("browser unavailable")
	}
	return s.openAgentBrowser(desktopCloudOrigin() + "/marketplace")
}
