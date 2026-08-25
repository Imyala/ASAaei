# ---------------------------------------------------------------------------
# ASAaei — app + LibreOffice converter in one container
# ---------------------------------------------------------------------------
# The whole point of this image is that nobody has to install anything on a
# laptop. Run it on one machine on the network and every tablet, phone and PC
# gets exact Word conversion by opening its address — no admin rights, no
# per-device setup, and no dependency on Microsoft for the conversion.
#
#   docker build -t asaaei .
#   docker run -d --restart unless-stopped -p 8787:8787 --name asaaei asaaei
#
# Then open http://<this-machine>:8787 on the tablets. Serving the app from the
# same address as the converter is what makes it work with nothing configured.
#
#   docker run --rm asaaei node server/convert-server.mjs --check
#
# ...prints whether conversion works in the image and why not, if not.
FROM node:22-bookworm-slim

# libreoffice-writer is the package that matters: libreoffice-core alone starts,
# reports a version and accepts connections, but has no Writer filters and fails
# every document. python3-uno is what keeps LibreOffice warm between jobs
# (sub-second conversions instead of ~1.5 s of start-up each time).
#
# The fonts are not optional either. A document laid out in Calibri on a machine
# without it re-wraps, which is a layout change — Carlito and Caladea are the
# metric-compatible stand-ins for Calibri and Cambria, so lines break in exactly
# the same places.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      python3-uno \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-liberation2 \
      fonts-dejavu-core \
      fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Substitution rules so a document asking for a font nobody has is mapped to the
# closest metric-compatible one rather than to whatever LibreOffice picks.
RUN cp server/fonts/60-asaaei-office-substitutes.conf /etc/fonts/conf.d/ \
 && fc-cache -f >/dev/null

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

# Fail the container if LibreOffice stops being able to convert, rather than
# letting the app quietly report that there is no converter.
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(h=>process.exit(h.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/convert-server.mjs"]
