# Ephemeral collector for the Indeed source (ADR-027, ADR-028).
#
# Built once on Atlas's host, run via `docker run --rm` on a schedule
# (systemd timer — see argos-indeed-collect.timer, not committed to run
# until deployed deliberately). Never runs inside argos-career's own
# container — no Docker socket is mounted there, by design (ADR-027).
#
# The image persists between runs (that is what makes each run fast — no
# repeated `pip install`); each *container* from it is `--rm`, exactly the
# "ephemeral Python container, prints JSON and exits" CLAUDE.md §6 names.
#
# requirements.txt pins exact versions (docs/audit AC-030) -- an unpinned
# `pip install python-jobspy requests` re-resolved on every rebuild, so the
# same commit could silently pick up a different jobspy release mid-deploy.
FROM python:3.12-slim@sha256:dd29372629eeba2dd003fd9e9d35a5b8236c44727875a0364254b5127af88e65

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY collect.py .

ENTRYPOINT ["python", "collect.py"]
