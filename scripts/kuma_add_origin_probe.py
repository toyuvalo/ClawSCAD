"""Add a Kuma HTTP monitor on the ClawSCAD Studio tunnel origin (clawscad.dvlce.ca).

cloudflared on the Mac Mini sends clawscad.dvlce.ca to http://100.95.28.29:8730 (the
desktop's tailnet address). Kuma runs on the same Mac, so this probe walks the exact path
the tunnel uses. CF Access answers 302 for everyone at the edge, so an outside probe can
never see the origin die.

Earned 2026-11-02: the ClawSCAD-Studio-Web task ran with --host 127.0.0.1, so the origin was
unreachable while loopback answered. The desktop watchdog probes loopback and stayed green;
nothing alarmed. This monitor alarms on that case.

Idempotent by name. Notification: ntfy-monitoring. Admin password read with the sanctioned
one-secret reader ~/bin/onecli-reveal.sh; never printed.
Run ON THE MAC: ~/dev/observability/.venv/bin/python kuma_add_origin_probe.py
"""
import os
import subprocess
import sys

from uptime_kuma_api import MonitorType, UptimeKumaApi

KUMA_URL = "http://127.0.0.1:3001"
NAME = "ClawSCAD origin (tunnel path 100.95.28.29:8730)"
URL = "http://100.95.28.29:8730/api/pipeline/status"


def main() -> int:
    password = subprocess.check_output(
        [os.path.expanduser("~/bin/onecli-reveal.sh"), "kuma-admin-password"], text=True
    ).strip()
    api = UptimeKumaApi(KUMA_URL)
    api.login("dvlce", password)
    notif = next((n for n in api.get_notifications() if n["name"] == "ntfy-monitoring"), None)
    nl = {str(notif["id"]): True} if notif else {}
    existing = {m["name"]: m for m in api.get_monitors()}
    if NAME in existing:
        mid = existing[NAME]["id"]
        print("exists id", mid)
    else:
        # A generation keeps the server busy but /api/pipeline/status still answers, so
        # 2 retries 60 s apart (alert after ~7 min) is enough slack.
        res = api.add_monitor(
            type=MonitorType.HTTP,
            name=NAME,
            url=URL,
            interval=300,
            retryInterval=60,
            maxretries=2,
            timeout=15,
            notificationIDList=nl,
        )
        mid = res["monitorID"]
        print("created id", mid)
    m = api.get_monitor(mid)
    print("type", m["type"], "url", m["url"], "interval", m["interval"],
          "maxretries", m["maxretries"], "notifications", m.get("notificationIDList"))
    api.disconnect()
    if not notif:
        print("WARN: ntfy-monitoring not found; monitor has no notification")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
