package desktopstate

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// EnvironmentRecord contains no authentication secret. A credential reference
// identifies a profile-scoped entry in the native credential store.
type EnvironmentRecord struct {
	ID, Host, Username, AuthType, CredentialRef, Hostname, Platform, Arch string
	Port                                                                  int
	CreatedAt, UpdatedAt                                                  string
}

type HostKey struct{ Type, Fingerprint string }

var ErrHostKeyChanged = errors.New("SSH host key changed")

const environmentColumns = "id, host, port, username, auth_type, credential_ref, hostname, platform, arch, created_at, updated_at"

func scanEnvironment(row interface{ Scan(...any) error }) (EnvironmentRecord, error) {
	var r EnvironmentRecord
	err := row.Scan(&r.ID, &r.Host, &r.Port, &r.Username, &r.AuthType, &r.CredentialRef, &r.Hostname, &r.Platform, &r.Arch, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}
func (s *Store) Environments(ctx context.Context) ([]EnvironmentRecord, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+environmentColumns+" FROM environments ORDER BY created_at,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []EnvironmentRecord{}
	for rows.Next() {
		r, e := scanEnvironment(rows)
		if e != nil {
			return nil, e
		}
		result = append(result, r)
	}
	return result, rows.Err()
}
func (s *Store) Environment(ctx context.Context, id string) (EnvironmentRecord, error) {
	return scanEnvironment(s.db.QueryRowContext(ctx, "SELECT "+environmentColumns+" FROM environments WHERE id=?", id))
}
func (s *Store) FindEnvironment(ctx context.Context, host string, port int, user string) (EnvironmentRecord, error) {
	return scanEnvironment(s.db.QueryRowContext(ctx, "SELECT "+environmentColumns+" FROM environments WHERE host=? AND port=? AND username=?", host, port, user))
}
func (s *Store) TrustedHost(ctx context.Context, host string, port int) (HostKey, error) {
	var k HostKey
	err := s.db.QueryRowContext(ctx, "SELECT key_type,fingerprint FROM ssh_host_keys WHERE host=? AND port=?", host, port).Scan(&k.Type, &k.Fingerprint)
	return k, err
}

// SaveEnvironment atomically pins the verified host and persists a successfully
// authenticated target. A concurrent or changed host key must never overwrite trust.
func (s *Store) SaveEnvironment(ctx context.Context, r EnvironmentRecord, key HostKey) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "INSERT INTO ssh_host_keys(host,port,key_type,fingerprint) VALUES(?,?,?,?) ON CONFLICT(host,port) DO NOTHING", r.Host, r.Port, key.Type, key.Fingerprint); err != nil {
		return err
	}
	var existing HostKey
	if err = tx.QueryRowContext(ctx, "SELECT key_type,fingerprint FROM ssh_host_keys WHERE host=? AND port=?", r.Host, r.Port).Scan(&existing.Type, &existing.Fingerprint); err != nil {
		return err
	}
	if existing != key {
		return ErrHostKeyChanged
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if r.CreatedAt == "" {
		r.CreatedAt = now
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO environments(`+environmentColumns+`) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET auth_type=excluded.auth_type,credential_ref=excluded.credential_ref,hostname=excluded.hostname,platform=excluded.platform,arch=excluded.arch,updated_at=excluded.updated_at
      WHERE environments.host=excluded.host AND environments.port=excluded.port AND environments.username=excluded.username`, r.ID, r.Host, r.Port, r.Username, r.AuthType, r.CredentialRef, r.Hostname, r.Platform, r.Arch, r.CreatedAt, now)
	if err != nil {
		return err
	}
	var host, user string
	var port int
	if err = tx.QueryRowContext(ctx, "SELECT host,port,username FROM environments WHERE id=?", r.ID).Scan(&host, &port, &user); err != nil {
		return err
	}
	if host != r.Host || port != r.Port || user != r.Username {
		return errors.New("environment identity mismatch")
	}
	return tx.Commit()
}

// RemoveEnvironment does not remove a host trust pin, or modify the remote host.
func (s *Store) RemoveEnvironment(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, "DELETE FROM environments WHERE id=?", id)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return sql.ErrNoRows
	}
	return nil
}
