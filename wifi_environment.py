"""
Wi‑Fi environment survey on macOS: discover nearby BSSIDs/channels for router tuning.

Prefers CoreWLAN (full channel + RSSI). Fills SSIDs from ``airport -s`` when it still returns
a neighbor list, else from ``system_profiler SPAirPortDataType -json`` for unambiguous channels.
Run with a Python that has PyObjC + CoreWLAN (e.g. ``/usr/bin/python3`` on macOS).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from collections import defaultdict
from typing import Any, DefaultDict, Dict, List, Optional, Tuple

import CoreWLAN

AIRPORT = (
    '/System/Library/PrivateFrameworks/Apple80211.framework/'
    'Versions/Current/Resources/airport'
)

_BSSID_RE = re.compile(
    r'((?:[0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2})',
)


def _normalize_bssid(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    t = str(s).strip().lower().replace('-', ':')
    parts = t.split(':')
    if len(parts) != 6:
        return None
    try:
        return ':'.join(f'{int(p, 16):02x}' for p in parts)
    except ValueError:
        return None


def _band_label(band_const: int) -> str:
    if band_const == CoreWLAN.kCWChannelBand2GHz:
        return '2.4 GHz'
    if band_const == CoreWLAN.kCWChannelBand5GHz:
        return '5 GHz'
    if band_const == CoreWLAN.kCWChannelBand6GHz:
        return '6 GHz'
    return 'Unknown'


def _band_bucket(band_const: int) -> str:
    if band_const == CoreWLAN.kCWChannelBand2GHz:
        return '2.4'
    if band_const == CoreWLAN.kCWChannelBand5GHz:
        return '5'
    if band_const == CoreWLAN.kCWChannelBand6GHz:
        return '6'
    return 'other'


def _width_mhz(width_const: int) -> Optional[int]:
    m = {
        CoreWLAN.kCWChannelWidth20MHz: 20,
        CoreWLAN.kCWChannelWidth40MHz: 40,
        CoreWLAN.kCWChannelWidth80MHz: 80,
        CoreWLAN.kCWChannelWidth160MHz: 160,
    }
    return m.get(width_const)


def _ssid_to_str(raw) -> Optional[str]:
    if raw is None:
        return None
    if isinstance(raw, str):
        t = raw.strip()
        return t or None
    # CWNetwork / NSString via PyObjC — UTF8String may be bytes or str depending on bridge
    try:
        if hasattr(raw, 'UTF8String'):
            u = raw.UTF8String()
            if isinstance(u, bytes):
                t = u.decode('utf-8', 'replace').strip()
            elif isinstance(u, str):
                t = u.strip()
            else:
                t = str(u).strip()
            if t:
                return t
    except Exception:
        pass
    try:
        s = str(raw).strip()
        if s and not s.startswith('<CW') and s != 'None':
            return s
    except Exception:
        pass
    return None


def get_wifi_interface_name() -> str:
    try:
        out = subprocess.run(
            ['networksetup', '-listallhardwareports'],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout
        lines = out.splitlines()
        for i, line in enumerate(lines):
            if 'Wi-Fi' in line or 'AirPort' in line:
                for j in range(i + 1, min(i + 4, len(lines))):
                    m = re.search(r'Device:\s*(\w+)', lines[j])
                    if m:
                        return m.group(1)
    except Exception:
        pass
    return 'en0'


def current_link_snapshot() -> Dict[str, Any]:
    """Best-effort association info (channel useful for “you are here” on charts)."""
    out: Dict[str, Any] = {
        'ssid': None,
        'bssid': None,
        'rssi': None,
        'channel': None,
        'band': None,
        'band_key': None,
    }
    try:
        client = CoreWLAN.CWWiFiClient.sharedWiFiClient()
        name = get_wifi_interface_name()
        iface = client.interfaceWithName_(name) or client.interface()
        if iface is None:
            return out
        out['ssid'] = _ssid_to_str(iface.ssid())
        out['bssid'] = _normalize_bssid(iface.bssid() if iface.bssid() else None)
        try:
            out['rssi'] = int(iface.rssiValue())
        except Exception:
            out['rssi'] = None
        wc = iface.wlanChannel()
        if wc is not None:
            try:
                out['channel'] = int(wc.channelNumber())
            except Exception:
                out['channel'] = None
            try:
                b = int(wc.channelBand())
                out['band'] = _band_label(b)
                out['band_key'] = _band_bucket(b)
            except Exception:
                pass
    except Exception:
        pass
    if not out.get('ssid'):
        ssid_fb, bssid_fb = current_link_fallback_from_system()
        if ssid_fb:
            out['ssid'] = ssid_fb
        if not out.get('bssid') and bssid_fb:
            out['bssid'] = bssid_fb
    # Match network_analyzer behavior: if link is active but SSID is redacted/hidden,
    # show a friendly fallback instead of "(hidden)".
    if not out.get('ssid') and (out.get('rssi') is not None or out.get('bssid')):
        out['ssid'] = 'Connected'
    return out


def _bssid_from_airport_cli() -> Optional[str]:
    """Try ``airport -I`` (default and explicit iface) and parse BSSID."""
    iface = get_wifi_interface_name()
    for cmd in ([AIRPORT, '-I'], [AIRPORT, iface, '-I']):
        try:
            r = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=5,
                stdin=subprocess.DEVNULL,
                check=False,
            )
            blob = f"{r.stdout or ''}\n{r.stderr or ''}"
        except Exception:
            continue
        m = _BSSID_RE.search(blob)
        if not m:
            continue
        b = _normalize_bssid(m.group(1))
        if b:
            return b
    return None


def _scan_record_ssid() -> Tuple[Optional[str], Optional[str]]:
    """
    Decode SSID/BSSID from SCDynamicStore ``CachedScanRecord``.
    Mirrors the approach used in ``network_analyzer`` for modern macOS.
    """
    try:
        import plistlib
        import SystemConfiguration as SC

        store = SC.SCDynamicStoreCreate(None, 'wifi', None, None)
        iface = get_wifi_interface_name()
        val = SC.SCDynamicStoreCopyValue(store, f'State:/Network/Interface/{iface}/AirPort')
        if not val:
            return None, None
        cached = val.get('CachedScanRecord')
        if not cached:
            return None, None

        archive = plistlib.loads(bytes(cached))
        objects = archive.get('$objects', [])
        top_ref = archive.get('$top', {})
        root_uid = list(top_ref.values())[0] if top_ref else None
        if root_uid is None:
            return None, None

        root_obj = objects[root_uid.data if isinstance(root_uid, plistlib.UID) else root_uid]

        def resolve(uid):
            if isinstance(uid, plistlib.UID):
                return objects[uid.data]
            return uid

        if isinstance(root_obj, dict):
            keys = [resolve(k) for k in (root_obj.get('$keys') or root_obj.get('NS.keys') or [])]
            vals = [resolve(v) for v in (root_obj.get('$values') or root_obj.get('NS.objects') or [])]
            d = dict(zip(keys, vals))
            ssid = str(d['SSID_STR']) if d.get('SSID_STR') else None
            raw_b = None
            for key in ('BSSID', 'IO80211BSSID', 'IO80211BSSIDString'):
                if d.get(key) is not None:
                    raw_b = d.get(key)
                    break
            if raw_b is None:
                bssid = None
            elif isinstance(raw_b, (bytes, bytearray)) and len(raw_b) == 6:
                bssid = ':'.join(f'{x:02x}' for x in raw_b)
            else:
                bssid = _normalize_bssid(str(raw_b).strip())
            return ssid, bssid
    except Exception:
        pass
    return None, None


def current_link_fallback_from_system() -> Tuple[Optional[str], Optional[str]]:
    """
    Best-effort SSID/BSSID fallback via command-line tools used by many analyzer apps.
    Helps when CoreWLAN returns hidden/blank on newer macOS privacy states.
    """
    iface = get_wifi_interface_name()
    ssid_acc: Optional[str] = None
    bssid_acc: Optional[str] = None

    # 0) Cached scan record from dynamic store (often works without full Location grants).
    ssid_c, bssid_c = _scan_record_ssid()
    if ssid_c:
        ssid_acc = ssid_c
    if bssid_c:
        bssid_acc = bssid_c

    # 0.5) airport -I BSSID (usually available when linked)
    if not bssid_acc:
        bssid_acc = _bssid_from_airport_cli()

    # 1) networksetup -getairportnetwork enX
    try:
        r = subprocess.run(
            ['networksetup', '-getairportnetwork', iface],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        line = (r.stdout or '').strip()
        if line and 'Current Wi-Fi Network:' in line:
            ssid = line.split('Current Wi-Fi Network:', 1)[1].strip()
            if ssid and 'You are not associated' not in ssid:
                ssid_acc = ssid_acc or ssid
    except Exception:
        pass

    # 2) ipconfig getsummary enX (can expose SSID/BSSID on some versions)
    try:
        r = subprocess.run(
            ['ipconfig', 'getsummary', iface],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        txt = r.stdout or ''
        ssid = None
        bssid = None
        for ln in txt.splitlines():
            t = ln.strip()
            if t.startswith('SSID :'):
                s = t.split('SSID :', 1)[1].strip()
                if s:
                    ssid = s
            elif t.startswith('BSSID :'):
                b = _normalize_bssid(t.split('BSSID :', 1)[1].strip())
                if b:
                    bssid = b
        if ssid:
            ssid_acc = ssid_acc or ssid
        if bssid:
            bssid_acc = bssid_acc or bssid
    except Exception:
        pass

    return ssid_acc, bssid_acc


def _network_row(net) -> Optional[Dict[str, Any]]:
    try:
        wc = net.wlanChannel()
        ch = int(wc.channelNumber()) if wc is not None else None
        band_const = int(wc.channelBand()) if wc is not None else CoreWLAN.kCWChannelBandUnknown
    except Exception:
        wc = None
        ch = None
        band_const = CoreWLAN.kCWChannelBandUnknown

    width = None
    if wc is not None:
        try:
            width = _width_mhz(int(wc.channelWidth()))
        except Exception:
            width = None

    ssid = _ssid_to_str(net.ssid())
    if not ssid:
        try:
            if hasattr(net, 'ssidData'):
                d = net.ssidData()
                if d is not None:
                    blob = bytes(d) if not isinstance(d, (bytes, bytearray)) else bytes(d)
                    ssid = blob.decode('utf-8', 'replace').strip() or None
        except Exception:
            pass
    bssid = _normalize_bssid(net.bssid() if net.bssid() else None)
    try:
        rssi = int(net.rssiValue())
    except Exception:
        rssi = None

    sec = phy = None
    try:
        sec = int(net.securityType())
    except Exception:
        pass
    try:
        phy = int(net.phyMode()) if net.phyMode() is not None else None
    except Exception:
        pass

    if ch is None and not ssid and not bssid:
        return None

    return {
        'ssid': ssid,
        'bssid': bssid,
        'rssi': rssi,
        'channel': ch,
        'band': _band_label(band_const),
        'band_key': _band_bucket(band_const),
        'width_mhz': width,
        'security_type': sec,
        'phy_mode': phy,
    }


def scan_corewlan(include_hidden: bool = True, timeout_hint: float = 12.0) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    Active scan via CoreWLAN. ``timeout_hint`` is only used for logging/warnings; the API blocks until done.
    """
    note = None
    t0 = time.monotonic()
    try:
        client = CoreWLAN.CWWiFiClient.sharedWiFiClient()
        name = get_wifi_interface_name()
        iface = client.interfaceWithName_(name) or client.interface()
        if iface is None:
            return [], 'No Wi‑Fi interface found.'
        nets, err = iface.scanForNetworksWithName_includeHidden_error_(None, include_hidden, None)
        if err is not None:
            return [], str(err)
        rows: List[Dict[str, Any]] = []
        for net in nets or []:
            row = _network_row(net)
            if row:
                rows.append(row)
        elapsed = time.monotonic() - t0
        if elapsed > timeout_hint:
            note = f'Scan took {elapsed:.1f}s (CoreWLAN).'
        return rows, note
    except Exception as e:
        return [], str(e)


def _network_row_merge_key(row: Dict[str, Any]) -> str:
    b = row.get('bssid')
    if b:
        return str(b).lower()
    ssid = row.get('ssid') or ''
    ch = row.get('channel')
    return f'_:{ssid!s}:{ch!s}'


def _merge_network_rows_from_passes(batches: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Union BSSIDs across passes; keep strongest RSSI sample and fill in SSID if it was missing."""
    merged: Dict[str, Dict[str, Any]] = {}
    for batch in batches:
        for row in batch:
            key = _network_row_merge_key(row)
            cur = merged.get(key)
            if cur is None:
                merged[key] = dict(row)
                continue
            r_new = row.get('rssi')
            r_old = cur.get('rssi')
            if r_new is not None and (r_old is None or r_new > r_old):
                # Stronger sample may omit SSID (common on some scan paths); keep prior name.
                merged_row = dict(row)
                if not (merged_row.get('ssid') or '').strip() and (cur.get('ssid') or '').strip():
                    merged_row['ssid'] = cur['ssid']
                if merged_row.get('width_mhz') is None and cur.get('width_mhz') is not None:
                    merged_row['width_mhz'] = cur['width_mhz']
                merged[key] = merged_row
            else:
                if not (cur.get('ssid') or '').strip() and (row.get('ssid') or '').strip():
                    cur = dict(cur)
                    cur['ssid'] = row['ssid']
                    merged[key] = cur
    return list(merged.values())


def _scan_pass_settings() -> Tuple[int, float]:
    try:
        n = int(os.environ.get('SCAN_PASSES', '3'))
    except ValueError:
        n = 3
    n = max(1, min(6, n))
    try:
        gap = float(os.environ.get('SCAN_PASS_INTERVAL_SEC', '1.25'))
    except ValueError:
        gap = 1.25
    gap = max(0.25, min(6.0, gap))
    return n, gap


def scan_corewlan_accumulated(
    include_hidden: bool = True, timeout_hint: float = 12.0
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    Run several CoreWLAN active scans with a short pause between passes, then merge rows.
    Helps catch BSSIDs that probe late or briefly drop out. Override with env
    ``SCAN_PASSES`` (1–6, default 3) and ``SCAN_PASS_INTERVAL_SEC`` (default 1.25).
    """
    n, gap = _scan_pass_settings()
    if n <= 1:
        return scan_corewlan(include_hidden, timeout_hint)

    batches: List[List[Dict[str, Any]]] = []
    notes: List[str] = []
    for i in range(n):
        rows, note = scan_corewlan(include_hidden, timeout_hint)
        batches.append(rows)
        if note:
            notes.append(note)
        if i + 1 < n:
            time.sleep(gap)
    merged = _merge_network_rows_from_passes(batches)
    seen_note = sorted(set(notes))
    meta = (
        f'{n} scan passes ({gap:.1f}s apart) → {len(merged)} unique BSSIDs '
        f'(merged from {sum(len(b) for b in batches)} observations).'
    )
    if seen_note:
        meta = meta + ' ' + ' | '.join(seen_note)
    return merged, meta


def _parse_airport_scan(text: str) -> List[Dict[str, Any]]:
    """Best-effort parser for ``airport -s`` (column layout varies by macOS)."""
    rows: List[Dict[str, Any]] = []
    for line in text.splitlines():
        if 'WARNING' in line or 'deprecated' in line.lower():
            continue
        if 'SSID' in line and 'BSSID' in line:
            continue
        m = _BSSID_RE.search(line)
        if not m:
            continue
        bssid = _normalize_bssid(m.group(1))
        if not bssid:
            continue
        tail = line[m.end() :].strip()
        parts = tail.split()
        rssi = None
        channel = None
        if parts:
            try:
                rssi = int(parts[0])
            except ValueError:
                rssi = None
        if len(parts) > 1:
            ch_token = parts[1].split(',')[0]
            try:
                channel = int(ch_token)
            except ValueError:
                channel = None
        left = line[: m.start()].strip()
        ssid = left or None
        band_key = '2.4' if channel is not None and channel <= 14 else '5' if channel else 'other'
        band = '2.4 GHz' if band_key == '2.4' else '5 GHz' if band_key == '5' else 'Unknown'
        rows.append({
            'ssid': ssid,
            'bssid': bssid,
            'rssi': rssi,
            'channel': channel,
            'band': band,
            'band_key': band_key,
            'width_mhz': None,
            'security_type': None,
            'phy_mode': None,
        })
    return rows


def _sp_channel_band(chfield: str) -> Tuple[Optional[int], str]:
    """Parse ``spairport_network_channel`` like ``149 (5GHz, 80MHz)`` → (149, '5')."""
    if not chfield:
        return None, 'other'
    s = str(chfield).strip()
    m = re.match(r'^(\d+)\s*\(', s)
    if not m:
        return None, 'other'
    ch = int(m.group(1))
    if '6GHz' in s or '6 GHz' in s:
        bk = '6'
    elif '5GHz' in s or '5 GHz' in s:
        bk = '5'
    elif '2GHz' in s or '2 GHz' in s:
        bk = '2.4'
    else:
        bk = '5' if ch >= 36 else '2.4' if 1 <= ch <= 14 else 'other'
    return ch, bk


def _system_profiler_other_wifi_json() -> List[Dict[str, Any]]:
    """Neighbor SSIDs from ``system_profiler -json`` (often still redacted on modern macOS)."""
    if sys.platform != 'darwin':
        return []
    try:
        r = subprocess.run(
            ['system_profiler', 'SPAirPortDataType', '-json'],
            capture_output=True,
            text=True,
            timeout=35,
            stdin=subprocess.DEVNULL,
        )
        if r.returncode != 0 or not (r.stdout or '').strip():
            return []
        data = json.loads(r.stdout)
    except Exception:
        return []
    out: List[Dict[str, Any]] = []
    try:
        for bundle in data.get('SPAirPortDataType') or []:
            for iface in bundle.get('spairport_airport_interfaces') or []:
                raw = iface.get('spairport_airport_other_local_wireless_networks') or []
                for net in raw:
                    name = (net.get('_name') or '').strip()
                    if not name or name == '<redacted>':
                        continue
                    chf = net.get('spairport_network_channel') or ''
                    ch, bk = _sp_channel_band(str(chf))
                    if ch is None or bk not in ('2.4', '5', '6'):
                        continue
                    out.append({'ssid': name, 'channel': ch, 'band_key': bk})
    except Exception:
        pass
    return out


def enrich_rows_ssid_from_system_profiler(rows: List[Dict[str, Any]]) -> int:
    """
    When ``airport -s`` is empty (macOS 14.4+), try **unambiguous** channel matches:
    exactly one CoreWLAN row and one ``system_profiler`` neighbor share (band_key, channel).
    """
    raw = _system_profiler_other_wifi_json()
    if not raw:
        return 0
    groups: DefaultDict[Tuple[str, int], List[str]] = defaultdict(list)
    for item in raw:
        bk = item.get('band_key')
        ch = item.get('channel')
        ss = (item.get('ssid') or '').strip()
        if bk not in ('2.4', '5', '6') or ch is None or not ss:
            continue
        groups[(bk, int(ch))].append(ss)
    n = 0
    for (bk, ch), ssids in groups.items():
        if len(set(ssids)) != 1:
            continue
        ssid = ssids[0]
        missing = [
            r
            for r in rows
            if not (r.get('ssid') or '').strip()
            and _histogram_band_for_row(r) == bk
            and int(r.get('channel') or -999) == ch
        ]
        if len(missing) != 1:
            continue
        missing[0]['ssid'] = ssid
        n += 1
    return n


def enrich_rows_ssid_from_airport(rows: List[Dict[str, Any]]) -> Tuple[int, Optional[str]]:
    """
    CoreWLAN scans often omit SSID strings (privacy / probe behavior). ``airport -s`` still
    lists many names — merge by BSSID so the UI is not all “(hidden)”.
    """
    if not rows:
        return 0, None
    if not any(not (r.get('ssid') or '').strip() for r in rows):
        return 0, None
    ar, err = scan_airport_fallback()
    if not ar:
        return 0, err
    by_b: Dict[str, str] = {}
    for x in ar:
        b = x.get('bssid')
        s = (x.get('ssid') or '').strip()
        if b and s:
            by_b[str(b).lower()] = s
    n = 0
    for r in rows:
        if (r.get('ssid') or '').strip():
            continue
        b = r.get('bssid')
        if not b:
            continue
        hit = by_b.get(str(b).lower())
        if hit:
            r['ssid'] = hit
            n += 1
    return n, None


def enrich_missing_ssid_names(rows: List[Dict[str, Any]]) -> Tuple[int, Optional[str], str]:
    """
    Fill missing SSIDs: (1) ``airport -s`` by BSSID when available; (2) ``system_profiler``
    when a channel has exactly one unnamed row and one named neighbor.
    Returns ``(total_filled, error_if_none_filled, short_note_for_survey)``.
    """
    if not rows:
        return 0, None, ''
    if not any(not (r.get('ssid') or '').strip() for r in rows):
        return 0, None, ''
    n_a, err = enrich_rows_ssid_from_airport(rows)
    n_b = 0
    if any(not (r.get('ssid') or '').strip() for r in rows):
        n_b = enrich_rows_ssid_from_system_profiler(rows)
    total = n_a + n_b
    parts: List[str] = []
    if n_a:
        parts.append(f'{n_a} via airport -s (BSSID)')
    if n_b:
        parts.append(f'{n_b} via system_profiler (unique ch.)')
    summary = '; '.join(parts)
    return total, err if total == 0 else None, summary


def scan_airport_fallback() -> Tuple[List[Dict[str, Any]], Optional[str]]:
    if not os.path.isfile(AIRPORT):
        return [], (
            f'airport binary missing at {AIRPORT} (this tool only ships on macOS).'
        )
    name = get_wifi_interface_name()
    for cmd in ([AIRPORT, name, '-s'], [AIRPORT, '-s']):
        try:
            r = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=25,
                stdin=subprocess.DEVNULL,
            )
            blob = (r.stdout or '') + '\n' + (r.stderr or '')
            rows = _parse_airport_scan(blob)
            if rows:
                return rows, None
        except Exception as e:
            return [], str(e)
    return [], (
        'airport neighbor scan is empty on many macOS 14.4+ systems (tool deprecated). '
        'SSID fill falls back to system_profiler when names are not redacted. '
        f'Binary: {AIRPORT}'
    )


def _histogram_band_for_row(row: Dict[str, Any]) -> str:
    """Bucket for per-band charts — use channel number when macOS mislabels band_key."""
    raw_bk = row.get('band_key') or 'other'
    ch = row.get('channel')
    try:
        c = int(ch) if ch is not None else None
    except (TypeError, ValueError):
        c = None
    bands = ('2.4', '5', '6', 'other')
    if c is None:
        return raw_bk if raw_bk in bands else 'other'
    if raw_bk == '6':
        return '6'
    if 1 <= c <= 14:
        return '2.4'
    if c >= 36:
        return '5'
    return raw_bk if raw_bk in bands else 'other'


def _build_channel_histograms(
    rows: List[Dict[str, Any]],
) -> Tuple[Dict[str, Dict[str, int]], Dict[str, Dict[str, Any]]]:
    by_channel: Dict[str, Dict[str, int]] = {'2.4': {}, '5': {}, '6': {}, 'other': {}}
    strongest: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        bk = _histogram_band_for_row(row)
        if bk not in by_channel:
            bk = 'other'
        ch = row.get('channel')
        if ch is not None:
            key = str(int(ch))
            by_channel[bk][key] = by_channel[bk].get(key, 0) + 1
            prev = strongest.get(f'{bk}:{key}')
            rssi = row.get('rssi')
            if rssi is not None and (prev is None or rssi > prev['rssi']):
                strongest[f'{bk}:{key}'] = {'rssi': rssi, 'ssid': row.get('ssid')}
    return by_channel, strongest


def summary_from_rows(
    rows: List[Dict[str, Any]],
    *,
    link: Dict[str, Any],
    source: str,
    note: Optional[str],
    err: Optional[str],
    scanned_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Build the survey dict returned to the UI from a list of AP rows (no radio scan)."""
    by_channel, strongest = _build_channel_histograms(rows)
    return {
        'ok': bool(rows),
        'source': source,
        'error': err,
        'note': note,
        'scanned_at': scanned_at or time.strftime('%Y-%m-%d %H:%M:%S'),
        'link': link,
        'networks': rows,
        'by_channel': by_channel,
        'strongest_per_channel': strongest,
    }


def merge_survey_summaries(prev: Dict[str, Any], new: Dict[str, Any]) -> Dict[str, Any]:
    """
    Merge a new scan into data from earlier ``Scan air`` runs this session.

    Reuses the same BSSID merge rules as multi-pass CoreWLAN (strongest RSSI wins;
    fills missing SSID when a later observation has it). Recomputes histograms from
    the union. Latest scan supplies ``link`` and ``scanned_at`` when present.
    """
    prev_rows = list(prev.get('networks') or [])
    if not prev_rows:
        return new
    new_rows = list(new.get('networks') or [])
    merged_rows = _merge_network_rows_from_passes([prev_rows, new_rows])
    link = new.get('link') or prev.get('link') or {}

    note_bits = [x for x in (new.get('note'),) if x]
    note_bits.append(
        f'Cumulative: {len(merged_rows)} unique BSSIDs '
        f'({len(prev_rows)} prior rows + {len(new_rows)} from latest scan).'
    )
    err: Optional[str] = None
    if not new_rows and new.get('error'):
        note_bits.append(f'Latest scan: {new["error"]} (kept prior BSSIDs).')
    if not merged_rows:
        err = new.get('error') or prev.get('error')

    return summary_from_rows(
        merged_rows,
        link=link,
        source=new.get('source') or prev.get('source', 'unknown'),
        note=' | '.join(note_bits) if note_bits else None,
        err=err,
        scanned_at=new.get('scanned_at') or prev.get('scanned_at'),
    )


def survey_fill_ssids_from_airport(summary: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run ``airport -s`` SSID fill again on the final ``networks`` list (e.g. after
    cumulative merge). Rebuilds histograms only when at least one name was added.
    """
    rows = list(summary.get('networks') or [])
    if not rows:
        return summary
    n, _, bits = enrich_missing_ssid_names(rows)
    if not n:
        return summary
    extra = f'{n} SSID name(s) post-merge ({bits}).' if bits else f'{n} SSID name(s) post-merge.'
    prev_note = summary.get('note')
    note = f'{prev_note} {extra}'.strip() if prev_note else extra
    return summary_from_rows(
        rows,
        link=summary.get('link') or {},
        source=summary.get('source', 'unknown'),
        note=note,
        err=summary.get('error'),
        scanned_at=summary.get('scanned_at'),
    )


def _ssid_missing_fraction(rows: List[Dict[str, Any]]) -> float:
    if not rows:
        return 0.0
    missing = sum(1 for r in rows if not (r.get('ssid') or '').strip())
    return missing / float(len(rows))


def run_survey(prefer_airport: bool = False) -> Dict[str, Any]:
    """
    Run a survey and return rows + aggregates for charting.

    ``prefer_airport`` is rarely needed; CoreWLAN is richer (band/width).
    """
    note: Optional[str] = None
    err: Optional[str] = None
    if prefer_airport:
        rows, err = scan_airport_fallback()
        source = 'airport'
    else:
        rows, wmeta = scan_corewlan_accumulated()
        if rows:
            source = 'corewlan'
            note = wmeta
        else:
            rows, aerr = scan_airport_fallback()
            source = 'airport'
            err = aerr or wmeta
            note = None
            if not rows and not err:
                err = 'No Wi‑Fi networks returned (permissions, hardware, or scan failure).'

    n_ssid, _, ssid_bits = enrich_missing_ssid_names(rows)
    if n_ssid:
        extra = (
            f'{n_ssid} SSID name(s) merged ({ssid_bits}). CoreWLAN often omits names.'
            if ssid_bits
            else f'{n_ssid} SSID name(s) merged. CoreWLAN often omits names.'
        )
        note = f'{note} {extra}'.strip() if note else extra

    if (
        source == 'corewlan'
        and rows
        and _ssid_missing_fraction(rows) >= 0.5
    ):
        hint = (
            'Most SSIDs still hidden — CoreWLAN often redacts names without Location/Wi‑Fi '
            'privacy for the app running this server (e.g. Terminal). SSIDs also fail when '
            'the process runs as root (sudo). If names used to appear, check System Settings → '
            'Privacy & Security.'
        )
        note = f'{note} {hint}'.strip() if note else hint

    link = current_link_snapshot()
    return summary_from_rows(
        rows,
        link=link,
        source=source,
        note=note,
        err=err,
        scanned_at=time.strftime('%Y-%m-%d %H:%M:%S'),
    )


def suggest_channels(summary: Dict[str, Any]) -> Dict[str, Any]:
    """
    Heuristic “less crowded” primary channel per band (by AP count; does not model overlap).
    """
    out: Dict[str, Any] = {}
    link = summary.get('link') or {}
    by = summary.get('by_channel') or {}

    def pick_least_loaded(band_key: str, allowed: List[int]) -> Optional[int]:
        counts = by.get(band_key) or {}
        best = None
        best_n = 10**9
        for ch in allowed:
            n = int(counts.get(str(ch), 0))
            if n < best_n:
                best_n = n
                best = ch
        return best

    out['2.4 GHz'] = {
        'recommended': pick_least_loaded('2.4', [1, 6, 11]),
        'note': 'Prefer 1 / 6 / 11 on 2.4 GHz to limit overlap; pick the one with the fewest APs here.',
    }
    # Common UNII-1 starter channels for home routers
    out['5 GHz'] = {
        'recommended': pick_least_loaded('5', [36, 40, 44, 48, 149, 153, 157, 161]),
        'note': 'Counts are per primary channel; DFS channels may be missing if routers hide them.',
    }
    out['6 GHz'] = {
        'recommended': pick_least_loaded('6', [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229]),
        'note': '6 GHz availability depends on router/client support and regulatory domain.',
    }

    cur_bk = link.get('band_key')
    cur_ch = link.get('channel')
    if cur_bk and cur_ch:
        rec = out.get(link.get('band') or '', {}).get('recommended')
        out['current_vs_recommended'] = {
            'current_channel': cur_ch,
            'recommended': rec,
            'same': rec == cur_ch,
        }
    return out
