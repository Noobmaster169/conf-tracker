# One-shot scripts for the box

A `NNN-name.sh` file put here runs **once** on the box, as the `student` user in `~/conf-tracker`, on the first cron
pass after it reaches `main` (within three minutes). It is for the rare thing no job verb covers (`ops/ct verbs`), now
that nobody can log in. What it printed is kept in `~/conf-tracker/ops-out/<name>.log` and shown by `ops/ct box` under
`oneshots`.

- It runs once, ever: its name is recorded before it starts. To run something again, add a new file.
- It is stopped after ten minutes.
- The repo is public: never put a secret in one. A secret reaches the box with `ops/ct job set-env`.
- It runs even while a deploy is held back, because the clone always follows `main`.
- Keep the files: they are the record of what was done to the box by hand.
- The box is shared with five other stacks. Touch nothing outside `~/conf-tracker` and this stack's containers.

The database from a script: `docker compose exec -T postgres psql -U postgres -d conf_tracker -c "..."`.
