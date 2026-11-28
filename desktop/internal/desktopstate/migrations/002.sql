CREATE TABLE ssh_host_keys (
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
    key_type TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY(host, port)
);
CREATE TABLE environments (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
    username TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK(auth_type IN ('password','agent','key')),
    credential_ref TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('darwin','linux','windows')),
    arch TEXT NOT NULL CHECK(arch IN ('amd64','arm64')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(host, port, username),
    FOREIGN KEY(host, port) REFERENCES ssh_host_keys(host, port)
);
