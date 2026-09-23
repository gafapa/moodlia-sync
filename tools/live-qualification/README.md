# Live cross-version qualification harness

This directory holds the disposable end-to-end harness that produced the
evidence recorded in `docs/CROSS-VERSION-QUALIFICATION.md` (run
`release037-core036-final`, 2026-09-22). It is development tooling and is not
part of the published npm package.

## What it provisions

- `compose.yaml`: four throwaway Moodle sites bound to loopback ports
  (`18450`/`18451` for Moodle 4.5.12, `18530`/`18531` for Moodle 5.3 beta),
  each with a SQLite database and its own volume. One site per release runs
  Core only; the other mounts the MoodlIA plugin checkout.
- `remote-setup.sh`: creates the staging directory, checks out the exact plugin
  commit under test, and generates a random administrator password in `.env`.
- `bootstrap/bootstrap.php`: run inside each container. It enables REST,
  creates a restricted external service and token for the lab administrator,
  and builds the fixture course (groups, grouping, Unicode HTML, and a Page with
  a nested Unicode asset on MoodlIA sources). Tokens are written only to `0600`
  JSON files under `results/`.
- `runner/run-qualification.mjs`: executes plan, apply, live verify, and an
  unchanged rerun for the four provider pairings with the public
  `moodlia-sync` package, then verifies the MoodlIA-to-MoodlIA Page bytes and references. The
  remaining `runner/*.mjs` files are inspection helpers used while diagnosing
  failures.

## Running it

1. Copy this directory to an isolated Docker host and run `remote-setup.sh`
   after adjusting `lab_root` and `plugin_commit`.
2. `docker compose -p <project> up -d` and wait until all four containers report
   `healthy` (first boot installs Moodle and takes several minutes).
3. Run `bootstrap.php <profile> <core|moodlia> <source|target>` in each
   container and store the JSON output as `results/<profile>.json`.
4. Install the package under test in `runner/` (`npm install moodlia-sync@<version>`
   or a local tarball) and run
   `QUALIFICATION_RUN_ID=<id> node runner/run-qualification.mjs` with the
   staging directory mounted at `/qualification`.
5. Archive `results/<id>-qualification-report.json`, then remove the containers,
   volumes, network, and the staging directory. The directory contains tokens
   and must not be kept.

Never point this harness at a persistent Moodle service.

## Shared-host limits

Each site is capped at 768 MiB and 0.75 CPU and labelled `moodlia-lab`, and
`remote-setup.sh` refuses to start with less than 3 GiB of available memory,
so the lab cannot push a shared production host into the out-of-memory
killer. After the run, remove lab images with
`docker image prune --filter label=moodlia-lab`. The preferred place for the
full matrix is GitHub Actions with the golden images from `moodlia-test-lab`.
