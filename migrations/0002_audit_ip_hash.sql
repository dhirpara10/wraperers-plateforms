-- Audit entries for logins record a hashed IP (never the IP itself),
-- so repeated failures from one address can be spotted.
ALTER TABLE audit_log ADD COLUMN ip_hash TEXT;
CREATE INDEX audit_action ON audit_log(action, created_at);
