package capabilitywatch

// Merge retains separate facts for the same npm package until evaluation so
// an installation issue and an extension issue can both be reported.
func Merge(base Snapshot, packages []Fact, packageState string) Snapshot {
	seen := make(map[string]Fact, len(base.Facts))
	for _, fact := range base.Facts {
		seen[fact.ID] = fact
	}
	for _, fact := range packages {
		previous, exists := seen[fact.ID]
		if exists && (previous.Type != fact.Type || previous.Name != fact.Name) {
			base.State = "partial"
			continue
		}
		if !exists && len(seen) >= 200 {
			base.State = "partial"
			continue
		}
		seen[fact.ID] = fact
		base.Facts = append(base.Facts, fact)
	}
	if packageState != "available" {
		base.State = "partial"
	}
	return base
}

// Collapse removes duplicate identities only after alert evaluation. The npm
// installation record supplies the current manifest revision when present.
func Collapse(value Snapshot) Snapshot {
	seen := make(map[string]int, len(value.Facts))
	items := make([]Fact, 0, len(value.Facts))
	for _, fact := range value.Facts {
		if index, ok := seen[fact.ID]; ok {
			if fact.Type == "npm" && fact.State != "failed" {
				items[index].Revision = fact.Revision
				items[index].InstalledVersion = fact.InstalledVersion
				items[index].Registry = fact.Registry
				items[index].Channel = fact.Channel
			}
			continue
		}
		seen[fact.ID] = len(items)
		items = append(items, fact)
	}
	value.Facts = items
	return value
}
