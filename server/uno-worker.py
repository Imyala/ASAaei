#!/usr/bin/env python3
"""Persistent LibreOffice conversion worker.

Speaking to a LibreOffice that is *already running* is the whole point of this
file. Shelling out to ``soffice --convert-to pdf`` per document pays LibreOffice's
process start-up (~1.2-1.5 s) on every single conversion; connecting over UNO to
a warm instance pays it once, at server start, so a typical inspection form
converts in 0.3-0.8 s instead of 1.5-3 s.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.

  in   {"id": 1, "src": "/tmp/x.docx", "out": "/tmp/x.pdf", "filter": "writer_pdf_Export",
        "filterData": {"Quality": 90, ...}}
  out  {"id": 1, "ok": true, "ms": 812, "pages": 12}
       {"id": 1, "ok": false, "error": "..."}

Anything this script writes to stderr is diagnostics for the Node parent; stdout
is reserved for the protocol, so nothing else may be printed there.
"""

import json
import os
import sys
import time
import traceback

import uno  # provided by python3-uno / LibreOffice's bundled python
from com.sun.star.beans import PropertyValue


def _pv(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def _log(msg):
    sys.stderr.write("[uno-worker] %s\n" % msg)
    sys.stderr.flush()


def connect(port, timeout=90.0):
    """Resolve a UNO context against the listener, retrying while it boots.

    The Node parent spawns soffice and this worker at the same time, so the
    listener's socket is usually not up yet on the first attempt. Retrying is
    normal start-up, not an error.
    """
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local)
    url = ("uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext" % port)
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            return resolver.resolve(url)
        except Exception as err:  # NoConnectException while soffice starts
            last = err
            time.sleep(0.25)
    raise RuntimeError("could not reach LibreOffice on port %d: %s" % (port, last))


def make_filter_data(spec):
    """Build the writer_pdf_Export FilterData sequence from a plain dict.

    The values arrive as JSON, so they are already the right Python types; the
    only thing UNO insists on is that the sequence is typed, hence uno.Any.
    """
    props = tuple(_pv(k, v) for k, v in (spec or {}).items())
    return uno.Any("[]com.sun.star.beans.PropertyValue", props)


def convert(desktop, job):
    src = os.path.abspath(job["src"])
    out = os.path.abspath(job["out"])
    if not os.path.exists(src):
        raise RuntimeError("source file is missing: %s" % src)

    load_props = (
        _pv("Hidden", True),
        _pv("ReadOnly", True),
        # Never chase linked content or ask about updating fields: a document
        # that pops a modal in a headless process hangs the worker forever.
        _pv("UpdateDocMode", 0),
        # NEVER_EXECUTE — a form arriving by email must not be able to run its
        # own macros on the conversion machine.
        _pv("MacroExecutionMode", 0),
    )
    doc = desktop.loadComponentFromURL(
        uno.systemPathToFileUrl(src), "_blank", 0, load_props)
    if doc is None:
        raise RuntimeError("LibreOffice could not open the document")

    try:
        # Refresh field/index content (page numbers, TOC) so the PDF matches
        # what Word would print rather than the stale cached values.
        try:
            doc.refresh()
        except AttributeError:
            pass  # not a text document
        try:
            doc.getDocumentIndexes().refresh()
        except AttributeError:
            pass

        store_props = [_pv("FilterName", job.get("filter", "writer_pdf_Export"))]
        if job.get("filterData"):
            fd = PropertyValue()
            fd.Name = "FilterData"
            fd.Value = make_filter_data(job["filterData"])
            store_props.append(fd)
        doc.storeToURL(uno.systemPathToFileUrl(out), tuple(store_props))

        pages = 0
        try:
            pages = int(doc.getCurrentController().PageCount)
        except Exception:
            pass
        return pages
    finally:
        try:
            doc.close(False)
        except Exception:
            try:
                doc.dispose()
            except Exception:
                pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 2002
    ctx = connect(port)
    desktop = ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.frame.Desktop", ctx)
    # Tell the parent we are warm and ready to take jobs.
    sys.stdout.write(json.dumps({"ready": True, "port": port}) + "\n")
    sys.stdout.flush()
    _log("connected on port %d" % port)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except ValueError:
            continue
        started = time.time()
        try:
            pages = convert(desktop, job)
            reply = {"id": job.get("id"), "ok": True,
                     "ms": int((time.time() - started) * 1000), "pages": pages}
        except Exception as err:
            _log(traceback.format_exc())
            reply = {"id": job.get("id"), "ok": False, "error": str(err) or repr(err)}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        _log("fatal: %s" % err)
        sys.exit(1)
