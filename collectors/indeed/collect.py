#!/usr/bin/env python3
"""
Collects Indeed postings via `python-jobspy` and pushes them to
argos-career's authenticated ingest endpoint.

ADR-027 (why this runs outside argos-career's own container — no Docker
socket mounted there, this is a fully separate process) and ADR-028 (why
this is allowed to break CLAUDE.md's polite-collector rule for this one
library and this one host — jobspy's Indeed scraper cannot be configured to
use an honest User-Agent, and apis.indeed.com's robots.txt disallows
everything regardless).

One run, one exit — this is the "ephemeral container" `docker run --rm`
runs on a schedule (see argos-indeed-collect.timer), not a long-lived
process. Never on the critical path: a failure here means Indeed's
postings are stale until the next scheduled run, nothing else in the
pipeline depends on it succeeding (principle 1, extended to a source that
lives outside the app entirely).

Required environment:
  ARGOS_API_URL   e.g. http://100.x.x.x:3000 (Atlas's Tailscale address)
  ARGOS_API_KEY   the same Bearer key every other API caller uses

Optional environment (defaults below):
  SEARCH_TERM, LOCATION, COUNTRY_INDEED, RESULTS_WANTED
"""

import json
import os
import sys

import requests
from jobspy import scrape_jobs

DEFAULT_SEARCH_TERM = "estagio"
DEFAULT_LOCATION = "Rio de Janeiro, Brazil"
DEFAULT_COUNTRY_INDEED = "Brazil"
DEFAULT_RESULTS_WANTED = "50"


def env(name: str, default: str | None = None, required: bool = False) -> str:
    value = os.environ.get(name, default)
    if required and not value:
        print(f"ERROR: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value or ""


def main() -> None:
    search_term = env("SEARCH_TERM", DEFAULT_SEARCH_TERM)
    location = env("LOCATION", DEFAULT_LOCATION)
    country_indeed = env("COUNTRY_INDEED", DEFAULT_COUNTRY_INDEED)
    results_wanted = int(env("RESULTS_WANTED", DEFAULT_RESULTS_WANTED))
    api_url = env("ARGOS_API_URL", required=True).rstrip("/")
    api_key = env("ARGOS_API_KEY", required=True)

    print(
        f"jobspy: searching Indeed for '{search_term}' in '{location}' "
        f"(up to {results_wanted})"
    )
    jobs = scrape_jobs(
        site_name=["indeed"],
        search_term=search_term,
        location=location,
        country_indeed=country_indeed,
        results_wanted=results_wanted,
    )
    print(f"jobspy: {len(jobs)} rows returned")

    if len(jobs) == 0:
        print("nothing to ingest, exiting")
        return

    # jobspy returns a pandas DataFrame; round-tripping through its own
    # to_json is what turns NaN into proper JSON null (a bare json.dumps on
    # the DataFrame's dict form does not) — the same conversion used to
    # capture the real fixture this source's schema/normalizer were fitted
    # against (ADR-027).
    rows = json.loads(jobs.to_json(orient="records", date_format="iso"))

    # jobspy's own row id is the natural sourceId — stable per posting, the
    # same field the normalizer's schema requires.
    postings = [
        {"sourceId": row["id"], "payload": row} for row in rows if row.get("id")
    ]
    skipped = len(rows) - len(postings)
    if skipped:
        print(f"WARNING: {skipped} row(s) had no id, skipped")

    # jobspy has no "there were more, we stopped" signal of its own -- a
    # result count that reached the requested budget is the same heuristic
    # this project's other paginated collectors use (a full final page plus
    # a cap being what stopped it, not the source running dry), applied
    # here since this process never sees Indeed's raw response either
    # (docs/audit PR-015).
    truncated = len(jobs) >= results_wanted

    body = {"source": "indeed", "postings": postings, "truncated": truncated}
    response = requests.post(
        f"{api_url}/runs/collect/external",
        json=body,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=120,
    )
    print(f"ingest: HTTP {response.status_code}")
    print(response.text[:2000])
    response.raise_for_status()


if __name__ == "__main__":
    main()
