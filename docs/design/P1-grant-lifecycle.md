# P1 grant lifecycle policy

Folder grants have four renderer-visible states: `active`, `missing`, `moved`,
and `revoked`. `missing` and `moved` are unavailable states and may become
active only through a future explicit re-grant flow. `revoked` is terminal for
that grant ID.

The capability reference is updated before lifecycle side effects run. Thus a
revoked grant immediately rejects grant, item, prepared-plan, and operation
resolution with `REVOKED_GRANT`; cleanup is defense in depth and cannot reopen
access.

For every unavailable state Untie stops the filesystem watcher and removes the
grant's index memberships. Derived file/search rows with no remaining grant
membership are deleted, so unavailable content is not searchable. Rows shared
with another grant remain indexed for that other grant.

Revocation additionally invalidates all opaque file items, prepared plans, and
operations issued under the grant. Re-selecting the same folder creates fresh
capabilities; old IDs never regain authority.
