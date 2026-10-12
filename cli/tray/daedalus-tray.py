#!/usr/bin/env python3
"""Daedalus Linux tray helper: a StatusNotifier/AppIndicator icon with a menu.

Protocol (over stdio with the Node parent):
  argv: --icon <png-path> --menu '<json: [{"id": "...", "label": "..."}]>'
  stdout: "READY" once the indicator is live
          "ACTION:<id>" when a menu item is activated
  stderr: "ERROR: <message>" then exit non-zero when AppIndicator3 is
          unavailable (missing libappindicator / python3-gobject).

Requires on the user's system: python3, python3-gobject, and the
AppIndicator3 gir bindings (Arch: `sudo pacman -S libappindicator-gtk3
python-gobject`; Debian/Ubuntu: `gir1.2-appindicator3-1`). The Node side
probes for exactly this before spawning, so a missing dependency is
reported honestly instead of a silent no-icon.
"""

import argparse
import json
import sys


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Daedalus tray icon helper")
    parser.add_argument("--icon", required=True, help="absolute path to the tray PNG")
    parser.add_argument("--menu", required=True, help="JSON menu items")
    return parser.parse_args(argv)


def fail(message, code=2):
    print(f"ERROR: {message}", file=sys.stderr, flush=True)
    return code


def main(argv):
    args = parse_args(argv)
    try:
        items = json.loads(args.menu)
    except json.JSONDecodeError as exc:
        return fail(f"invalid --menu JSON: {exc}")
    if not isinstance(items, list) or not all(
        isinstance(i, dict) and "id" in i and "label" in i for i in items
    ):
        return fail("--menu must be a JSON list of {id, label}")

    try:
        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("AppIndicator3", "0.1")
        from gi.repository import AppIndicator3, Gtk, GLib
    except Exception as exc:  # missing bindings -> honest failure
        return fail(f"AppIndicator3 unavailable: {exc}")

    indicator = AppIndicator3.Indicator.new(
        "daedalus",
        args.icon,
        AppIndicator3.IndicatorCategory.APPLICATION_STATUS,
    )
    indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)
    indicator.set_title("Daedalus")

    menu = Gtk.Menu()
    for entry in items:
        menu_item = Gtk.MenuItem(label=str(entry["label"]))
        # default-arg binding: avoids the late-binding closure trap
        menu_item.connect(
            "activate", lambda _w, item_id=str(entry["id"]): print(f"ACTION:{item_id}", flush=True)
        )
        menu.append(menu_item)
        menu_item.show()
    indicator.set_menu(menu)

    print("READY", flush=True)

    # If the Node parent dies (terminal closed, SIGKILL), stdin hits EOF —
    # quit instead of leaving an orphaned icon behind.
    loop = GLib.MainLoop()

    def _watch_stdin():
        try:
            sys.stdin.read()
        except Exception:
            pass
        finally:
            GLib.idle_add(loop.quit)

    import threading

    threading.Thread(target=_watch_stdin, daemon=True).start()
    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
