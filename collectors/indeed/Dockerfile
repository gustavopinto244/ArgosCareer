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
FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir python-jobspy requests

COPY collect.py .

ENTRYPOINT ["python", "collect.py"]
