# Lessons

Each entry records one generalizable lesson: the class of mistake, not the
instance. Read this before designing or reviewing a change in the same area.
Add an entry, in a pull request, whenever a bug reveals a class of mistake
that a checklist could have caught.

## "Only the caller's own commit is published" needs an invariant, not a chase

The first review of this tool found, round after round, one more interleaving
in which a commit made outside the lease could be published as the caller's:
before the rebase, right after the caller's commit, before it, as a merge, as
a duplicate of one of the caller's changes, as the replacement of a commit
the rebase dropped. Each was real and each was closed with a hook-driven test
that failed before the fix, but checks on counts, sets and patch ids each
left a variant open. What ended it was an invariant that is easy to state and
check: memory history is linear and every commit changes something; the
caller's commit is the one commit on the `HEAD` it checked, identified by its
SHA; and a rebase must reproduce the caller's commits one for one, each
leaving the folder exactly as the original did. When a change claims
exclusivity under concurrency, state the invariant first and test it, rather
than enumerating interleavings.
